/**
 * A2A client bridge: `/a2a add` registration, spawning `a2a:` agents from the
 * task tool, timeouts, interrupted states, and the two-instance loop against
 * the in-tree A2A server.
 *
 * The remote side is a real `Bun.serve` speaking the v1.0 JSON-RPC binding
 * (PascalCase methods, proto task states), never a stubbed fetch: the wire
 * shape is the contract under test.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	A2aClient,
	A2aClientError,
	A2aTimeoutError,
	cardRequiresBearer,
	fetchAgentCard,
	resolveAgentCardUrl,
	resolveRpcEndpoint,
} from "@oh-my-pi/pi-coding-agent/a2a/client";
import {
	A2A_AUTH_REQUIRED_TEXT,
	A2A_WAITING_FOR_INPUT_TEXT,
	A2aAgentBridge,
	addA2aAgentsFromUrl,
	runtimeAgentName,
	spawnA2aAgent,
} from "@oh-my-pi/pi-coding-agent/a2a/agent-bridge";
import {
	AGENT_CARD_PATH,
	type A2aServerHandle,
	createA2aServer,
	readLocalBridgeEntry,
	resolveA2aToken,
	startA2aServer,
} from "@oh-my-pi/pi-coding-agent/a2a/server";
import { type AgentCard, buildAgentCard } from "@oh-my-pi/pi-coding-agent/a2a/card";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { type A2aTask, TASK_STATE, sendA2aMessage } from "@oh-my-pi/pi-coding-agent/a2a/rpc";
import { IncomingRequests, type IncomingRequestsApi } from "@oh-my-pi/pi-coding-agent/a2a/incoming-requests";
import { installA2aReplyRelay } from "@oh-my-pi/pi-coding-agent/a2a/reply-relay";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { type OutgoingRequest, OutgoingRequests } from "@oh-my-pi/pi-coding-agent/a2a/outgoing-requests";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { SpawnSubagentOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	type AgentRef as RegistryAgentRef,
	type AgentRegistryApi,
	type RegistryEvent,
	type RegistryListener,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { BUILTIN_A2A_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-a2a";
import type { SlashCommandRuntime, SlashCommandSpec } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

interface RpcCall {
	method: string;
	params: Record<string, unknown>;
	authorization: string | null;
}

interface MockA2aServer {
	url: string;
	calls: RpcCall[];
	cardFetches: number;
	stop(): void;
}

const CARD_SKILLS = [{ id: "main", displayName: "Main", description: "Main omp agent" }];

function startMockA2a(options: {
	/** JSON-RPC result for a request; return a full `{ jsonrpc, id, result }` envelope. */
	onRpc: (call: RpcCall) => unknown | Promise<unknown>;
	skills?: Parameters<typeof buildAgentCard>[0]["skills"];
	securitySchemes?: boolean;
	/** Card identity and per-process id, for discovery/instanceId tests. */
	name?: string;
	instanceId?: string;
}): MockA2aServer {
	const calls: RpcCall[] = [];
	const state = { cardFetches: 0 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const base = `http://127.0.0.1:${server.port}/`;
			if (request.method === "GET" && url.pathname === AGENT_CARD_PATH) {
				state.cardFetches += 1;
				const card: AgentCard = buildAgentCard({
					url: base,
					version: "test",
					...(options.name !== undefined ? { name: options.name } : {}),
					...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
					skills: options.skills ?? CARD_SKILLS,
				});
				if (options.securitySchemes === false) card.securitySchemes = {};
				return Response.json(card);
			}
			if (request.method !== "POST") return new Response("Not Found", { status: 404 });
			const body = (await request.json()) as { id: unknown; method: string; params: Record<string, unknown> };
			const call: RpcCall = {
				method: body.method,
				params: body.params,
				authorization: request.headers.get("authorization"),
			};
			calls.push(call);
			return Response.json(await options.onRpc(call));
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/`,
		calls,
		get cardFetches() {
			return state.cardFetches;
		},
		stop: () => server.stop(true),
	};
}

function rpcResult(id: unknown, result: unknown): unknown {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): unknown {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function completedTask(text: string, id = "task-1"): unknown {
	return {
		id,
		status: { state: TASK_STATE.COMPLETED },
		artifacts: [{ artifactId: `${id}:output`, parts: [{ text }] }],
	};
}

const servers: MockA2aServer[] = [];

function mockA2a(options: Parameters<typeof startMockA2a>[0]): MockA2aServer {
	const server = startMockA2a(options);
	servers.push(server);
	return server;
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	vi.restoreAllMocks();
	vi.useRealTimers();
	IncomingRequests.resetGlobalForTests();
	OutgoingRequests.resetGlobalForTests();
	// Other files in the shared process install a global job manager without
	// resetting it; this file's "no implicit global" assertions must not
	// observe that leftover.
	AsyncJobManager.resetForTests();
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

async function tempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-a2a-client-"));
}

function toolSession(
	bridge: A2aAgentBridge,
	settings: Settings,
	cwd: string,
	options: {
		frozenSessionAgents?: boolean;
		planMode?: boolean;
		agentId?: string;
		asyncJobManager?: AsyncJobManager;
	} = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getA2aBridge: () => bridge,
		...(options.agentId !== undefined ? { getAgentId: () => options.agentId } : {}),
		...(options.asyncJobManager !== undefined ? { asyncJobManager: options.asyncJobManager } : {}),
		...(options.planMode ? { getPlanModeState: () => ({ enabled: true, planFilePath: "PLAN.md" }) } : {}),
		...(options.frozenSessionAgents ? { getSessionAgents: () => [], advertisedSessionAgents: () => [] } : {}),
	} as unknown as ToolSession;
}

async function createTaskTool(
	bridge: A2aAgentBridge,
	settings: Settings = Settings.isolated(),
	options: {
		frozenSessionAgents?: boolean;
		planMode?: boolean;
		agentId?: string;
		asyncJobManager?: AsyncJobManager;
	} = {},
): Promise<TaskTool> {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	const cwd = await tempDir();
	return TaskTool.create(toolSession(bridge, settings, cwd, options));
}

async function registerFrom(server: MockA2aServer, options: { token?: string; agentDir?: string } = {}) {
	const bridge = new A2aAgentBridge();
	const result = await addA2aAgentsFromUrl({
		bridge,
		url: server.url,
		token: options.token,
		agentDir: options.agentDir ?? (await tempDir()),
	});
	return { bridge, ...result };
}

function slashRuntime(bridge: A2aAgentBridge, outputs: string[]): SlashCommandRuntime {
	return {
		session: { a2aBridge: bridge } as unknown as SlashCommandRuntime["session"],
		settings: Settings.isolated(),
		sessionManager: {},
		cwd: "/tmp",
		output: (text: string) => {
			outputs.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	} as unknown as SlashCommandRuntime;
}

function a2aCommand(): SlashCommandSpec & { handle: NonNullable<SlashCommandSpec["handle"]> } {
	const spec = BUILTIN_A2A_SLASH_COMMANDS.find(command => command.name === "a2a");
	if (!spec?.handle) throw new Error("a2a slash command is not registered");
	return spec as SlashCommandSpec & { handle: NonNullable<SlashCommandSpec["handle"]> };
}

describe("a2a client", () => {
	it("sends SendMessage with ROLE_USER text parts and reads the artifact text", async () => {
		const server = mockA2a({
			onRpc: call => rpcResult(call.params.id ?? 1, { task: completedTask("remote answer") }),
		});
		const client = new A2aClient({ url: server.url, token: "test-token", pollIntervalMs: 5 });

		const run = await client.sendAndWait("hello remote");

		expect(run.text).toBe("remote answer");
		expect(run.state).toBe(TASK_STATE.COMPLETED);
		expect(server.calls).toHaveLength(1);
		const call = server.calls[0]!;
		expect(call.method).toBe("SendMessage");
		expect(call.authorization).toBe("Bearer test-token");
		const message = call.params.message as { role: string; parts: Array<{ text: string }> };
		expect(message.role).toBe("ROLE_USER");
		expect(message.parts).toEqual([{ text: "hello remote" }]);
	});

	it("polls GetTask with backoff until the task completes", async () => {
		let polls = 0;
		const server = mockA2a({
			onRpc: call => {
				if (call.method === "SendMessage") {
					return rpcResult(1, { task: { id: "task-9", status: { state: TASK_STATE.WORKING } } });
				}
				polls += 1;
				const task =
					polls < 3
						? { id: "task-9", status: { state: TASK_STATE.WORKING } }
						: completedTask("done after polling", "task-9");
				return rpcResult(2, task);
			},
		});
		const client = new A2aClient({ url: server.url, pollIntervalMs: 5, maxPollIntervalMs: 12 });

		const run = await client.sendAndWait("long job");

		expect(run.text).toBe("done after polling");
		expect(polls).toBe(3);
		expect(server.calls.map(call => call.method)).toEqual(["SendMessage", "GetTask", "GetTask", "GetTask"]);
	});

	it("falls back to the status message when the task carries no artifacts", async () => {
		const server = mockA2a({
			onRpc: () =>
				rpcResult(1, {
					task: {
						id: "task-2",
						status: {
							state: TASK_STATE.COMPLETED,
							message: { messageId: "m1", role: "ROLE_AGENT", parts: [{ text: "status text answer" }] },
						},
					},
				}),
		});
		const client = new A2aClient({ url: server.url, pollIntervalMs: 5 });

		expect((await client.sendAndWait("hi")).text).toBe("status text answer");
	});

	it("stops on INPUT_REQUIRED without polling", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: { id: "task-3", status: { state: TASK_STATE.INPUT_REQUIRED } } }),
		});
		const client = new A2aClient({ url: server.url, pollIntervalMs: 5 });

		const run = await client.sendAndWait("needs input");

		expect(run.interrupted).toBe(true);
		expect(run.state).toBe(TASK_STATE.INPUT_REQUIRED);
		expect(server.calls.map(call => call.method)).toEqual(["SendMessage"]);
	});

	it("times out with the task id and state in the reason", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: { id: "task-slow", status: { state: TASK_STATE.WORKING } } }),
		});
		const client = new A2aClient({ url: server.url, pollIntervalMs: 10, totalTimeoutMs: 60 });

		const error = await client.sendAndWait("forever").catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(A2aTimeoutError);
		expect(String((error as Error).message)).toContain("task-slow");
		expect(String((error as Error).message)).toContain("timed out");
	});

	it("bounds the whole run: a hanging initial SendMessage still hits totalTimeoutMs", async () => {
		let aborted = false;
		const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			const signal = init?.signal as AbortSignal | undefined;
			signal?.addEventListener("abort", () => {
				aborted = true;
				reject(signal.reason);
			});
			return promise;
		}) as unknown as typeof fetch;
		const client = new A2aClient({ url: "http://127.0.0.1:1/", totalTimeoutMs: 40, fetch: hangingFetch });
		const error = await client.sendAndWait("hang").catch((cause: unknown) => cause);
		// The budget covers SendMessage itself, not just the later GetTask polls.
		expect(error).toBeInstanceOf(A2aTimeoutError);
		expect(aborted).toBe(true);
	});

	it("aborts a hanging GetTask within the whole-run budget", async () => {
		let pollAborted = false;
		const fetcher = ((_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { method: string };
			if (body.method === "SendMessage") {
				return Promise.resolve(
					Response.json(
						rpcResult(1, {
							task: { id: "slow-poll", status: { state: TASK_STATE.WORKING } },
						}),
					),
				);
			}
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => {
				pollAborted = true;
				reject(init.signal?.reason);
			});
			return promise;
		}) as unknown as typeof fetch;
		const client = new A2aClient({
			url: "http://127.0.0.1:1/",
			fetch: fetcher,
			totalTimeoutMs: 50,
			connectTimeoutMs: 500,
			pollIntervalMs: 5,
		});
		expect(await client.sendAndWait("wait").catch((error: unknown) => error)).toBeInstanceOf(A2aTimeoutError);
		expect(pollAborted).toBe(true);
	});

	it("defaults to no total timeout", async () => {
		let polls = 0;
		const server = mockA2a({
			onRpc: call => {
				if (call.method === "SendMessage") {
					return rpcResult(1, { task: { id: "task-long", status: { state: TASK_STATE.WORKING } } });
				}
				polls += 1;
				return rpcResult(
					2,
					polls < 4
						? { id: "task-long", status: { state: TASK_STATE.WORKING } }
						: completedTask("finished eventually", "task-long"),
				);
			},
		});
		const client = new A2aClient({ url: server.url, pollIntervalMs: 5 });

		expect((await client.sendAndWait("hours")).text).toBe("finished eventually");
		expect(polls).toBe(4);
	});

	it("surfaces JSON-RPC method errors instead of retrying", async () => {
		const server = mockA2a({ onRpc: call => rpcError(call.params.id ?? 1, -32601, "Method not found: SendMessage") });
		const client = new A2aClient({ url: server.url, pollIntervalMs: 5 });

		const error = await client.sendAndWait("hi").catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(A2aClientError);
		expect((error as A2aClientError).code).toBe(-32601);
		expect(String((error as Error).message)).toContain("Method not found");
		expect(server.calls).toHaveLength(1);
	});

	it("maps HTTP 401 to an unauthorized client error", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized" } },
					{ status: 401 },
				),
		});
		try {
			const client = new A2aClient({ url: `http://127.0.0.1:${server.port}/`, token: "wrong" });
			const error = await client.sendAndWait("hi").catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(A2aClientError);
			expect((error as A2aClientError).httpStatus).toBe(401);
			expect(String((error as Error).message)).toContain("Unauthorized");
		} finally {
			server.stop(true);
		}
	});

	it("resolves the well-known card URL and the RPC endpoint", async () => {
		expect(resolveAgentCardUrl("http://127.0.0.1:7391")).toBe("http://127.0.0.1:7391/.well-known/agent-card.json");
		expect(resolveAgentCardUrl("http://127.0.0.1:7391/omp")).toBe(
			"http://127.0.0.1:7391/omp/.well-known/agent-card.json",
		);
		expect(resolveAgentCardUrl("http://127.0.0.1:7391/.well-known/agent-card.json")).toBe(
			"http://127.0.0.1:7391/.well-known/agent-card.json",
		);

		const server = mockA2a({ onRpc: () => rpcResult(1, {}) });
		const { card, endpoint } = await fetchAgentCard({ url: server.url });
		expect(card.name).toBe("omp");
		expect(endpoint).toBe(server.url);
	});
});

