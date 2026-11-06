/**
 * A2A v1.0 bridge server: agent card conformance, bearer auth, JSON-RPC method
 * set, omp `to` addressing, the spawn seam, loopback-only binding, SSE status
 * events, and the token file under the fork agent directory.
 *
 * The registry and bus are fakes cast to their process-global interfaces: the
 * server's contract is `get`/`list`/`onChange`/`setStatus` on the registry and
 * `send` on the bus, so a fake pins exactly the surface the bridge relies on.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentCard } from "@oh-my-pi/pi-coding-agent/a2a/card";
import { A2aAgentBridge } from "@oh-my-pi/pi-coding-agent/a2a/agent-bridge";
import {
	type A2aTask,
	RPC_ERRORS,
	TASK_STATE,
	mapAgentStatus,
	taskFromAgentRef,
} from "@oh-my-pi/pi-coding-agent/a2a/rpc";
import {
	A2A_HOST,
	AGENT_CARD_PATH,
	type A2aBus,
	type A2aServerHandle,
	createA2aServer,
	resolveA2aToken,
	startA2aServer,
} from "@oh-my-pi/pi-coding-agent/a2a/server";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SpawnSubagentOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import {
	AgentRegistry,
	type AgentRegistryApi,
	type AgentRef as RegistryAgentRef,
	type RegistryEvent,
	type RegistryListener,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SpawnPendingError, spawnSubagentViaExecutor } from "@oh-my-pi/pi-coding-agent/task/spawn-subagent";
import { cfgA2aEnabled, cfgA2aPort } from "@oh-my-pi/pi-coding-agent/task/settings";
import {
	StructuredSubagentError,
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

const TOKEN = "test-bearer-token";

type AgentRef = RegistryAgentRef;

function makeRef(overrides: Partial<RegistryAgentRef> & Pick<RegistryAgentRef, "id">): RegistryAgentRef {
	const now = Date.now();
	// The registry mints refs; the bridge only reads them, so a test literal is
	// a structurally-complete ref minus the private generation token.
	return {
		displayName: overrides.id,
		kind: "sub",
		parentId: "Main",
		status: "idle",
		session: null,
		sessionFile: null,
		createdAt: now,
		lastActivity: now,
		...overrides,
	} as unknown as RegistryAgentRef;
}

/** The registry surface the server uses, plus test-only mutation helpers. */
class FakeRegistry {
	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	constructor(refs: AgentRef[] = []) {
		for (const ref of refs) this.#refs.set(ref.id, ref);
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setStatus(id: string, status: AgentRef["status"]): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return false;
		const leftRunning = ref.status === "running";
		ref.status = status;
		ref.lastActivity = Date.now();
		if (status !== "running") ref.activity = undefined;
		if (leftRunning) ref.lifecycle = { ...ref.lifecycle, terminalAt: ref.lastActivity };
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	/** Record progress the way the executor does, then notify like `metadata_changed`. */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.activity = activity;
		ref.lastActivity = Date.now();
		this.#emit({ type: "metadata_changed", ref });
	}

	/** Register a ref the way the executor does (new generation, `registered` event). */
	register(input: { id: string; displayName: string; kind: AgentRef["kind"]; status?: AgentRef["status"] }): AgentRef {
		const ref = makeRef({
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			...(input.status ? { status: input.status } : {}),
		});
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	emit(event: RegistryEvent): void {
		this.#emit(event);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	asApi(): AgentRegistryApi {
		return this as unknown as AgentRegistryApi;
	}
}

interface SentIrc {
	from: string;
	to: string;
	body: string;
}

class FakeBus {
	readonly sent: SentIrc[] = [];
	outcome: IrcDeliveryReceipt["outcome"] = "woken";
	error: string | undefined;

	async send(msg: Omit<IrcMessage, "id" | "ts">): Promise<IrcDeliveryReceipt> {
		this.sent.push({ from: msg.from, to: msg.to, body: msg.body });
		return { to: msg.to, outcome: this.outcome, ...(this.error !== undefined ? { error: this.error } : {}) };
	}
}

const handles: A2aServerHandle[] = [];

afterEach(() => {
	while (handles.length > 0) handles.pop()?.stop();
});

function startServer(options: {
	refs?: AgentRef[];
	spawn?: (options: SpawnSubagentOptions) => Promise<AgentRef>;
	registry?: FakeRegistry;
	bus?: FakeBus;
	streamPollMs?: number;
}): { handle: A2aServerHandle; registry: FakeRegistry; bus: FakeBus } {
	const registry = options.registry ?? new FakeRegistry(options.refs ?? []);
	const bus = options.bus ?? new FakeBus();
	const handle = createA2aServer({
		token: TOKEN,
		port: 0,
		registry: registry.asApi(),
		bus,
		spawn: options.spawn,
		streamPollMs: options.streamPollMs ?? 20,
		card: () =>
			buildAgentCard({
				url: `http://${A2A_HOST}:${handle.port}/`,
				version: "18.16.0",
				skills: registry.list().map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					description: `Agent ${ref.id} from discovery`,
				})),
			}),
	});
	handles.push(handle);
	return { handle, registry, bus };
}

