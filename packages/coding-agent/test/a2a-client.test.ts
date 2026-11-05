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
	fetchAgentCard,
	resolveAgentCardUrl,
} from "@oh-my-pi/pi-coding-agent/a2a/client";
import {
	A2A_AUTH_REQUIRED_TEXT,
	A2A_WAITING_FOR_INPUT_TEXT,
	A2aAgentBridge,
	addA2aAgentsFromUrl,
} from "@oh-my-pi/pi-coding-agent/a2a/agent-bridge";
import { AGENT_CARD_PATH, type A2aServerHandle, createA2aServer } from "@oh-my-pi/pi-coding-agent/a2a/server";
import { type AgentCard, buildAgentCard } from "@oh-my-pi/pi-coding-agent/a2a/card";
import { TASK_STATE } from "@oh-my-pi/pi-coding-agent/a2a/rpc";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";

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
	options: { frozenSessionAgents?: boolean } = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getA2aBridge: () => bridge,
		...(options.frozenSessionAgents ? { getSessionAgents: () => [], advertisedSessionAgents: () => [] } : {}),
	} as unknown as ToolSession;
}

async function createTaskTool(
	bridge: A2aAgentBridge,
	settings: Settings = Settings.isolated(),
	options: { frozenSessionAgents?: boolean } = {},
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
				await tool.execute("tc-a2a-loop", { agent: "a2a:main", task: "run the loop" } as TaskParams),
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