describe("a2a registration", () => {
	it("registers one runtime agent per card skill and writes no files", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, {}) });
		const agentDir = await tempDir();
		const { bridge, added } = await registerFrom(server, { token: "secret", agentDir });

		expect(added.map(agent => agent.name)).toEqual(["a2a:main"]);
		const agent = bridge.get("a2a:main");
		expect(agent?.description).toBe("Main omp agent");
		expect(agent?.url).toBe(server.url);
		expect(agent?.token).toBe("secret");
		expect(bridge.list()).toHaveLength(1);
		await expect(fs.readdir(agentDir)).resolves.toEqual([]);
	});

	it("replaces a re-added card instead of duplicating its skills", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, {}) });
		const { bridge } = await registerFrom(server);
		await addA2aAgentsFromUrl({ bridge, url: server.url, agentDir: await tempDir() });

		expect(bridge.list()).toHaveLength(1);
	});

	it("reads the bearer token from the agent directory when the card declares one", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, {}) });
		const agentDir = await tempDir();
		await fs.writeFile(path.join(agentDir, "a2a.token"), "file-token\n", { mode: 0o600 });

		const { bridge } = await registerFrom(server, { agentDir });

		expect(bridge.get("a2a:main")?.token).toBe("file-token");
	});

	it("registers the card itself when it lists no skills", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, {}), skills: [] });
		const { bridge } = await registerFrom(server);

		const agent = bridge.list()[0];
		expect(agent?.name).toBe("a2a:omp");
		expect(agent?.description).toContain("oh-my-pi");
	});

	it("/a2a add registers through the slash command and /a2a list sees it in the same session", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, {}) });
		const bridge = new A2aAgentBridge();
		const outputs: string[] = [];
		const runtime = slashRuntime(bridge, outputs);
		const spec = a2aCommand();

		await spec.handle({ name: "a2a", args: `add ${server.url} --token secret`, text: "" }, runtime);
		expect(bridge.get("a2a:main")).toBeDefined();
		expect(outputs.join("\n")).toContain("a2a:main");

		await spec.handle({ name: "a2a", args: "list", text: "" }, runtime);
		expect(outputs.join("\n")).toContain(`a2a:main`);
		expect(outputs.join("\n")).toContain(server.url);

		await spec.handle({ name: "a2a", args: "remove main", text: "" }, runtime);
		expect(bridge.list()).toEqual([]);
	});

	it("/a2a add reports an unreachable bridge instead of registering", async () => {
		const bridge = new A2aAgentBridge();
		const outputs: string[] = [];
		const spec = a2aCommand();

		await spec.handle({ name: "a2a", args: "add http://127.0.0.1:1", text: "" }, slashRuntime(bridge, outputs));

		expect(outputs.join("\n")).toContain("A2A registration failed");
		expect(bridge.list()).toEqual([]);
	});
});

describe("task tool a2a spawn", () => {
	it("advertises a remote agent even when the session-agent surface is frozen", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, {}) });
		const { bridge } = await registerFrom(server);
		const tool = await createTaskTool(bridge, Settings.isolated(), { frozenSessionAgents: true });

		expect(tool.description).toContain("a2a:main");
		expect(tool.description).toContain("Main omp agent");
	});

	it("spawns a registered remote agent and returns its text in the task-result envelope", async () => {
		const server = mockA2a({
			onRpc: () =>
				rpcResult(1, {
					task: completedTask("remote says hi"),
				}),
		});
		const { bridge } = await registerFrom(server, { token: "spawn-token" });
		const tool = await createTaskTool(bridge);

		expect(tool.description).toContain("a2a:main");
		expect(tool.description).toContain("Main omp agent");

		const result = await tool.execute("tc-a2a", { agent: "a2a:main", task: "summarize the repo" } as TaskParams);
		const text = textOf(result);

		expect(text).toContain("<task-result");
		expect(text).toContain('agent="a2a:main"');
		expect(text).toContain('status="completed"');
		expect(text).toContain("remote says hi");
		expect(server.calls[0]?.authorization).toBe("Bearer spawn-token");
		expect(server.calls[0]?.params.message).toMatchObject({
			role: "ROLE_USER",
			parts: [{ text: "summarize the repo" }],
		});
	});

	it("refuses a remote dispatch in plan mode without sending a request", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, { task: completedTask("unexpected") }) });
		const { bridge } = await registerFrom(server);
		const tool = await createTaskTool(bridge, Settings.isolated(), { planMode: true });
		const result = await tool.execute("tc-a2a-plan", { agent: "a2a:main", task: "change files" } as TaskParams);
		expect(textOf(result)).toContain("plan mode");
		expect(server.calls).toHaveLength(0);
	});

	it("discovers a later peer before resolving the remote spawn policy", async () => {
		const { registerLocalBridge } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		using dir = TempDir.createSync("@a2a-late-peer-");
		const server = mockA2a({
			instanceId: "late-instance",
			skills: [{ id: "late", displayName: "Late peer" }],
			onRpc: () => rpcResult(1, { task: completedTask("late reply") }),
		});
		await registerLocalBridge({
			agentDir: dir.path(),
			pid: process.ppid,
			port: Number(new URL(server.url).port),
			name: "late",
			instanceId: "late-instance",
		});
		const settings = await Settings.loadIsolated({ inMemory: true, agentDir: dir.path() });
		const tool = await createTaskTool(new A2aAgentBridge(), settings);
		const result = await tool.execute("tc-a2a-late", { agent: "a2a:late", task: "hello" } as TaskParams);
		expect(textOf(result)).toContain("late reply");
		expect(server.calls).toHaveLength(1);
	});

	it("forwards batch context through the task tool in the SendMessage extension", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, { task: completedTask("ok") }) });
		const { bridge } = await registerFrom(server);
		const tool = await createTaskTool(bridge, Settings.isolated({ "task.batch": true }));
		const result = await tool.execute("tc-a2a-context", {
			context: "shared contract",
			tasks: [{ agent: "a2a:main", task: "work" }],
		} as TaskParams);
		expect(textOf(result)).toContain("ok");
		expect(server.calls[0]?.params.metadata).toMatchObject({ context: "shared contract" });
	});

	it("turns INPUT_REQUIRED into the waiting message instead of hanging", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: { id: "task-input", status: { state: TASK_STATE.INPUT_REQUIRED } } }),
		});
		const { bridge } = await registerFrom(server);
		const tool = await createTaskTool(bridge);

		const text = textOf(await tool.execute("tc-a2a-input", { agent: "a2a:main", task: "ask me" } as TaskParams));

		expect(text).toContain(A2A_WAITING_FOR_INPUT_TEXT);
		expect(text).toContain('status="failed (exit 1)"');
	});

	it("reports AUTH_REQUIRED as the authentication message", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: { id: "task-auth", status: { state: TASK_STATE.AUTH_REQUIRED } } }),
		});
		const { bridge } = await registerFrom(server);
		const tool = await createTaskTool(bridge);

		const text = textOf(await tool.execute("tc-a2a-auth", { agent: "a2a:main", task: "needs auth" } as TaskParams));

		expect(text).toContain(A2A_AUTH_REQUIRED_TEXT);
		expect(text).toContain('status="failed (exit 1)"');
	});

	it("fails the spawn with the timeout reason when a2a.clientTimeoutMs is exceeded", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: { id: "task-never", status: { state: TASK_STATE.WORKING } } }),
		});
		const { bridge } = await registerFrom(server);
		const tool = await createTaskTool(bridge, Settings.isolated({ "a2a.clientTimeoutMs": 60 }));

		const text = textOf(
			await tool.execute("tc-a2a-timeout", { agent: "a2a:main", task: "wait forever" } as TaskParams),
		);

		expect(text).toContain('status="failed (exit 1)"');
		expect(text).toContain("task-never");
		expect(text).toContain("timed out");
	});
});

describe("two-instance loop (task-9 server as counterparty)", () => {
	type AgentRef = RegistryAgentRef;

	function makeRef(overrides: Partial<AgentRef> & Pick<AgentRef, "id">): AgentRef {
		const now = Date.now();
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
		} as unknown as AgentRef;
	}

	class LoopRegistry {
		readonly #refs = new Map<string, AgentRef>();
		readonly #listeners = new Set<RegistryListener>();

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
			ref.status = status;
			ref.lastActivity = Date.now();
			for (const listener of this.#listeners) listener({ type: "status_changed", ref } as RegistryEvent);
			return true;
		}
		register(ref: AgentRef): AgentRef {
			this.#refs.set(ref.id, ref);
			for (const listener of this.#listeners) listener({ type: "registered", ref } as RegistryEvent);
			return ref;
		}
	}

	it("spawns an a2a agent against the in-tree server and returns the remote run's output", async () => {
		const agentDir = await tempDir();
		const outputPath = path.join(agentDir, "remote-output.md");
		await fs.writeFile(outputPath, "loop answer from the remote instance\n");
		const registry = new LoopRegistry();
		const spawns: SpawnSubagentOptions[] = [];
		const handle: A2aServerHandle = createA2aServer({
			token: "loop-token",
			port: 0,
			registry: registry as unknown as AgentRegistryApi,
			bus: { send: async (): Promise<IrcDeliveryReceipt> => ({ to: "remote-1", outcome: "injected" }) },
			spawn: async options => {
				spawns.push(options);
				return registry.register(
					makeRef({
						id: "remote-1",
						displayName: "Remote",
						status: "idle",
						lifecycle: { terminalAt: Date.now() },
						history: { outputPath },
					}),
				);
			},
			card: () =>
				buildAgentCard({
					url: handle.url,
					version: "test",
					skills: [{ id: "main", displayName: "Main", description: "Main omp agent" }],
				}),
		});
		try {
			const bridge = new A2aAgentBridge();
			await addA2aAgentsFromUrl({ bridge, url: handle.url, token: "loop-token", agentDir });
			expect(bridge.get("a2a:main")).toBeDefined();

			const tool = await createTaskTool(bridge);
			const text = textOf(
				await tool.execute("tc-a2a-loop", {
					agent: "a2a:main",
					task: "run the loop",
					a2aSpawn: true,
				} as TaskParams),
			);

			expect(spawns).toHaveLength(1);
			expect(spawns[0]?.prompt).toBe("run the loop");
			expect(text).toContain('agent="a2a:main"');
			expect(text).toContain('status="completed"');
			expect(text).toContain("loop answer from the remote instance");
		} finally {
			handle.stop();
		}
	});
});