/** A parsed JSON body: `unknown` until the assertions below pin its shape. */
type JsonObject = Record<string, unknown>;

function asObject(value: unknown, what: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${what} is not a JSON object: ${JSON.stringify(value)}`);
	}
	return value as JsonObject;
}

/** The serialized `result.task` the server emitted; asserted field-by-field below. */
function taskResult(json: unknown): A2aTask {
	return asObject(asObject(json, "response").result, "result").task as A2aTask;
}

function errorResult(json: unknown): { code: number; message: string } {
	return asObject(asObject(json, "response").error, "error") as { code: number; message: string };
}

async function rpc(
	handle: A2aServerHandle,
	body: unknown,
	token: string | null = TOKEN,
): Promise<{ status: number; json: unknown }> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token !== null) headers.authorization = `Bearer ${token}`;
	const response = await fetch(`${handle.url}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	return { status: response.status, json: await response.json() };
}

describe("A2A agent card", () => {
	const card = buildAgentCard({
		url: "http://127.0.0.1:7391/",
		version: "18.16.0",
		skills: [
			{ id: "task", displayName: "Task Agent", description: "General-purpose task subagent" },
			{ id: "review", displayName: "Reviewer", description: "Reviews a diff" },
		],
	});

	it("carries the REQUIRED v1.0 fields", () => {
		expect(card.protocolVersion).toBe("1.0");
		expect(card.version).toBe("18.16.0");
		expect(card.defaultInputModes).toEqual(["text/plain"]);
		expect(card.defaultOutputModes).toEqual(["text/plain"]);
		expect(card.capabilities.streaming).toBe(true);
		expect(card.name.length).toBeGreaterThan(0);
		expect(card.description.length).toBeGreaterThan(0);
		expect(card.supportedInterfaces[0]).toMatchObject({
			protocolBinding: "JSONRPC",
			protocolVersion: "1.0",
			url: "http://127.0.0.1:7391/",
		});
		expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe("Bearer");
	});

	it("builds skills from registry display names and discovery descriptions only", () => {
		expect(card.skills).toEqual([
			{ id: "task", name: "Task Agent", description: "General-purpose task subagent", tags: ["omp", "subagent"] },
			{ id: "review", name: "Reviewer", description: "Reviews a diff", tags: ["omp", "subagent"] },
		]);
		// A system prompt must never ride the card: skills expose identity and
		// discovery description only.
		expect(JSON.stringify(card)).not.toContain("systemPrompt");
	});
});

describe("A2A bearer auth", () => {
	it("serves the agent card at the well-known path without auth", async () => {
		const { handle } = startServer({ refs: [makeRef({ id: "task", displayName: "Task Agent" })] });
		const response = await fetch(`${handle.url}${AGENT_CARD_PATH}`);
		expect(response.status).toBe(200);
		const card = asObject(await response.json(), "agent card");
		expect(card.protocolVersion).toBe("1.0");
		const skills = card.skills as Array<Record<string, unknown>>;
		expect(skills[0]).toMatchObject({ id: "task", name: "Task Agent" });
	});

	it("rejects a missing bearer with 401 and a JSON-RPC error", async () => {
		const { handle } = startServer({});
		const { status, json } = await rpc(handle, { jsonrpc: "2.0", id: 1, method: "ListTasks" }, null);
		expect(status).toBe(401);
		const body = asObject(json, "response");
		expect(body.jsonrpc).toBe("2.0");
		expect(errorResult(json).message.length).toBeGreaterThan(0);
		expect(body.result).toBeUndefined();
	});

	it("rejects a wrong bearer with 401", async () => {
		const { handle } = startServer({});
		const { status } = await rpc(handle, { jsonrpc: "2.0", id: 1, method: "ListTasks" }, "wrong-token");
		expect(status).toBe(401);
	});
});

