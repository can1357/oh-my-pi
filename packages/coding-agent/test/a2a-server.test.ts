/**
 * A2A v1.0 bridge server: agent card conformance, bearer auth, JSON-RPC method
 * set, omp `to` addressing, the spawn seam, loopback-only binding, SSE status
 * events, and the token file under the fork agent directory.
 *
 * The registry and bus are fakes cast to their process-global interfaces: the
 * server's contract is `get`/`list`/`onChange`/`setStatus` on the registry and
 * `send` on the bus, so a fake pins exactly the surface the bridge relies on.
 */

import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentCard } from "@oh-my-pi/pi-coding-agent/a2a/card";
import { addA2aAgentsFromUrl, A2aAgentBridge } from "@oh-my-pi/pi-coding-agent/a2a/agent-bridge";
import {
	IncomingRequests,
	type IncomingRequestLease,
	type IncomingRequestsApi,
} from "@oh-my-pi/pi-coding-agent/a2a/incoming-requests";
import { type OutgoingRequest, OutgoingRequests } from "@oh-my-pi/pi-coding-agent/a2a/outgoing-requests";
import {
	A2A_ARTIFACT_MAX_CHARS,
	type A2aTask,
	RPC_ERRORS,
	TASK_STATE,
	mapAgentStatus,
	taskFromAgentRef,
	sendA2aMessage,
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
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { IrcBridge } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	AgentRegistry,
	type AgentRegistryApi,
	type AgentRef as RegistryAgentRef,
	type RegistryEvent,
	type RegistryListener,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
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

	setStatus(id: string, status: AgentRef["status"], expected?: AgentRef): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return false;
		if (expected !== undefined && ref !== expected) return false;
		const previousStatus = ref.status;
		const leftRunning = previousStatus === "running";
		ref.status = status;
		ref.lastActivity = Date.now();
		if (status !== "running") ref.activity = undefined;
		if (leftRunning) ref.lifecycle = { ...ref.lifecycle, terminalAt: ref.lastActivity };
		this.#emit({ type: "status_changed", ref, previousStatus });
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
	/** Insert an exact ref so a test can pin generation identity. */
	insert(ref: AgentRef, notify = true): void {
		this.#refs.set(ref.id, ref);
		if (notify) this.#emit({ type: "registered", ref });
	}

	/** Attach a live session the way AgentRegistry.attachSession does, when the exact ref still owns the id. */
	attachSession(id: string, session: AgentRef["session"], sessionFile?: string | null, expected?: AgentRef): boolean {
		const ref = this.#refs.get(id);
		if (!ref || (expected !== undefined && ref !== expected)) return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		return true;
	}

	/** Drop a ref the way AgentRegistry.unregister does, including the removed event. */
	unregister(id: string): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return false;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
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
	vi.useRealTimers();
	IncomingRequests.resetGlobalForTests();
	OutgoingRequests.resetGlobalForTests();
});

function startServer(options: {
	refs?: AgentRef[];
	spawn?: (options: SpawnSubagentOptions) => Promise<AgentRef>;
	registry?: FakeRegistry;
	bus?: FakeBus;
	streamPollMs?: number;
	incoming?: IncomingRequestsApi;
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
		incoming: options.incoming ?? new IncomingRequests(),
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

/** Like `rpc`, but keeps the Response so a 204 notification body can be asserted. */
async function rpcRaw(handle: A2aServerHandle, body: unknown, token: string | null = TOKEN): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token !== null) headers.authorization = `Bearer ${token}`;
	return fetch(`${handle.url}`, { method: "POST", headers, body: JSON.stringify(body) });
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

	describe("output artifact cap is Unicode code points", () => {
		/** Serve a ref whose published output is `text`, then GetTask it as an artifact. */
		async function artifactFor(text: string): Promise<string> {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-a2a-cap-"));
			try {
				const outputPath = path.join(dir, "beta.md");
				await fs.writeFile(outputPath, text, "utf8");
				const registry = new FakeRegistry([
					makeRef({
						id: "beta",
						status: "idle",
						lifecycle: { terminalAt: 1 },
						history: { outputPath },
					}),
				]);
				const { handle } = startServer({ registry });
				const { json } = await rpc(handle, { jsonrpc: "2.0", id: 30, method: "GetTask", params: { id: "beta" } });
				const task = asObject(asObject(json, "response").result, "result") as unknown as A2aTask;
				const artifacts = task.artifacts as Array<{ artifactId: string; parts: Array<{ text: string }> }>;
				expect(artifacts).toHaveLength(1);
				expect(artifacts[0]?.artifactId).toBe("beta:output");
				return artifacts[0]?.parts[0]?.text ?? "";
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		}

		it("artifact cap preserves astral code point at boundary", async () => {
			const report = "a".repeat(A2A_ARTIFACT_MAX_CHARS - 1) + "😀" + "z";
			const emitted = await artifactFor(report);
			// The cut lands exactly at the emoji: the full 😀 survives, "z" is
			// gone, and no surrogate half-pair was introduced by the slice.
			expect(emitted).toBe("a".repeat(A2A_ARTIFACT_MAX_CHARS - 1) + "😀");
			expect([...emitted]).toHaveLength(A2A_ARTIFACT_MAX_CHARS);
			expect(emitted).not.toContain("z");
			expect(isWellFormed(emitted)).toBe(true);
		});

		it("caps ASCII over the limit and keeps under/exact-cap output identical", async () => {
			// ASCII over cap stays capped at exactly the cap.
			const over = "x".repeat(A2A_ARTIFACT_MAX_CHARS + 1000);
			const capped = await artifactFor(over);
			expect(capped).toBe("x".repeat(A2A_ARTIFACT_MAX_CHARS));
			// Under and exactly at the cap flow through byte-for-byte.
			const under = "a".repeat(A2A_ARTIFACT_MAX_CHARS - 1) + "😀";
			expect(await artifactFor(under)).toBe(under);
			const exact = "b".repeat(A2A_ARTIFACT_MAX_CHARS);
			expect(await artifactFor(exact)).toBe(exact);
		});

		it("keeps exactly the cap of full emoji for all-astral output over the limit", async () => {
			const emoji = "😀".repeat(A2A_ARTIFACT_MAX_CHARS + 2);
			const emitted = await artifactFor(emoji);
			expect([...emitted]).toHaveLength(A2A_ARTIFACT_MAX_CHARS);
			expect(emitted.endsWith("😀")).toBe(true);
			expect(isWellFormed(emitted)).toBe(true);
		});

		function isWellFormed(text: string): boolean {
			for (let index = 0; index < text.length; index++) {
				const unit = text.charCodeAt(index);
				const high = unit >= 0xd800 && unit <= 0xdbff;
				const low = unit >= 0xdc00 && unit <= 0xdfff;
				if (high) {
					const next = text.charCodeAt(index + 1);
					if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
					index += 1;
				} else if (low) {
					return false;
				}
			}
			return true;
		}
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

	it("ListTasks persists message.contextId, pages in stable creation order, and accepts an empty pageToken", async () => {
		const registry = new FakeRegistry([
			makeRef({ id: "beta", createdAt: 1000 }),
			makeRef({ id: "alpha", createdAt: 2000 }),
			makeRef({ id: "gamma", createdAt: 3000 }),
		]);
		const { handle } = startServer({ registry, spawn: async () => registry.get("beta")! });
		// A task created by SendMessage keeps the caller's message.contextId.
		await rpc(handle, {
			jsonrpc: "2.0",
			id: 20,
			method: "SendMessage",
			params: {
				message: { messageId: "m-ctx", role: "ROLE_USER", parts: [{ text: "go" }], contextId: "ctx-remote" },
				metadata: { spawn: true },
			},
		});
		const filtered = await rpc(handle, {
			jsonrpc: "2.0",
			id: 21,
			method: "ListTasks",
			params: { contextId: "ctx-remote" },
		});
		const filteredTasks = asObject(asObject(filtered.json, "response").result, "result").tasks as A2aTask[];
		expect(filteredTasks.map(task => task.id)).toEqual(["beta"]);
		// An empty pageToken is the first page, not a malformed cursor.
		const first = await rpc(handle, {
			jsonrpc: "2.0",
			id: 22,
			method: "ListTasks",
			params: { pageToken: "", pageSize: 2 },
		});
		const firstResult = asObject(asObject(first.json, "response").result, "result");
		expect((firstResult.tasks as A2aTask[]).map(task => task.id)).toEqual(["beta", "alpha"]);
		// lastActivity churn must not reorder the page between two reads.
		registry.setActivity("alpha", "still working");
		const second = await rpc(handle, { jsonrpc: "2.0", id: 23, method: "ListTasks", params: { pageSize: 2 } });
		const secondTasks = asObject(asObject(second.json, "response").result, "result").tasks as A2aTask[];
		expect(secondTasks.map(task => task.id)).toEqual(["beta", "alpha"]);
	});

	it("CancelTask aborts only bridge-created tasks and refuses Main", async () => {
		let aborted = false;
		const beta = makeRef({
			id: "beta",
			status: "running",
			session: { abort: async () => void (aborted = true) } as never,
		});
		const registry = new FakeRegistry([beta, makeRef({ id: "Main", kind: "main", status: "running" })]);
		const { handle } = startServer({ registry, spawn: async () => beta });
		// A2A spawns create the task, so it becomes cancelable through this bridge.
		const created = await rpc(handle, {
			jsonrpc: "2.0",
			id: 12,
			method: "SendMessage",
			params: {
				message: { messageId: "m-13", role: "ROLE_USER", parts: [{ text: "start" }] },
				metadata: { spawn: true },
			},
		});
		expect(taskResult(created.json).id).toBe("beta");
		// Main and local subagents were never created by the bridge: refuse them.
		const main = await rpc(handle, { jsonrpc: "2.0", id: 13, method: "CancelTask", params: { id: "Main" } });
		expect(errorResult(main.json).code).toBe(RPC_ERRORS.TASK_NOT_CANCELABLE);
		const { json } = await rpc(handle, { jsonrpc: "2.0", id: 14, method: "CancelTask", params: { id: "beta" } });
		const task = asObject(asObject(json, "response").result, "result") as unknown as A2aTask;
		expect(aborted).toBe(true);
		expect(task.id).toBe("beta");
		expect(task.status.state).toBe(TASK_STATE.CANCELED);
	});

	it("refuses to cancel an unrelated local subagent after delivery", async () => {
		let aborted = false;
		const local = makeRef({
			id: "local",
			status: "running",
			session: { abort: async () => void (aborted = true) } as never,
		});
		const { handle } = startServer({ refs: [local] });
		await rpc(handle, {
			jsonrpc: "2.0",
			id: 1,
			method: "SendMessage",
			params: { message: { messageId: "m", parts: [{ text: "hello" }] }, metadata: { to: "local" } },
		});
		const result = await rpc(handle, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id: "local" } });
		expect(errorResult(result.json).code).toBe(RPC_ERRORS.TASK_NOT_CANCELABLE);
		expect(aborted).toBe(false);
	});

	it("does not cancel a replacement generation that reused a bridge task id", async () => {
		let aborted = false;
		const original = makeRef({ id: "worker", status: "running" });
		const registry = new FakeRegistry([original]);
		const { handle } = startServer({ registry, spawn: async () => original });
		await rpc(handle, {
			jsonrpc: "2.0",
			id: 1,
			method: "SendMessage",
			params: { message: { messageId: "m", contextId: "old-context", parts: [{ text: "go" }] } },
		});
		const replacement = registry.register({ id: "worker", displayName: "worker", kind: "sub", status: "running" });
		replacement.session = { abort: async () => void (aborted = true) } as never;
		const canceled = await rpc(handle, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id: "worker" } });
		expect(errorResult(canceled.json).code).toBe(RPC_ERRORS.TASK_NOT_CANCELABLE);
		expect(aborted).toBe(false);
		const listed = await rpc(handle, {
			jsonrpc: "2.0",
			id: 3,
			method: "ListTasks",
			params: { contextId: "old-context" },
		});
		expect(asObject(asObject(listed.json, "response").result, "result").tasks as A2aTask[]).toEqual([]);
	});

	it("preserves a completed task or replacement registered during cancellation", async () => {
		for (const replace of [false, true]) {
			const registry = new FakeRegistry();
			const original = registry.register({ id: "worker", displayName: "worker", kind: "sub", status: "running" });
			original.session = {
				abort: async () => {
					if (replace) registry.register({ id: "worker", displayName: "new", kind: "sub", status: "running" });
					else registry.setStatus("worker", "idle");
				},
			} as never;
			const { handle } = startServer({ registry, spawn: async () => original });
			await rpc(handle, {
				jsonrpc: "2.0",
				id: 1,
				method: "SendMessage",
				params: { message: { messageId: "m", parts: [{ text: "go" }] } },
			});
			await rpc(handle, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id: "worker" } });
			expect(registry.get("worker")?.status).toBe(replace ? "running" : "idle");
		}
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

