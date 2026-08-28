import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as core from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function createMode(opts: { flushFails?: boolean } = {}): Promise<{
	mode: InteractiveMode;
	session: AgentSession;
	cleanup: () => Promise<void>;
}> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-resume-outer-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({ "compaction.enabled": false });

	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

	const initialTools = await createTools(
		{ cwd: tempDir.path(), hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings },
		["read"],
	);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const session = new AgentSession({
		agent: new core.Agent({
			initialState: { model, systemPrompt: ["Test"], tools: initialTools, messages: [] },
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	mode.ui.requestRender = vi.fn();

	// Make settings.flush fail or succeed as configured.
	vi.spyOn(mode.settings, "flush").mockImplementation(async () => {
		if (opts.flushFails) throw new Error("disk full");
	});

	return {
		mode,
		session,
		cleanup: async () => {
			resetSettingsForTest();
			await tempDir.remove();
		},
	};
}

describe("InteractiveMode.handleResumeSession outer preflight flush", () => {
	it("aborts before disposing controllers or resetting observers when flush fails", async () => {
		const { mode, cleanup } = await createMode({ flushFails: true });
		try {
			const resetSpy = vi.spyOn(mode, "resetObserverRegistry");
			const switchSpy = vi.spyOn(mode.session, "switchSession").mockResolvedValue(true);
			const showErrorSpy = vi.spyOn(mode, "showError");

			await mode.handleResumeSession("/tmp/some-session.jsonl");

			expect(mode.settings.flush).toHaveBeenCalled();
			expect(showErrorSpy).toHaveBeenCalledWith(expect.stringContaining("disk full"));
			expect(resetSpy).not.toHaveBeenCalled();
			expect(switchSpy).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("disposes controllers and delegates to SelectorController with settingsFlushed on success", async () => {
		const { mode, session, cleanup } = await createMode({ flushFails: false });
		try {
			const resetSpy = vi.spyOn(mode, "resetObserverRegistry");
			const switchSpy = vi.spyOn(session, "switchSession").mockResolvedValue(true);

			await mode.handleResumeSession("/tmp/some-session.jsonl");

			expect(mode.settings.flush).toHaveBeenCalled();
			expect(resetSpy).toHaveBeenCalled();
			expect(switchSpy).toHaveBeenCalledWith(
				"/tmp/some-session.jsonl",
				expect.objectContaining({ onCwdChange: expect.any(Function) }),
			);
		} finally {
			await cleanup();
		}
	});
});