describe("A2aAgentBridge cross-terminal name collisions", () => {
	it("different endpoints with the same skill id register under -2/-3 suffixes", () => {
		const bridge = new A2aAgentBridge();
		const base = runtimeAgentName("Main");
		bridge.add({ name: base, skillId: "Main", description: "t1", cardName: "omp", url: "http://127.0.0.1:7601/" });
		bridge.add({ name: base, skillId: "Main", description: "t2", cardName: "omp", url: "http://127.0.0.1:7602/" });
		bridge.add({ name: base, skillId: "Main", description: "t3", cardName: "omp", url: "http://127.0.0.1:7603/" });
		const listed = bridge.list().map(agent => `${agent.name}:${agent.url}`);
		expect(listed).toEqual([
			"a2a:Main:http://127.0.0.1:7601/",
			"a2a:Main-2:http://127.0.0.1:7602/",
			"a2a:Main-3:http://127.0.0.1:7603/",
		]);
	});

	it("re-adding the same endpoint refreshes in place without a suffix", () => {
		const bridge = new A2aAgentBridge();
		const base = runtimeAgentName("Main");
		bridge.add({ name: base, skillId: "Main", description: "t1", cardName: "omp", url: "http://127.0.0.1:7601/" });
		bridge.add({ name: base, skillId: "Main", description: "t2", cardName: "omp", url: "http://127.0.0.1:7602/" });
		bridge.add({
			name: base,
			skillId: "Main",
			description: "t1 refreshed",
			cardName: "omp",
			url: "http://127.0.0.1:7601/",
		});
		const listed = bridge.list().map(agent => `${agent.name}:${agent.description}`);
		expect(listed).toEqual(["a2a:Main:t1 refreshed", "a2a:Main-2:t2"]);
	});

	it("refreshes an endpoint already assigned a suffixed name without adding another", () => {
		const bridge = new A2aAgentBridge();
		bridge.add({ name: "a2a:Main", skillId: "Main", description: "first", cardName: "omp", url: "http://one/" });
		bridge.add({ name: "a2a:Main", skillId: "Main", description: "second", cardName: "omp", url: "http://two/" });
		bridge.add({ name: "a2a:Main", skillId: "Main", description: "updated", cardName: "omp", url: "http://two/" });
		expect(bridge.list().map(agent => [agent.name, agent.description])).toEqual([
			["a2a:Main", "first"],
			["a2a:Main-2", "updated"],
		]);
	});
});

describe("A2A reply correlation", () => {
	it("correlates successive replies to separate unanswered requests from one peer", async () => {
		const incoming = IncomingRequests.global();
		await incoming.note({ from: "peer", messageId: "first", to: "Main", at: 1 });
		await incoming.note({ from: "peer", messageId: "second", to: "Main", at: 2 });
		expect((await incoming.consume({ to: "Main", from: "peer" }))?.request.messageId).toBe("first");
		expect((await incoming.consume({ to: "Main", from: "peer" }))?.request.messageId).toBe("second");
		expect(await incoming.consume({ to: "Main", from: "peer" })).toBeUndefined();
	});

	it("consumes one named request without disturbing the order of the rest", async () => {
		const incoming = IncomingRequests.global();
		for (const messageId of ["first", "second", "third"]) {
			await incoming.note({ from: "peer", messageId, to: "Main", at: 1 });
		}
		expect((await incoming.consume({ to: "Main", from: "peer", messageId: "second" }))?.request.messageId).toBe(
			"second",
		);
		expect(await incoming.consume({ to: "Main", from: "peer", messageId: "second" })).toBeUndefined();
		expect((await incoming.list("Main")).map(request => request.messageId)).toEqual(["first", "third"]);
		expect((await incoming.consume({ to: "Main", from: "peer" }))?.request.messageId).toBe("first");
	});
});