describe("A2A task status mapping", () => {
	it("maps live and idle agents by real AgentStatus", () => {
		expect(mapAgentStatus(makeRef({ id: "a", status: "running" }))).toBe(TASK_STATE.WORKING);
		expect(mapAgentStatus(makeRef({ id: "a", status: "parked" }))).toBe(TASK_STATE.WORKING);
		// Idle without a terminal milestone means a follow-up run is still
		// considered in flight; there is nothing terminal to report yet.
		expect(mapAgentStatus(makeRef({ id: "a", status: "idle" }))).toBe(TASK_STATE.WORKING);
		expect(mapAgentStatus(makeRef({ id: "a", status: "idle", lifecycle: { terminalAt: 1 } }))).toBe(
			TASK_STATE.FAILED,
		);
		expect(
			mapAgentStatus(
				makeRef({ id: "a", status: "idle", lifecycle: { terminalAt: 1 }, history: { outputPath: "/tmp/a.md" } }),
			),
		).toBe(TASK_STATE.COMPLETED);
		expect(mapAgentStatus(makeRef({ id: "a", status: "aborted" }))).toBe(TASK_STATE.CANCELED);
	});

	it("derives the task id from the agent id and keeps omp metadata", () => {
		const task = taskFromAgentRef(
			makeRef({ id: "beta", displayName: "Beta", status: "idle", lifecycle: { terminalAt: 5 }, activity: "x" }),
		);
		expect(task.id).toBe("beta");
		expect(task.contextId).toBe("Main");
		expect(task.status.state).toBe(TASK_STATE.FAILED);
		expect(task.metadata?.agentId).toBe("beta");
		expect(task.metadata?.agentStatus).toBe("idle");
	});
});

