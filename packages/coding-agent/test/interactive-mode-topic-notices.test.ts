/**
 * Reload reports and extension errors stay current: a newer report of a topic replaces the older block,
 * and an extension's error line disappears once a reload touches that extension.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { extensionErrorTopic } from "@oh-my-pi/pi-coding-agent/session/notice-topics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const WIDTH = 100;

function rendered(mode: InteractiveMode): string {
	return mode.chatContainer.children.map(child => child.render(WIDTH).join("\n")).join("\n");
}

describe("InteractiveMode topic notices", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let requestRender: ReturnType<typeof vi.fn>;
	let tempDir: TempDir;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-topic-notices-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		requestRender = vi.fn();
		mode.ui.requestRender = requestRender;
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	beforeEach(() => {
		mode.chatContainer.clear();
	});

	afterAll(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("replaces the previous report of a topic instead of stacking another one", () => {
		mode.showTopicNotice("warning", "extensions unchanged: +0 ~0 -0, 1 failed\n  index.ts: boom", "extensions");
		mode.showTopicNotice("info", "extensions reloaded: +0 ~1 -0\n  recovered: index.ts", "extensions");

		const text = rendered(mode);
		expect(text).toContain("recovered: index.ts");
		expect(text).not.toContain("index.ts: boom");
		expect(text.match(/extensions (reloaded|unchanged)/g)).toHaveLength(1);
	});

	it("retracts an extension's error line once a reload touches that extension", () => {
		const broken = "/agent/extensions/auto-goal/index.ts";
		const other = "/agent/extensions/other.ts";
		mode.presentTopic(extensionErrorTopic(broken), new Text(`Extension "${broken}" error: boom`, 1, 0));
		expect(mode.chatContainer.children).toHaveLength(1);
		mode.retractTopics([extensionErrorTopic(other)]);
		expect(mode.chatContainer.children).toHaveLength(1);

		mode.showTopicNotice("info", "extensions reloaded: +0 ~1 -0", "extensions", [extensionErrorTopic(broken)]);

		expect(mode.chatContainer.children).toHaveLength(1);
		expect(rendered(mode)).toContain("extensions reloaded");
		expect(rendered(mode)).not.toContain("boom");
	});

	it("leaves notices without a topic alone", () => {
		mode.showWarning("first");
		mode.showTopicNotice("warning", "second", undefined);
		const text = rendered(mode);
		expect(text).toContain("first");
		expect(text).toContain("second");
	});

	it("clears a topic block already retired into native scrollback by replaying the transcript", () => {
		session.sessionManager.appendMessage({ role: "user", content: "keep this turn", timestamp: Date.now() });
		const broken = "/agent/extensions/auto-goal/index.ts";
		mode.presentTopic(extensionErrorTopic(broken), new Text(`Extension "${broken}" error: boom`, 1, 0));
		// Retire the block into the committed ledger, where nothing can delete it in place.
		expect(mode.chatContainer.peekFinalizedBatch(WIDTH, 0)).toBeDefined();
		const stale = mode.chatContainer.children.at(-1)!;
		expect(mode.chatContainer.canRemoveBlock(stale)).toBe(false);
		requestRender.mockClear();

		mode.showTopicNotice("info", "extensions reloaded: +0 ~1 -0", "extensions", [extensionErrorTopic(broken)]);

		expect(mode.chatContainer.children).not.toContain(stale);
		const text = rendered(mode);
		expect(text).not.toContain("boom");
		expect(text).toContain("extensions reloaded");
		// The scrollback-clearing replay rebuilds from session messages, so the turn survives.
		expect(text).toContain("keep this turn");
		expect(requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});
});
