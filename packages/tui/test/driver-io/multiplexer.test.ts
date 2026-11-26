import { describe, expect, it } from "bun:test";
import {
	classifyMultiplexer,
	hasMultiplexerSession,
	insideMultiplexer,
	isSsh,
	MULTIPLEXER_ENV_KEYS,
} from "../../src/driver/mux/detect";

const ORCA = { ORCA_PANE_KEY: "tab-1:12345678-1234-1234-1234-123456789abc", ORCA_WORKTREE_ID: "worktree-1" };

describe("hasMultiplexerSession", () => {
	it("recognizes Herdr session identity while ignoring client-only settings", () => {
		expect(hasMultiplexerSession("herdr", { HERDR_ENV: "1" })).toBe(true);
		for (const env of [{ HERDR_PANE_ID: "abc" }, { HERDR_TAB_ID: "t1" }, { HERDR_WORKSPACE_ID: "w1" }]) {
			expect(hasMultiplexerSession("herdr", env)).toBe(true);
		}
		for (const env of [
			{ HERDR_ENV: "0" },
			{ HERDR_PANE_ID: "" },
			{ HERDR_TAB_ID: "" },
			{ HERDR_WORKSPACE_ID: "" },
			{ HERDR_SOCKET_PATH: "/tmp/x" },
			{ HERDR_BIN_PATH: "/usr/bin/herdr" },
			{ HERDR_SESSION: "s1" },
			{ HERDR_CONFIG_PATH: "/tmp/herdr.toml" },
			{ HERDR_CLIENT_SOCKET_PATH: "/tmp/client.sock" },
		]) {
			expect(hasMultiplexerSession("herdr", env)).toBe(false);
		}
	});

	it("matches explicit provider markers and excludes TERM fallbacks", () => {
		expect(hasMultiplexerSession("tmux", { TMUX: "/tmp/tmux,1,0" })).toBe(true);
		expect(hasMultiplexerSession("screen", { STY: "1234.pts-0.host" })).toBe(true);
		expect(hasMultiplexerSession("zellij", { ZELLIJ: "0" })).toBe(true);
		expect(hasMultiplexerSession("cmux", { CMUX_WORKSPACE_ID: "workspace" })).toBe(true);
		expect(hasMultiplexerSession("cmux", { CMUX_SURFACE_ID: "surface" })).toBe(true);
		expect(hasMultiplexerSession("cmux", { CMUX_REMOTE_TRANSPORT: "ssh" })).toBe(true);
		expect(hasMultiplexerSession("cmux", { CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toBe(false);
		expect(hasMultiplexerSession("tmux", { TERM: "tmux-256color" })).toBe(false);
		expect(classifyMultiplexer({ TERM: "tmux-256color" })).toBe("tmux");
	});

	it("recognizes wmux session markers but not CLI overrides", () => {
		expect(hasMultiplexerSession("wmux", { WMUX: "1" })).toBe(true);
		expect(hasMultiplexerSession("wmux", { WMUX_SURFACE_ID: "3f2a" })).toBe(true);
		expect(hasMultiplexerSession("wmux", { WMUX: "0" })).toBe(false);
		expect(hasMultiplexerSession("wmux", { WMUX_SURFACE_ID: "" })).toBe(false);
		expect(hasMultiplexerSession("wmux", { WMUX_CLI: "C:/wmux/wmux.exe" })).toBe(false);
		expect(hasMultiplexerSession("wmux", { WMUX_PIPE: "\\\\.\\pipe\\wmux" })).toBe(false);
	});

	it("requires both nonempty Orca worktree identity markers", () => {
		expect(hasMultiplexerSession("orca", ORCA)).toBe(true);
		for (const env of [
			{ ORCA_PANE_KEY: ORCA.ORCA_PANE_KEY },
			{ ORCA_WORKTREE_ID: ORCA.ORCA_WORKTREE_ID },
			{ ORCA_PANE_KEY: "", ORCA_WORKTREE_ID: ORCA.ORCA_WORKTREE_ID },
			{ ORCA_PANE_KEY: ORCA.ORCA_PANE_KEY, ORCA_WORKTREE_ID: "" },
			{ ORCA_PANE_KEY: " ", ORCA_WORKTREE_ID: ORCA.ORCA_WORKTREE_ID },
			{ ORCA_PANE_KEY: ORCA.ORCA_PANE_KEY, ORCA_WORKTREE_ID: " " },
			{ TERM_PROGRAM: "orca" },
		]) {
			expect(hasMultiplexerSession("orca", env)).toBe(false);
		}
	});
});

describe("multiplexer classification", () => {
	it("preserves nested-provider precedence and TERM-only classification", () => {
		expect(classifyMultiplexer({ HERDR_PANE_ID: "p1", TMUX: "session" })).toBe("herdr");
		expect(classifyMultiplexer({ TMUX: "session", STY: "screen" })).toBe("tmux");
		expect(classifyMultiplexer({ STY: "screen", ZELLIJ: "session" })).toBe("screen");
		expect(classifyMultiplexer({ TERM: "screen-256color" })).toBe("screen");
	});

	it("classifies Orca after nested multiplexers without moving it off the direct render path", () => {
		expect(classifyMultiplexer(ORCA)).toBe("orca");
		expect(insideMultiplexer(ORCA)).toBe(false);
		expect(classifyMultiplexer({ ...ORCA, TMUX: "session" })).toBe("tmux");
		expect(insideMultiplexer({ ...ORCA, TMUX: "session" })).toBe(true);
		expect(classifyMultiplexer({ ...ORCA, ZELLIJ: "session" })).toBe("zellij");
		expect(classifyMultiplexer({ ...ORCA, TERM: "tmux-256color" })).toBe("tmux");
		expect(classifyMultiplexer({ ...ORCA, TERM: "screen-256color" })).toBe("screen");
		expect(classifyMultiplexer({ TERM_PROGRAM: "orca" })).toBe(null);
		expect(classifyMultiplexer({ ORCA_PANE_KEY: ORCA.ORCA_PANE_KEY })).toBe(null);
		expect(classifyMultiplexer({ ORCA_WORKTREE_ID: ORCA.ORCA_WORKTREE_ID })).toBe(null);
	});

	it("recognizes session markers through the generic render-path gate", () => {
		expect(insideMultiplexer({ HERDR_PANE_ID: "p1" })).toBe(true);
		expect(insideMultiplexer({ WMUX: "1" })).toBe(true);
		expect(insideMultiplexer({ WMUX_SURFACE_ID: "3f2a" })).toBe(true);
		expect(insideMultiplexer({ WMUX: "0" })).toBe(false);
		expect(insideMultiplexer({ WMUX_SURFACE_ID: "" })).toBe(false);
		expect(insideMultiplexer({ WMUX_CLI: "C:/wmux/wmux.exe" })).toBe(false);
		expect(insideMultiplexer({ WMUX_PIPE: "\\\\.\\pipe\\wmux" })).toBe(false);
	});

	it("lists every key classification reads, so a sanitized env classifies as a direct terminal", () => {
		const env = { ...ORCA, HERDR_PANE_ID: "p1", TMUX: "s", STY: "x", ZELLIJ: "0", WMUX: "1", TERM: "tmux-256color" };
		const sanitized: Record<string, string> = { ...env };
		for (const key of MULTIPLEXER_ENV_KEYS) delete sanitized[key];
		expect(classifyMultiplexer(sanitized)).toBe(null);
	});
});

describe("isSsh", () => {
	it("treats any SSH session marker as a remote terminal", () => {
		expect(isSsh({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 51000" })).toBe(true);
		expect(isSsh({ SSH_CLIENT: "10.0.0.1 51000 22" })).toBe(true);
		expect(isSsh({ SSH_TTY: "/dev/pts/3" })).toBe(true);
		expect(isSsh({ SSH_TTY: "" })).toBe(false);
		expect(isSsh({})).toBe(false);
	});
});