describe("autoRegisterLocalBridges / rescanLocalBridges", () => {
	function portOf(server: { url: string }): number {
		return Number(new URL(server.url).port);
	}

	it("registers live bridges from per-process files and prunes dead entries", async () => {
		const { autoRegisterLocalBridges } = await import("@oh-my-pi/pi-coding-agent/a2a/agent-bridge");
		const { registerLocalBridge } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-autoreg-"));
		try {
			const server = mockA2a({
				onRpc: () => rpcResult(1, {}),
				name: "peer",
				instanceId: "inst-live",
				skills: [{ id: "Main", displayName: "Main", description: "peer main" }],
			});
			const port = portOf(server);
			await registerLocalBridge({ agentDir, pid: process.ppid, port, name: "peer", instanceId: "inst-live" });
			await registerLocalBridge({ agentDir, pid: 999999, port: 1234, name: "dead", instanceId: "inst-dead" });
			const bridge = new A2aAgentBridge();
			const result = await autoRegisterLocalBridges({ bridge, agentDir, token: "t" });
			expect([...result.registered.keys()]).toEqual([`http://127.0.0.1:${port}/`]);
			expect(result.registered.get(`http://127.0.0.1:${port}/`)).toEqual(["a2a:Main"]);
			expect(result.failed.size).toBe(0);
			expect(bridge.get("a2a:dead")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("refuses a stale entry whose port now serves a different instanceId", async () => {
		const { autoRegisterLocalBridges } = await import("@oh-my-pi/pi-coding-agent/a2a/agent-bridge");
		const { registerLocalBridge } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-autoreg-stale-"));
		try {
			const server = mockA2a({
				onRpc: () => rpcResult(1, {}),
				name: "peer",
				instanceId: "other-instance",
				skills: [{ id: "Main", displayName: "Main", description: "peer main" }],
			});
			const port = portOf(server);
			await registerLocalBridge({
				agentDir,
				pid: process.ppid,
				port,
				name: "peer",
				instanceId: "recorded-instance",
			});
			const bridge = new A2aAgentBridge();
			const result = await autoRegisterLocalBridges({ bridge, agentDir, token: "t" });
			expect(result.registered.size).toBe(0);
			expect(result.failed.get(`http://127.0.0.1:${port}/`)).toContain("instanceId mismatch");
			expect(bridge.list()).toEqual([]);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("drops an auto-discovered peer when its live port serves a different instance", async () => {
		const { rescanLocalBridges } = await import("@oh-my-pi/pi-coding-agent/a2a/agent-bridge");
		const { registerLocalBridge } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await tempDir();
		const options: Parameters<typeof mockA2a>[0] = {
			onRpc: () => rpcResult(1, {}),
			instanceId: "right",
			skills: [{ id: "peer", displayName: "Peer" }],
		};
		const server = mockA2a(options);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await registerLocalBridge({
				agentDir,
				pid: process.ppid,
				port: portOf(server),
				name: "peer",
				instanceId: "right",
			});
			const bridge = new A2aAgentBridge();
			await rescanLocalBridges({ bridge, agentDir });
			expect(bridge.get("a2a:peer")).toBeDefined();
			options.instanceId = "wrong";
			now += 2_001;
			await rescanLocalBridges({ bridge, agentDir });
			expect(bridge.get("a2a:peer")).toBeUndefined();
		} finally {
			clock.mockRestore();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("a terminal started later becomes visible after an on-demand rescan and gone peers are dropped", async () => {
		const { rescanLocalBridges } = await import("@oh-my-pi/pi-coding-agent/a2a/agent-bridge");
		const { registerLocalBridge, unregisterLocalBridge } = await import("@oh-my-pi/pi-coding-agent/a2a/server");
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "a2a-rescan-"));
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const first = mockA2a({
				onRpc: () => rpcResult(1, {}),
				name: "peer-one",
				instanceId: "i1",
				skills: [{ id: "peer-one", displayName: "Peer One" }],
			});
			await registerLocalBridge({
				agentDir,
				pid: process.ppid,
				port: portOf(first),
				name: "peer-one",
				instanceId: "i1",
			});
			const bridge = new A2aAgentBridge();
			await rescanLocalBridges({ bridge, agentDir, token: "t", excludePid: -1 });
			expect(bridge.get("a2a:peer-one")).toBeDefined();
			const otherSession = new A2aAgentBridge();
			await rescanLocalBridges({ bridge: otherSession, agentDir, token: "t", excludePid: -1 });
			expect(otherSession.get("a2a:peer-one")).toBeDefined();
			// A second terminal starts after the earlier one already read the roster.
			const second = mockA2a({
				onRpc: () => rpcResult(1, {}),
				name: "peer-two",
				instanceId: "i2",
				skills: [{ id: "peer-two", displayName: "Peer Two" }],
			});
			await registerLocalBridge({
				agentDir,
				pid: process.pid,
				port: portOf(second),
				name: "peer-two",
				instanceId: "i2",
			});
			now += 2_001;
			await rescanLocalBridges({ bridge, agentDir, token: "t", excludePid: -1 });
			expect(bridge.get("a2a:peer-one")).toBeDefined();
			expect(bridge.get("a2a:peer-two")).toBeDefined();
			// A bridge that disappears is removed from the roster.
			await unregisterLocalBridge(agentDir, process.ppid);
			now += 2_001;
			await rescanLocalBridges({ bridge, agentDir, token: "t", excludePid: -1 });
			expect(bridge.get("a2a:peer-one")).toBeUndefined();
			expect(bridge.get("a2a:peer-two")).toBeDefined();
		} finally {
			clock.mockRestore();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("re-registering the same URL replaces its entries instead of leaving stale duplicates", async () => {
		const options: Parameters<typeof mockA2a>[0] = {
			onRpc: () => rpcResult(1, {}),
			skills: [{ id: "Main", displayName: "Main", description: "v1" }],
		};
		const server = mockA2a(options);
		const bridge = new A2aAgentBridge();
		await addA2aAgentsFromUrl({ bridge, url: server.url });
		expect(bridge.list().map(agent => agent.name)).toEqual(["a2a:Main"]);
		// The peer refreshes its card with a different skill id (e.g. an auto name).
		options.skills = [{ id: "Renamed", displayName: "Renamed", description: "v2" }];
		await addA2aAgentsFromUrl({ bridge, url: server.url });
		await addA2aAgentsFromUrl({ bridge, url: server.url });
		expect(bridge.list().map(agent => agent.name)).toEqual(["a2a:Renamed"]);
	});

	it("parses --no-a2a-auto-register", () => {
		expect(parseArgs([]).noA2aAutoRegister).toBeUndefined();
		expect(parseArgs(["--no-a2a-auto-register"]).noA2aAutoRegister).toBe(true);
	});
});

describe("spawnA2aAgent default addressing", () => {
	it("addresses the skill (metadata.to) and returns the delivery receipt for a running target", async () => {
		const { spawnA2aAgent } = await import("@oh-my-pi/pi-coding-agent/a2a/agent-bridge");
		let capturedMetadata: Record<string, unknown> | undefined;
		const server = startMockA2a({
			onRpc: call => {
				if (call.method === "SendMessage") {
					capturedMetadata = call.params.metadata as Record<string, unknown>;
					return {
						jsonrpc: "2.0",
						id: 1,
						result: {
							task: {
								id: "Main",
								contextId: "Main",
								status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() },
								metadata: { delivery: { to: "Main", outcome: "injected" } },
							},
						},
					};
				}
				return { jsonrpc: "2.0", id: 1, result: {} };
			},
		});
		try {
			const result = await spawnA2aAgent({
				agent: {
					name: "a2a:Main",
					skillId: "Main",
					description: "peer",
					cardName: "omp",
					url: server.url,
				},
				prompt: "hello peer",
			});
			expect(capturedMetadata?.to).toBe("Main");
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Delivered to a2a:Main");
			expect(result.output).toContain("own conversation");
		} finally {
			server.stop();
		}
	});
});

describe("--a2a-name flag", () => {
	it("parses both --a2a-name value and --a2a-name=value", () => {
		expect(parseArgs(["--a2a-name", "builder"]).a2aName).toBe("builder");
		expect(parseArgs(["--a2a-name=reviewer"]).a2aName).toBe("reviewer");
	});
});

describe("peer skill registration cap", () => {
	it("registers at most maxPeerSkills skills from a fat peer card, main first", async () => {
		const fatSkills = Array.from({ length: 20 }, (_, i) => ({
			id: i === 0 ? "Main" : `ImplTask${i}`,
			displayName: i === 0 ? "Main" : `ImplTask${i}`,
			description: "worker",
		}));
		const server = startMockA2a({
			onRpc: () => ({ jsonrpc: "2.0", id: 1, result: {} }),
			skills: fatSkills,
		});
		try {
			const bridge = new A2aAgentBridge();
			await addA2aAgentsFromUrl({ bridge, url: server.url, token: "t", maxPeerSkills: 5 });
			const names = bridge.list().map(agent => agent.name);
			expect(names).toHaveLength(5);
			expect(names[0]).toBe("a2a:Main");
			expect(names).not.toContain("a2a:ImplTask6");
		} finally {
			server.stop();
		}
	});

	it("default cap is 8", async () => {
		const { A2A_DEFAULT_MAX_PEER_SKILLS } = await import("@oh-my-pi/pi-coding-agent/a2a/agent-bridge");
		expect(A2A_DEFAULT_MAX_PEER_SKILLS).toBe(8);
	});
});

describe("spawnA2aAgent reply channel (metadata.from/fromUrl)", () => {
	type AgentRef = RegistryAgentRef;

	function terminalMainRef(): AgentRef {
		const now = Date.now();
		return {
			id: "Main",
			displayName: "Main",
			kind: "main",
			parentId: "Main",
			status: "idle",
			session: null,
			sessionFile: null,
			createdAt: now,
			lastActivity: now,
		} as unknown as AgentRef;
	}

	/** A registry whose "Main" conversation records every bus delivery it receives. */
	function conversationRegistry(): AgentRegistryApi {
		const refs = new Map<string, AgentRef>([["Main", terminalMainRef()]]);
		return {
			get: (id: string) => refs.get(id),
			list: () => [...refs.values()],
			onChange: () => () => {},
			setStatus: () => false,
		} as unknown as AgentRegistryApi;
	}

	function recordingBus(inbox: Array<{ to: string; body: string; external?: boolean }>) {
		return {
			send: async (message: { to: string; body: string; external?: boolean }): Promise<IrcDeliveryReceipt> => {
				inbox.push({ to: message.to, body: message.body, external: message.external });
				return { to: message.to, outcome: "injected" };
			},
		};
	}

	/** One terminal: a real in-tree bridge serving a card under its public identity. */
	async function startTerminal(options: {
		agentDir: string;
		name?: string;
		/** Distinct cwd basenames give in-process terminals distinct auto names. */
		cwd?: string;
		inbox: Array<{ to: string; body: string; external?: boolean }>;
		incoming?: IncomingRequestsApi;
	}): Promise<A2aServerHandle> {
		const settings = await Settings.loadIsolated({ inMemory: true, agentDir: options.agentDir });
		return startA2aServer({
			settings,
			agentDir: options.agentDir,
			port: 0,
			...(options.name !== undefined ? { name: options.name } : {}),
			...(options.incoming !== undefined ? { incoming: options.incoming } : {}),
			registry: conversationRegistry(),
			bus: recordingBus(options.inbox),
			session: { cwd: options.cwd ?? options.agentDir, getSessionAgents: () => [] },
		});
	}

	it("stamps metadata.from/fromUrl so the peer can address the reply back", async () => {
		using dir = TempDir.createSync("@a2a-reply-wire-");
		const remoteInbox: Array<{ to: string; body: string; external?: boolean }> = [];
		const remote = await startTerminal({ agentDir: dir.path(), name: "builder", inbox: remoteInbox });
		try {
			const bridge = new A2aAgentBridge();
			await addA2aAgentsFromUrl({ bridge, url: remote.url, agentDir: dir.path() });

			const result = await spawnA2aAgent({
				agent: bridge.get("a2a:builder")!,
				prompt: "what is 17+25?",
				fromIdentity: { name: "alpha", url: "http://127.0.0.1:1/" },
			});

			// The wire contract: the addressed send carries this terminal's identity
			// so the peer knows which a2a:<name> to spawn for the reply.
			expect(remoteInbox).toHaveLength(1);
			const delivered = remoteInbox[0]!;
			expect(delivered.to).toBe("Main");
			expect(delivered.external).toBe(true);
			expect(delivered.body).toContain("[A2A task from peer terminal alpha");
			expect(delivered.body).toContain("spawning the agent a2a:alpha");
			expect(delivered.body).toContain("what is 17+25?");
			// The spawn reports delivery, not the answer: the work runs remotely.
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Delivered to a2a:builder");
			expect(result.remoteTaskId).toBe("Main");
		} finally {
			remote.stop();
		}
	});

	it("omits the reply envelope when the caller has no identity", async () => {
		using dir = TempDir.createSync("@a2a-reply-anon-");
		const remoteInbox: Array<{ to: string; body: string; external?: boolean }> = [];
		const remote = await startTerminal({ agentDir: dir.path(), inbox: remoteInbox });
		try {
			const bridge = new A2aAgentBridge();
			await addA2aAgentsFromUrl({ bridge, url: remote.url, agentDir: dir.path() });
			// With no a2a.name the peer is registered under its auto name (A1).
			const registered = bridge.list()[0]!;
			expect(registered.name).toMatch(/^a2a:[a-z0-9-]+-\d+$/);
			await spawnA2aAgent({ agent: registered, prompt: "plain question" });

			// Without from/fromUrl the peer gets only the raw text: there is no
			// return address, so no envelope may claim one exists.
			expect(remoteInbox).toHaveLength(1);
			expect(remoteInbox[0]!.body).toBe("plain question");
			expect(remoteInbox[0]!.body).not.toContain("[A2A task from peer terminal");
		} finally {
			remote.stop();
		}
	});

	it("full round trip with auto names: B's reply to A is correlated and adds no new envelope", async () => {
		using dir = TempDir.createSync("@a2a-reply-loop-");
		const alphaCwd = path.join(dir.path(), "alpha");
		const builderCwd = path.join(dir.path(), "builder");
		await fs.mkdir(alphaCwd, { recursive: true });
		await fs.mkdir(builderCwd, { recursive: true });
		const senderInbox: Array<{ to: string; body: string; external?: boolean }> = [];
		const remoteInbox: Array<{ to: string; body: string; external?: boolean }> = [];
		const senderIncoming = new IncomingRequests();
		const builderReplyBridge = new A2aAgentBridge();
		const sender = await startTerminal({
			agentDir: dir.path(),
			cwd: alphaCwd,
			inbox: senderInbox,
			incoming: senderIncoming,
		});
		const remote = await startTerminal({
			agentDir: dir.path(),
			cwd: builderCwd,
			inbox: remoteInbox,
			incoming: IncomingRequests.global(),
		});
		try {
			const alphaName = (await fetchAgentCard({ url: sender.url })).card.name;
			const builderName = (await fetchAgentCard({ url: remote.url })).card.name;
			// A1: two terminals with no a2a.name get distinct, skill-id-safe names.
			expect(alphaName).not.toBe(builderName);
			expect(alphaName).toMatch(/^[a-z0-9-]+-\d+$/);
			expect(builderName).toMatch(/^[a-z0-9-]+-\d+$/);

			// A registers B's card and spawns B's main agent - the outbound half.
			const alphaBridge = new A2aAgentBridge();
			await addA2aAgentsFromUrl({ bridge: alphaBridge, url: remote.url, agentDir: dir.path() });
			const outbound = await spawnA2aAgent({
				agent: alphaBridge.get(`a2a:${builderName}`)!,
				prompt: "what is 17+25?",
				fromIdentity: { name: alphaName, url: sender.url },
			});
			expect(outbound.exitCode).toBe(0);
			expect(remoteInbox).toHaveLength(1);
			expect(remoteInbox[0]!.body).toContain(`spawning the agent a2a:${alphaName}`);

			// B registers A's card, then answers by spawning a2a:<A's auto name>.
			// The caller consumes the outstanding request and passes the correlation explicitly.
			await addA2aAgentsFromUrl({ bridge: builderReplyBridge, url: sender.url, agentDir: dir.path() });
			const replyTarget = builderReplyBridge.get(`a2a:${alphaName}`);
			expect(replyTarget).toBeDefined();
			const reply = await spawnA2aAgent({
				agent: replyTarget!,
				prompt: "the answer is 42",
				fromIdentity: { name: builderName, url: remote.url },
				inReplyTo: (await IncomingRequests.global().consume({ to: "Main", from: replyTarget!.skillId }))?.request
					.messageId,
			});
			expect(reply.exitCode).toBe(0);
			expect(senderInbox).toHaveLength(1);
			const answer = senderInbox[0]!;
			expect(answer.to).toBe("Main");
			expect(answer.external).toBe(true);
			expect(answer.body).toContain("[A2A reply to your request");
			expect(answer.body).toContain("the answer is 42");
			// A2: no new reply envelope and no new outstanding request, so the
			// exchange cannot grow into an unbounded request/reply chain.
			expect(answer.body).not.toContain("[A2A task from peer terminal");
			expect(answer.body).not.toContain("spawning the agent");
			expect(await senderIncoming.list("Main")).toEqual([]);
		} finally {
			remote.stop();
			sender.stop();
		}
	});

	it("retains fromUrl through the wire so an equal-skill-id sender is pinned to its endpoint", async () => {
		using dir = TempDir.createSync("@a2a-reply-url-loop-");
		const alphaCwd = path.join(dir.path(), "alpha");
		const betaCwd = path.join(dir.path(), "beta");
		await fs.mkdir(alphaCwd, { recursive: true });
		await fs.mkdir(betaCwd, { recursive: true });
		const senderInbox: Array<{ to: string; body: string; external?: boolean }> = [];
		const senderIncoming = new IncomingRequests();
		// B's terminal records A's request with its own ledger.
		const remoteIncoming = new IncomingRequests();
		const sender = await startTerminal({
			agentDir: dir.path(),
			cwd: alphaCwd,
			inbox: senderInbox,
			incoming: senderIncoming,
			name: "alpha",
		});
		const remote = await startTerminal({
			agentDir: dir.path(),
			cwd: betaCwd,
			inbox: [],
			incoming: remoteIncoming,
			name: "alpha",
		});
		try {
			// Two live terminals advertise the SAME skill id ("alpha") from
			// distinct endpoints. B registers both.
			const builderBridge = new A2aAgentBridge();
			await addA2aAgentsFromUrl({ bridge: builderBridge, url: sender.url, agentDir: dir.path() });
			await addA2aAgentsFromUrl({ bridge: builderBridge, url: remote.url, agentDir: dir.path() });
			const sameSkill = builderBridge.list().filter(agent => agent.skillId === "alpha");
			expect(sameSkill.map(agent => agent.name).sort()).toEqual(["a2a:alpha", "a2a:alpha-2"]);

			// A's request lands on B carrying fromUrl = A's endpoint.
			const builderTarget = builderBridge.list().find(agent => agent.url === remote.url)!;
			const outbound = await spawnA2aAgent({
				agent: builderTarget,
				prompt: "what is 17+25?",
				fromIdentity: { name: "alpha", url: sender.url },
			});
			expect(outbound.exitCode).toBe(0);

			// The noted request on B carries A's fromUrl from the actual wire
			// request, so the shared selection pins A's endpoint, not the twin.
			const noted = (await remoteIncoming.list("Main"))[0]!;
			expect(noted).toMatchObject({ from: "alpha", fromUrl: sender.url });
			const reply = await spawnA2aAgent({
				agent: builderBridge.get("a2a:alpha")!,
				prompt: "the answer is 42",
				fromIdentity: { name: "alpha", url: remote.url },
				inReplyTo: (await remoteIncoming.consume({ to: "Main", from: "alpha", messageId: noted.messageId }))
					?.request.messageId,
			});
			expect(reply.exitCode).toBe(0);
			expect(senderInbox).toHaveLength(1);
			expect(senderInbox[0]!.body).toContain("[A2A reply to your request");
			// The URL-pinned endpoint is A's bridge, so A received the answer.
			expect(await senderIncoming.list("Main")).toEqual([]);
		} finally {
			remote.stop();
			sender.stop();
		}
	});
});

describe("/a2a remove", () => {
	it("forgets one agent by skill name and by full a2a: name, and reports unknowns as failed", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, {}) });
		const bridge = new A2aAgentBridge();
		const outputs: string[] = [];
		const runtime = slashRuntime(bridge, outputs);
		const spec = a2aCommand();
		await spec.handle({ name: "a2a", args: `add ${server.url} --token t`, text: "" }, runtime);

		// Bare skill name form: `remove main` resolves to `a2a:main`.
		const removed = await spec.handle({ name: "a2a", args: "remove main", text: "" }, runtime);
		expect(removed).toEqual({ consumed: true });
		expect(bridge.get("a2a:main")).toBeUndefined();
		expect(outputs.join("\n")).toContain("Forgot a2a:main");

		// Full name form removes the same way after re-registration.
		await spec.handle({ name: "a2a", args: `add ${server.url} --token t`, text: "" }, runtime);
		await spec.handle({ name: "a2a", args: "remove a2a:main", text: "" }, runtime);
		expect(bridge.list()).toEqual([]);

		// An unknown name is a failed consume, not a silent success: print mode
		// turns `failed` into a nonzero exit code.
		const unknown = await spec.handle({ name: "a2a", args: "remove ghost", text: "" }, runtime);
		expect(unknown).toEqual({ consumed: true, failed: true });
		expect(outputs.join("\n")).toContain("No registered remote agent: a2a:ghost");

		// A bare name never invents an entry where none was registered.
		expect(bridge.list()).toEqual([]);
	});

	it("removing one agent leaves its siblings registered", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, {}),
			skills: [
				{ id: "Main", displayName: "Main", description: "peer main" },
				{ id: "Helper", displayName: "Helper", description: "peer helper" },
			],
		});
		const bridge = new A2aAgentBridge();
		const runtime = slashRuntime(bridge, []);
		const spec = a2aCommand();
		await spec.handle({ name: "a2a", args: `add ${server.url} --token t`, text: "" }, runtime);

		await spec.handle({ name: "a2a", args: "remove Helper", text: "" }, runtime);

		// The surviving sibling stays spawnable through the task tool's roster.
		expect(bridge.get("a2a:Helper")).toBeUndefined();
		expect(bridge.get("a2a:Main")).toMatchObject({ skillId: "Main", url: server.url });
		expect(bridge.list()).toHaveLength(1);
	});
});

