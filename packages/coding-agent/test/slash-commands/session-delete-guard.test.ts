import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-session";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as SessionSelector from "@oh-my-pi/pi-tui/overlays/session-selector";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function headlessRuntime(settings: Settings) {
	const newSession = vi.fn(async () => true);
	const dropSession = vi.fn(async () => {});
	const output = vi.fn(async (_text: string) => {});
	const runtime = {
		settings,
		cwd: "/tmp",
		session: {
			isStreaming: false,
			sessionId: "s1",
			sessionName: "test",
			newSession,
		},
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
			dropSession,
		},
		output,
		refreshCommands: async () => {},
		reloadPlugins: async () => {},
	} as unknown as SlashCommandRuntime;
	return { runtime, newSession, dropSession, output };
}

async function runHeadlessSessionDelete(runtime: SlashCommandRuntime) {
	const command = BUILTIN_SESSION_SLASH_COMMANDS.find(spec => spec.name === "session");
	if (!command?.handle) throw new Error("Expected /session to expose a headless handle");
	return command.handle(parseSlashCommand("/session delete")!, runtime);
}

describe("session.delete.enabled gates user session deletion", () => {
	it("refuses headless /session delete without touching the session", async () => {
		const { runtime, newSession, dropSession, output } = headlessRuntime(
			Settings.isolated({ "session.delete.enabled": false }),
		);

		const result = await runHeadlessSessionDelete(runtime);

		expect(result).toMatchObject({ consumed: true, failed: true });
		expect(output).toHaveBeenCalledTimes(1);
		expect(String(output.mock.calls[0][0])).toContain("disabled");
		expect(newSession).not.toHaveBeenCalled();
		expect(dropSession).not.toHaveBeenCalled();
	});

	it("still deletes headlessly when the setting keeps its default", async () => {
		const { runtime, newSession, dropSession } = headlessRuntime(Settings.isolated({}));

		const result = await runHeadlessSessionDelete(runtime);

		expect(result).toMatchObject({ consumed: true });
		expect(newSession).toHaveBeenCalledWith({ drop: true });
		expect(dropSession).toHaveBeenCalledWith("/tmp/session.jsonl");
	});

	it("refuses /delete before starting any new-session flow", async () => {
		const newSession = vi.fn(async () => true);
		const showError = vi.fn();
		const ctx = {
			settings: Settings.isolated({ "session.delete.enabled": false }),
			session: { isCompacting: false, newSession },
			sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
			showError,
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleDeleteCommand();

		expect(showError).toHaveBeenCalledTimes(1);
		expect(String(showError.mock.calls[0][0])).toContain("disabled");
		expect(newSession).not.toHaveBeenCalled();
	});

	it("refuses /session delete in the TUI without a confirmation prompt", async () => {
		const showHookConfirm = vi.fn(async () => true);
		const showError = vi.fn();
		const ctx = {
			settings: Settings.isolated({ "session.delete.enabled": false }),
			sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
			showHookConfirm,
			showError,
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new SelectorController(ctx).handleSessionDeleteCommand();

		expect(showError).toHaveBeenCalledTimes(1);
		expect(String(showError.mock.calls[0][0])).toContain("disabled");
		expect(showHookConfirm).not.toHaveBeenCalled();
	});

	it("hides the resume picker delete action when disabled and keeps it by default", async () => {
		const captured: SessionSelector.SessionSelectorOptions<SessionInfo>[] = [];
		const listed: SessionInfo[] = [];
		vi.spyOn(SessionManager, "listForPicker").mockResolvedValue({
			sessions: listed,
			complete: Promise.resolve(listed),
		});
		vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(((
			_sessions: SessionInfo[],
			_onSelect: (session: SessionInfo) => void,
			_onCancel: () => void,
			_onExit: () => void,
			options: SessionSelector.SessionSelectorOptions<SessionInfo>,
		) => {
			captured.push(options);
			return { setOnRequestRender: () => {}, handleInput: () => {} };
		}) as never);

		const makeCtx = (deleteEnabled: boolean) =>
			({
				settings: Settings.isolated(deleteEnabled ? {} : { "session.delete.enabled": false }),
				sessionManager: { getCwd: () => "/tmp", getSessionDir: () => "/tmp", getSessionFile: () => undefined },
				ui: {
					requestRender: () => {},
					setFocus: () => {},
					terminal: { rows: 24 },
					showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }),
				},
				editor: {},
				editorContainer: { children: [], clear: () => {}, addChild: () => {} },
				showError: () => {},
				showWarning: () => {},
				showStatus: () => {},
			}) as unknown as InteractiveModeContext;

		await new SelectorController(makeCtx(false)).showSessionSelector();
		expect(captured).toHaveLength(1);
		expect(captured[0].onDelete).toBeUndefined();

		await new SelectorController(makeCtx(true)).showSessionSelector();
		expect(captured).toHaveLength(2);
		expect(captured[1].onDelete).toBeDefined();
	});
});