describe("A2A JSON-RPC methods", () => {
	it("SendMessage delivers to an existing idle agent through the bus and returns the receipt", async () => {
		const { handle, bus } = startServer({ refs: [makeRef({ id: "beta", displayName: "Beta" })] });
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: 7,
			method: "SendMessage",
			params: {
				message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "please check the build" }] },
				metadata: { to: "beta" },
			},
		});
		expect(status).toBe(200);
		const body = asObject(json, "response");
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(7);
		const task = taskResult(json);
		expect(task.id).toBe("beta");
		expect(task.metadata?.delivery).toMatchObject({ to: "beta", outcome: "woken" });
		expect(bus.sent).toEqual([{ from: "a2a", to: "beta", body: "please check the build" }]);
	});

	it("SendMessage without a recipient spawns through the seam and returns the new agentId", async () => {
		const spawned = makeRef({ id: "Spawn-1", displayName: "Spawn One", status: "running" });
		const calls: SpawnSubagentOptions[] = [];
		const { handle } = startServer({
			spawn: async options => {
				calls.push(options);
				return spawned;
			},
		});
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: 8,
			method: "SendMessage",
			params: {
				message: { messageId: "m-2", role: "ROLE_USER", parts: [{ text: "implement the fix" }] },
				metadata: { agent: "task", context: "repo context" },
			},
		});
		expect(status).toBe(200);
		const task = taskResult(json);
		expect(task.id).toBe("Spawn-1");
		expect(task.metadata).toMatchObject({ agentId: "Spawn-1", spawned: true });
		expect(calls).toEqual([{ agent: "task", prompt: "implement the fix", context: "repo context" }]);
	});

	it("SendMessage with metadata.spawn prefers a spawn over the addressed delivery", async () => {
		const spawned = makeRef({ id: "Spawn-2", displayName: "Spawn Two", status: "running" });
		const calls: SpawnSubagentOptions[] = [];
		const { handle, bus } = startServer({
			refs: [makeRef({ id: "beta", displayName: "Beta" })],
			spawn: async options => {
				calls.push(options);
				return spawned;
			},
		});
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: 18,
			method: "SendMessage",
			params: {
				message: { messageId: "m-2b", role: "ROLE_USER", parts: [{ text: "implement the fix" }] },
				metadata: { to: "beta", spawn: true, agent: "task" },
			},
		});
		expect(status).toBe(200);
		const task = taskResult(json);
		expect(task.id).toBe("Spawn-2");
		expect(task.metadata).toMatchObject({ agentId: "Spawn-2", spawned: true });
		expect(calls).toEqual([{ agent: "task", prompt: "implement the fix" }]);
		// Spawn wins: the addressed agent received nothing.
		expect(bus.sent).toEqual([]);
	});

	it("rejects a non-boolean metadata.spawn with -32602", async () => {
		const { handle } = startServer({ refs: [makeRef({ id: "beta" })] });
		const { json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: 19,
			method: "SendMessage",
			params: {
				message: { messageId: "m-2c", role: "ROLE_USER", parts: [{ text: "go" }] },
				metadata: { to: "beta", spawn: "yes" },
			},
		});
		expect(errorResult(json).code).toBe(RPC_ERRORS.INVALID_PARAMS);
	});

	it("answers unknown methods, including the SubscribeToTask v1 cut, with -32601", async () => {
		const { handle } = startServer({});
		for (const method of ["SubscribeToTask", "NoSuchMethod"]) {
			const { status, json } = await rpc(handle, { jsonrpc: "2.0", id: 9, method, params: {} });
			expect(status).toBe(200);
			expect(errorResult(json).code).toBe(RPC_ERRORS.METHOD_NOT_FOUND);
		}
	});

	it("GetTask returns a registered agent and -32001 for an unknown one", async () => {
		const { handle } = startServer({ refs: [makeRef({ id: "beta", displayName: "Beta", status: "running" })] });
		const found = await rpc(handle, { jsonrpc: "2.0", id: 10, method: "GetTask", params: { id: "beta" } });
		// The server serialized an A2aTask; assert the fields below.
		const task = asObject(asObject(found.json, "response").result, "result") as unknown as A2aTask;
		expect(task.id).toBe("beta");
		expect(task.status.state).toBe(TASK_STATE.WORKING);
		const missing = await rpc(handle, { jsonrpc: "2.0", id: 11, method: "GetTask", params: { id: "nope" } });
		expect(errorResult(missing.json).code).toBe(RPC_ERRORS.TASK_NOT_FOUND);
	});

	it("ListTasks lists the registry with pagination metadata", async () => {
		const { handle } = startServer({
			refs: [makeRef({ id: "beta", status: "running" }), makeRef({ id: "alpha", status: "running" })],
		});
		const { json } = await rpc(handle, { jsonrpc: "2.0", id: 12, method: "ListTasks", params: {} });
		const result = asObject(asObject(json, "response").result, "result");
		const tasks = result.tasks as A2aTask[];
		expect(tasks.map(task => task.id).sort((a, b) => a.localeCompare(b))).toEqual(["alpha", "beta"]);
		expect(result.nextPageToken).toBe("");
		expect(result.pageSize as number).toBeGreaterThanOrEqual(2);
		expect(result.totalSize).toBe(2);
	});

	it("CancelTask aborts the live session and reports CANCELED", async () => {
		let aborted = false;
		const registry = new FakeRegistry([
			makeRef({
				id: "beta",
				status: "running",
				session: { abort: async () => void (aborted = true) } as never,
			}),
		]);
		const { handle } = startServer({ registry });
		const { json } = await rpc(handle, { jsonrpc: "2.0", id: 13, method: "CancelTask", params: { id: "beta" } });
		// The server serialized an A2aTask; assert the fields below.
		const task = asObject(asObject(json, "response").result, "result") as unknown as A2aTask;
		expect(aborted).toBe(true);
		expect(task.id).toBe("beta");
		expect(task.status.state).toBe(TASK_STATE.CANCELED);
	});

	it("hides advisor transcripts from GetTask", async () => {
		const { handle } = startServer({ refs: [makeRef({ id: "__advisor", kind: "advisor", status: "running" })] });
		const { json } = await rpc(handle, { jsonrpc: "2.0", id: 15, method: "GetTask", params: { id: "__advisor" } });
		expect(errorResult(json).code).toBe(RPC_ERRORS.TASK_NOT_FOUND);
	});

	it("reports a refused spawn as AGENT_REJECTED (HTTP 200), not an internal error", async () => {
		const { handle } = startServer({
			spawn: async () => {
				throw new StructuredSubagentError("preflight", 'Agent "nope" is disabled in settings.');
			},
		});
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: 16,
			method: "SendMessage",
			params: { message: { messageId: "m-4", role: "ROLE_USER", parts: [{ text: "go" }] } },
		});
		expect(status).toBe(200);
		const error = errorResult(json);
		expect(error.code).toBe(RPC_ERRORS.AGENT_REJECTED);
		expect(error.message).toContain("disabled");
	});

	it("rejects malformed SendMessage params with -32602", async () => {
		const { handle } = startServer({});
		const { json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: 14,
			method: "SendMessage",
			params: { message: { parts: [] } },
		});
		expect(errorResult(json).code).toBe(RPC_ERRORS.INVALID_PARAMS);
	});
});