describe("A2aClient poll-failure tolerance", () => {
	/** A flaky peer: `failFor` consecutive GetTask calls answer HTTP 503 garbage. */
	function flakyServer(failFor: number): { url: string; polls: () => number; stop(): void } {
		let polls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { id: unknown; method: string };
				if (body.method === "SendMessage") {
					return Response.json(
						rpcResult(body.id, { task: { id: "task-poll", status: { state: TASK_STATE.WORKING } } }),
					);
				}
				polls += 1;
				if (polls <= failFor) return new Response("Service Unavailable", { status: 503 });
				return Response.json(
					rpcResult(body.id, {
						task: {
							id: "task-poll",
							status: { state: TASK_STATE.COMPLETED },
							artifacts: [{ artifactId: "task-poll:output", parts: [{ text: "recovered" }] }],
						},
					}),
				);
			},
		});
		return { url: `http://127.0.0.1:${server.port}/`, polls: () => polls, stop: () => server.stop(true) };
	}

	it("rides out two consecutive transport failures and still returns the task output", async () => {
		const server = flakyServer(2);
		try {
			const client = new A2aClient({ url: server.url, pollIntervalMs: 5 });

			const run = await client.sendAndWait("transient outage");

			expect(run.state).toBe(TASK_STATE.COMPLETED);
			expect(run.text).toBe("recovered");
			expect(server.polls()).toBe(3);
		} finally {
			server.stop();
		}
	});

	it("fails the run after three consecutive transport failures without more polling", async () => {
		let polls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { id: unknown; method: string };
				if (body.method === "SendMessage") {
					return Response.json(
						rpcResult(body.id, { task: { id: "task-dead", status: { state: TASK_STATE.WORKING } } }),
					);
				}
				polls += 1;
				return new Response("Service Unavailable", { status: 503 });
			},
		});
		try {
			const client = new A2aClient({ url: `http://127.0.0.1:${server.port}/`, pollIntervalMs: 5 });

			const error = await client.sendAndWait("hard outage").catch((cause: unknown) => cause);

			// The third failed poll is terminal: the spawn reports the transport
			// error instead of polling a dead endpoint forever.
			expect(error).toBeInstanceOf(A2aClientError);
			expect((error as A2aClientError).code).toBeUndefined();
			expect(String((error as Error).message)).toContain("GetTask");
			expect(polls).toBe(3);
		} finally {
			server.stop(true);
		}
	});
});

describe("resolveRpcEndpoint and cardRequiresBearer", () => {
	function card(overrides: Partial<AgentCard>): AgentCard {
		return {
			name: "peer",
			description: "peer card",
			protocolVersion: "1.0",
			version: "1",
			supportedInterfaces: [],
			capabilities: { streaming: true },
			defaultInputModes: ["text/plain"],
			defaultOutputModes: ["text/plain"],
			skills: [],
			securitySchemes: {},
			...overrides,
		};
	}

	it("prefers the advertised interface, falls back to the fetch URL, and rejects neither-given", () => {
		const advertised = resolveRpcEndpoint(
			card({
				supportedInterfaces: [
					{ url: "http://127.0.0.1:7391/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
				],
			}),
		);
		expect(advertised).toBe("http://127.0.0.1:7391/rpc");

		// A malformed first entry (no url) must not shadow a valid later one.
		const secondValid = resolveRpcEndpoint(
			card({
				supportedInterfaces: [
					{
						protocolBinding: "JSONRPC",
						protocolVersion: "1.0",
					} as unknown as AgentCard["supportedInterfaces"][number],
					{ url: "http://127.0.0.1:7392/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
				],
			}),
		);
		expect(secondValid).toBe("http://127.0.0.1:7392/rpc");

		const fallback = resolveRpcEndpoint(card({}), "http://127.0.0.1:7393/base/");
		expect(fallback).toBe("http://127.0.0.1:7393/base/");

		// No endpoint at all is a hard client error: registration must not
		// silently pick a guessed URL and post bearer tokens to it.
		expect(() => resolveRpcEndpoint(card({}))).toThrow(A2aClientError);
	});

	it("fetchAgentCard resolves the endpoint through the same precedence", async () => {
		// A peer whose card advertises a different RPC path than its card URL:
		// the client must talk to the advertised endpoint, not the card host root.
		let port = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (request.method === "GET" && url.pathname === AGENT_CARD_PATH) {
					return Response.json(
						card({
							supportedInterfaces: [
								{
									url: `http://127.0.0.1:${port}/rpc`,
									protocolBinding: "JSONRPC",
									protocolVersion: "1.0",
								},
							],
						}),
					);
				}
				return Response.json(rpcResult(1, {}));
			},
		});
		port = server.port!;

		try {
			const { card: fetched, endpoint } = await fetchAgentCard({ url: `http://127.0.0.1:${server.port}/` });
			expect(fetched.name).toBe("peer");
			expect(endpoint).toBe(`http://127.0.0.1:${server.port}/rpc`);
		} finally {
			server.stop(true);
		}
	});

	it("cardRequiresBearer detects bearer schemes case-insensitively and rejects others", () => {
		expect(
			cardRequiresBearer(
				card({ securitySchemes: { b: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "opaque" } } } }),
			),
		).toBe(true);
		expect(
			cardRequiresBearer(
				card({ securitySchemes: { b: { httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "opaque" } } } }),
			),
		).toBe(true);
		// A non-bearer scheme must not trigger token-file reads during registration.
		expect(
			cardRequiresBearer(
				card({ securitySchemes: { b: { httpAuthSecurityScheme: { scheme: "Basic", bearerFormat: "opaque" } } } }),
			),
		).toBe(false);
		expect(cardRequiresBearer(card({}))).toBe(false);
	});
});

describe("a2a.name card propagation", () => {
	type AgentRef = RegistryAgentRef;

	function mainRef(): AgentRef {
		const now = Date.now();
		return {
			id: "Main",
			displayName: "Main",
			kind: "main",
			parentId: "Main",
			status: "running",
			session: null,
			sessionFile: null,
			createdAt: now,
			lastActivity: now,
		} as unknown as AgentRef;
	}

	it("startA2aServer renames the card name, main skill id, and local bridge entry", async () => {
		using dir = TempDir.createSync("@a2a-name-card-");
		const registry = new Map<string, AgentRef>([["Main", mainRef()]]);
		const settings = await Settings.loadIsolated({ inMemory: true, agentDir: dir.path() });
		const handle = await startA2aServer({
			settings,
			agentDir: dir.path(),
			port: 0,
			name: "builder",
			registry: {
				get: (id: string) => registry.get(id),
				list: () => [...registry.values()],
				onChange: () => () => {},
				setStatus: () => false,
			} as unknown as Parameters<typeof startA2aServer>[0]["registry"],
			bus: { send: async () => ({ to: "Main", outcome: "injected" }) } as never,
			session: { cwd: dir.path(), getSessionAgents: () => [] },
		});
		try {
			const card = (await (await fetch(`${handle.url}${AGENT_CARD_PATH}`)).json()) as {
				name: string;
				skills: Array<{ id: string }>;
			};
			// The public identity is what peers auto-register as a2a:<name> and what
			// reply envelopes address; both the card name and the main skill id carry it.
			expect(card.name).toBe("builder");
			expect(card.skills.map(skill => skill.id)).toEqual(["builder"]);

			// The machine-local registry entry carries the same identity, so
			// `#ownA2aIdentity` stamps reply envelopes with it.
			const entry = await readLocalBridgeEntry(dir.path(), process.pid);
			expect(entry).toMatchObject({ pid: process.pid, port: handle.port, name: "builder" });
		} finally {
			handle.stop();
		}
	});

	it("a named terminal is addressed through its identity, not only its registry id", async () => {
		using dir = TempDir.createSync("@a2a-name-address-");
		const inbox: Array<{ to: string; body: string; external?: boolean }> = [];
		const registry = new Map<string, AgentRef>([["Main", mainRef()]]);
		const settings = await Settings.loadIsolated({ inMemory: true, agentDir: dir.path() });
		const handle = await startA2aServer({
			settings,
			agentDir: dir.path(),
			port: 0,
			name: "builder",
			registry: {
				get: (id: string) => registry.get(id),
				list: () => [...registry.values()],
				onChange: () => () => {},
				setStatus: () => false,
			} as unknown as Parameters<typeof startA2aServer>[0]["registry"],
			bus: {
				send: async (message: { to: string; body: string; external?: boolean }): Promise<IrcDeliveryReceipt> => {
					inbox.push({ to: message.to, body: message.body, external: message.external });
					return { to: message.to, outcome: "injected" };
				},
			} as never,
			session: { cwd: dir.path(), getSessionAgents: () => [] },
		});
		try {
			// A peer that registered this terminal's card sends to the skill id it
			// was given ("builder"); the bridge must resolve it back to Main.
			const token = await resolveA2aToken({ agentDir: dir.path() });
			const posted = await fetch(handle.url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "SendMessage",
					params: {
						message: { messageId: "m-name", role: "ROLE_USER", parts: [{ text: "reach me by identity" }] },
						metadata: { to: "builder" },
					},
				}),
			});
			const payload = (await posted.json()) as {
				result?: { task?: { metadata?: { delivery?: { outcome?: string } } } };
			};
			expect(payload.result?.task?.metadata?.delivery?.outcome).toBe("injected");
			expect(inbox).toHaveLength(1);
			expect(inbox[0]!.to).toBe("Main");
			expect(inbox[0]!.body).toBe("reach me by identity");
		} finally {
			handle.stop();
		}
	});
});

function outgoingRequest(overrides: Partial<OutgoingRequest> = {}): OutgoingRequest {
	return {
		messageId: "m1",
		peer: "peer-a",
		ownerId: "owner-a",
		jobId: "job-a",
		deadline: null,
		...overrides,
	};
}

/** A settlement hook that pauses the first claim so a second transition can queue behind it. */
function gateRegistry(): {
	registry: OutgoingRequests;
	entered: Promise<void>;
	release: () => void;
} {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let calls = 0;
	const registry = new OutgoingRequests({
		beforeCommit: async () => {
			calls++;
			if (calls === 1) {
				entered.resolve();
				await release.promise;
			}
		},
	});
	return { registry, entered: entered.promise, release: () => release.resolve() };
}

function trackSettlement(promise: Promise<string>): { settled: () => boolean; result: Promise<string> } {
	let settled = false;
	const result = promise.then(
		text => {
			settled = true;
			return text;
		},
		(error: unknown) => {
			settled = true;
			throw error;
		},
	);
	return { settled: () => settled, result };
}

function deliveryTask(outcome: "injected" | "failed" = "injected", error?: string): unknown {
	return {
		id: "remote-main",
		status: { state: outcome === "failed" ? TASK_STATE.FAILED : TASK_STATE.WORKING },
		metadata: {
			delivery: { to: "Main", outcome, ...(error !== undefined ? { error } : {}) },
		},
	};
}

function messageIdOf(call: { params: Record<string, unknown> }): string {
	const message = call.params.message;
	if (typeof message !== "object" || message === null) throw new Error("SendMessage had no message");
	const id = Reflect.get(message, "messageId");
	if (typeof id !== "string" || id.length === 0) throw new Error("SendMessage had no messageId");
	return id;
}

function localMainRef(): RegistryAgentRef {
	const now = Date.now();
	return {
		id: "Main",
		displayName: "Main",
		kind: "main",
		parentId: "Main",
		status: "idle",
		session: null,
		sessionFile: null,
		createdAt: now,
		lastActivity: now,
	} as unknown as RegistryAgentRef;
}

/** Inbound reply through the real dispatcher, recording any IRC copy. */
async function deliverReply(options: {
	messageId: string;
	from?: string;
	text: string;
	bus: Array<{ body: string }>;
	incoming?: IncomingRequests;
}): Promise<A2aTask> {
	const main = localMainRef();
	return sendA2aMessage(
		{
			message: {
				messageId: `reply-to-${options.messageId}`,
				role: "ROLE_USER",
				parts: [{ text: options.text }],
			},
			metadata: {
				to: "Main",
				...(options.from !== undefined ? { from: options.from } : {}),
				inReplyTo: options.messageId,
			},
		},
		{
			registry: {
				get: (id: string) => (id === "Main" || id === "main" ? main : undefined),
				list: () => [main],
				setStatus: () => false,
			},
			send: async message => {
				options.bus.push({ body: message.body });
				return { to: message.to, outcome: "injected" };
			},
			...(options.incoming !== undefined ? { incoming: options.incoming } : {}),
			outgoing: OutgoingRequests.global(),
		},
	);
}

