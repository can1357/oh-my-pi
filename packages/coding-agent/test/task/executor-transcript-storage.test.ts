/**
 * A subagent's transcript belongs to its parent session's storage. When the
 * parent session keeps its transcripts in SQL while the process default is
 * file storage (an SDK embedding that passes its own storage, or a session
 * opened from another store), the child must be written as a row of that SQL
 * store and found there, not left as a file the parent's readers never see:
 * `history://<child>` from the parent, and the transcript-availability probe
 * behind the task tool's `history://` hint, read the same store.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import { hasResolvableTranscript } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";
import { readStoredSession } from "../helpers/sql-session-storage";

const TABLE = "omp_session_files";

let previousStorage: SessionStorage;
const clients: SQL[] = [];
const managers: SessionManager[] = [];
const tempDirs: TempDir[] = [];

beforeEach(() => {
	previousStorage = defaultSessionStorage();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.close();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	setDefaultSessionStorage(previousStorage);
	for (const client of clients.splice(0)) await client.end();
	for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
});

function assistantStop(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
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
	};
}

/** A child session that yields at once, writing through the manager the executor opened. */
function yieldingChild(sessionManager: SessionManager): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	return {
		...createSessionDefaults(),
		state,
		agent: { state: { systemPrompt: ["child"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager,
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			const reply = assistantStop();
			state.messages.push(reply);
			sessionManager.appendMessage(reply);
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield-call",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: {} },
					},
					isError: false,
				});
			}
			return true;
		},
		getLastAssistantMessage: () => state.messages.at(-1),
	} as unknown as AgentSession;
}

it("writes a spawned subagent's transcript to its parent's SQL storage, where the parent's readers find it", async () => {
	const tempDir = TempDir.createSync("@omp-subagent-transcript-storage-");
	tempDirs.push(tempDir);
	setDefaultSessionStorage(new FileSessionStorage());
	const client = new SQL(`sqlite:${tempDir.join("sessions.db")}`);
	clients.push(client);
	const sqlStorage = await SqlSessionStorage.create({ client });
	const cwd = tempDir.join("project");
	await fs.mkdir(cwd, { recursive: true });
	const parent = SessionManager.create(cwd, tempDir.join("sessions"), sqlStorage);
	managers.push(parent);
	parent.appendMessage({ role: "user", content: "parent question", timestamp: Date.now() });
	parent.appendMessage(assistantStop());
	await parent.flush();
	const parentFile = parent.getSessionFile();
	if (!parentFile) throw new Error("Expected the parent session file");
	const childFile = path.join(parentFile.slice(0, -".jsonl".length), "Worker.jsonl");

	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [{ name: "task", description: "Task agent", systemPrompt: "Work.", source: "bundled" }],
		projectAgentsDir: null,
	});
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		const sessionManager = options.sessionManager;
		if (!sessionManager) throw new Error("Expected the executor to open a child session manager");
		managers.push(sessionManager);
		return {
			session: yieldingChild(sessionManager),
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	const toolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false }),
		getSessionFile: () => parent.getSessionFile() ?? null,
		getArtifactsDir: () => parent.getArtifactsDir(),
		getSessionSpawns: () => "*",
		sessionManager: parent,
		modelRegistry: {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		} as unknown as ModelRegistry,
	} as unknown as ToolSession;

	const tool = await TaskTool.create(toolSession);
	const result = await tool.execute("spawn-worker", { agent: "task", name: "Worker", task: "Do the work." });
	expect(result.details?.results[0]?.exitCode).toBe(0);
	await sqlStorage.drain();

	expect(await readStoredSession(client, TABLE, childFile)).toContain('"type":"session"');
	expect(await Bun.file(childFile).exists()).toBe(false);
	expect(Object.keys(await collectSubSessions(parentFile, { storage: parent.getStorage() }))).toEqual(["Worker"]);

	// A later process holds no live ref: history:// restores the parent's roster
	// from the parent's storage and renders the child's stored turn.
	AgentRegistry.resetGlobalForTests();
	const history = await InternalUrlRouter.instance().resolve("history://Worker", sessionResolveContext(toolSession));
	expect(history.sourcePath).toBe(childFile);
	expect(history.content).toContain("done");
	expect(await hasResolvableTranscript("Worker", parent.getStorage())).toBe(true);
});