describe("A2A delivery ingress", () => {
	function startWithBus(registry: FakeRegistry, bus: A2aBus): A2aServerHandle {
		const handle = createA2aServer({
			token: TOKEN,
			port: 0,
			registry: registry.asApi(),
			bus,
			card: () => buildAgentCard({ url: `http://${A2A_HOST}:7391/`, version: "18.16.0", skills: [] }),
		});
		handles.push(handle);
		return handle;
	}

	it("marks bridge deliveries external: a repeated or bursty request is not agent-guarded", async () => {
		// A real bus with its guard on and a healthy recipient: the bridge's
		// deliveries must not be refused by the agent-loop rate/dedup policy.
		const session = { deliverIrcMessage: async () => "injected" as const };
		const registry = new FakeRegistry([
			makeRef({ id: "beta", displayName: "Beta", status: "idle", session: session as never }),
		]);
		const bus = new IrcBus(registry.asApi(), undefined, { settings: Settings.isolated({}) });
		const handle = startWithBus(registry, bus);
		// 160 chars = 40 tokens: more than one 30-token window, so a shared agent
		// budget would refuse every request after the first.
		const body = "please continue ".repeat(10);
		for (const messageId of ["m-1", "m-2", "m-3"]) {
			const { status, json } = await rpc(handle, {
				jsonrpc: "2.0",
				id: messageId,
				method: "SendMessage",
				params: {
					message: { messageId, role: "ROLE_USER", parts: [{ text: body }] },
					metadata: { to: "beta" },
				},
			});
			expect(status).toBe(200);
			expect(taskResult(json).metadata?.delivery).toMatchObject({ to: "beta", outcome: "injected" });
		}

		// The same body twice from the shared "a2a" sender id without the external
		// mark is exactly what the guard would have cut; proving the exemption runs
		// on the A2A path, not in the guard's absence.
		const direct = await bus.send({ from: "a2a", to: "beta", body: "identical agent send" });
		const repeat = await bus.send({ from: "a2a", to: "beta", body: "identical agent send" });
		expect(direct.outcome).toBe("injected");
		expect(repeat.outcome).toBe("failed");
		expect(repeat.error).toStartWith("duplicate");
	});

	it("answers a failed delivery with a JSON-RPC error, not a success receipt", async () => {
		const bus = new FakeBus();
		bus.outcome = "failed";
		bus.error = "rate limited: a2a may send 30 tokens per 500 ms";
		const { handle } = startServer({ refs: [makeRef({ id: "beta", displayName: "Beta" })], bus });
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: 23,
			method: "SendMessage",
			params: {
				message: { messageId: "m-5", role: "ROLE_USER", parts: [{ text: "please check" }] },
				metadata: { to: "beta" },
			},
		});
		expect(status).toBe(200);
		const error = errorResult(json);
		expect(error.code).toBe(RPC_ERRORS.DELIVERY_FAILED);
		expect(error.message).toContain("rate limited");
		expect(asObject(json, "response").result).toBeUndefined();
	});
});