function replyJob(result: { details?: unknown }): TaskToolDetails["async"] {
	return (result.details as TaskToolDetails | undefined)?.async;
}

async function stillPending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	const mark = () => {
		settled = true;
	};
	void promise.then(mark, mark);
	const flushed = Promise.withResolvers<void>();
	setImmediate(flushed.resolve);
	await flushed.promise;
	return !settled;
}

function captureOutgoing(): OutgoingRequest[] {
	const real = OutgoingRequests.global();
	const seen: OutgoingRequest[] = [];
	OutgoingRequests.installGlobal({
		register: async request => {
			seen.push({ ...request });
			await real.register(request);
		},
		wait: (messageId, signal) => real.wait(messageId, signal),
		resolve: (messageId, from, text) => real.resolve(messageId, from, text),
		fail: (messageId, reason) => real.fail(messageId, reason),
		cancel: messageId => real.cancel(messageId),
		hasOwner: ownerId => real.hasOwner(ownerId),
	});
	return seen;
}

describe("addressed A2A reply jobs", () => {
	const OWNER = "caller-a";

	function managerFor(): AsyncJobManager {
		return new AsyncJobManager({ onJobComplete: () => {} });
	}

	it("sends a caller-supplied messageId and generates omp-<uuid> when omitted", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: completedTask("ok") }),
		});
		const client = new A2aClient({ url: server.url });
		await client.sendMessage("hello", { messageId: "caller-supplied" });
		await client.sendAndWait("again", { messageId: "wait-supplied" });
		await client.sendMessage("generated");

		expect(messageIdOf(server.calls[0]!)).toBe("caller-supplied");
		expect(messageIdOf(server.calls[1]!)).toBe("wait-supplied");
		expect(messageIdOf(server.calls[2]!)).toMatch(
			/^omp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("treats an interrupted delivery receipt as a receipt rather than an interrupted task", async () => {
		const server = mockA2a({
			onRpc: () =>
				rpcResult(1, {
					task: {
						id: "remote-main",
						status: { state: TASK_STATE.INPUT_REQUIRED },
						metadata: { delivery: { to: "Main", outcome: "injected" } },
					},
				}),
		});
		const run = await new A2aClient({ url: server.url }).sendAndWait("hello");
		expect(run.state).toBe(TASK_STATE.INPUT_REQUIRED);
		expect(run.interrupted).toBe(false);
		expect(server.calls.map(call => call.method)).toEqual(["SendMessage"]);
	});

	for (const state of [TASK_STATE.COMPLETED, TASK_STATE.FAILED]) {
		it(`keeps the reply job running for a ${state} delivery with an old artifact`, async () => {
			const server = mockA2a({
				onRpc: () =>
					rpcResult(1, {
						task: {
							id: "remote-main",
							status: { state },
							metadata: { delivery: { to: "Main", outcome: "injected" } },
							artifacts: [{ artifactId: "old-output", parts: [{ text: "stale previous answer" }] }],
						},
					}),
			});
			const { bridge } = await registerFrom(server);
			const manager = managerFor();
			const tool = await createTaskTool(bridge, Settings.isolated(), {
				agentId: OWNER,
				asyncJobManager: manager,
			});
			const result = await tool.execute("tc-terminal-receipt", {
				agent: "a2a:main",
				task: "ask the peer",
			} as TaskParams);
			const job = replyJob(result);
			try {
				expect(job?.state).toBe("running");
				expect(job?.jobId).toBeString();
				expect(manager.getJob(job!.jobId)?.status).toBe("running");
				expect(textOf(result)).toContain("awaiting reply");
				expect(textOf(result)).not.toContain("stale previous answer");
				expect(server.calls.map(call => call.method)).toEqual(["SendMessage"]);
			} finally {
				if (job?.jobId) manager.cancel(job.jobId, { ownerId: OWNER });
			}
			expect(server.calls.every(call => call.method !== "CancelTask")).toBe(true);
		});
	}

	it("registers an owned running reply job before SendMessage and reports that job, not a completed task", async () => {
		const events: string[] = [];
		const seen = Promise.withResolvers<RpcCall>();
		const server = mockA2a({
			onRpc: call => {
				events.push("send");
				seen.resolve(call);
				return rpcResult(1, { task: deliveryTask() });
			},
		});
		const { bridge } = await registerFrom(server);
		const manager = managerFor();
		const original = manager.register.bind(manager);
		manager.register = ((type, label, run, options) => {
			events.push(`register:${type}:${options?.ownerId ?? ""}`);
			return original(type, label, run, options);
		}) as AsyncJobManager["register"];
		const registered = captureOutgoing();
		const tool = await createTaskTool(bridge, Settings.isolated(), {
			agentId: OWNER,
			asyncJobManager: manager,
		});

		const executing = tool.execute("tc-addressed", { agent: "a2a:main", task: "ask the peer" } as TaskParams);
		await seen.promise;
		expect(events[0]).toBe(`register:task:${OWNER}`);
		expect(events[1]).toBe("send");
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(true);
		expect(registered[0]).toMatchObject({
			messageId: messageIdOf(server.calls[0]!),
			peer: "omp",
			ownerId: OWNER,
		});
		const running = manager.getRunningJobs({ ownerId: OWNER });
		expect(running).toHaveLength(1);
		expect(running[0]?.id).toBe(registered[0]?.jobId);
		expect(AsyncJobManager.instance()).toBeUndefined();

		const result = await executing;
		const text = textOf(result);
		const job = replyJob(result);
		expect(text).toContain("Delivered");
		expect(text).toContain("awaiting reply");
		expect(text).toContain(running[0]!.id);
		expect(text).not.toContain("<task-result");
		expect(job).toEqual({ state: "running", jobId: running[0]!.id, type: "task" });
		expect(manager.getJob(job!.jobId)?.status).toBe("running");
		expect(manager.getJob(job!.jobId)?.ownerId).toBe(OWNER);
		expect(manager.cancel(job!.jobId, { ownerId: "other-owner" })).toBe(false);
		manager.cancel(job!.jobId, { ownerId: OWNER });
	});

	it("completes the owned job once when the matching reply arrives before the receipt, with no IRC copy", async () => {
		const hold = Promise.withResolvers<unknown>();
		const seen = Promise.withResolvers<RpcCall>();
		const server = mockA2a({
			onRpc: call => {
				seen.resolve(call);
				return hold.promise;
			},
		});
		const { bridge } = await registerFrom(server);
		const manager = managerFor();
		const tool = await createTaskTool(bridge, Settings.isolated(), {
			agentId: OWNER,
			asyncJobManager: manager,
		});
		const executing = tool.execute("tc-early", { agent: "a2a:main", task: "ask early" } as TaskParams);
		try {
			const call = await seen.promise;
			const bus: Array<{ body: string }> = [];
			const incoming = new IncomingRequests();
			await deliverReply({
				messageId: messageIdOf(call),
				from: "omp",
				text: "early answer",
				bus,
				incoming,
			});
			expect(bus).toEqual([]);
			expect(await incoming.list()).toEqual([]);
			hold.resolve(rpcResult(1, { task: deliveryTask() }));
			const result = await executing;
			const jobId = replyJob(result)?.jobId;
			expect(jobId).toBeString();
			await manager.getJob(jobId!)!.promise;
			expect(manager.getJob(jobId!)).toMatchObject({ status: "completed", resultText: "early answer" });
			const ownerWait = await new WaitTool(
				toolSession(bridge, Settings.isolated(), await tempDir(), { agentId: OWNER, asyncJobManager: manager }),
			).execute("wait-owner", {});
			expect(textOf(ownerWait)).toContain("early answer");
			expect(textOf(ownerWait).match(/early answer/g)).toHaveLength(1);
			const otherWait = await new WaitTool(
				toolSession(bridge, Settings.isolated(), await tempDir(), {
					agentId: "other-owner",
					asyncJobManager: manager,
				}),
			).execute("wait-other", {});
			expect(textOf(otherWait)).not.toContain("early answer");
			expect(textOf(otherWait)).toContain("Nothing to wait for");
		} finally {
			hold.resolve(rpcResult(1, { task: deliveryTask() }));
		}
	});

	it("cancels the owned job when the tool signal aborts while SendMessage is held", async () => {
		const hold = Promise.withResolvers<unknown>();
		const seen = Promise.withResolvers<RpcCall>();
		const server = mockA2a({
			onRpc: call => {
				seen.resolve(call);
				return hold.promise;
			},
		});
		const { bridge } = await registerFrom(server);
		const manager = managerFor();
		const tool = await createTaskTool(bridge, Settings.isolated(), {
			agentId: OWNER,
			asyncJobManager: manager,
		});
		const controller = new AbortController();
		const executing = tool.execute(
			"tc-abort",
			{ agent: "a2a:main", task: "abort while sending" } as TaskParams,
			controller.signal,
		);
		try {
			await seen.promise;
			expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(true);
			controller.abort();
			await executing;
			expect(manager.getAllJobs({ ownerId: OWNER })[0]).toMatchObject({ status: "cancelled" });
			expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(false);
		} finally {
			hold.resolve(rpcResult(1, { task: deliveryTask() }));
		}
	});

	it("completes the owned job once when the matching reply arrives after the receipt, with no IRC copy", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: deliveryTask() }),
		});
		const { bridge } = await registerFrom(server);
		const manager = managerFor();
		const delivered: string[] = [];
		manager.registerDeliverySink(OWNER, (_jobId, text) => {
			delivered.push(text);
		});
		const tool = await createTaskTool(bridge, Settings.isolated(), {
			agentId: OWNER,
			asyncJobManager: manager,
		});
		const result = await tool.execute("tc-late", { agent: "a2a:main", task: "ask late" } as TaskParams);
		const jobId = replyJob(result)?.jobId;
		expect(jobId).toBeString();
		expect(manager.getJob(jobId!)?.status).toBe("running");
		const bus: Array<{ body: string }> = [];
		await deliverReply({
			messageId: messageIdOf(server.calls[0]!),
			from: "omp",
			text: "late answer",
			bus,
		});
		expect(bus).toEqual([]);
		await manager.getJob(jobId!)!.promise;
		expect(manager.getJob(jobId!)).toMatchObject({ status: "completed", resultText: "late answer" });
		const again: Array<{ body: string }> = [];
		await deliverReply({
			messageId: messageIdOf(server.calls[0]!),
			from: "omp",
			text: "late answer",
			bus: again,
		});
		expect(again).toHaveLength(1);
		expect(manager.getJob(jobId!)?.resultText).toBe("late answer");
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(delivered).toEqual(["late answer"]);
	});

	it("matches the remote terminal identity, not the addressed skill id or display alias", async () => {
		const alpha = mockA2a({
			name: "alpha",
			skills: [{ id: "Reviewer", displayName: "Reviewer Alias", description: "reviews" }],
			onRpc: () => rpcResult(1, { task: deliveryTask() }),
		});
		const beta = mockA2a({
			name: "beta",
			skills: [{ id: "Reviewer", displayName: "Reviewer Alias", description: "reviews" }],
			onRpc: () => rpcResult(1, { task: deliveryTask() }),
		});
		const bridge = new A2aAgentBridge();
		const agentDir = await tempDir();
		await addA2aAgentsFromUrl({ bridge, url: alpha.url, agentDir });
		await addA2aAgentsFromUrl({ bridge, url: beta.url, agentDir });
		const target = bridge.list().find(agent => agent.url === beta.url);
		expect(target).toMatchObject({ name: "a2a:Reviewer-2", skillId: "Reviewer", cardName: "beta" });
		const manager = managerFor();
		const registered = captureOutgoing();
		const tool = await createTaskTool(bridge, Settings.isolated(), {
			agentId: OWNER,
			asyncJobManager: manager,
		});
		const result = await tool.execute("tc-skill", {
			agent: target!.name,
			task: "review this",
		} as TaskParams);
		const jobId = replyJob(result)?.jobId;
		expect(jobId).toBeString();
		expect(registered[0]?.peer).toBe("beta");
		const messageId = messageIdOf(beta.calls[0]!);
		for (const from of ["Reviewer", "Reviewer Alias", "alpha"]) {
			const bus: Array<{ body: string }> = [];
			await deliverReply({ messageId, from, text: `nope-${from}`, bus });
			expect(bus).toHaveLength(1);
			expect(manager.getJob(jobId!)?.status).toBe("running");
		}
		const matched: Array<{ body: string }> = [];
		await deliverReply({ messageId, from: "beta", text: "terminal answer", bus: matched });
		expect(matched).toEqual([]);
		await manager.getJob(jobId!)!.promise;
		expect(manager.getJob(jobId!)?.resultText).toBe("terminal answer");
	});

	it("fails the job and drops the expectation when transport or the delivery receipt fails", async () => {
		const transport = mockA2a({
			onRpc: () => rpcResult(-32603, { message: "connection reset" }),
		});
		const transportBridge = (await registerFrom(transport)).bridge;
		const transportManager = managerFor();
		const transportDelivered: string[] = [];
		transportManager.registerDeliverySink(OWNER, (_jobId, text) => {
			transportDelivered.push(text);
		});
		const transportTool = await createTaskTool(transportBridge, Settings.isolated(), {
			agentId: OWNER,
			asyncJobManager: transportManager,
		});
		const transportResult = await transportTool.execute("tc-transport", {
			agent: "a2a:main",
			task: "unreachable",
		} as TaskParams);
		expect(textOf(transportResult)).not.toContain("awaiting reply");
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(false);
		const transportJobs = transportManager.getAllJobs({ ownerId: OWNER });
		expect(transportJobs).toHaveLength(1);
		expect(transportJobs[0]?.status).toBe("failed");

		await transportManager.drainDeliveries({ timeoutMs: 1_000 });
		expect(transportDelivered).toEqual([]);

		const receipt = mockA2a({
			onRpc: () => rpcResult(1, { task: deliveryTask("failed", "agent is gone") }),
		});
		const receiptBridge = (await registerFrom(receipt)).bridge;
		const receiptManager = managerFor();
		const receiptDelivered: string[] = [];
		receiptManager.registerDeliverySink("caller-b", (_jobId, text) => {
			receiptDelivered.push(text);
		});
		const receiptTool = await createTaskTool(receiptBridge, Settings.isolated(), {
			agentId: "caller-b",
			asyncJobManager: receiptManager,
		});
		const receiptResult = await receiptTool.execute("tc-receipt", {
			agent: "a2a:main",
			task: "missing agent",
		} as TaskParams);
		expect(textOf(receiptResult)).toContain("agent is gone");
		expect(textOf(receiptResult)).not.toContain("awaiting reply");
		expect(OutgoingRequests.global().hasOwner("caller-b")).toBe(false);
		expect(receiptManager.getAllJobs({ ownerId: "caller-b" })[0]).toMatchObject({
			status: "failed",
			errorText: expect.stringContaining("agent is gone"),
		});
		await receiptManager.drainDeliveries({ timeoutMs: 1_000 });
		expect(receiptDelivered).toEqual([]);
	});

	it("fails the reply job on the reply deadline and leaves a zero deadline running", async () => {
		vi.useFakeTimers();
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: deliveryTask() }),
		});
		const { bridge } = await registerFrom(server);
		const timed = managerFor();
		const timedTool = await createTaskTool(bridge, Settings.isolated({ "a2a.replyTimeoutMs": 5_000 }), {
			agentId: OWNER,
			asyncJobManager: timed,
		});
		const timedResult = await timedTool.execute("tc-deadline", {
			agent: "a2a:main",
			task: "expire",
		} as TaskParams);
		const timedJobId = replyJob(timedResult)?.jobId;
		expect(timed.getJob(timedJobId!)?.status).toBe("running");
		vi.advanceTimersByTime(4_999);
		await Promise.resolve();
		expect(timed.getJob(timedJobId!)?.status).toBe("running");
		vi.advanceTimersByTime(1);
		await Promise.resolve();
		await timed.getJob(timedJobId!)!.promise;
		expect(timed.getJob(timedJobId!)).toMatchObject({
			status: "failed",
			errorText: expect.stringContaining("reply timeout"),
		});
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(false);

		const open = managerFor();
		const openTool = await createTaskTool(bridge, Settings.isolated({ "a2a.replyTimeoutMs": 0 }), {
			agentId: "caller-open",
			asyncJobManager: open,
		});
		const openResult = await openTool.execute("tc-open", { agent: "a2a:main", task: "no deadline" } as TaskParams);
		const openJobId = replyJob(openResult)?.jobId;
		vi.advanceTimersByTime(60 * 60 * 1000);
		await Promise.resolve();
		expect(open.getJob(openJobId!)?.status).toBe("running");
		expect(OutgoingRequests.global().hasOwner("caller-open")).toBe(true);
		open.cancel(openJobId!, { ownerId: "caller-open" });
	});

	it("cancels only the local wait and sends no remote CancelTask", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: deliveryTask() }),
		});
		const { bridge } = await registerFrom(server);
		const manager = managerFor();
		const tool = await createTaskTool(bridge, Settings.isolated(), {
			agentId: OWNER,
			asyncJobManager: manager,
		});
		const result = await tool.execute("tc-cancel", { agent: "a2a:main", task: "cancel me" } as TaskParams);
		const jobId = replyJob(result)?.jobId;
		expect(manager.cancel(jobId!, { ownerId: OWNER })).toBe(true);
		await manager.getJob(jobId!)!.promise;
		expect(manager.getJob(jobId!)?.status).toBe("cancelled");
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(false);
		expect(server.calls.every(call => call.method !== "CancelTask")).toBe(true);
		const bus: Array<{ body: string }> = [];
		await deliverReply({
			messageId: messageIdOf(server.calls[0]!),
			from: "omp",
			text: "too late",
			bus,
		});
		expect(bus).toHaveLength(1);
	});

	it("does not open a reply job for an outbound reply or an a2aSpawn", async () => {
		const server = mockA2a({
			onRpc: call =>
				rpcResult(1, {
					task:
						call.params.metadata && Reflect.get(call.params.metadata, "spawn") === true
							? completedTask("spawned output")
							: deliveryTask(),
				}),
		});
		const { bridge } = await registerFrom(server);
		await IncomingRequests.global().note({ from: "main", messageId: "owed-1", to: OWNER, at: 1 });
		await IncomingRequests.global().note({ from: "main", messageId: "owed-2", to: OWNER, at: 2 });
		await IncomingRequests.global().note({ from: "main", messageId: "main-owed", to: "Main", at: 0 });
		const manager = managerFor();
		const registered = captureOutgoing();
		const tool = await createTaskTool(bridge, Settings.isolated(), {
			agentId: OWNER,
			asyncJobManager: manager,
		});
		const reply = await tool.execute("tc-reply", { agent: "a2a:main", task: "the answer" } as TaskParams);
		expect(server.calls[0]?.params.metadata).toMatchObject({ inReplyTo: "owed-1" });
		expect((await IncomingRequests.global().list(OWNER)).map(request => request.messageId)).toEqual(["owed-2"]);
		expect((await IncomingRequests.global().list("Main")).map(request => request.messageId)).toEqual(["main-owed"]);
		expect(registered).toEqual([]);
		expect(manager.getAllJobs({ ownerId: OWNER })).toEqual([]);
		expect(replyJob(reply)).toBeUndefined();

		const spawned = await tool.execute("tc-spawn", {
			agent: "a2a:main",
			task: "create one",
			a2aSpawn: true,
		} as TaskParams);
		expect(server.calls[1]?.params.metadata).toMatchObject({ spawn: true });
		expect(server.calls[1]?.params.metadata).not.toHaveProperty("to");
		expect(textOf(spawned)).toContain("spawned output");
		expect(textOf(spawned)).toContain('status="completed"');
		expect(registered).toEqual([]);
		expect(manager.getAllJobs({ ownerId: OWNER })).toEqual([]);
	});

	it("sends only the explicit Main task reply when the relay sees the same request", async () => {
		const server = mockA2a({ onRpc: () => rpcResult(1, { task: deliveryTask() }) });
		const { bridge } = await registerFrom(server);
		const manager = managerFor();
		const tool = await createTaskTool(bridge, Settings.isolated(), { asyncJobManager: manager });
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		let relaySends = 0;
		const relay = installA2aReplyRelay({
			bridge,
			subscribe: next => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			identity: async () => ({}),
			rescan: async () => {},
			send: options => {
				relaySends += 1;
				return spawnA2aAgent(options);
			},
		});
		try {
			await IncomingRequests.global().note({ from: "main", messageId: "shared-request", to: "Main", at: 100 });
			const reply = await tool.execute("tc-explicit-reply", {
				agent: "a2a:main",
				task: "explicit answer",
			} as TaskParams);
			expect(replyJob(reply)).toBeUndefined();
			expect(server.calls).toHaveLength(1);
			expect(server.calls[0]?.params.metadata).toMatchObject({ inReplyTo: "shared-request" });

			listener?.({
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "also answered" }],
						timestamp: 150,
						stopReason: "stop",
					},
				],
			} as AgentSessionEvent);
			await relay.settled();
			expect(relaySends).toBe(0);
			expect(server.calls).toHaveLength(1);
			expect(await IncomingRequests.global().list("Main")).toEqual([]);
		} finally {
			relay.stop();
		}
	});

	it("waits inline for the reply when the session has no async manager", async () => {
		const seen = Promise.withResolvers<RpcCall>();
		const server = mockA2a({
			onRpc: call => {
				seen.resolve(call);
				return rpcResult(1, { task: deliveryTask() });
			},
		});
		const { bridge } = await registerFrom(server);
		const tool = await createTaskTool(bridge, Settings.isolated({ "a2a.replyTimeoutMs": 0 }), {
			agentId: OWNER,
		});
		const pending = tool.execute("tc-inline", { agent: "a2a:main", task: "ask inline" } as TaskParams);
		const call = await seen.promise;
		expect(await stillPending(pending)).toBe(true);
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(true);
		const bus: Array<{ body: string }> = [];
		await deliverReply({
			messageId: messageIdOf(call),
			from: "omp",
			text: "inline answer",
			bus,
		});
		expect(bus).toEqual([]);
		expect(textOf(await pending)).toBe("inline answer");
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(false);
	});

	it("fails the inline wait at the same reply deadline", async () => {
		vi.useFakeTimers();
		const seen = Promise.withResolvers<RpcCall>();
		const server = mockA2a({
			onRpc: call => {
				seen.resolve(call);
				return rpcResult(1, { task: deliveryTask() });
			},
		});
		const { bridge } = await registerFrom(server);
		const tool = await createTaskTool(bridge, Settings.isolated({ "a2a.replyTimeoutMs": 5_000 }), {
			agentId: OWNER,
		});
		const pending = tool.execute("tc-inline-timeout", { agent: "a2a:main", task: "expire inline" } as TaskParams);
		await seen.promise;
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(true);
		vi.advanceTimersByTime(4_999);
		await Promise.resolve();
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(true);
		vi.advanceTimersByTime(1);
		await Promise.resolve();
		expect(textOf(await pending)).toContain("reply timeout");
		expect(OutgoingRequests.global().hasOwner(OWNER)).toBe(false);
	});

	it("keeps two caller owners distinct on the process registry", async () => {
		const server = mockA2a({
			onRpc: () => rpcResult(1, { task: deliveryTask() }),
		});
		const { bridge } = await registerFrom(server);
		const manager = managerFor();
		const toolA = await createTaskTool(bridge, Settings.isolated(), {
			agentId: "owner-a",
			asyncJobManager: manager,
		});
		const toolB = await createTaskTool(bridge, Settings.isolated(), {
			agentId: "owner-b",
			asyncJobManager: manager,
		});
		const resultA = await toolA.execute("tc-a", { agent: "a2a:main", task: "question a" } as TaskParams);
		const resultB = await toolB.execute("tc-b", { agent: "a2a:main", task: "question b" } as TaskParams);
		const jobA = replyJob(resultA)?.jobId;
		const jobB = replyJob(resultB)?.jobId;
		expect(jobA).toBeString();
		expect(jobB).toBeString();
		expect(jobA).not.toBe(jobB);
		expect(OutgoingRequests.global().hasOwner("owner-a")).toBe(true);
		expect(OutgoingRequests.global().hasOwner("owner-b")).toBe(true);
		const bus: Array<{ body: string }> = [];
		await deliverReply({
			messageId: messageIdOf(server.calls[0]!),
			from: "omp",
			text: "answer a",
			bus,
		});
		expect(bus).toEqual([]);
		await manager.getJob(jobA!)!.promise;
		expect(manager.getJob(jobA!)?.resultText).toBe("answer a");
		expect(manager.getJob(jobB!)?.status).toBe("running");
		expect(OutgoingRequests.global().hasOwner("owner-a")).toBe(false);
		expect(OutgoingRequests.global().hasOwner("owner-b")).toBe(true);
		manager.cancel(jobB!, { ownerId: "owner-b" });
	});
});