describe("A2A JSON-RPC notifications and batches", () => {
	const notify = {
		jsonrpc: "2.0",
		method: "SendMessage",
		params: {
			message: { messageId: "n-1", role: "ROLE_USER", parts: [{ text: "notify" }] },
			metadata: { to: "Main" },
		},
	};

	it("processes a request without an id as a notification and answers 204 with no body", async () => {
		const registry = new FakeRegistry([makeRef({ id: "Main", status: "running" })]);
		const bus = new FakeBus();
		const { handle } = startServer({ registry, bus });
		const response = await rpcRaw(handle, notify);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(bus.sent).toHaveLength(1);
		expect(bus.sent[0]!.body).toBe("notify");
	});

	it("executes a streaming notification without opening an SSE response", async () => {
		const { handle, bus } = startServer({ refs: [makeRef({ id: "Main", kind: "main", status: "running" })] });
		const response = await rpcRaw(handle, { ...notify, method: "SendStreamingMessage" });
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(bus.sent.map(message => message.body)).toEqual(["notify"]);
	});

	it("returns one response per non-notification call in a batch, omitting notifications", async () => {
		const registry = new FakeRegistry([makeRef({ id: "Main", status: "running" })]);
		const bus = new FakeBus();
		const { handle } = startServer({ registry, bus });
		const response = await rpcRaw(handle, [
			{ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} },
			notify,
			{ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "Main" } },
		]);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as Array<{ id: number }>;
		expect(payload.map(row => row.id)).toEqual([1, 2]);
		expect(bus.sent).toHaveLength(1);
	});

	it("answers an all-notification batch with 204", async () => {
		const registry = new FakeRegistry([makeRef({ id: "Main", status: "running" })]);
		const bus = new FakeBus();
		const { handle } = startServer({ registry, bus });
		const response = await rpcRaw(handle, [notify, notify]);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(bus.sent).toHaveLength(2);
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

	it("fast recipient can claim request before send receipt resolves", async () => {
		const base = new IncomingRequests();
		const gate = Promise.withResolvers<void>();
		const notedFirst = Promise.withResolvers<void>();
		let sendEntered = false;
		const incoming: IncomingRequestsApi = {
			// Gate `note`: the dispatch must not enter the bus send until it resolves.
			note: request => {
				notedFirst.resolve();
				return gate.promise.then(() => base.note(request));
			},
			consume: match => base.consume(match),
			confirm: leaseId => base.confirm(leaseId),
			release: leaseId => base.release(leaseId),
			discard: match => base.discard(match),
			list: to => base.list(to),
		};
		const bus = new FakeBus();
		let claimedBeforeReceipt = false;
		let replyDelivered: string | undefined;
		bus.send = async msg => {
			sendEntered = true;
			bus.sent.push({ from: msg.from, to: msg.to, body: msg.body });
			// A fast recipient wakes synchronously inside the bus delivery: it
			// claims the just-addressed request and completes a correlated
			// answer before the send receipt resolves.
			const lease = await base.consume({ to: "Main", from: "peer" });
			claimedBeforeReceipt = lease?.request.messageId === "fast-1" && lease.request.from === "peer";
			const sent: string[] = [];
			await sendA2aMessage(
				{
					message: { messageId: "answer-1", role: "ROLE_USER", parts: [{ text: "the answer" }] },
					metadata: { to: "Peer", from: "Main", inReplyTo: lease?.request.messageId },
				},
				{
					registry: {
						get: (id: string) => (id === "Peer" ? makeRef({ id: "Peer", status: "running" }) : undefined),
						list: () => [],
						setStatus: () => false,
					},
					send: async reply => {
						sent.push(reply.body);
						return { to: reply.to, outcome: "injected" };
					},
					incoming: base,
				},
			);
			replyDelivered = sent[0];
			return { to: msg.to, outcome: "woken" };
		};
		const { handle } = startServer({
			refs: [makeRef({ id: "Main", kind: "main", status: "running" })],
			bus,
			incoming,
		});
		const pending = rpc(handle, {
			jsonrpc: "2.0",
			id: "fast-1",
			method: "SendMessage",
			params: {
				message: { messageId: "fast-1", role: "ROLE_USER", parts: [{ text: "hello" }] },
				metadata: { to: "Main", from: "peer" },
			},
		});
		// The dispatch is parked inside `note` on an unresolved gate, so the
		// bus send cannot have entered: the record is being made before delivery.
		await notedFirst.promise;
		expect(sendEntered).toBe(false);
		gate.resolve();
		const { status, json } = await pending;
		expect(status).toBe(200);
		expect(taskResult(json).metadata?.delivery).toMatchObject({ to: "Main", outcome: "woken" });
		// The recipient saw and claimed the request before the receipt existed.
		expect(claimedBeforeReceipt).toBe(true);
		// Its correlated answer completed before the receipt resolved.
		expect(replyDelivered).toContain("[A2A reply to your request fast-1");
		expect(replyDelivered).toContain("the answer");
		// The reply created no new incoming request on either side.
		expect(await base.list("Main")).toEqual([]);
		expect(await base.list("Peer")).toEqual([]);
		await expect(base.consume({ to: "Main", from: "peer" })).resolves.toBeUndefined();
	});

	it("refused delivery discards only its incoming request", async () => {
		const incoming = new IncomingRequests();
		const bus = new FakeBus();
		bus.outcome = "failed";
		bus.error = "agent Main has no live session";
		let lease: IncomingRequestLease | undefined;
		bus.send = async msg => {
			bus.sent.push({ from: msg.from, to: msg.to, body: msg.body });
			lease = await incoming.consume({ to: "Main", from: "peer" });
			return { to: msg.to, outcome: "failed", error: bus.error };
		};
		const { handle } = startServer({
			refs: [makeRef({ id: "Main", kind: "main", status: "running" })],
			bus,
			incoming,
		});
		// An unrelated queued request from another peer must survive the rollback.
		await incoming.note({ to: "Main", from: "other", messageId: "kept", at: 1 });
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: "refused",
			method: "SendMessage",
			params: {
				message: { messageId: "refused-1", role: "ROLE_USER", parts: [{ text: "hello" }] },
				metadata: { to: "Main", from: "peer" },
			},
		});
		expect(status).toBe(200);
		const error = errorResult(json);
		expect(error.code).toBe(RPC_ERRORS.DELIVERY_FAILED);
		expect(error.message).toContain("agent Main has no live session");
		// The refused request was rolled back; the queued one is retained, and
		// a discarded lease token cannot resurrect the removed record.
		expect((await incoming.list("Main")).map(request => request.messageId)).toEqual(["kept"]);
		await expect(incoming.consume({ to: "Main", from: "peer" })).resolves.toBeUndefined();
		expect(lease).toBeDefined();
		expect(await incoming.release(lease!.leaseId)).toBe(false);
		expect(await incoming.confirm(lease!.leaseId)).toBe(false);
		expect((await incoming.list("Main")).map(request => request.messageId)).toEqual(["kept"]);
	});

	it("throwing delivery invalidates a pending claim", async () => {
		const incoming = new IncomingRequests();
		const bus = new FakeBus();
		let lease: IncomingRequestLease | undefined;
		bus.send = async msg => {
			bus.sent.push({ from: msg.from, to: msg.to, body: msg.body });
			lease = await incoming.consume({ to: "Main", from: "peer" });
			throw new Error("bus transport exploded");
		};
		const { handle } = startServer({
			refs: [makeRef({ id: "Main", kind: "main", status: "running" })],
			bus,
			incoming,
		});
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: "thrown",
			method: "SendMessage",
			params: {
				message: { messageId: "thrown-1", role: "ROLE_USER", parts: [{ text: "hello" }] },
				metadata: { to: "Main", from: "peer" },
			},
		});
		expect(status).toBe(500);
		expect(errorResult(json).message).toContain("bus transport exploded");
		expect(await incoming.list("Main")).toEqual([]);
		expect(lease).toBeDefined();
		// The recipient claimed before the throw; the discard invalidates it.
		expect(await incoming.release(lease!.leaseId)).toBe(false);
		expect(await incoming.confirm(lease!.leaseId)).toBe(false);
	});

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
	it("is on by default with a free port; --a2a-port pins an explicit port for the run", () => {
		expect(cfgA2aEnabled.default).toBe(true);
		expect(cfgA2aPort.default).toBe(0);
		expect(parseArgs([]).a2aPort).toBeUndefined();
		expect(parseArgs(["--a2a-port", "7123"]).a2aPort).toBe(7123);
	});
});

