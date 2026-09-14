import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-session";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const SESSION_ID = "sess-1";

function tuiRuntime() {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const setSessionName = vi.fn(async () => true);
	const sessionManager = {
		getCwd: () => "/tmp/proj",
		setSessionName,
	} as unknown as InteractiveModeContext["sessionManager"];
	const ctx = {
		collabGuest: false,
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		showStatus,
		sessionManager,
		session: { sessionId: SESSION_ID, sessionName: "old" } as unknown as InteractiveModeContext["session"],
		settings: {} as unknown as InteractiveModeContext["settings"],
	} as unknown as InteractiveModeContext;
	return { setText, showStatus, setSessionName, ctx };
}

function textRuntime() {
	const setSessionName = vi.fn(async () => true);
	const output = vi.fn(async () => {});
	const runtime = {
		cwd: "/tmp/proj",
		output,
		refreshCommands: async () => {},
		reloadPlugins: async () => {},
		session: { sessionId: SESSION_ID, sessionName: "old" },
		sessionManager: { getCwd: () => "/tmp/proj", getSessionFile: () => "/tmp/x.jsonl", setSessionName },
		settings: {},
	} as unknown as SlashCommandRuntime;
	return { setSessionName, output, runtime };
}

describe("/session rename (TUI)", () => {
	it("renames the current session and confirms with the new name", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/session rename tui-name", h);
		expect(handled).toBe(true);
		expect(h.setSessionName).toHaveBeenCalledWith("tui-name", "user");
		expect(h.showStatus).toHaveBeenCalledWith('Session renamed to "tui-name".');
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("shows a usage message for an empty rename", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/session rename   ", h);
		expect(handled).toBe(true);
		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith("Usage: /session rename <name>");
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("leaves the durable session id unchanged", async () => {
		const h = tuiRuntime();
		expect(h.ctx.session.sessionId).toBe(SESSION_ID);
		await executeBuiltinSlashCommand("/session rename whatever", h);
		expect(h.ctx.session.sessionId).toBe(SESSION_ID);
	});
});

describe("/session rename (text/ACP handle)", () => {
	const spec = BUILTIN_SESSION_SLASH_COMMANDS.find(c => c.name === "session")!;

	it("renames the current session via the text handler", async () => {
		const h = textRuntime();
		const command = {
			name: "session",
			args: "rename foo",
			text: "/session rename foo",
		} as unknown as ParsedSlashCommand;
		await spec.handle?.(command, h.runtime);
		expect(h.setSessionName).toHaveBeenCalledWith("foo", "user");
		expect(h.output).toHaveBeenCalledWith('Session renamed to "foo".');
	});

	it("shows a usage message for an empty rename without renaming", async () => {
		const h = textRuntime();
		const command = {
			name: "session",
			args: "rename   ",
			text: "/session rename   ",
		} as unknown as ParsedSlashCommand;
		await spec.handle?.(command, h.runtime);
		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(expect.stringContaining("rename"));
	});
});
