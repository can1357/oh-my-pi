/**
 * Spawn depth gates spawn capacity (`task.maxRecursionDepth`) separately from
 * `taskDepth`: a child launched with a reset spawn depth keeps the nesting budget
 * a main session has, while its task depth still counts every level.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { extractSessionInit, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

const settings = () => Settings.isolated({ "task.maxRecursionDepth": 2, "task.isolation.enabled": false });

const spawningAgent: AgentDefinition = {
	name: "worker",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
	tools: ["read", "task"],
	spawns: "*",
};

/** A child session that finishes its run at once and records the `session_init` it is given. */
function finishingSession(inits: Array<Record<string, unknown>>): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: (init: Record<string, unknown>) => inits.push(init) },
		getActiveToolNames: () => ["read"],
		getEnabledToolNames: () => ["read"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "spawn-depth",
					toolName: "yield",
					result: { content: [{ type: "text", text: "done" }], details: { status: "success", data: {} } },
					isError: false,
				});
			}
			return true;
		},
	} as unknown as AgentSession;
}

/** Launches one child through the real executor and returns what it handed `createAgentSession` and `session_init`. */
async function launch(options: Partial<ExecutorOptions>) {
	const inits: Array<Record<string, unknown>> = [];
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session: finishingSession(inits),
		extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as CreateAgentSessionResult);
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: spawningAgent,
		task: "do work",
		index: 0,
		id: `SpawnDepth${Snowflake.next()}`,
		settings: settings(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		...options,
	});
	expect(result.exitCode).toBe(0);
	const created = spy.mock.calls[0]?.[0];
	spy.mockRestore();
	return { created, init: inits[0] };
}

function toolSession(depths: { taskDepth: number; spawnDepth?: number }): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: settings(),
		enableLsp: false,
		skipPythonPreflight: true,
		...depths,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("executor spawn depth", () => {
	it("strips the task tool from a child at the maximum depth by default", async () => {
		const { created, init } = await launch({ taskDepth: 1 });
		expect(created?.taskDepth).toBe(2);
		expect(created?.spawnDepth).toBe(2);
		expect(created?.toolNames).not.toContain("task");
		expect(created?.spawns).toBe("");
		expect(init).not.toHaveProperty("spawnDepth");
	});

	it("keeps a full nesting budget below a child launched with a reset spawn depth", async () => {
		// Main session (task depth 0) launches a worker at spawn depth 0.
		const worker = await launch({ taskDepth: 0, spawnDepth: 0 });
		expect(worker.created?.taskDepth).toBe(1);
		expect(worker.created?.spawnDepth).toBe(0);
		expect(worker.created?.toolNames).toContain("task");
		expect(worker.init?.spawnDepth).toBe(0);

		// The worker's helper counts up from the worker's spawn depth.
		const helper = await launch({ taskDepth: 1, parentSpawnDepth: 0 });
		expect(helper.created?.taskDepth).toBe(2);
		expect(helper.created?.spawnDepth).toBe(1);
		expect(helper.created?.toolNames).toContain("task");
		expect(helper.created?.spawns).toBe("*");
		expect(helper.init?.spawnDepth).toBe(1);

		// The next level reaches the cap.
		const leaf = await launch({ taskDepth: 2, parentSpawnDepth: 1 });
		expect(leaf.created?.taskDepth).toBe(3);
		expect(leaf.created?.spawnDepth).toBe(2);
		expect(leaf.created?.toolNames).not.toContain("task");
		expect(leaf.init?.spawnDepth).toBe(2);
	});
});

describe("built-in task tool gate", () => {
	it("follows the spawn depth, falling back to the task depth", async () => {
		const names = async (depths: { taskDepth: number; spawnDepth?: number }) =>
			(await resolveBuiltinToolPlan(toolSession(depths), ["read", "task"])).names;
		expect(await names({ taskDepth: 2 })).not.toContain("task");
		expect(await names({ taskDepth: 1, spawnDepth: 0 })).toContain("task");
		expect(await names({ taskDepth: 2, spawnDepth: 1 })).toContain("task");
		expect(await names({ taskDepth: 3, spawnDepth: 2 })).not.toContain("task");
	});
});

describe("structured spawn from a session", () => {
	async function spawnFrom(depths: { taskDepth: number; spawnDepth?: number }) {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [spawningAgent], projectAgentsDir: null });
		let forwarded: ExecutorOptions | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			forwarded = options;
			return {
				index: 0,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
			} as SingleResult;
		});
		const session = {
			...toolSession(depths),
			authStorage: {},
			modelRegistry: { refresh: async () => {} },
			restrictToolNames: true,
			enableMCP: false,
			enableIrc: false,
			getSessionAgents: () => [],
		} as unknown as ToolSession;
		await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: "do work",
			agent: "worker",
			structured: false,
			identity: { id: `SpawnDepth${Snowflake.next()}` },
			keepAlive: false,
		});
		return forwarded;
	}

	it("refuses a session at the cap by its task depth when no spawn depth is set", async () => {
		await expect(spawnFrom({ taskDepth: 2 })).rejects.toThrow(/spawn depth 2; maximum depth is 2/);
	});

	it("lets a session below the cap by spawn depth spawn and forwards its spawn depth", async () => {
		const forwarded = await spawnFrom({ taskDepth: 2, spawnDepth: 1 });
		expect(forwarded?.taskDepth).toBe(2);
		expect(forwarded?.parentSpawnDepth).toBe(1);
	});
});

describe("createAgentSession spawn depth", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	async function enabledTools(depths: { taskDepth: number; spawnDepth?: number }): Promise<string[]> {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-spawn-depth-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(":memory:");
		const { session } = await sdkModule.createAgentSession({
			cwd: tempDir,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: new ModelRegistry(authStorage),
			settings: settings(),
			sessionManager: SessionManager.inMemory(tempDir),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			hasUI: false,
			agentRegistry: new AgentRegistry(),
			parentTaskPrefix: "SpawnDepth",
			toolNames: ["read", "task"],
			...depths,
		});
		try {
			return session.getEnabledToolNames();
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	it("gives a session its task tool by spawn depth", async () => {
		expect(await enabledTools({ taskDepth: 2 })).not.toContain("task");
		expect(await enabledTools({ taskDepth: 2, spawnDepth: 1 })).toContain("task");
	}, 60_000);
});

describe("session_init spawn depth", () => {
	it("round-trips the persisted spawn depth and leaves it absent on older entries", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendSessionInit({ systemPrompt: ["p"], task: "t", tools: ["read"] });
		const legacy = extractSessionInit(manager.getEntries());
		expect(legacy?.spawnDepth).toBeUndefined();
		expect(legacy).not.toHaveProperty("spawnDepth");

		manager.appendSessionInit({ systemPrompt: ["p"], task: "t", tools: ["read"], spawnDepth: 0 });
		expect(extractSessionInit(manager.getEntries())?.spawnDepth).toBe(0);
	});
});
