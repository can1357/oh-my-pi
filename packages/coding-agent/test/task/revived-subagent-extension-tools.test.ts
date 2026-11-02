/**
 * A parked subagent is rebuilt on revival: its extensions are bound again and see `session_start`,
 * but its turns are agent-initiated (IRC wakes), which skip `before_agent_start`. A tool an extension
 * registers from that hook must still reach the revived session's first request.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "ReviveTools";
const MOCK_API_SOURCE = "test/revived-subagent-extension-tools";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-revive-ext-tools-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Holds the extension's tool discovery open while set, as a slow MCP server start would. */
let discoveryGate: (() => Promise<void>) | undefined;
/** `reason` of every `before_agent_start` the extension saw, across its bindings. */
const turnStartReasons: string[] = [];

/**
 * Registers the way the HexRays ida-mcp extension does: discovery starts at `session_start`, and
 * the tool is registered at the next `input` or `before_agent_start`. Its calls work only while the
 * binding that registered it has a live session.
 */
const registersAtFirstTurn: ExtensionFactory = pi => {
	let startup: Promise<void> | undefined;
	let pending: (() => void) | undefined;
	let running = false;
	const discover = async (): Promise<void> => {
		await discoveryGate?.();
		if (!running) return;
		pending = () =>
			pi.registerTool({
				name: "late_tool",
				loadMode: "essential",
				label: "late_tool",
				description: "Tool registered at the first turn",
				parameters: type({}),
				async execute() {
					if (!running) throw new Error("late_tool: session has ended");
					return { content: [{ type: "text", text: "late_tool ok" }] };
				},
			});
	};
	const ensure = async (): Promise<void> => {
		if (running) startup ??= discover();
		await startup;
		const register = pending;
		pending = undefined;
		register?.();
	};
	pi.on("session_start", () => {
		if (startup) return;
		running = true;
		startup = discover();
	});
	pi.on("input", ensure);
	pi.on("before_agent_start", event => {
		turnStartReasons.push(event.reason);
		return ensure();
	});
	pi.on("session_shutdown", () => {
		running = false;
		startup = undefined;
		pending = undefined;
	});
};

interface RecordedRequest {
	tools: string[];
	systemPrompt: string;
}

/** Runs `AGENT_ID` to a finished keep-alive state with `registersAtFirstTurn` loaded, then parks it. */
async function spawnAndPark() {
	turnStartReasons.length = 0;
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const requests: RecordedRequest[] = [];
	let requested = Promise.withResolvers<void>();
	const mock = createMockModel({
		handler: context => {
			requests.push({
				tools: (context.tools ?? []).map(tool => tool.name).sort(),
				systemPrompt: (context.systemPrompt ?? []).join("\n"),
			});
			requested.resolve();
			if (requests.length === 1) {
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
			}
			if (context.messages.at(-1)?.role !== "toolResult") {
				return { content: [{ type: "toolCall", name: "late_tool", arguments: {} }] };
			}
			return { content: ["ack"] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		// No TTL timer: the test parks explicitly through the same path the timer takes.
		"task.agentIdleTtlMs": 0,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const preparedExtensions = [
		{ path: "<inline-0>", resolvedPath: "<inline-0>", factory: registersAtFirstTurn, error: null },
	];
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			preloadedPreparedExtensions: preparedExtensions,
			settings,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);
		await AgentLifecycleManager.global().park(AGENT_ID);
	} catch (error) {
		authStorage.close();
		throw error;
	}
	return {
		parked: requests.at(-1)!,
		/** The reviver a restarted process builds for the parked agent from its session file. */
		async coldRevive(): Promise<AgentSession> {
			const owner = {
				sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
				effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
				preparedExtensions,
			} as unknown as AgentSession;
			const ref = AgentRegistry.global().get(AGENT_ID);
			if (!ref) throw new Error(`${AGENT_ID} is not registered`);
			const reviver = await createPersistedSubagentReviverFactory({
				session: owner,
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
			})(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			return reviver(ref);
		},
		/** Wakes `session` with an IRC message, as a peer would, and returns the wake's first request. */
		async wake(session: AgentSession): Promise<RecordedRequest> {
			requested = Promise.withResolvers<void>();
			const before = requests.length;
			await session.deliverIrcMessage({ id: "irc-wake", from: "Main", to: AGENT_ID, body: "one more", ts: 1 });
			await requested.promise;
			await session.agent.waitForIdle();
			return requests[before]!;
		},
		close: () => authStorage.close(),
	};
}

function lateToolOutput(session: AgentSession): string | undefined {
	const result = session.agent.state.messages.findLast(
		message => message.role === "toolResult" && message.toolName === "late_tool",
	);
	if (result?.role !== "toolResult") return undefined;
	const [first] = result.content;
	return first?.type === "text" ? first.text : undefined;
}

it("warm-revives with the tools an extension registered at its first turn", async () => {
	const run = await spawnAndPark();
	try {
		expect(run.parked.tools).toContain("late_tool");
		const revived = await AgentLifecycleManager.global().ensureLive(AGENT_ID);
		const wake = await run.wake(revived);

		expect(wake.tools).toEqual(run.parked.tools);
		expect(wake.systemPrompt).toEqual(run.parked.systemPrompt);
		expect(lateToolOutput(revived)).toBe("late_tool ok");
		// The spawn's prompt, then the revive's replay; the wake turn fires none.
		expect(turnStartReasons).toEqual(["prompt", "revive"]);
	} finally {
		run.close();
	}
}, 30_000);

it("hands a second caller the revived session only once its extensions have re-registered", async () => {
	const run = await spawnAndPark();
	const discovering = Promise.withResolvers<void>();
	const discovered = Promise.withResolvers<void>();
	discoveryGate = () => {
		discovering.resolve();
		return discovered.promise;
	};
	const lifecycle = AgentLifecycleManager.global();
	let first: Promise<AgentSession> | undefined;
	try {
		first = lifecycle.ensureLive(AGENT_ID);
		await discovering.promise;
		let handedOut = false;
		const second = lifecycle.ensureLive(AGENT_ID).then(session => {
			handedOut = true;
			return session;
		});
		// One macrotask turn runs every pending microtask, so a session handed out without waiting is out by now.
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		expect(handedOut).toBe(false);

		discovered.resolve();
		const revived = await first;
		expect(await second).toBe(revived);
		expect((await run.wake(revived)).tools).toEqual(run.parked.tools);
	} finally {
		discoveryGate = undefined;
		discovered.resolve();
		await first?.catch(() => undefined);
		run.close();
	}
}, 30_000);

it("cold-revives with the tools an extension registered at its first turn", async () => {
	const run = await spawnAndPark();
	let revived: AgentSession | undefined;
	try {
		revived = await run.coldRevive();
		const wake = await run.wake(revived);

		expect(wake.tools).toContain("late_tool");
		expect(lateToolOutput(revived)).toBe("late_tool ok");
	} finally {
		await revived?.dispose();
		run.close();
	}
}, 30_000);