interface SseReader {
	until(predicate: (text: string) => boolean): Promise<void>;
	toEnd(): Promise<void>;
	readonly text: string;
	cancel(): void;
}

/** One reader over an SSE response: `until` waits for a frame, `toEnd` for the close. */
function openSse(response: Response): SseReader {
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
		const error = (await spawn.catch(caught => caught)) as SpawnPendingError;
		expect(error).toBeInstanceOf(SpawnPendingError);
		expect(error.agentId).toBe("Spawn-late");
		// The run ends without ever registering: the pending outcome turns final.
		never.resolve({ result: { exitCode: 1, error: "model unavailable" } } as unknown as StructuredSubagentResult);
		await expect(error.registration).rejects.toThrow("model unavailable");
	});

	it("settles a pending spawn with the ref once it registers late", async () => {
		AgentRegistry.resetGlobalForTests();
		const never = Promise.withResolvers<StructuredSubagentResult>();
		const spawn = spawnSubagentViaExecutor(
			{} as unknown as ToolSession,
			{ prompt: "slow start" },
			{ reserveId: async () => "Spawn-late", run: async () => await never.promise },
			0,
		);
		const error = (await spawn.catch(caught => caught)) as SpawnPendingError;
		const ref = AgentRegistry.global().register({
			id: "Spawn-late",
			displayName: "late",
			kind: "sub",
			session: null,
		});
		expect(await error.registration).toBe(ref);
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
				throw new SpawnPendingError("Spawn-late", Promise.withResolvers<AgentRef>().promise);
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

/** RPC result that is the task itself (`GetTask`, `CancelTask`). */
function rpcTask(json: unknown): A2aTask {
	const body = asObject(json, "response");
	expect(body.error, JSON.stringify(body.error)).toBeUndefined();
	return body.result as A2aTask;
}

function listResult(json: unknown): { tasks: A2aTask[]; nextPageToken: string; totalSize: number } {
	const result = asObject(asObject(json, "response").result, "result");
	return {
		tasks: result.tasks as A2aTask[],
		nextPageToken: String(result.nextPageToken),
		totalSize: result.totalSize as number,
	};
}

function sseData(text: string): unknown[] {
	const frames: unknown[] = [];
	for (const block of text.split("\n\n")) {
		const line = block.split("\n").find(row => row.startsWith("data:"));
		if (!line) continue;
		frames.push(JSON.parse(line.slice("data:".length).trim()));
	}
	return frames;
}

interface SseStatusUpdate {
	state?: string;
	final?: boolean;
	reason?: string;
}

function optionalRecord(value: unknown): JsonObject | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	// Guarded JSON object; callers read fields they then narrow.
	const record: JsonObject = value as JsonObject;
	return record;
}

function sseStatusUpdates(text: string): SseStatusUpdate[] {
	const updates: SseStatusUpdate[] = [];
	for (const frame of sseData(text)) {
		const result = optionalRecord(optionalRecord(frame)?.result);
		const update = optionalRecord(result?.statusUpdate);
		if (!update) continue;
		const status = optionalRecord(update.status);
		const message = optionalRecord(status?.message);
		const parts = message?.parts;
		const part = Array.isArray(parts) ? optionalRecord(parts[0]) : undefined;
		const reason = typeof part?.text === "string" ? part.text : undefined;
		updates.push({
			state: typeof status?.state === "string" ? status.state : undefined,
			final: update.final === true,
			...(reason !== undefined ? { reason } : {}),
		});
	}
	return updates;
}

function initialSseTask(text: string): A2aTask {
	for (const frame of sseData(text)) {
		const task = optionalRecord(optionalRecord(frame)?.result)?.task;
		if (task !== undefined) return task as A2aTask;
	}
	throw new Error(`SSE stream has no initial task: ${text}`);
}

async function openSpawnStream(
	handle: A2aServerHandle,
	messageId: string,
	contextId?: string,
): Promise<{ response: Response; sse: SseReader }> {
	const response = await fetch(handle.url, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 40,
			method: "SendStreamingMessage",
			params: {
				message: {
					messageId,
					role: "ROLE_USER",
					parts: [{ text: "start late" }],
					...(contextId !== undefined ? { contextId } : {}),
				},
			},
		}),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	return { response, sse: openSse(response) };
}

const sendPending = (messageId: string, contextId?: string) => ({
	jsonrpc: "2.0",
	id: 41,
	method: "SendMessage",
	params: {
		message: {
			messageId,
			role: "ROLE_USER",
			parts: [{ text: "start late" }],
			...(contextId !== undefined ? { contextId } : {}),
		},
	},
});