/** A non-loopback IPv4 interface, when this host has one. */
const externalIpv4 = Object.values(os.networkInterfaces())
	.flat()
	.find(entry => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;

describe("A2A network surface", () => {
	it("refuses to bind anything but loopback", () => {
		expect(A2A_HOST).toBe("127.0.0.1");
		expect(() =>
			createA2aServer({
				token: TOKEN,
				host: "0.0.0.0",
				port: 0,
				registry: new FakeRegistry().asApi(),
				bus: new FakeBus(),
				card: () => buildAgentCard({ url: "http://127.0.0.1:1/", version: "1.0", skills: [] }),
			}),
		).toThrow(/127\.0\.0\.1/);
	});

	it.skipIf(externalIpv4 === undefined)("is unreachable through a non-loopback interface", async () => {
		const address = externalIpv4;
		if (!address) throw new Error("unreachable: no external IPv4 interface");
		const { handle } = startServer({});
		// Integration probe of the real bind: the connect deadline is the only
		// timer here, not a sleep between assertions.
		await expect(
			fetch(`http://${address}:${handle.port}${AGENT_CARD_PATH}`, {
				signal: AbortSignal.timeout(1500),
			}),
		).rejects.toThrow();
	});
});

describe("A2A opt-in", () => {
	it("is off by default and only enabled per run by --a2a-port", () => {
		expect(cfgA2aEnabled.default).toBe(false);
		expect(cfgA2aPort.default).toBe(7391);
		expect(parseArgs([]).a2aPort).toBeUndefined();
		expect(parseArgs(["--a2a-port", "7123"]).a2aPort).toBe(7123);
	});
});

/** One reader over an SSE response: `until` waits for a frame, `toEnd` for the close. */
function openSse(response: Response) {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const append = async (): Promise<boolean> => {
		const chunk = await reader.read();
		if (chunk.done) return false;
		text += decoder.decode(chunk.value, { stream: true });
		return true;
	};
	return {
		async until(predicate: (text: string) => boolean): Promise<void> {
			while (!predicate(text)) {
				if (!(await append())) throw new Error(`SSE stream closed before the expected frame: ${text}`);
			}
		},
		async toEnd(): Promise<void> {
			while (await append()) {}
		},
		get text(): string {
			return text;
		},
		cancel(): void {
			void reader.cancel().catch(() => {});
		},
	};
}

describe("A2A streaming", () => {
	it("SendStreamingMessage emits TaskStatusUpdateEvent frames and closes on a terminal state", async () => {
		const registry = new FakeRegistry([makeRef({ id: "beta", status: "running" })]);
		const { handle } = startServer({ registry });
		const response = await fetch(handle.url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 21,
				method: "SendStreamingMessage",
				params: {
					message: { messageId: "m-3", role: "ROLE_USER", parts: [{ text: "keep going" }] },
					metadata: { to: "beta" },
				},
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const sse = openSse(response);
		try {
			await sse.until(text => text.includes('"result":{"task"'));
			expect(sse.text).toContain('"id":"beta"');

			registry.setActivity("beta", "editing the parser");
			await sse.until(text => text.includes("statusUpdate"));
			expect(sse.text).toContain("TASK_STATE_WORKING");
			expect(sse.text).toContain('"taskId":"beta"');
			expect(sse.text).toContain('"final":false');

			registry.get("beta")!.history = { outputPath: "/tmp/beta.md" };
			registry.setStatus("beta", "idle");
			await sse.toEnd();
			expect(sse.text).toContain("TASK_STATE_COMPLETED");
			expect(sse.text).toContain('"final":true');
		} finally {
			sse.cancel();
		}
	});

	it("closes a stream whose delivery failed with a final TASK_STATE_FAILED", async () => {
		const bus = new FakeBus();
		bus.outcome = "failed";
		bus.error = "agent beta has no live session";
		const registry = new FakeRegistry([makeRef({ id: "beta", status: "running" })]);
		const { handle } = startServer({ registry, bus });
		const response = await fetch(handle.url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 24,
				method: "SendStreamingMessage",
				params: {
					message: { messageId: "m-6", role: "ROLE_USER", parts: [{ text: "keep going" }] },
					metadata: { to: "beta" },
				},
			}),
		});
		expect(response.status).toBe(200);
		const sse = openSse(response);
		try {
			// The registry ref never changes: without a terminal frame the stream
			// stays open and only the test's own timeout ends it.
			await sse.toEnd();
			expect(sse.text).toContain("TASK_STATE_FAILED");
			expect(sse.text).toContain("agent beta has no live session");
			expect(sse.text).toContain('"final":true');
		} finally {
			sse.cancel();
		}
	}, 2000); // A non-closing SSE stream is the failure under test: bound the wait.
});

