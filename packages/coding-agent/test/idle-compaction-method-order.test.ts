import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function runIdle(settings: Record<string, unknown>): Promise<string | undefined> {
	const tempDir = TempDir.createSync("@pi-idle-method-order-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const firstKeptEntryId = sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "kept" }],
		timestamp: Date.now(),
	});
	vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
		firstKeptEntryId,
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 100,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
	});
	vi.spyOn(compactionModule, "compact").mockResolvedValue({
		summary: "summary",
		shortSummary: undefined,
		firstKeptEntryId,
		tokensBefore: 100,
		details: {},
	});
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager,
		settings: Settings.isolated({ "compaction.autoContinue": false, ...settings }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	const events: AgentSessionEvent[] = [];
	session.subscribe(event => events.push(event));
	try {
		await session.runIdleCompaction();
		const start = events.find(event => event.type === "auto_compaction_start");
		return start?.type === "auto_compaction_start" ? start.action : undefined;
	} finally {
		await session.dispose();
		authStorage.close();
		await tempDir.remove();
	}
}

describe("compaction.idleMethodOrder", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs idle compaction from the idle order instead of methodOrder", async () => {
		const action = await runIdle({
			"compaction.methodOrder": ["snapcompact"],
			"compaction.idleMethodOrder": ["soft"],
		});
		expect(action).toBe("context-full");
	});

	it("inherits methodOrder when the idle order is empty", async () => {
		const action = await runIdle({
			"compaction.methodOrder": ["soft"],
			"compaction.idleMethodOrder": [],
		});
		expect(action).toBe("context-full");
	});

	it("uses the idle order even when methodOrder is empty", async () => {
		const action = await runIdle({
			"compaction.methodOrder": [],
			"compaction.idleMethodOrder": ["soft"],
		});
		expect(action).toBe("context-full");
	});
});
