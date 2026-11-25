/**
 * RPC host URI schemes belong to the session `set_host_uri_schemes` reached and to the
 * task subagents it runs on its thread, fresh or cold-revived; no other session resolves them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockHandler, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, setInteractiveHost } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/sdk-host-uri-sessions";
const MODEL = "mock/mock-model";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "Do the assigned work.",
	tools: ["read"],
	source: "bundled",
};

const call = (name: string, args: Record<string, unknown>): MockResponse => ({
	content: [{ type: "toolCall", name, arguments: args }],
});

let savedEnv: Record<string, string | undefined> = {};
let savedInteractiveHost: boolean;
let root: string;
let authStorage: AuthStorage;
const sessions: AgentSession[] = [];

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

/** Text of a read through `session`'s own read tool; a failure's message when it throws. */
async function readThrough(session: AgentSession, url: string): Promise<string> {
	const read = session.getToolByName("read");
	if (!read) throw new Error("Expected a read tool");
	try {
		const result = await read.execute(`read-${url}`, { path: url });
		return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** The host side of `set_host_uri_schemes` for `session`, answering every request and recording its URL. */
function bindHost(session: AgentSession): { bridge: RpcHostUriBridge; requests: string[] } {
	const requests: string[] = [];
	const bridge: RpcHostUriBridge = new RpcHostUriBridge(frame => {
		if (frame.type !== "host_uri_request") return;
		requests.push(frame.url);
		bridge.handleResult({ type: "host_uri_result", id: frame.id, content: `payload of ${frame.url}` });
	}, session.urlSchemes.hostUris);
	return { bridge, requests };
}

/** Options for real sessions in `cwd` whose subagents run on the scripted mock model. */
function sessionOptions(cwd: string, handler: MockHandler) {
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({ handler });
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"task.isolation.enabled": false,
		"task.agentIdleTtlMs": 0,
		"task.workerThreads": 0,
		modelRoles: { default: MODEL },
	});
	const base: CreateAgentSessionOptions = {
		cwd,
		authStorage,
		modelRegistry,
		settings,
		model: mock,
		toolNames: ["read", "task"],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
	};
	const open = async (options: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> => {
		const { session } = await createAgentSession({
			...base,
			sessionManager: SessionManager.inMemory(cwd),
			...options,
		});
		sessions.push(session);
		return session;
	};
	return { open, modelRegistry, settings };
}

beforeEach(async () => {
	savedInteractiveHost = setInteractiveHost(false);
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-uri-sessions-"));
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
});

afterEach(async () => {
	for (const session of sessions.splice(0).reverse()) await session.dispose();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	authStorage.close();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	setInteractiveHost(savedInteractiveHost);
	await removeWithRetries(root);
});

describe("RPC host URI schemes across sessions", () => {
	it("reach the RPC session's tools and the task subagents it runs, never a sibling session", async () => {
		const cwd = path.join(root, "home", "work");
		const childReads: string[] = [];
		// Only the child prompts the model: it reads one row, then answers.
		const { open } = sessionOptions(cwd, context => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult" && last.toolName === "read") {
				childReads.push(last.content.map(part => (part.type === "text" ? part.text : "")).join("\n"));
				return { content: ["done"] };
			}
			// The host registers its scheme only once the child session is running.
			host.bridge.setSchemes([{ scheme: "db" }]);
			return call("read", { path: "db://rows/2" });
		});
		const rpcSession = await open();
		const sibling = await open();
		const host = bindHost(rpcSession);
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });

		const task = rpcSession.getToolByName("task");
		if (!task) throw new Error("Expected a task tool");
		await task.execute("spawn", {
			context: "The host serves db:// rows.",
			tasks: [{ agent: "task", name: "Child", task: "Read the row." }],
		});

		expect(childReads).toHaveLength(1);
		expect(childReads[0]).toContain("payload of db://rows/2");
		expect(await readThrough(rpcSession, "db://rows/1")).toContain("payload of db://rows/1");
		expect(await readThrough(sibling, "db://rows/3")).not.toContain("payload of");
		expect(host.requests).toEqual(["db://rows/2", "db://rows/1"]);
	}, 30_000);

	it("reach a parked task subagent the RPC session cold-revives from disk", async () => {
		const cwd = path.join(root, "home", "work");
		// The parked transcript names a catalog model, which a revive restores by lookup.
		authStorage.keys.setRuntime("anthropic", "test-key");
		const { open, modelRegistry, settings } = sessionOptions(cwd, () => ({ content: ["unused"] }));
		const rpcSession = await open();
		const { bridge, requests } = bindHost(rpcSession);
		bridge.setSchemes([{ scheme: "db" }]);

		const persisted = SessionManager.create(cwd, path.join(root, "sessions"));
		const sessionFile = persisted.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		persisted.appendSessionInit({
			systemPrompt: ["persisted prompt"],
			task: "persisted task",
			tools: ["read", "yield"],
			restrictToolNames: true,
		});
		persisted.appendMessage({ role: "user", content: "persisted task", timestamp: Date.now() });
		// A session file is written once it holds an assistant turn.
		persisted.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "parked" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await persisted.close();
		const ref = AgentRegistry.global().register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile,
			status: "parked",
		});

		const reviver = await createPersistedSubagentReviverFactory({
			session: rpcSession,
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const revived = await reviver(ref);
		if (!(revived instanceof AgentSession)) throw new Error("Expected the subagent revived on this thread");
		sessions.push(revived);

		expect(await readThrough(revived, "db://rows/4")).toContain("payload of db://rows/4");
		expect(requests).toEqual(["db://rows/4"]);
	}, 30_000);
});