describe("spawnSubagent seam", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("resolves the registry ref while the run is still in flight", async () => {
		AgentRegistry.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const requests: StructuredSubagentRequest[] = [];
		const running = Promise.withResolvers<StructuredSubagentResult>();
		// The injected executor never touches the session; the fake pins the
		// request shape the task executor receives.
		const session = {} as unknown as ToolSession;
		const spawn = spawnSubagentViaExecutor(
			session,
			{ agent: "task", prompt: "  do the work  ", context: "shared context" },
			{
				reserveId: async () => "Spawn-9",
				run: async request => {
					requests.push(request);
					registry.register({
						id: "Spawn-9",
						displayName: "Spawn 9",
						kind: "sub",
						session: null,
						status: "running",
					});
					return await running.promise;
				},
			},
		);
		const ref = await spawn;
		expect(ref.id).toBe("Spawn-9");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			assignment: "do the work",
			agent: "task",
			context: "shared context",
			identity: { id: "Spawn-9" },
			detached: true,
			keepAlive: true,
		});
		running.resolve(undefined as unknown as StructuredSubagentResult);
	});

	it("rejects an empty prompt before reserving an id or running the executor", async () => {
		await expect(
			spawnSubagentViaExecutor(
				{} as unknown as ToolSession,
				{ prompt: "   " },
				{
					reserveId: async () => {
						throw new Error("reserve must not run");
					},
					run: async () => {
						throw new Error("run must not run");
					},
				},
			),
		).rejects.toThrow(/non-empty prompt/);
	});

	it("reports a reserved id as pending when registration times out", async () => {
		AgentRegistry.resetGlobalForTests();
		const never = Promise.withResolvers<StructuredSubagentResult>();
		const spawn = spawnSubagentViaExecutor(
			{} as unknown as ToolSession,
			{ prompt: "slow start" },
			{
				reserveId: async () => "Spawn-late",
				run: async () => await never.promise,
			},
			0,
		);
		await expect(spawn).rejects.toBeInstanceOf(SpawnPendingError);
		await spawn.catch(error => {
			expect((error as SpawnPendingError).agentId).toBe("Spawn-late");
		});
		never.resolve(undefined as unknown as StructuredSubagentResult);
	});

	it("rejects when the run fails before the child registers", async () => {
		AgentRegistry.resetGlobalForTests();
		await expect(
			spawnSubagentViaExecutor(
				{} as unknown as ToolSession,
				{ prompt: "fix it" },
				{
					reserveId: async () => "Spawn-10",
					run: async () => {
						throw new Error("preflight rejected the spawn");
					},
				},
			),
		).rejects.toThrow("preflight rejected the spawn");
	});
	it("refuses a second seam spawn under maxConcurrency=1 + refuse, as AGENT_REJECTED", async () => {
		AgentRegistry.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const running = Promise.withResolvers<StructuredSubagentResult>();
		// The seam shares the session's limiter with the task tool; a detached
		// run keeps the only slot until it settles.
		const session = {
			settings: Settings.isolated({ "task.maxConcurrency": 1, "task.concurrencyPolicy": "refuse" }),
		} as unknown as ToolSession;
		const spawn = (options: SpawnSubagentOptions) =>
			spawnSubagentViaExecutor(session, options, {
				reserveId: async () => "Spawn-Limit",
				run: async () => {
					registry.register({
						id: "Spawn-Limit",
						displayName: "Spawn Limit",
						kind: "sub",
						status: "running",
						session: null,
					});
					return await running.promise;
				},
			});
		const { handle } = startServer({ spawn });

		const first = await rpc(handle, {
			jsonrpc: "2.0",
			id: 31,
			method: "SendMessage",
			params: { message: { messageId: "m-7", role: "ROLE_USER", parts: [{ text: "first run" }] } },
		});
		expect(first.status).toBe(200);
		expect(taskResult(first.json).id).toBe("Spawn-Limit");

		const second = await rpc(handle, {
			jsonrpc: "2.0",
			id: 32,
			method: "SendMessage",
			params: { message: { messageId: "m-8", role: "ROLE_USER", parts: [{ text: "second run" }] } },
		});
		expect(second.status).toBe(200);
		const error = errorResult(second.json);
		expect(error.code).toBe(RPC_ERRORS.AGENT_REJECTED);
		expect(error.message).toContain("Concurrent subagent limit reached (1 running; task.maxConcurrency=1)");

		running.resolve(undefined as unknown as StructuredSubagentResult);
	});

	it("rejects a remote A2A agent name before reserving an id", async () => {
		const bridge = new A2aAgentBridge();
		bridge.add({
			name: "a2a:main",
			description: "Remote Main",
			url: "http://127.0.0.1:7391/",
			cardName: "Main",
			skillId: "main",
		});
		const session = { getA2aBridge: () => bridge } as unknown as ToolSession;
		await expect(
			spawnSubagentViaExecutor(
				session,
				{ agent: "a2a:main", prompt: "run remotely" },
				{
					reserveId: async () => {
						throw new Error("reserve must not run");
					},
					run: async () => {
						throw new Error("run must not run");
					},
				},
			),
		).rejects.toThrow(/remote A2A agent and can only be spawned by the task tool/);
	});
});