describe("A2A pending spawn lifecycle", () => {
	function pendingServer(id: string, refs: AgentRef[] = [], options?: { streamPollMs?: number }) {
		const registration = Promise.withResolvers<AgentRef>();
		const registry = new FakeRegistry(refs);
		const events: RegistryEvent[] = [];
		registry.onChange(event => events.push(event));
		const started = startServer({
			registry,
			spawn: async () => {
				throw new SpawnPendingError(id, registration.promise);
			},
			...(options?.streamPollMs !== undefined ? { streamPollMs: options.streamPollMs } : {}),
		});
		return { registration, events, ...started, registry };
	}

	it("keeps an unresolved registration SUBMITTED in every view past 30 seconds", async () => {
		const started = Date.now();
		const id = "Spawn-late";
		const { handle } = pendingServer(id, [
			makeRef({ id: "alpha", createdAt: started - 1_000, status: "running" }),
			makeRef({ id: "gamma", createdAt: started + 1_000, status: "idle" }),
		]);
		setSystemTime(started);
		let sse: SseReader | undefined;
		try {
			const sent = await rpc(handle, sendPending("m-pending", "ctx-pending"));
			const submitted = taskResult(sent.json);
			expect(submitted.id).toBe(id);
			expect(submitted.status.state).toBe(TASK_STATE.SUBMITTED);
			expect(submitted.contextId).toBe("ctx-pending");
			const submittedAt = submitted.status.timestamp;
			expect(submittedAt).toBe(new Date(started).toISOString());

			setSystemTime(started + 31_000);
			const got = rpcTask((await rpc(handle, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id } })).json);
			expect(got).toMatchObject({
				id,
				contextId: "ctx-pending",
				status: { state: TASK_STATE.SUBMITTED, timestamp: submittedAt },
			});

			const filtered = listResult(
				(
					await rpc(handle, {
						jsonrpc: "2.0",
						id: 3,
						method: "ListTasks",
						params: { contextId: "ctx-pending", status: TASK_STATE.SUBMITTED },
					})
				).json,
			);
			expect(filtered.tasks.map(task => task.id)).toEqual([id]);
			expect(filtered.tasks[0]?.status).toMatchObject({ state: TASK_STATE.SUBMITTED, timestamp: submittedAt });

			const otherContext = listResult(
				(
					await rpc(handle, {
						jsonrpc: "2.0",
						id: 4,
						method: "ListTasks",
						params: { contextId: "ctx-other" },
					})
				).json,
			);
			expect(otherContext.tasks).toEqual([]);

			const page = listResult(
				(await rpc(handle, { jsonrpc: "2.0", id: 5, method: "ListTasks", params: { pageSize: 2 } })).json,
			);
			expect(page.tasks.map(task => task.id)).toEqual(["alpha", id]);
			expect(page.nextPageToken).toBe("2");
			expect(page.totalSize).toBe(3);
			const rest = listResult(
				(
					await rpc(handle, {
						jsonrpc: "2.0",
						id: 6,
						method: "ListTasks",
						params: { pageSize: 2, pageToken: page.nextPageToken },
					})
				).json,
			);
			expect(rest.tasks.map(task => task.id)).toEqual(["gamma"]);

			sse = (await openSpawnStream(handle, "m-stream", "ctx-stream")).sse;
			await sse.until(text => text.includes('"result":{"task"'));
			const streamed = initialSseTask(sse.text);
			expect(streamed.status.state).toBe(TASK_STATE.SUBMITTED);
			const streamedGot = rpcTask(
				(await rpc(handle, { jsonrpc: "2.0", id: 7, method: "GetTask", params: { id: streamed.id } })).json,
			);
			expect(streamedGot.status.state).toBe(TASK_STATE.SUBMITTED);
			expect(streamedGot.status.timestamp).toBe(streamed.status.timestamp);

			setSystemTime(started + 62_000);
			// Bun.serve already armed the SSE poll on the real clock. Fake timers
			// would freeze that interval and the open fetch, so this waits out a few
			// 20ms polls after the clock jump instead of advancing a fake clock.
			const grace = Promise.withResolvers<boolean>();
			const graceTimer = setTimeout(() => grace.resolve(false), 80);
			const ended = await Promise.race([
				sse.toEnd().then(
					() => true,
					() => true,
				),
				grace.promise,
			]);
			clearTimeout(graceTimer);
			expect(ended).toBe(false);
			expect(sse.text).not.toContain("TASK_STATE_FAILED");
			const still = rpcTask((await rpc(handle, { jsonrpc: "2.0", id: 8, method: "GetTask", params: { id } })).json);
			expect(still.status).toMatchObject({ state: TASK_STATE.SUBMITTED, timestamp: submittedAt });
		} finally {
			sse?.cancel();
			setSystemTime();
		}
	});

	it("publishes the registered ref in every view once, without a duplicate row", async () => {
		const id = "Spawn-late";
		const { handle, registration, registry } = pendingServer(id, [
			makeRef({ id: "alpha", createdAt: 1_000, status: "running" }),
		]);
		const sse = (await openSpawnStream(handle, "m-resolve", "ctx-pending")).sse;
		try {
			await sse.until(text => text.includes("TASK_STATE_SUBMITTED"));
			const sent = await rpc(handle, sendPending("m-send", "ctx-pending"));
			expect(taskResult(sent.json).status.state).toBe(TASK_STATE.SUBMITTED);

			// The seam resolves its promise only once the registry holds the
			// ref, so the legitimate resolution registers before settling.
			const ref = makeRef({ id, status: "running", createdAt: 1_500, activity: "booting" });
			registry.insert(ref);
			registration.resolve(ref);
			await registration.promise;

			const got = rpcTask((await rpc(handle, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id } })).json);
			expect(got.status.state).toBe(TASK_STATE.WORKING);
			expect(got.contextId).toBe("ctx-pending");
			await sse.until(text => text.includes("TASK_STATE_WORKING"));
			const listed = listResult(
				(await rpc(handle, { jsonrpc: "2.0", id: 3, method: "ListTasks", params: {} })).json,
			);
			expect(listed.tasks.filter(task => task.id === id)).toHaveLength(1);
			expect(listed.tasks.find(task => task.id === id)?.status.state).toBe(TASK_STATE.WORKING);
			expect(listed.tasks.map(task => task.id)).toEqual(["alpha", id]);
		} finally {
			sse.cancel();
		}
	});

	it("fails every view with the registration error and one final SSE update, without a registry event", async () => {
		const id = "Spawn-late";
		const { handle, registration, events } = pendingServer(id, [], { streamPollMs: 60_000 });
		const sse = (await openSpawnStream(handle, "m-fail", "ctx-pending")).sse;
		try {
			await sse.until(text => text.includes("TASK_STATE_SUBMITTED"));
			registration.reject(new Error("registration failed"));
			await expect(registration.promise).rejects.toThrow("registration failed");

			const got = rpcTask((await rpc(handle, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id } })).json);
			expect(got.contextId).toBe("ctx-pending");
			expect(got.status.state).toBe(TASK_STATE.FAILED);
			expect(got.status.message?.parts[0]?.text).toBe("registration failed");
			await sse.toEnd();
			const failedUpdates = sseStatusUpdates(sse.text).filter(update => update.state === TASK_STATE.FAILED);
			expect(failedUpdates).toEqual([{ state: TASK_STATE.FAILED, final: true, reason: "registration failed" }]);
			expect(events).toEqual([]);
			const listed = listResult(
				(
					await rpc(handle, {
						jsonrpc: "2.0",
						id: 3,
						method: "ListTasks",
						params: { contextId: "ctx-pending", status: TASK_STATE.FAILED },
					})
				).json,
			);
			expect(listed.tasks.map(task => task.status.message?.parts[0]?.text)).toEqual(["registration failed"]);
		} finally {
			sse.cancel();
		}
	});

	it("records a pending cancel and aborts only that generation after registration", async () => {
		const id = "Spawn-late";
		let aborts = 0;
		const owned = makeRef({
			id,
			status: "running",
			createdAt: 1_500,
			session: { abort: async () => void (aborts += 1) } as never,
		});
		const { handle, registration, registry } = pendingServer(id, [
			makeRef({ id: "Main", kind: "main", status: "running" }),
		]);
		const sse = (await openSpawnStream(handle, "m-cancel", "ctx-pending")).sse;
		try {
			await sse.until(text => text.includes("TASK_STATE_SUBMITTED"));
			const refused = await rpc(handle, { jsonrpc: "2.0", id: 9, method: "CancelTask", params: { id: "Main" } });
			expect(errorResult(refused.json).code).toBe(RPC_ERRORS.TASK_NOT_CANCELABLE);

			const canceled = rpcTask(
				(await rpc(handle, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id } })).json,
			);
			expect(canceled.status.state).toBe(TASK_STATE.SUBMITTED);
			expect(aborts).toBe(0);
			expect(sse.text).not.toContain('"final":true');

			registry.insert(owned);
			registration.resolve(owned);
			await registration.promise;
			await sse.until(text => text.includes("TASK_STATE_CANCELED"));
			expect(aborts).toBe(1);
			await sse.toEnd();
			const updates = sseStatusUpdates(sse.text);
			expect(updates.filter(update => update.state === TASK_STATE.CANCELED && update.final)).toHaveLength(1);

			const got = rpcTask((await rpc(handle, { jsonrpc: "2.0", id: 3, method: "GetTask", params: { id } })).json);
			expect(got.status.state).toBe(TASK_STATE.CANCELED);
			const listed = listResult(
				(await rpc(handle, { jsonrpc: "2.0", id: 4, method: "ListTasks", params: { contextId: "ctx-pending" } }))
					.json,
			);
			expect(listed.tasks.map(task => task.status.state)).toEqual([TASK_STATE.CANCELED]);
		} finally {
			sse.cancel();
		}
	});

	it("fails a pending cancel when registration rejects and never aborts a same-id replacement", async () => {
		const id = "Spawn-late";
		let ownedAborts = 0;
		let replacementAborts = 0;
		const owned = makeRef({
			id,
			status: "running",
			session: { abort: async () => void (ownedAborts += 1) } as never,
		});
		const replacement = makeRef({
			id,
			status: "running",
			session: { abort: async () => void (replacementAborts += 1) } as never,
		});
		const rejected = pendingServer(id);
		await rpc(rejected.handle, sendPending("m-reject", "ctx-pending"));
		const canceled = rpcTask(
			(await rpc(rejected.handle, { jsonrpc: "2.0", id: 1, method: "CancelTask", params: { id } })).json,
		);
		expect(canceled.status.state).toBe(TASK_STATE.SUBMITTED);
		rejected.registration.reject(new Error("registration failed"));
		await expect(rejected.registration.promise).rejects.toThrow("registration failed");
		const failed = rpcTask(
			(await rpc(rejected.handle, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id } })).json,
		);
		expect(failed.status.state).toBe(TASK_STATE.FAILED);
		expect(failed.status.message?.parts[0]?.text).toBe("registration failed");
		expect(ownedAborts).toBe(0);

		const replaced = pendingServer(id);
		await rpc(replaced.handle, sendPending("m-replace", "ctx-pending"));
		const pendingCancel = rpcTask(
			(await rpc(replaced.handle, { jsonrpc: "2.0", id: 3, method: "CancelTask", params: { id } })).json,
		);
		expect(pendingCancel.status.state).toBe(TASK_STATE.SUBMITTED);
		replaced.registry.insert(replacement);
		replaced.registration.resolve(owned);
		await replaced.registration.promise;
		expect(replacementAborts).toBe(0);
		// A settlement to a ref the registry no longer holds is the removal
		// transition: the pending cancel dies with the discarded row and
		// aborts neither the replacement nor the removed generation.
		expect(ownedAborts).toBe(0);
		expect(replaced.registry.get(id)?.status).toBe("running");
		const live = rpcTask(
			(await rpc(replaced.handle, { jsonrpc: "2.0", id: 4, method: "GetTask", params: { id } })).json,
		);
		expect(live.status.state).toBe(TASK_STATE.WORKING);
	});

	it("drops a resolved spawn from every view when its exact ref is unregistered", async () => {
		const id = "Spawn-late";
		const { handle, registration, registry } = pendingServer(id, [
			makeRef({ id: "alpha", createdAt: 1_000, status: "running" }),
		]);
		const ref = makeRef({ id, status: "running", createdAt: 1_500, activity: "booting" });
		const sse = (await openSpawnStream(handle, "m-evict", "ctx-pending")).sse;
		try {
			await sse.until(text => text.includes("TASK_STATE_SUBMITTED"));
			// The seam resolves its promise only once the registry holds the ref.
			registry.insert(ref);
			registration.resolve(ref);
			await registration.promise;
			await sse.until(text => text.includes("TASK_STATE_WORKING"));

			expect(registry.unregister(id)).toBe(true);
			const missing = await rpc(handle, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id } });
			expect(errorResult(missing.json).code).toBe(RPC_ERRORS.TASK_NOT_FOUND);
			const listed = listResult(
				(await rpc(handle, { jsonrpc: "2.0", id: 3, method: "ListTasks", params: {} })).json,
			);
			expect(listed.tasks.map(task => task.id)).toEqual(["alpha"]);
			await sse.toEnd();
			expect(
				sseStatusUpdates(sse.text).filter(update => update.state === TASK_STATE.FAILED && update.final),
			).toHaveLength(1);
		} finally {
			sse.cancel();
		}
	});

	it("cancels the resolved generation when a stale ref occupied the id at SendMessage", async () => {
		const id = "Spawn-late";
		let staleAborts = 0;
		let ownedAborts = 0;
		const stale = makeRef({
			id,
			status: "idle",
			createdAt: 1_000,
			session: { abort: async () => void (staleAborts += 1) } as never,
		});
		const owned = makeRef({
			id,
			status: "running",
			createdAt: 2_000,
			session: { abort: async () => void (ownedAborts += 1) } as never,
		});
		const { handle, registration, registry } = pendingServer(id, [stale]);
		await rpc(handle, sendPending("m-stale", "ctx-pending"));
		registry.insert(owned);
		registration.resolve(owned);
		await registration.promise;

		const canceled = rpcTask(
			(await rpc(handle, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id } })).json,
		);
		expect(canceled.status.state).toBe(TASK_STATE.CANCELED);
		expect(ownedAborts).toBe(1);
		expect(staleAborts).toBe(0);
		expect(registry.get(id)?.status).toBe("aborted");
	});

	it("registration removed in the same turn never reappears through pending snapshot", async () => {
		const id = "Spawn-late";
		const { handle, registration, registry } = pendingServer(id, [
			makeRef({ id: "alpha", createdAt: 1_000, status: "running" }),
		]);
		const ref = makeRef({ id, status: "running", createdAt: 1_500, activity: "booting" });
		const sse = (await openSpawnStream(handle, "m-same-turn", "ctx-pending")).sse;
		try {
			await sse.until(text => text.includes("TASK_STATE_SUBMITTED"));
			const sent = await rpc(handle, sendPending("m-send", "ctx-pending"));
			expect(taskResult(sent.json).status.state).toBe(TASK_STATE.SUBMITTED);

			// The exact ref registers and is removed before the registration
			// promise's `.then` callback runs: the ledger must not resolve the
			// pending row into the removed generation.
			registry.insert(ref);
			registration.resolve(ref);
			expect(registry.unregister(id)).toBe(true);
			await registration.promise;

			const missing = await rpc(handle, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id } });
			expect(errorResult(missing.json).code).toBe(RPC_ERRORS.TASK_NOT_FOUND);
			const listed = listResult(
				(await rpc(handle, { jsonrpc: "2.0", id: 3, method: "ListTasks", params: {} })).json,
			);
			expect(listed.tasks.map(task => task.id)).toEqual(["alpha"]);
			await sse.toEnd();
			expect(
				sseStatusUpdates(sse.text).filter(update => update.state === TASK_STATE.FAILED && update.final),
			).toHaveLength(1);
		} finally {
			sse.cancel();
		}
	});

	it("pending cancel cannot affect replacement registered before promise settlement", async () => {
		const id = "Spawn-late";
		let oldAborts = 0;
		let replacementAborts = 0;
		const old = makeRef({
			id,
			status: "running",
			createdAt: 1_500,
			session: { abort: async () => void (oldAborts += 1) } as never,
		});
		const replacement = makeRef({
			id,
			status: "running",
			createdAt: 2_000,
			activity: "replacement work",
			session: { abort: async () => void (replacementAborts += 1) } as never,
		});
		const { handle, registration, registry } = pendingServer(id, []);
		const sse = (await openSpawnStream(handle, "m-replace-cancel", "ctx-pending")).sse;
		try {
			await sse.until(text => text.includes("TASK_STATE_SUBMITTED"));
			const canceled = rpcTask(
				(await rpc(handle, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id } })).json,
			);
			expect(canceled.status.state).toBe(TASK_STATE.SUBMITTED);

			// The registered old generation is removed and a distinct
			// replacement ref takes the id, all before the promise settles.
			registry.insert(old);
			registration.resolve(old);
			expect(registry.unregister(id)).toBe(true);
			registry.insert(replacement);
			await registration.promise;

			expect(oldAborts).toBe(0);
			expect(replacementAborts).toBe(0);
			expect(registry.get(id)).toBe(replacement);
			expect(registry.get(id)?.status).toBe("running");

			const got = rpcTask((await rpc(handle, { jsonrpc: "2.0", id: 3, method: "GetTask", params: { id } })).json);
			expect(got.status.state).toBe(TASK_STATE.WORKING);
			expect(got.status.message?.parts[0]?.text).toBe("replacement work");
			const listed = listResult(
				(await rpc(handle, { jsonrpc: "2.0", id: 4, method: "ListTasks", params: {} })).json,
			);
			expect(listed.tasks.map(task => task.id)).toEqual([id]);
			expect(listed.tasks[0]?.status.state).toBe(TASK_STATE.WORKING);
			// A pending cancel that resolved to a removed generation must not
			// linger and must not transfer: the id left the bridge's ownership
			// with the discarded row, so a fresh CancelTask refuses instead of
			// aborting a replacement ref the bridge never created.
			const refused = await rpc(handle, { jsonrpc: "2.0", id: 5, method: "CancelTask", params: { id } });
			expect(errorResult(refused.json).code).toBe(RPC_ERRORS.TASK_NOT_CANCELABLE);
			expect(oldAborts).toBe(0);
			expect(replacementAborts).toBe(0);
			expect(registry.get(id)?.status).toBe("running");
			// The live replacement owns the stream: no removal-style terminal
			// failure may be minted for it.
			expect(sse.text).not.toContain('"final":true');
		} finally {
			sse.cancel();
		}
	});
});