describe("outgoing request registry", () => {
	afterEach(() => {
		vi.useRealTimers();
		OutgoingRequests.resetGlobalForTests();
	});

	it("installs a process-wide singleton", () => {
		const installed = new OutgoingRequests();
		OutgoingRequests.installGlobal(installed);
		expect(OutgoingRequests.global()).toBe(installed);
		OutgoingRequests.resetGlobalForTests();
		const created = OutgoingRequests.global();
		expect(created).not.toBe(installed);
		expect(created).toBeInstanceOf(OutgoingRequests);
		expect(OutgoingRequests.global()).toBe(created);
	});

	it("settles only the matching peer and id, and a second resolve loses", async () => {
		const registry = new OutgoingRequests();
		await registry.register(outgoingRequest());
		await registry.register(outgoingRequest({ messageId: "m2", peer: "peer-b", ownerId: "owner-b", jobId: "job-b" }));
		const own = trackSettlement(registry.wait("m1"));
		const other = trackSettlement(registry.wait("m2"));

		expect(await registry.resolve("m1", "peer-b", "wrong peer")).toBe(false);
		expect(await registry.resolve("missing", "peer-a", "unknown")).toBe(false);
		expect(own.settled()).toBe(false);
		expect(other.settled()).toBe(false);
		expect(registry.hasOwner("owner-a")).toBe(true);
		expect(registry.hasOwner("owner-b")).toBe(true);

		expect(await registry.resolve("m1", "peer-a", "exact-a")).toBe(true);
		expect(await own.result).toBe("exact-a");
		expect(other.settled()).toBe(false);
		expect(registry.hasOwner("owner-a")).toBe(false);
		expect(registry.hasOwner("owner-b")).toBe(true);
		expect(await registry.resolve("m1", "peer-a", "again")).toBe(false);
		expect(other.settled()).toBe(false);

		await registry.cancel("m2");
		await expect(other.result).rejects.toThrow("cancelled");
	});

	it("rejects duplicate registration and keeps a fast reply for a late wait", async () => {
		const registry = new OutgoingRequests();
		await registry.register(outgoingRequest());
		await expect(registry.register(outgoingRequest())).rejects.toThrow("already registered");

		expect(await registry.resolve("m1", "peer-a", "fast reply")).toBe(true);
		expect(registry.hasOwner("owner-a")).toBe(true);
		expect(await registry.resolve("m1", "peer-a", "second")).toBe(false);
		expect(await registry.wait("m1")).toBe("fast reply");
		expect(registry.hasOwner("owner-a")).toBe(false);
		await expect(registry.wait("m1")).rejects.toThrow("unknown outgoing request");
	});

	it("fails a deadline with reply timeout and leaves a null deadline open under fake time", async () => {
		vi.useFakeTimers();
		const registry = new OutgoingRequests();
		const deadline = Date.now() + 5_000;
		await registry.register(outgoingRequest({ messageId: "timed", deadline }));
		await registry.register(outgoingRequest({ messageId: "open", ownerId: "owner-open", jobId: "job-open" }));
		await registry.register(
			outgoingRequest({ messageId: "past", ownerId: "owner-past", jobId: "job-past", deadline: Date.now() - 1 }),
		);
		const timed = registry.wait("timed");
		const open = trackSettlement(registry.wait("open"));
		const past = registry.wait("past");

		vi.advanceTimersByTime(1);
		await expect(past).rejects.toThrow("reply timeout");
		expect(registry.hasOwner("owner-past")).toBe(false);

		vi.advanceTimersByTime(4_998);
		await Promise.resolve();
		expect(registry.hasOwner("owner-a")).toBe(true);
		vi.advanceTimersByTime(1);
		await expect(timed).rejects.toThrow("reply timeout");
		expect(registry.hasOwner("owner-a")).toBe(false);

		vi.advanceTimersByTime(60 * 60 * 1000);
		await Promise.resolve();
		await Promise.resolve();
		expect(open.settled()).toBe(false);
		expect(registry.hasOwner("owner-open")).toBe(true);
		expect(await registry.cancel("open")).toBe(true);
		await expect(open.result).rejects.toThrow("cancelled");
	});

	it("fail and cancel remove ownership and reject the waiter", async () => {
		const registry = new OutgoingRequests();
		await registry.register(outgoingRequest());
		await registry.register(outgoingRequest({ messageId: "m2", peer: "peer-b", ownerId: "owner-b", jobId: "job-b" }));
		const failed = registry.wait("m1");
		const cancelled = registry.wait("m2");

		expect(await registry.fail("m1", "delivery failed")).toBe(true);
		await expect(failed).rejects.toThrow("delivery failed");
		expect(registry.hasOwner("owner-a")).toBe(false);
		expect(await registry.fail("m1", "again")).toBe(false);

		expect(await registry.cancel("m2")).toBe(true);
		await expect(cancelled).rejects.toThrow("cancelled");
		expect(registry.hasOwner("owner-b")).toBe(false);
		expect(await registry.cancel("m2")).toBe(false);
		expect(await registry.cancel("missing")).toBe(false);
	});

	it("lets the first gated settlement win against a timeout", async () => {
		vi.useFakeTimers();
		const { registry, entered, release } = gateRegistry();
		await registry.register(outgoingRequest({ deadline: Date.now() + 1_000 }));
		const waiting = trackSettlement(registry.wait("m1"));

		const resolving = registry.resolve("m1", "peer-a", "won the race");
		await entered;
		vi.advanceTimersByTime(1_000);
		release();

		expect(await resolving).toBe(true);
		expect(await waiting.result).toBe("won the race");
		expect(waiting.settled()).toBe(true);
		expect(registry.hasOwner("owner-a")).toBe(false);
		expect(await registry.resolve("m1", "peer-a", "late")).toBe(false);
	});

	it("lets a gated timeout win against resolve", async () => {
		vi.useFakeTimers();
		const { registry, entered, release } = gateRegistry();
		await registry.register(outgoingRequest({ deadline: Date.now() + 1_000 }));
		const waiting = registry.wait("m1");

		vi.advanceTimersByTime(1_000);
		await entered;
		const resolving = registry.resolve("m1", "peer-a", "too late");
		release();

		expect(await resolving).toBe(false);
		await expect(waiting).rejects.toThrow("reply timeout");
		expect(registry.hasOwner("owner-a")).toBe(false);
	});

	it("lets the first gated settlement win between cancel and resolve", async () => {
		const resolveFirst = gateRegistry();
		await resolveFirst.registry.register(outgoingRequest());
		const resolveWait = resolveFirst.registry.wait("m1");
		const resolving = resolveFirst.registry.resolve("m1", "peer-a", "resolved");
		await resolveFirst.entered;
		const cancelling = resolveFirst.registry.cancel("m1");
		resolveFirst.release();
		expect(await resolving).toBe(true);
		expect(await cancelling).toBe(false);
		expect(await resolveWait).toBe("resolved");

		const cancelFirst = gateRegistry();
		await cancelFirst.registry.register(outgoingRequest({ messageId: "m2", jobId: "job-2" }));
		const cancelWait = cancelFirst.registry.wait("m2");
		const cancellingFirst = cancelFirst.registry.cancel("m2");
		await cancelFirst.entered;
		const resolvingSecond = cancelFirst.registry.resolve("m2", "peer-a", "nope");
		cancelFirst.release();
		expect(await cancellingFirst).toBe(true);
		expect(await resolvingSecond).toBe(false);
		await expect(cancelWait).rejects.toThrow("cancelled");
		expect(cancelFirst.registry.hasOwner("owner-a")).toBe(false);
	});

	it("rejects a registration already queued when its worker home exits, then forgets that home", async () => {
		const registry = new OutgoingRequests();
		await registry.register(outgoingRequest(), "w-dead");
		const waiting = registry.wait("m1");
		await Promise.resolve();
		expect(registry.hasWaiter("m1")).toBe(true);

		const queued = registry.register(
			outgoingRequest({ messageId: "inflight", ownerId: "inflight-owner", jobId: "inflight-job" }),
			"w-dead",
		);
		registry.dropHome("w-dead");
		await expect(waiting).rejects.toThrow("owner exited");
		await expect(queued).rejects.toThrow("owner exited");
		expect(registry.hasOwner("owner-a")).toBe(false);
		expect(registry.hasOwner("inflight-owner")).toBe(false);
		expect(registry.hasWaiter("m1")).toBe(false);
		expect(await registry.resolve("m1", "peer-a", "gone")).toBe(false);

		// The dead-home mark only blocks registers already queued at exit.
		await registry.register(
			outgoingRequest({ messageId: "after", ownerId: "after-owner", jobId: "after-job" }),
			"w-dead",
		);
		expect(registry.hasOwner("after-owner")).toBe(true);
		await registry.cancel("after");

		await registry.register(
			outgoingRequest({ messageId: "live", ownerId: "live-owner", jobId: "live-job" }),
			"w-live",
		);
		registry.dropHome("w-dead");
		expect(registry.hasOwner("live-owner")).toBe(true);
		await registry.cancel("live");
	});

	it("drops the entry when a reply follows an aborted wait, and cancel with no waiter leaves nothing", async () => {
		const registry = new OutgoingRequests();
		await registry.register(outgoingRequest());
		const controller = new AbortController();
		const aborted = registry.wait("m1", controller.signal);
		await Promise.resolve();
		expect(registry.hasWaiter("m1")).toBe(true);

		controller.abort();
		await expect(aborted).rejects.toThrow();
		expect(registry.hasWaiter("m1")).toBe(false);
		expect(registry.hasOwner("owner-a")).toBe(true);

		expect(await registry.resolve("m1", "peer-a", "after abort")).toBe(true);
		expect(registry.hasOwner("owner-a")).toBe(false);
		expect(await registry.cancel("m1")).toBe(false);
		await expect(registry.wait("m1")).rejects.toThrow("unknown outgoing request");

		await registry.register(outgoingRequest({ messageId: "bare", ownerId: "owner-bare", jobId: "job-bare" }));
		expect(await registry.cancel("bare")).toBe(true);
		expect(registry.hasOwner("owner-bare")).toBe(false);
		await expect(registry.wait("bare")).rejects.toThrow("unknown outgoing request");
		expect(await registry.cancel("bare")).toBe(false);
	});

	it("discards a kept result on cancel without treating the request as still open", async () => {
		const registry = new OutgoingRequests();
		await registry.register(outgoingRequest());
		expect(await registry.resolve("m1", "peer-a", "kept")).toBe(true);
		expect(registry.hasOwner("owner-a")).toBe(true);
		expect(await registry.cancel("m1")).toBe(false);
		expect(registry.hasOwner("owner-a")).toBe(false);
		await expect(registry.wait("m1")).rejects.toThrow("unknown outgoing request");
	});

	it("counts a kept unread reply as owned until a waiter takes it", async () => {
		const registry = new OutgoingRequests();
		await registry.register(outgoingRequest());
		expect(await registry.resolve("m1", "peer-a", "early")).toBe(true);
		expect(registry.hasOwner("owner-a")).toBe(true);
		expect(await registry.wait("m1")).toBe("early");
		expect(registry.hasOwner("owner-a")).toBe(false);
	});

	it("re-arms a deadline above the setTimeout ceiling instead of firing early", async () => {
		vi.useFakeTimers();
		const ceiling = 2 ** 31 - 1;
		const extra = 1_000;
		const registry = new OutgoingRequests();
		const deadline = Date.now() + ceiling * 2 + extra;
		await registry.register(
			outgoingRequest({ messageId: "long", ownerId: "owner-long", jobId: "job-long", deadline }),
		);
		const waiting = registry.wait("long");
		const flush = async (): Promise<void> => {
			await Promise.resolve();
			await Promise.resolve();
		};

		vi.advanceTimersByTime(ceiling);
		await flush();
		expect(registry.hasOwner("owner-long")).toBe(true);

		vi.advanceTimersByTime(ceiling);
		await flush();
		expect(registry.hasOwner("owner-long")).toBe(true);

		vi.advanceTimersByTime(extra);
		await expect(waiting).rejects.toThrow("reply timeout");
		expect(registry.hasOwner("owner-long")).toBe(false);
	});

	it("lets the first of two gated resolves win and delivers its text", async () => {
		const { registry, entered, release } = gateRegistry();
		await registry.register(outgoingRequest());
		const waiting = registry.wait("m1");
		const first = registry.resolve("m1", "peer-a", "first text");
		await entered;
		const second = registry.resolve("m1", "peer-a", "second text");
		release();
		expect(await Promise.all([first, second])).toEqual([true, false]);
		expect(await waiting).toBe("first text");
	});
});