describe("A2A streaming a pending spawn", () => {
	it("stays open on SUBMITTED and never reports a vanished-agent failure", async () => {
		const registry = new FakeRegistry();
		const { handle } = startServer({
			registry,
			spawn: async () => {
				throw new SpawnPendingError("Spawn-late");
			},
		});
		const response = await fetch(handle.url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 22,
				method: "SendStreamingMessage",
				params: { message: { messageId: "m-4b", role: "ROLE_USER", parts: [{ text: "start late" }] } },
			}),
		});
		const sse = openSse(response);
		try {
			await sse.until(text => text.includes('"result":{"task"'));
			expect(sse.text).toContain("TASK_STATE_SUBMITTED");
			expect(sse.text).toContain('"pending":true');

			// A progress notification for the reserved id before registration must
			// not be read as a vanished agent: the run is still starting.
			registry.emit({ type: "metadata_changed", ref: makeRef({ id: "Spawn-late", status: "running" }) });
			expect(sse.text).not.toContain("TASK_STATE_FAILED");

			registry.register({ id: "Spawn-late", displayName: "Late", kind: "sub", status: "running" });
			await sse.until(text => text.includes("statusUpdate"));
			expect(sse.text).toContain("TASK_STATE_WORKING");

			registry.get("Spawn-late")!.history = { outputPath: "/tmp/late.md" };
			registry.setStatus("Spawn-late", "idle");
			await sse.toEnd();
			expect(sse.text).toContain("TASK_STATE_COMPLETED");
			expect(sse.text).not.toContain("TASK_STATE_FAILED");
		} finally {
			sse.cancel();
		}
	});
});

describe("A2A agent card discovery", () => {
	it("serves discovery descriptions and never AgentDefinition system prompts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-a2a-card-"));
		try {
			const registry = new FakeRegistry([makeRef({ id: "leaky", displayName: "Leaky Agent" })]);
			const definition: AgentDefinition = {
				name: "leaky",
				description: "Leaky agent description",
				systemPrompt: "SECRET SYSTEM PROMPT",
				source: "project",
			};
			const handle = await startA2aServer({
				settings: Settings.isolated(),
				agentDir: dir,
				port: 0,
				registry: registry.asApi(),
				bus: new FakeBus(),
				session: { cwd: dir, getSessionAgents: () => [definition] },
			});
			handles.push(handle);
			const body = await (await fetch(`${handle.url}${AGENT_CARD_PATH}`)).text();
			const parsed: unknown = JSON.parse(body);
			expect(asObject(parsed, "agent card").protocolVersion).toBe("1.0");
			expect(body).toContain("Leaky agent description");
			expect(body).not.toContain("SECRET SYSTEM PROMPT");
			expect(body).not.toContain("systemPrompt");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("A2A bearer token", () => {
	it("generates the token once under the agent dir with mode 600 and reuses it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-a2a-token-"));
		try {
			const first = await resolveA2aToken({ agentDir: dir });
			expect(first.length).toBeGreaterThanOrEqual(32);
			const file = path.join(dir, "a2a.token");
			const stat = await fs.stat(file);
			expect(stat.mode & 0o777).toBe(0o600);
			expect((await fs.readFile(file, "utf8")).trim()).toBe(first);
			const second = await resolveA2aToken({ agentDir: dir });
			expect(second).toBe(first);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("prefers an explicitly configured token", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-a2a-token-"));
		try {
			expect(await resolveA2aToken({ agentDir: dir, explicitToken: "configured-token" })).toBe("configured-token");
			await expect(fs.stat(path.join(dir, "a2a.token"))).rejects.toThrow();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("local bridge registry", () => {
	it("registers the bridge and prunes dead pids on read", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-reg-"));
		try {
			const handle = await startA2aServer({
				settings: Settings.isolated(),
				agentDir,
				port: 0,
				registry: new FakeRegistry([]).asApi(),
				bus: new FakeBus(),
			});
			handles.push(handle);
			// registry file written with this process's entry
			const raw = JSON.parse(await fs.readFile(path.join(agentDir, "a2a-bridges.json"), "utf8")) as Array<{
				pid: number;
				port: number;
			}>;
			expect(raw.some(entry => entry.pid === process.pid && entry.port === handle.port)).toBe(true);
			// readLiveBridges excludes self
			const { readLiveBridges } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
			expect((await readLiveBridges(agentDir)).size).toBe(0);
			// a dead pid entry is pruned (not returned)
			await fs.writeFile(
				path.join(agentDir, "a2a-bridges.json"),
				JSON.stringify([{ pid: 999999, port: 1234, startedAt: 1 }]),
			);
			expect((await readLiveBridges(agentDir)).size).toBe(0);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("accepts port 0 and reports the bound port", () => {
		const result = parseArgs(["--a2a-port", "0"]);
		expect(result.a2aPort).toBe(0);
	});
});
