/**
 * A session's `--tools` allow-list reaches every subagent it spawns, so a child
 * can invoke nothing its parent could not; a structured child can still yield
 * its result. Round-1 review of #17970: the list was not forwarded to children.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAllowList } from "@oh-my-pi/pi-coding-agent/tools/tool-allowlist";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { createSessionDefaults } from "./helpers/session-defaults";

const probeSend: CustomTool = {
	name: "probe_send",
	label: "Probe send",
	description: "Stands in for a messaging tool.",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text", text: "probe sent" }] }),
} as unknown as CustomTool;

describe("subagents and the parent's tool allow-list", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards the parent session's allow-list to a spawned child", async () => {
		const toolAllowList = ToolAllowList.parse(["read", "task"]);
		const parent = {
			cwd: os.tmpdir(),
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionAgents: () => [],
			getPlanModeState: () => undefined,
			skills: [],
			toolAllowList,
		} as unknown as ToolSession;
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "child", description: "child", systemPrompt: "test", source: "project" }],
			projectAgentsDir: null,
		});
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const child = {
			...createSessionDefaults(),
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			prompt: async () => {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: "tool-1",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { ok: true } },
						},
						isError: false,
					} as AgentSessionEvent);
				}
				return true;
			},
			sendCustomMessage: vi.fn(async () => {}),
			getLastAssistantMessage: () => undefined,
		} as unknown as AgentSession;
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: child,
			extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as unknown as CreateAgentSessionResult);

		await runStructuredSubagent({ session: parent, invocationKind: "task", assignment: "do work", agent: "child" });

		expect(spy.mock.calls[0]?.[0]?.toolAllowList).toBe(toolAllowList);
	});
});

describe("createAgentSession with an allow-list", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `omp-subagent-allowlist-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
		authStorage.close();
		removeSyncWithRetries(dir);
	});

	async function activeTools(options: { requireYieldTool?: boolean }): Promise<string[]> {
		const { session } = await sdkModule.createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			customTools: [probeSend],
			toolNames: ["read", "probe_send"],
			toolAllowList: ToolAllowList.parse(["read"]),
			...options,
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	it("activates nothing the list does not allow, even a tool the child's own list names", async () => {
		const names = await activeTools({});
		expect(names).toContain("read");
		expect(names).not.toContain("probe_send");
		expect(names).not.toContain("yield");
	});

	it("still lets a structured child yield its result", async () => {
		const names = await activeTools({ requireYieldTool: true });
		expect(names).toContain("yield");
		expect(names).not.toContain("probe_send");
	});
});