describe("A2A agent card discovery", () => {
	it("serves discovery descriptions and never AgentDefinition system prompts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-a2a-card-"));
		try {
			const registry = new FakeRegistry([
				makeRef({ id: "leaky", displayName: "Leaky Agent", kind: "sub", status: "running" }),
			]);
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
			if (process.platform !== "win32") {
				const stat = await fs.stat(file);
				expect(stat.mode & 0o777).toBe(0o600);
			}
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
	it("writes one per-process file with an instanceId mirrored on the card, and ignores the old single-file format", async () => {
		const { readLiveBridges, readLocalBridgeEntry, autoA2aName } =
			await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-reg-"));
		try {
			const handle = await startA2aServer({
				settings: Settings.isolated(),
				agentDir,
				port: 0,
				registry: new FakeRegistry([makeRef({ id: "Main", kind: "main" })]).asApi(),
				bus: new FakeBus(),
			});
			handles.push(handle);
			const file = path.join(agentDir, "a2a-bridges", `${process.pid}.json`);
			const entry = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
			expect(entry.pid).toBe(process.pid);
			expect(entry.port).toBe(handle.port);
			expect(typeof entry.instanceId).toBe("string");
			expect((entry.instanceId as string).length).toBeGreaterThan(0);
			// A1: no a2a.name -> a unique, skill-id-safe auto name used for the
			// card, the main skill, and the registry entry alike.
			const card = (await (await fetch(`${handle.url}${AGENT_CARD_PATH}`)).json()) as {
				name: string;
				instanceId?: string;
				skills: Array<{ id: string }>;
			};
			expect(card.name).toBe(autoA2aName(process.cwd()));
			expect(card.name).toMatch(/^[a-z0-9-]+-\d+$/);
			expect(entry.name).toBe(card.name);
			expect(card.instanceId).toBe(entry.instanceId as string);
			expect(card.skills.map(skill => skill.id)).toContain(card.name);
			expect(await readLocalBridgeEntry(agentDir, process.pid)).toMatchObject({
				pid: process.pid,
				port: handle.port,
			});
			// Self is never registered as its own peer.
			expect((await readLiveBridges(agentDir)).size).toBe(0);
			// A stale single-file registry is neither written nor read.
			await expect(fs.stat(path.join(agentDir, "a2a-bridges.json"))).rejects.toThrow();
			await fs.writeFile(
				path.join(agentDir, "a2a-bridges.json"),
				JSON.stringify([{ pid: process.ppid, port: 9999, startedAt: 1 }]),
			);
			expect((await readLiveBridges(agentDir, { excludePid: -1 })).size).toBe(1);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps concurrent per-process registrations and drops only the stopped bridge", async () => {
		const { registerLocalBridge, unregisterLocalBridge, readLiveBridges, readLocalBridgeEntry } =
			await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-reg-multi-"));
		try {
			const pidA = process.ppid;
			const pidB = process.pid;
			await Promise.all([
				registerLocalBridge({ agentDir, pid: pidA, port: 7601, name: "peer-a", instanceId: "id-a" }),
				registerLocalBridge({ agentDir, pid: pidB, port: 7602, name: "peer-b", instanceId: "id-b" }),
			]);
			// Both writes land: the old read-modify-write single file lost one.
			expect(await readLocalBridgeEntry(agentDir, pidA)).toMatchObject({
				pid: pidA,
				port: 7601,
				instanceId: "id-a",
			});
			expect(await readLocalBridgeEntry(agentDir, pidB)).toMatchObject({
				pid: pidB,
				port: 7602,
				instanceId: "id-b",
			});
			expect((await readLiveBridges(agentDir, { excludePid: -1 })).size).toBe(2);
			// Shutdown removes only the stopping bridge's own file.
			await unregisterLocalBridge(agentDir, pidA);
			expect(await readLocalBridgeEntry(agentDir, pidA)).toBeUndefined();
			expect((await readLiveBridges(agentDir, { excludePid: -1 })).size).toBe(1);
			// A dead pid entry is pruned on read, not returned as a live peer.
			await fs.writeFile(
				path.join(agentDir, "a2a-bridges", "999999.json"),
				JSON.stringify({ pid: 999999, port: 1234, startedAt: 1 }),
			);
			expect((await readLiveBridges(agentDir, { excludePid: -1 })).size).toBe(1);
			await expect(fs.stat(path.join(agentDir, "a2a-bridges", "999999.json"))).rejects.toThrow();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects live registry files without an instance id", async () => {
		const { readLiveBridges, readLocalBridgeEntry } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-reg-invalid-"));
		try {
			await fs.mkdir(path.join(agentDir, "a2a-bridges"));
			await fs.writeFile(
				path.join(agentDir, "a2a-bridges", `${process.pid}.json`),
				JSON.stringify({ pid: process.pid, port: 7601, startedAt: 1 }),
			);
			expect(await readLocalBridgeEntry(agentDir, process.pid)).toBeUndefined();
			expect((await readLiveBridges(agentDir, { excludePid: -1 })).size).toBe(0);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("does not remove a newer bridge entry when an older server stops", async () => {
		const { readLocalBridgeEntry } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-replacement-"));
		try {
			const options = {
				settings: Settings.isolated(),
				agentDir,
				port: 0,
				registry: new FakeRegistry().asApi(),
				bus: new FakeBus(),
			};
			const old = await startA2aServer(options);
			const current = await startA2aServer(options);
			handles.push(old, current);
			old.stop();
			expect((await readLocalBridgeEntry(agentDir, process.pid))?.port).toBe(current.port);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("publishes the registered instance id even with a custom card", async () => {
		const { readLocalBridgeEntry } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-custom-card-"));
		try {
			const handle = await startA2aServer({
				settings: Settings.isolated(),
				agentDir,
				port: 0,
				registry: new FakeRegistry().asApi(),
				bus: new FakeBus(),
				card: () => buildAgentCard({ url: "http://127.0.0.1/", version: "1", skills: [] }),
			});
			handles.push(handle);
			const entry = await readLocalBridgeEntry(agentDir, process.pid);
			const card = (await (await fetch(`${handle.url}${AGENT_CARD_PATH}`)).json()) as { instanceId?: string };
			expect(entry?.instanceId).toBeDefined();
			expect(card.instanceId).toBe(entry?.instanceId);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("addresses Main by the auto-generated public identity when no a2a.name is set", async () => {
		const { autoA2aName } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-reg-alias-"));
		try {
			const bus = new FakeBus();
			const registry = new FakeRegistry([makeRef({ id: "Main", kind: "main", status: "running" })]);
			const handle = await startA2aServer({
				settings: Settings.isolated(),
				agentDir,
				port: 0,
				registry: registry.asApi(),
				bus,
			});
			handles.push(handle);
			const { json } = await rpc(
				handle,
				{
					jsonrpc: "2.0",
					id: 1,
					method: "SendMessage",
					params: {
						message: { messageId: "alias-1", role: "ROLE_USER", parts: [{ text: "ping" }] },
						metadata: { to: autoA2aName(process.cwd()) },
					},
				},
				await resolveA2aToken({ agentDir }),
			);
			expect(taskResult(json).id).toBe("Main");
			expect(bus.sent).toHaveLength(1);
			expect(bus.sent[0]!.to).toBe("Main");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("accepts port 0 and reports the bound port", () => {
		const result = parseArgs(["--a2a-port", "0"]);
		expect(result.a2aPort).toBe(0);
	});
});

describe("A2A incoming request cleanup", () => {
	const REQUEST = (to: string, messageId: string, at: number) => ({ to, from: "peer", messageId, at });

	it("startA2aServer expires and removes requests on the injected ledger", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-cleanup-"));
		try {
			const incoming = new IncomingRequests();
			const registry = new FakeRegistry([makeRef({ id: "Main", kind: "main", status: "running" })]);
			const handle = await startA2aServer({
				settings: Settings.isolated({ "a2a.replyTimeoutMs": 50 }),
				agentDir: dir,
				port: 0,
				registry: registry.asApi(),
				bus: new FakeBus(),
				incoming,
			});
			handles.push(handle);
			vi.useFakeTimers();
			setSystemTime(100);
			try {
				// Same absolute `at` for both: a lease claim must not reset the
				// recipient's reply deadline.
				await incoming.note(REQUEST("Main", "open", 100));
				await incoming.note(REQUEST("Main", "held", 100));
				const held = await incoming.consume({ to: "Main", messageId: "held" }, "w1");
				vi.advanceTimersByTime(49);
				expect(Date.now()).toBe(149);
				expect((await incoming.list("Main")).map(request => request.messageId)).toEqual(["open"]);
				vi.advanceTimersByTime(1);
				await Promise.resolve();
				expect(Date.now()).toBe(150);
				expect(await incoming.list()).toEqual([]);
				// Late settlement of the expired lease settles nothing.
				expect(await incoming.release(held!.leaseId, "w1")).toBe(false);
				expect(await incoming.confirm(held!.leaseId, "w1")).toBe(false);
				// Removal of the recipient discards its whole queue on the
				// same injected ledger, without touching another recipient.
				await incoming.note(REQUEST("Main", "late", 150));
				await incoming.note(REQUEST("Other", "kept", 150));
				registry.unregister("Main");
				expect(await incoming.list()).toEqual([REQUEST("Other", "kept", 150)]);
			} finally {
				vi.useRealTimers();
				setSystemTime();
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("a bridge whose startup fails after cleanup installation stops the cleanup", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-cleanup-fail-"));
		try {
			const incoming = new IncomingRequests();
			let removals = 0;
			const registry = new FakeRegistry([makeRef({ id: "Main", kind: "main", status: "running" })]);
			registry.onChange(event => {
				if (event.type === "removed") removals += 1;
			});
			// A non-loopback bind makes `createA2aServer` throw after
			// `startA2aServer` already installed cleanup on the ledger.
			await expect(
				startA2aServer({
					settings: Settings.isolated({ "a2a.replyTimeoutMs": 50 }),
					agentDir: dir,
					host: "0.0.0.0",
					port: 0,
					registry: registry.asApi(),
					bus: new FakeBus(),
					incoming,
				}),
			).rejects.toThrow(/127\.0\.0\.1/);
			// The failed bridge's cleanup is gone: a later removal and time
			// advancement on that registry/ledger pair touch nothing.
			const notedAt = Date.now();
			await incoming.note(REQUEST("Main", "kept", notedAt));
			registry.unregister("Main");
			expect(removals).toBe(1);
			vi.useFakeTimers();
			try {
				// Advancing 60 s past a 50 ms timeout on the same ledger must
				// not expire the request: the failed bridge's cleanup is gone.
				vi.advanceTimersByTime(60_000);
				await Promise.resolve();
				expect(Date.now() - notedAt).toBeGreaterThan(50);
				expect((await incoming.list("Main")).map(request => request.messageId)).toEqual(["kept"]);
			} finally {
				vi.useRealTimers();
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("A2A reply envelope", () => {
	it("delivers the task with a reply-back instruction when metadata.from is present", async () => {
		const bodies: string[] = [];
		const handle = createA2aServer({
			token: "reply-token",
			port: 0,
			registry: {
				list: () => [],
				get: id => (id === "Main" ? makeRef({ id: "Main", displayName: "Main", status: "running" }) : undefined),
				onChange: () => () => {},
				setStatus: () => false,
			},
			bus: {
				send: async (message: { to: string; body: string }) => {
					bodies.push(message.body);
					return { to: message.to, outcome: "injected" as const };
				},
			} as never,
			spawn: async () => {
				throw new Error("spawn must not run for an addressed send");
			},
			card: async () =>
				buildAgentCard({
					url: "http://127.0.0.1:1/",
					version: "t",
					skills: [],
				}),
		});
		handles.push(handle);
		const response = await fetch(handle.url + "/", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer reply-token" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "SendMessage",
				params: {
					message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "do the thing" }] },
					metadata: { to: "Main", from: "alpha", fromUrl: "http://127.0.0.1:7531/" },
				},
			}),
		});
		const payload = (await response.json()) as { result?: { task?: { metadata?: Record<string, unknown> } } };
		expect(payload.result?.task?.metadata?.delivery).toMatchObject({ outcome: "injected" });
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain("[A2A task from peer terminal alpha");
		expect(bodies[0]).toContain("spawning the agent a2a:alpha");
		expect(bodies[0]).toContain("do the thing");
	});

	it("delivers the raw text when no sender identity is given", async () => {
		const bodies: string[] = [];
		const handle = createA2aServer({
			token: "reply-token-2",
			port: 0,
			registry: {
				list: () => [],
				get: id => (id === "Main" ? makeRef({ id: "Main", displayName: "Main", status: "running" }) : undefined),
				onChange: () => () => {},
				setStatus: () => false,
			},
			bus: {
				send: async (message: { to: string; body: string }) => {
					bodies.push(message.body);
					return { to: message.to, outcome: "injected" as const };
				},
			} as never,
			card: async () => buildAgentCard({ url: "http://127.0.0.1:1/", version: "t", skills: [] }),
		});
		handles.push(handle);
		await fetch(handle.url + "/", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer reply-token-2" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "SendMessage",
				params: {
					message: { messageId: "m2", role: "ROLE_USER", parts: [{ text: "plain text" }] },
					metadata: { to: "Main" },
				},
			}),
		});
		expect(bodies).toEqual(["plain text"]);
	});

	it("labels metadata.inReplyTo as a reply without a new envelope or outstanding request", async () => {
		const bodies: string[] = [];
		const answers: Array<string | undefined> = [];
		const incoming = new IncomingRequests();
		const handle = createA2aServer({
			token: "reply-token-3",
			port: 0,
			incoming,
			registry: {
				list: () => [],
				get: id => (id === "Main" ? makeRef({ id: "Main", displayName: "Main", status: "running" }) : undefined),
				onChange: () => () => {},
				setStatus: () => false,
			},
			bus: {
				send: async (message: { to: string; body: string; a2aInReplyTo?: string }) => {
					bodies.push(message.body);
					answers.push(message.a2aInReplyTo);
					return { to: message.to, outcome: "injected" as const };
				},
			} as never,
			card: async () => buildAgentCard({ url: "http://127.0.0.1:1/", version: "t", skills: [] }),
		});
		handles.push(handle);
		const response = await fetch(handle.url + "/", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer reply-token-3" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "SendMessage",
				params: {
					message: { messageId: "m3", role: "ROLE_USER", parts: [{ text: "the answer is 42" }] },
					metadata: { to: "Main", from: "builder", inReplyTo: "request-17" },
				},
			}),
		});
		expect(response.status).toBe(200);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain("[A2A reply to your request request-17");
		expect(bodies[0]).toContain("the answer is 42");
		// No new reply envelope: a reply must not start an unbounded chain.
		expect(bodies[0]).not.toContain("[A2A task from peer terminal");
		expect(bodies[0]).not.toContain("spawning the agent");
		expect(await incoming.list("Main")).toEqual([]);
		// The recipient's footer reads this mark: an answer owes no reply.
		expect(answers).toEqual(["request-17"]);
	});

	it("retains the wire request's fromUrl on the incoming request record", async () => {
		const incoming = new IncomingRequests();
		const handle = createA2aServer({
			token: "reply-token-4",
			port: 0,
			incoming,
			registry: {
				list: () => [],
				get: id => (id === "Main" ? makeRef({ id: "Main", displayName: "Main", status: "running" }) : undefined),
				onChange: () => () => {},
				setStatus: () => false,
			},
			bus: {
				send: async (message: { to: string; body: string }) => {
					expect(message.body).toContain("do the thing");
					return { to: message.to, outcome: "injected" as const };
				},
			} as never,
			card: async () => buildAgentCard({ url: "http://127.0.0.1:1/", version: "t", skills: [] }),
		});
		handles.push(handle);
		const response = await fetch(handle.url + "/", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer reply-token-4" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 4,
				method: "SendMessage",
				params: {
					message: { messageId: "m-url", role: "ROLE_USER", parts: [{ text: "do the thing" }] },
					metadata: { to: "Main", from: "alpha", fromUrl: "http://127.0.0.1:7531/" },
				},
			}),
		});
		expect(response.status).toBe(200);
		// The ledger record carries the actual wire request's fromUrl, so a
		// later automatic reply can pin the originating endpoint.
		expect(await incoming.list("Main")).toEqual([
			{
				from: "alpha",
				messageId: "m-url",
				to: "Main",
				at: expect.any(Number),
				fromUrl: "http://127.0.0.1:7531/",
			},
		]);
		// A claim leases that exact record, fromUrl included.
		const lease = await incoming.consume({ to: "Main", messageId: "m-url" });
		expect(lease?.request.fromUrl).toBe("http://127.0.0.1:7531/");
	});
});

describe("A2A outgoing reply correlation", () => {
	function request(overrides: Partial<OutgoingRequest> = {}): OutgoingRequest {
		return {
			messageId: "req-1",
			peer: "builder",
			ownerId: "owner-a",
			jobId: "job-a",
			deadline: null,
			...overrides,
		};
	}

	function start() {
		const incoming = new IncomingRequests();
		const started = startServer({
			refs: [makeRef({ id: "Main", displayName: "Main Alias", kind: "main", status: "running" })],
			incoming,
		});
		return { ...started, incoming };
	}

	async function sendReply(
		handle: A2aServerHandle,
		metadata: Record<string, unknown>,
		text = "the answer",
	): Promise<{ status: number; json: unknown }> {
		return rpc(handle, {
			jsonrpc: "2.0",
			id: 1,
			method: "SendMessage",
			params: {
				message: { messageId: `reply-${metadata.inReplyTo ?? "none"}`, role: "ROLE_USER", parts: [{ text }] },
				metadata: { to: "Main", ...metadata },
			},
		});
	}

	function deliveryOutcome(json: unknown): string | undefined {
		const payload = json as { result?: { task?: { metadata?: { delivery?: { outcome?: string } } } } };
		return payload.result?.task?.metadata?.delivery?.outcome;
	}

	it("completes a matching terminal-identity reply without an IRC copy", async () => {
		const { handle, bus, incoming } = start();
		await OutgoingRequests.global().register(request());
		const waiting = OutgoingRequests.global().wait("req-1");

		const { status, json } = await sendReply(handle, { from: "builder", inReplyTo: "req-1" }, "exact reply");

		expect(status).toBe(200);
		expect(deliveryOutcome(json)).toBe("injected");
		expect(bus.sent).toEqual([]);
		expect(await incoming.list()).toEqual([]);
		expect(await waiting).toBe("exact reply");
		expect(OutgoingRequests.global().hasOwner("owner-a")).toBe(false);
	});

	it("keeps a wrong sender, missing sender, unknown id, or duplicate on the IRC bus", async () => {
		const { handle, bus, incoming } = start();
		await OutgoingRequests.global().register(request());
		const waiting = OutgoingRequests.global().wait("req-1");

		await sendReply(handle, { from: "Reviewer", inReplyTo: "req-1" }, "skill id");
		await sendReply(handle, { from: "Main Alias", inReplyTo: "req-1" }, "display alias");
		await sendReply(handle, { inReplyTo: "req-1" }, "missing sender");
		await sendReply(handle, { from: "builder", inReplyTo: "unknown-id" }, "unknown id");
		expect(bus.sent.map(message => message.body)).toEqual([
			expect.stringContaining("skill id"),
			expect.stringContaining("display alias"),
			expect.stringContaining("missing sender"),
			expect.stringContaining("unknown id"),
		]);
		expect(await incoming.list()).toEqual([]);
		let settled = false;
		void waiting.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(OutgoingRequests.global().hasOwner("owner-a")).toBe(true);

		const matched = await sendReply(handle, { from: "builder", inReplyTo: "req-1" }, "exact reply");
		expect(deliveryOutcome(matched.json)).toBe("injected");
		expect(bus.sent).toHaveLength(4);
		expect(await waiting).toBe("exact reply");

		await sendReply(handle, { from: "builder", inReplyTo: "req-1" }, "duplicate");
		expect(bus.sent).toHaveLength(5);
		expect(bus.sent[4]?.body).toContain("duplicate");
	});

	it("keeps a timed-out or cancelled reply on the IRC bus", async () => {
		const { handle, bus } = start();
		const registry = OutgoingRequests.global();
		vi.useFakeTimers();
		await registry.register(request({ messageId: "timed", deadline: Date.now() + 15 }));
		await registry.register(request({ messageId: "cancelled", ownerId: "owner-b", jobId: "job-b" }));
		const timed = registry.wait("timed");
		const cancelled = registry.wait("cancelled");
		vi.advanceTimersByTime(15);
		await Promise.resolve();
		await expect(timed).rejects.toThrow("reply timeout");
		expect(await registry.cancel("cancelled")).toBe(true);
		await expect(cancelled).rejects.toThrow("cancelled");
		vi.useRealTimers();

		await sendReply(handle, { from: "builder", inReplyTo: "timed" }, "after timeout");
		await sendReply(handle, { from: "builder", inReplyTo: "cancelled" }, "after cancel");

		expect(bus.sent.map(message => message.body)).toEqual([
			expect.stringContaining("after timeout"),
			expect.stringContaining("after cancel"),
		]);
		expect(registry.hasOwner("owner-a")).toBe(false);
		expect(registry.hasOwner("owner-b")).toBe(false);
	});
});

describe("agent card skill filtering", () => {
	/**
	 * The A2A-1 card contract: Main first, then running, then addressable
	 * kept-alive idle, then revivable parked — each group newest activity
	 * first, id as the tie-breaker. Advisors, aborted agents, completed
	 * one-shot corpses and unrevivable parked refs stay off the card, and
	 * `a2a.maxPeerSkills` cuts AFTER the ordering.
	 */
	it("card orders reachable kept-alive agents before applying maxPeerSkills", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-a2a-order-"));
		try {
			// Distinct lastActivity values pin the newest-first order inside
			// each group; the two parked refs share one to pin the id tie-break.
			const base = Date.now();
			const registry = new FakeRegistry([
				makeRef({ id: "Main", displayName: "Main", kind: "main", status: "running", lastActivity: base }),
				// running group: newest activity first.
				makeRef({ id: "RunOld", displayName: "Run Old", kind: "sub", status: "running", lastActivity: base - 500 }),
				makeRef({ id: "RunNew", displayName: "Run New", kind: "sub", status: "running", lastActivity: base }),
				// kept-alive idle group: a live session makes the ref addressable
				// (IRC wake). A finished turn's published output does NOT retire it.
				makeRef({
					id: "IdleOld",
					kind: "sub",
					status: "idle",
					lastActivity: base - 400,
					session: {} as never,
					history: { outputPath: "/tmp/idle-old-report.md" },
				}),
				makeRef({ id: "IdleNew", kind: "sub", status: "idle", lastActivity: base, session: {} as never }),
				// supported parked: a transcript the persisted factory can revive.
				makeRef({
					id: "ParkedNew",
					kind: "sub",
					status: "parked",
					lastActivity: base - 300,
					sessionFile: path.join(dir, "ParkedNew.jsonl"),
				}),
				makeRef({
					id: "ParkedOld",
					kind: "sub",
					status: "parked",
					lastActivity: base - 300,
					sessionFile: path.join(dir, "ParkedOld.jsonl"),
				}),
				// unsupported parked: no transcript to revive from.
				makeRef({ id: "ParkedDead", kind: "sub", status: "parked", lastActivity: base }),
				// excluded kinds and terminal corpses.
				makeRef({ id: "AdvisorX", kind: "advisor", status: "idle", lastActivity: base }),
				makeRef({ id: "AbortedX", kind: "sub", status: "aborted", lastActivity: base }),
				// completed one-shot corpse: idle with no live session and a
				// published output — finished, not kept alive, not wakeable.
				makeRef({
					id: "OneShot",
					kind: "sub",
					status: "idle",
					lastActivity: base,
					lifecycle: { terminalAt: base },
					history: { outputPath: "/tmp/one-shot.md" },
				}),
			]);
			// A lifecycle managing this registry proves actual parked revive
			// capability: its persisted factory builds a reviver exactly for
			// refs that carry a session file.
			const lifecycle = new AgentLifecycleManager(registry.asApi());
			lifecycle.setPersistedSubagentReviverFactory(
				ref =>
					ref.sessionFile ? Promise.resolve(async () => ({}) as AgentSessionHandle) : Promise.resolve(undefined),
				() => 0,
			);
			const startCardServer = async (settings: Settings): Promise<A2aServerHandle> => {
				const handle = await startA2aServer({
					settings,
					agentDir: dir,
					port: 0,
					name: "Main",
					registry: registry.asApi(),
					bus: new FakeBus(),
					lifecycle,
				});
				handles.push(handle);
				return handle;
			};
			const cardSkills = async (handle: A2aServerHandle): Promise<Array<{ id: string }>> => {
				const body = (await (await fetch(`${handle.url}${AGENT_CARD_PATH}`)).json()) as {
					skills: Array<{ id: string }>;
				};
				return body.skills;
			};
			// Default cap (8) keeps the full ordered roster: Main, running by
			// newest activity, kept-alive idle, then supported parked by id.
			const full = await startCardServer(Settings.isolated());
			expect((await cardSkills(full)).map(skill => skill.id)).toEqual([
				"Main",
				"RunNew",
				"RunOld",
				"IdleNew",
				"IdleOld",
				"ParkedNew",
				"ParkedOld",
			]);
			// The public card carries only skill fields: no transcript paths,
			// no output artifacts, no prompts.
			const text = JSON.stringify(await (await fetch(`${full.url}${AGENT_CARD_PATH}`)).json());
			expect(text).not.toContain(dir);
			expect(text).not.toContain("/tmp/one-shot.md");
			expect(text).not.toContain("sessionFile");
			expect(text).not.toContain("outputPath");
			expect(text).not.toContain("systemPrompt");
			// A cap below the roster size cuts AFTER the ordering, across
			// status groups: the newest groups survive, the rest fall off.
			const capped = await startCardServer(Settings.isolated({ "a2a.maxPeerSkills": 4 }));
			expect((await cardSkills(capped)).map(skill => skill.id)).toEqual(["Main", "RunNew", "RunOld", "IdleNew"]);
			// A peer registering from that capped card sees the same capped
			// order through the registration cap as defense in depth.
			const bridge = new A2aAgentBridge();
			await addA2aAgentsFromUrl({ bridge, url: capped.url, token: TOKEN, maxPeerSkills: 4 });
			expect(bridge.list().map(agent => agent.skillId)).toEqual(["Main", "RunNew", "RunOld", "IdleNew"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("a2a addressed delivery to reachable idle and parked agents", () => {
	/**
	 * One idle kept-alive child behind a REAL bus and IRC bridge: the ref's
	 * session delegates `deliverIrcMessage` to an `IrcBridge` host that wakes
	 * a turn, so the A2A → IRC → wake path is exercised end-to-end.
	 */
	function idleChildHarness() {
		const woken: CustomMessage[][] = [];
		const bridge = new IrcBridge({
			isDisposed: () => false,
			isStreaming: () => false,
			planModeEnabled: () => false,
			hasWakeRelay: () => true,
			emitSessionEvent: async () => {},
			wakeForIrc: (records: AgentMessage[]) => {
				woken.push(records as CustomMessage[]);
			},
		} as never);
		const session = {
			deliverIrcMessage: async (msg: IrcMessage) => bridge.deliver(msg),
		};
		return { bridge, session, woken };
	}

	it("a2a addressed delivery wakes the idle kept-alive agent", async () => {
		const { session, woken } = idleChildHarness();
		const registry = new FakeRegistry([
			makeRef({ id: "Main", kind: "main", status: "idle" }),
			makeRef({
				id: "IdleChild",
				kind: "sub",
				status: "idle",
				session: session as never,
				// A finished turn's published output must not retire the ref.
				history: { outputPath: "/tmp/idle-child.md" },
			}),
		]);
		const spawnCalls: SpawnSubagentOptions[] = [];
		// A real bus: its #deliver resolves the ref, finds the live session,
		// and calls deliverIrcMessage, which wakes through the IRC bridge.
		const bus = new IrcBus(registry.asApi(), undefined, { settings: Settings.isolated({}) });
		const handle = createA2aServer({
			token: TOKEN,
			port: 0,
			registry: registry.asApi(),
			bus,
			spawn: async options => {
				spawnCalls.push(options);
				throw new Error("delivery must not spawn a fresh agent");
			},
			card: () => buildAgentCard({ url: `http://${A2A_HOST}:${handle.port}/`, version: "18.16.0", skills: [] }),
		});
		handles.push(handle);
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: "idle-wake",
			method: "SendMessage",
			params: {
				message: { messageId: "wake-1", role: "ROLE_USER", parts: [{ text: "please check the build" }] },
				metadata: { to: "IdleChild", from: "peer" },
			},
		});
		expect(status).toBe(200);
		// The SAME idle child received the request through the real bus, was
		// woken exactly once, and no fresh spawn happened.
		expect(woken).toHaveLength(1);
		expect((woken[0]?.[0] as CustomMessage | undefined)?.details).toMatchObject({
			external: true,
			a2aMessageId: "wake-1",
		});
		expect(spawnCalls).toEqual([]);
		const task = taskResult(json);
		expect(task.id).toBe("IdleChild");
		expect(task.metadata?.delivery).toMatchObject({ to: "IdleChild", outcome: "woken" });
		// The task stays WORKING (a wake turn started), not COMPLETED from a
		// prior turn's published output.
		expect(task.status.state).toBe(TASK_STATE.WORKING);
	});

	it("a2a addressed delivery revives a supported parked agent through the lifecycle", async () => {
		// A lifecycle managing this registry proves the parked ref's revive
		// capability; the real bus routes the delivery through ensureLive,
		// which invokes the installed factory — the same persisted-revive
		// path the Agent Hub uses (see test/task/persisted-revive.test.ts).
		const woken: CustomMessage[][] = [];
		const bridge = new IrcBridge({
			isDisposed: () => false,
			isStreaming: () => false,
			planModeEnabled: () => false,
			hasWakeRelay: () => true,
			emitSessionEvent: async () => {},
			wakeForIrc: (records: AgentMessage[]) => {
				woken.push(records as CustomMessage[]);
			},
		} as never);
		const revivedSession = {
			deliverIrcMessage: async (msg: IrcMessage) => bridge.deliver(msg),
		};
		const registry = new FakeRegistry([
			makeRef({ id: "Main", kind: "main", status: "idle" }),
			makeRef({
				id: "ParkedChild",
				kind: "sub",
				status: "parked",
				sessionFile: "/tmp/parked-child.jsonl",
			}),
		]);
		const lifecycle = new AgentLifecycleManager(registry.asApi());
		const reviveCalls: string[] = [];
		lifecycle.setPersistedSubagentReviverFactory(
			ref =>
				ref.sessionFile
					? Promise.resolve(async expected => {
							reviveCalls.push(expected.id);
							// The exact parked ref is claimed by the revive, mirroring
							// the real persisted path (createAgentSession claims the
							// ref as running; the lifecycle then transitions it idle).
							if (registry.get(expected.id) !== expected) throw new Error("stale ref");
							if (!registry.attachSession(expected.id, revivedSession as never, expected.sessionFile, expected))
								throw new Error("attach failed");
							if (!registry.setStatus(expected.id, "running", expected)) throw new Error("claim failed");
							return revivedSession as never;
						})
					: Promise.resolve(undefined),
			() => 0,
		);
		const spawnCalls: SpawnSubagentOptions[] = [];
		const bus = new IrcBus(registry.asApi(), lifecycle, { settings: Settings.isolated({}) });
		const handle = createA2aServer({
			token: TOKEN,
			port: 0,
			registry: registry.asApi(),
			bus,
			lifecycle,
			spawn: async options => {
				spawnCalls.push(options);
				throw new Error("delivery must not spawn a fresh agent");
			},
			card: () => buildAgentCard({ url: `http://${A2A_HOST}:${handle.port}/`, version: "18.16.0", skills: [] }),
		});
		handles.push(handle);
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: "parked-revive",
			method: "SendMessage",
			params: {
				message: { messageId: "revive-1", role: "ROLE_USER", parts: [{ text: "resume the review" }] },
				metadata: { to: "ParkedChild", from: "peer" },
			},
		});
		expect(status).toBe(200);
		// The ORIGINAL identity was revived (same id, same ref) and received
		// the request; no fresh spawn, no Main substitution.
		expect(reviveCalls).toEqual(["ParkedChild"]);
		expect(woken).toHaveLength(1);
		expect((woken[0]?.[0] as CustomMessage | undefined)?.details).toMatchObject({
			external: true,
			a2aMessageId: "revive-1",
		});
		expect(spawnCalls).toEqual([]);
		const task = taskResult(json);
		expect(task.id).toBe("ParkedChild");
		expect(task.metadata?.delivery).toMatchObject({ to: "ParkedChild", outcome: "revived" });
		// A revived delivery reports WORKING (the revived turn started), not
		// the prior run's terminal state.
		expect(task.status.state).toBe(TASK_STATE.WORKING);
	});

	it("a2a addressed delivery refuses an unrevivable parked agent like an unknown recipient", async () => {
		const registry = new FakeRegistry([
			makeRef({ id: "Main", kind: "main", status: "idle" }),
			makeRef({ id: "DeadParked", kind: "sub", status: "parked", sessionFile: null }),
		]);
		const lifecycle = new AgentLifecycleManager(registry.asApi());
		const bus = new IrcBus(registry.asApi(), lifecycle, { settings: Settings.isolated({}) });
		const busSend = vi.fn();
		bus.send = busSend as never;
		const handle = createA2aServer({
			token: TOKEN,
			port: 0,
			registry: registry.asApi(),
			bus,
			lifecycle,
			card: () => buildAgentCard({ url: `http://${A2A_HOST}:${handle.port}/`, version: "18.16.0", skills: [] }),
		});
		handles.push(handle);
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: "parked-dead",
			method: "SendMessage",
			params: {
				message: { messageId: "dead-1", role: "ROLE_USER", parts: [{ text: "resume" }] },
				metadata: { to: "DeadParked", from: "peer" },
			},
		});
		// The same externally observable unknown-agent contract as a missing id.
		expect(status).toBe(404);
		expect(errorResult(json).code).toBe(RPC_ERRORS.TASK_NOT_FOUND);
		// No wake, no revive, no bus send, and no phantom incoming record.
		expect(busSend).not.toHaveBeenCalled();
		const incoming = IncomingRequests.global();
		expect(await incoming.list("DeadParked")).toEqual([]);
	});

	it("a2a addressed delivery refuses a ref removed after discovery without a replacement delivery", async () => {
		const registry = new FakeRegistry([
			makeRef({ id: "Main", kind: "main", status: "idle" }),
			makeRef({ id: "GoneChild", kind: "sub", status: "idle", session: {} as never }),
		]);
		const bus = new IrcBus(registry.asApi(), undefined, { settings: Settings.isolated({}) });
		const handle = createA2aServer({
			token: TOKEN,
			port: 0,
			registry: registry.asApi(),
			bus,
			card: () => buildAgentCard({ url: `http://${A2A_HOST}:${handle.port}/`, version: "18.16.0", skills: [] }),
		});
		handles.push(handle);
		// The recipient disappears between card discovery and delivery.
		registry.unregister("GoneChild");
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: "gone-child",
			method: "SendMessage",
			params: {
				message: { messageId: "gone-1", role: "ROLE_USER", parts: [{ text: "resume" }] },
				metadata: { to: "GoneChild", from: "peer" },
			},
		});
		expect(status).toBe(404);
		expect(errorResult(json).code).toBe(RPC_ERRORS.TASK_NOT_FOUND);
		expect(await IncomingRequests.global().list("GoneChild")).toEqual([]);
	});

	it("a2a addressed delivery to a registered idle corpse fails with DELIVERY_FAILED, not 404", async () => {
		// A still-registered idle ref with no live session is a legitimate
		// lookup: the addressed resolution succeeds and the IRC bus then
		// refuses the hand-off, so the client sees the existing
		// DELIVERY_FAILED error (HTTP 200), never TASK_NOT_FOUND/404.
		const registry = new FakeRegistry([
			makeRef({ id: "Main", kind: "main", status: "idle" }),
			makeRef({ id: "IdleCorpse", kind: "sub", status: "idle", session: null }),
		]);
		const bus = new IrcBus(registry.asApi(), undefined, { settings: Settings.isolated({}) });
		const handle = createA2aServer({
			token: TOKEN,
			port: 0,
			registry: registry.asApi(),
			bus,
			card: () => buildAgentCard({ url: `http://${A2A_HOST}:${handle.port}/`, version: "18.16.0", skills: [] }),
		});
		handles.push(handle);
		const { status, json } = await rpc(handle, {
			jsonrpc: "2.0",
			id: "idle-corpse",
			method: "SendMessage",
			params: {
				message: { messageId: "corpse-1", role: "ROLE_USER", parts: [{ text: "resume" }] },
				metadata: { to: "IdleCorpse", from: "peer" },
			},
		});
		expect(status).toBe(200);
		const error = errorResult(json);
		expect(error.code).toBe(RPC_ERRORS.DELIVERY_FAILED);
		expect(error.message).toContain("no live session");
		// The refused delivery rolled its incoming record back.
		expect(await IncomingRequests.global().list("IdleCorpse")).toEqual([]);
	});

	it("refuses unauthenticated and wrong-token requests to an idle/parked address without waking or reviving", async () => {
		const { session } = idleChildHarness();
		const registry = new FakeRegistry([
			makeRef({ id: "Main", kind: "main", status: "idle" }),
			makeRef({ id: "IdleChild", kind: "sub", status: "idle", session: session as never }),
			makeRef({ id: "ParkedChild", kind: "sub", status: "parked", sessionFile: "/tmp/parked-child.jsonl" }),
		]);
		const lifecycle = new AgentLifecycleManager(registry.asApi());
		const ensureLive = vi.fn();
		lifecycle.ensureLive = ensureLive as never;
		const bus = new IrcBus(registry.asApi(), lifecycle, { settings: Settings.isolated({}) });
		const busSend = vi.fn();
		bus.send = busSend as never;
		const handle = createA2aServer({
			token: TOKEN,
			port: 0,
			registry: registry.asApi(),
			bus,
			lifecycle,
			card: () => buildAgentCard({ url: `http://${A2A_HOST}:${handle.port}/`, version: "18.16.0", skills: [] }),
		});
		handles.push(handle);
		const request = (to: string) => ({
			jsonrpc: "2.0" as const,
			id: "auth-probe",
			method: "SendMessage",
			params: {
				message: { messageId: "auth-1", role: "ROLE_USER" as const, parts: [{ text: "hello" }] },
				metadata: { to },
			},
		});
		// Authentication happens before any wake, revive, or bus send.
		for (const to of ["IdleChild", "ParkedChild"]) {
			const missing = await rpc(handle, request(to), null);
			expect(missing.status).toBe(401);
			const wrong = await rpc(handle, request(to), "wrong-token");
			expect(wrong.status).toBe(401);
		}
		expect(ensureLive).not.toHaveBeenCalled();
		expect(busSend).not.toHaveBeenCalled();
		expect(await IncomingRequests.global().list("IdleChild")).toEqual([]);
	});
});
