import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	detectStyledUnderlineSupport,
	detectTerminalId,
	getTerminalInfo,
	hyperlinksUserOverride,
	ImageProtocol,
	isPaseoEmbedder,
	NotifyProtocol,
	resolveImageProtocol,
	resolveWarpImageProtocol,
	shouldEnableHyperlinksByDefault,
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
	classifyTerminalMultiplexer,
	hasTerminalMultiplexerSession,
	isInsideTerminalMultiplexer,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";

describe("hasTerminalMultiplexerSession", () => {
	it("recognizes Herdr session identity while ignoring client-only settings", () => {
		expect(hasTerminalMultiplexerSession("herdr", { HERDR_ENV: "1" })).toBe(true);
		for (const env of [{ HERDR_PANE_ID: "abc" }, { HERDR_TAB_ID: "t1" }, { HERDR_WORKSPACE_ID: "w1" }]) {
			expect(hasTerminalMultiplexerSession("herdr", env)).toBe(true);
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
			expect(hasTerminalMultiplexerSession("herdr", env)).toBe(false);
		}
	});

	it("matches explicit provider markers and excludes TERM fallbacks", () => {
		expect(hasTerminalMultiplexerSession("tmux", { TMUX: "/tmp/tmux,1,0" })).toBe(true);
		expect(hasTerminalMultiplexerSession("screen", { STY: "1234.pts-0.host" })).toBe(true);
		expect(hasTerminalMultiplexerSession("zellij", { ZELLIJ: "0" })).toBe(true);
		expect(hasTerminalMultiplexerSession("cmux", { CMUX_WORKSPACE_ID: "workspace" })).toBe(true);
		expect(hasTerminalMultiplexerSession("cmux", { CMUX_SURFACE_ID: "surface" })).toBe(true);
		expect(hasTerminalMultiplexerSession("cmux", { CMUX_REMOTE_TRANSPORT: "ssh" })).toBe(true);
		expect(hasTerminalMultiplexerSession("cmux", { CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toBe(false);
		expect(hasTerminalMultiplexerSession("tmux", { TERM: "tmux-256color" })).toBe(false);
		expect(classifyTerminalMultiplexer({ TERM: "tmux-256color" })).toBe("tmux");
	});

	it("recognizes wmux session markers but not CLI overrides", () => {
		expect(hasTerminalMultiplexerSession("wmux", { WMUX: "1" })).toBe(true);
		expect(hasTerminalMultiplexerSession("wmux", { WMUX_SURFACE_ID: "3f2a" })).toBe(true);
		expect(hasTerminalMultiplexerSession("wmux", { WMUX: "0" })).toBe(false);
		expect(hasTerminalMultiplexerSession("wmux", { WMUX_SURFACE_ID: "" })).toBe(false);
		expect(hasTerminalMultiplexerSession("wmux", { WMUX_CLI: "C:/wmux/wmux.exe" })).toBe(false);
		expect(hasTerminalMultiplexerSession("wmux", { WMUX_PIPE: "\\\\.\\pipe\\wmux" })).toBe(false);
	});

	it("requires both nonempty Orca worktree identity markers", () => {
		expect(
			hasTerminalMultiplexerSession("orca", {
				ORCA_PANE_KEY: "tab-1:12345678-1234-1234-1234-123456789abc",
				ORCA_WORKTREE_ID: "worktree-1",
			}),
		).toBe(true);
		for (const env of [
			{ ORCA_PANE_KEY: "tab-1:12345678-1234-1234-1234-123456789abc" },
			{ ORCA_WORKTREE_ID: "worktree-1" },
			{ ORCA_PANE_KEY: "", ORCA_WORKTREE_ID: "worktree-1" },
			{ ORCA_PANE_KEY: "tab-1:12345678-1234-1234-1234-123456789abc", ORCA_WORKTREE_ID: "" },
			{ ORCA_PANE_KEY: " ", ORCA_WORKTREE_ID: "worktree-1" },
			{ ORCA_PANE_KEY: "tab-1:12345678-1234-1234-1234-123456789abc", ORCA_WORKTREE_ID: " " },
			{ TERM_PROGRAM: "orca" },
		]) {
			expect(hasTerminalMultiplexerSession("orca", env)).toBe(false);
		}
	});
});

describe("terminal multiplexer classification", () => {
	it("preserves nested-provider precedence and TERM-only classification", () => {
		expect(classifyTerminalMultiplexer({ HERDR_PANE_ID: "p1", TMUX: "session" })).toBe("herdr");
		expect(classifyTerminalMultiplexer({ TMUX: "session", STY: "screen" })).toBe("tmux");
		expect(classifyTerminalMultiplexer({ STY: "screen", ZELLIJ: "session" })).toBe("screen");
		expect(classifyTerminalMultiplexer({ TERM: "screen-256color" })).toBe("screen");
	});

	it("classifies Orca after nested multiplexers without moving it off the direct render path", () => {
		const orcaEnv = {
			ORCA_PANE_KEY: "tab-1:12345678-1234-1234-1234-123456789abc",
			ORCA_WORKTREE_ID: "worktree-1",
		};
		expect(classifyTerminalMultiplexer(orcaEnv)).toBe("orca");
		expect(isInsideTerminalMultiplexer(orcaEnv)).toBe(false);
		expect(classifyTerminalMultiplexer({ ...orcaEnv, TMUX: "session" })).toBe("tmux");
		expect(isInsideTerminalMultiplexer({ ...orcaEnv, TMUX: "session" })).toBe(true);
		expect(classifyTerminalMultiplexer({ ...orcaEnv, ZELLIJ: "session" })).toBe("zellij");
		expect(classifyTerminalMultiplexer({ ...orcaEnv, TERM: "tmux-256color" })).toBe("tmux");
		expect(classifyTerminalMultiplexer({ ...orcaEnv, TERM: "screen-256color" })).toBe("screen");
		expect(classifyTerminalMultiplexer({ TERM_PROGRAM: "orca" })).toBe(null);
		expect(classifyTerminalMultiplexer({ ORCA_PANE_KEY: "tab-1:12345678-1234-1234-1234-123456789abc" })).toBe(null);
		expect(classifyTerminalMultiplexer({ ORCA_WORKTREE_ID: "worktree-1" })).toBe(null);
	});

	it("recognizes session markers through the generic render-path gate", () => {
		expect(isInsideTerminalMultiplexer({ HERDR_PANE_ID: "p1" })).toBe(true);
		expect(isInsideTerminalMultiplexer({ WMUX: "1" })).toBe(true);
		expect(isInsideTerminalMultiplexer({ WMUX_SURFACE_ID: "3f2a" })).toBe(true);
		expect(isInsideTerminalMultiplexer({ WMUX: "0" })).toBe(false);
		expect(isInsideTerminalMultiplexer({ WMUX_SURFACE_ID: "" })).toBe(false);
		expect(isInsideTerminalMultiplexer({ WMUX_CLI: "C:/wmux/wmux.exe" })).toBe(false);
		expect(isInsideTerminalMultiplexer({ WMUX_PIPE: "\\\\.\\pipe\\wmux" })).toBe(false);
	});
});

describe("detectTerminalId", () => {
	it("recognizes rio via TERM_PROGRAM", () => {
		expect(detectTerminalId({ TERM_PROGRAM: "rio", COLORTERM: "truecolor" })).toBe("rio");
	});

	it("maps rio to kitty graphics with verified hyperlink capability", () => {
		// Reporter-verified (#12205): kitty graphics + true color. Hyperlinks
		// verified against rio 0.5.28's published escape sequence support plus a
		// live OSC 8 Alt+click and OSC 52 round-trip. Notifications stay on BEL:
		// rio's Windows toast needs an AUMID registration it does not create
		// (observed silent drop), so Osc9 would only remove the D-Bus fallback
		// for Linux rio users.
		const info = getTerminalInfo("rio");
		expect(info.id).toBe("rio");
		expect(info.imageProtocol).toBe(ImageProtocol.Kitty);
		expect(info.trueColor).toBe(true);
		expect(info.hyperlinks).toBe(true);
		expect(info.notifyProtocol).toBe(NotifyProtocol.Bell);
	});

	it("recognizes Warp before the true-color fallback", () => {
		expect(detectTerminalId({ TERM_PROGRAM: "WarpTerminal", COLORTERM: "truecolor" })).toBe("warp");
	});

	it("recognizes Monstar by TERM and routes notifications through OSC 9", () => {
		// Monstar exports TERM=monstar and COLORTERM=truecolor. The trueColor
		// fallback uses BEL plus an action-less notify-send toast, so a click
		// cannot focus the window. Monstar's own OSC 9 notification can.
		const id = detectTerminalId({ TERM: "monstar", COLORTERM: "truecolor" });
		expect(id).toBe("monstar");
		expect(getTerminalInfo(id).notifyProtocol).toBe(NotifyProtocol.Osc9);
	});

	it("falls back to trueColor on VTE/Ptyxis environments — VTE OSC 9 is ConEmu progress, not a notification protocol", () => {
		const env = { TERM: "xterm-256color", TERM_PROGRAM: "", COLORTERM: "truecolor", VTE_VERSION: "8400" };

		expect(detectTerminalId(env)).toBe("trueColor");
	});
});

describe("tmux client terminal resolution", () => {
	it.skipIf(process.platform === "win32")("uses the attached client's terminal profile", async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tmux-client-"));
		try {
			const tmux = path.join(binDir, "tmux");
			await Bun.write(
				tmux,
				`#!/bin/sh
[ "$1" = "display-message" ] && [ "$2" = "-p" ] && [ "$3" = '#{client_termtype}' ] || exit 64
printf "%s\\n" "WezTerm 20260905-175422-0f4b5596"
`,
			);
			await fs.chmod(tmux, 0o755);
			const env = subprocessEnv({
				PI_TEST_RUNTIME: undefined,
				BUN_ENV: undefined,
				NODE_ENV: undefined,
				TERM: "tmux-256color",
				TERM_PROGRAM: "tmux",
				TERM_PROGRAM_VERSION: "3.6b",
				COLORTERM: "truecolor",
				TMUX: "/tmp/tmux-1000/default,4242,0",
				SSH_CONNECTION: "client 1 server 22",
				PATH: `${binDir}${path.delimiter}${Bun.env.PATH ?? ""}`,
			});
			const proc = Bun.spawn({
				cmd: [
					process.execPath,
					"--eval",
					`import { TERMINAL, TERMINAL_ID } from "@oh-my-pi/pi-tui/terminal-capabilities";
console.log(JSON.stringify({ id: TERMINAL_ID, notifyProtocol: TERMINAL.notifyProtocol }));`,
				],
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toBe('{"id":"wezterm","notifyProtocol":"\\u001b]9;"}\n');
		} finally {
			await fs.rm(binDir, { force: true, recursive: true });
		}
	});
});

describe("synchronizedOutputUserOverride", () => {
	it("returns null when the user expresses no preference", () => {
		expect(synchronizedOutputUserOverride({})).toBeNull();
		expect(synchronizedOutputUserOverride({ TERM: "xterm-256color" })).toBeNull();
	});

	it("returns false for either opt-out flag", () => {
		expect(synchronizedOutputUserOverride({ PI_NO_SYNC_OUTPUT: "1" })).toBe(false);
		expect(synchronizedOutputUserOverride({ PI_TUI_SYNC_OUTPUT: "0" })).toBe(false);
	});

	it("returns true for either force-on flag", () => {
		expect(synchronizedOutputUserOverride({ PI_FORCE_SYNC_OUTPUT: "1" })).toBe(true);
		expect(synchronizedOutputUserOverride({ PI_TUI_SYNC_OUTPUT: "1" })).toBe(true);
	});

	it("resolves opt-out ahead of force-on when both are set", () => {
		expect(synchronizedOutputUserOverride({ PI_NO_SYNC_OUTPUT: "1", PI_FORCE_SYNC_OUTPUT: "1" })).toBe(false);
		expect(synchronizedOutputUserOverride({ PI_TUI_SYNC_OUTPUT: "0", PI_FORCE_SYNC_OUTPUT: "1" })).toBe(false);
	});
});

describe("shouldEnableSynchronizedOutputByDefault", () => {
	it("enables sync for every known direct terminal, including Alacritty and VS Code", () => {
		for (const id of ["kitty", "ghostty", "monstar", "wezterm", "iterm2", "alacritty", "vscode"] as const) {
			expect(shouldEnableSynchronizedOutputByDefault({}, id)).toBe(true);
		}
	});

	it("enables sync only when WT_SESSION does not contradict the terminal identity", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ WT_SESSION: "abc" }, "trueColor")).toBe(true);
		expect(
			shouldEnableSynchronizedOutputByDefault(
				{ WT_SESSION: "abc", TERM_PROGRAM: "Windows_Terminal", COLORTERM: "truecolor" },
				"trueColor",
			),
		).toBe(true);
		expect(
			shouldEnableSynchronizedOutputByDefault(
				{ WT_SESSION: "0", TERM_PROGRAM: "Tabby", COLORTERM: "truecolor" },
				"trueColor",
			),
		).toBe(false);
	});

	it("enables sync when TERM_FEATURES advertises the Sy capability, even through SSH/mux", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ TERM_FEATURES: "ClSyTc" }, "base")).toBe(true);
		expect(
			shouldEnableSynchronizedOutputByDefault({ TERM_FEATURES: "ClSyTc", SSH_CONNECTION: "1 2 3 4" }, "base"),
		).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM_FEATURES: "ClSyTc", TMUX: "1" }, "base")).toBe(true);
	});

	it("does not treat a TERM_FEATURES list without the Sy token as advertising support", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ TERM_FEATURES: "ClTc" }, "base")).toBe(false);
	});

	it("no longer blanket-disables SSH for recognized terminals", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ SSH_CONNECTION: "1 2 3 4" }, "iterm2")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ SSH_TTY: "/dev/pts/3" }, "kitty")).toBe(true);
	});

	it("keeps risky multiplexers off by default even when an inner terminal id leaks", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ TMUX: "1" }, "kitty")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ ZELLIJ: "0" }, "ghostty")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ STY: "x" }, "wezterm")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ CMUX_WORKSPACE_ID: "workspace" }, "wezterm")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM: "tmux-256color" }, "iterm2")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM: "screen-256color" }, "kitty")).toBe(false);
	});

	it("enables sync inside Herdr even when a Kitty/Ghostty identity leaks", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_ENV: "1" }, "kitty")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_ENV: "1" }, "ghostty")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_ENV: "1" }, "trueColor")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_ENV: "1" }, "base")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_PANE_ID: "p1" }, "kitty")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_PANE_ID: "p1" }, "ghostty")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_PANE_ID: "p1", TMUX: "1" }, "kitty")).toBe(true);
		// Any Herdr session in the path enables sync, whichever layer classifies first.
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_PANE_ID: "p1", STY: "x" }, "base")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_PANE_ID: "p1", ZELLIJ: "0" }, "base")).toBe(true);
	});

	it("does not treat client-only Herdr vars as inside a pane", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_SOCKET_PATH: "/tmp/x", TMUX: "1" }, "kitty")).toBe(false);
	});

	it("still lets a user opt-out inside Herdr", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_ENV: "1", PI_NO_SYNC_OUTPUT: "1" }, "ghostty")).toBe(
			false,
		);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_ENV: "1", PI_TUI_SYNC_OUTPUT: "0" }, "kitty")).toBe(false);
	});

	it("keeps known-unsupported and unknown profiles off", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ VTE_VERSION: "6800" }, "base")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ TERM: "xterm-256color" }, "base")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({}, "base")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({}, "trueColor")).toBe(false);
	});

	it("lets a user opt-out beat every positive heuristic", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ PI_NO_SYNC_OUTPUT: "1" }, "kitty")).toBe(false);
		expect(shouldEnableSynchronizedOutputByDefault({ PI_TUI_SYNC_OUTPUT: "0" }, "ghostty")).toBe(false);
		expect(
			shouldEnableSynchronizedOutputByDefault(
				{ PI_NO_SYNC_OUTPUT: "1", WT_SESSION: "abc", TERM_FEATURES: "Sy" },
				"kitty",
			),
		).toBe(false);
	});

	it("lets a user force-on beat the conservative defaults", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ PI_FORCE_SYNC_OUTPUT: "1" }, "base")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ PI_TUI_SYNC_OUTPUT: "1", TMUX: "1" }, "base")).toBe(true);
		expect(
			shouldEnableSynchronizedOutputByDefault({ PI_FORCE_SYNC_OUTPUT: "1", SSH_CONNECTION: "1 2 3 4" }, "base"),
		).toBe(true);
	});
});

describe("Warp terminal capabilities", () => {
	it("resolves the process-wide Warp terminal id and image protocol from TERM_PROGRAM", async () => {
		const env = subprocessEnv({
			TERM_PROGRAM: "WarpTerminal",
			COLORTERM: "truecolor",
		});
		for (const key of ["WSL_DISTRO_NAME", "WSL_INTEROP"]) {
			delete env[key];
		}

		const proc = Bun.spawn({
			cmd: [
				process.execPath,
				"--eval",
				`import { ImageProtocol, TERMINAL, TERMINAL_ID } from "@oh-my-pi/pi-tui/terminal-capabilities";
console.log(JSON.stringify({ id: TERMINAL_ID, imageProtocol: TERMINAL.imageProtocol, expected: ImageProtocol.Kitty }));`,
			],
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const resolved = JSON.parse(stdout) as { id: string; imageProtocol: string | null; expected: string };
		expect(resolved.id).toBe("warp");
		// Warp for Windows lacks Kitty graphics support.
		expect(resolved.imageProtocol).toBe(process.platform === "win32" ? null : resolved.expected);
	});

	it("is Kitty-capable with true color but no OSC 8 hyperlinks", () => {
		const warp = getTerminalInfo("warp");
		// Warp lacks Kitty graphics on Windows hosts, including WSL.
		const windowsHost =
			process.platform === "win32" ||
			(process.platform === "linux" && Boolean(Bun.env.WSL_DISTRO_NAME || Bun.env.WSL_INTEROP));
		expect(warp.imageProtocol).toBe(windowsHost ? null : ImageProtocol.Kitty);
		expect(warp.trueColor).toBe(true);
		expect(warp.hyperlinks).toBe(false);
		expect(warp.notifyProtocol).toBe(NotifyProtocol.Osc9);
		expect(warp.supportsTextSizing).toBe(false);
	});

	it("uses Kitty images on macOS/Linux and disables them on Windows", () => {
		const mac = getTerminalInfo("warp", "darwin", {});
		const linux = getTerminalInfo("warp", "linux", {});
		const windows = getTerminalInfo("warp", "win32", {});

		expect(resolveWarpImageProtocol("darwin", {})).toBe(ImageProtocol.Kitty);
		expect(resolveWarpImageProtocol("linux", {})).toBe(ImageProtocol.Kitty);
		expect(resolveWarpImageProtocol("win32", {})).toBeNull();
		expect(mac.imageProtocol).toBe(ImageProtocol.Kitty);
		expect(linux.imageProtocol).toBe(ImageProtocol.Kitty);
		expect(windows.imageProtocol).toBeNull();
		expect(linux.trueColor).toBe(true);
		expect(linux.hyperlinks).toBe(false);
		expect(linux.deccara).toBe(false);
		expect(linux.supportsTextSizing).toBe(false);
	});

	it("treats WSL as the Windows host so Kitty APC garbage never reaches Warp for Windows", () => {
		// Bun reports process.platform === "linux" inside WSL even though the
		// renderer is the Windows Warp build, which lacks Kitty support.
		const wslDistro = getTerminalInfo("warp", "linux", { WSL_DISTRO_NAME: "Ubuntu" });
		const wslInterop = getTerminalInfo("warp", "linux", { WSL_INTEROP: "/run/WSL/1_interop" });

		expect(resolveWarpImageProtocol("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBeNull();
		expect(resolveWarpImageProtocol("linux", { WSL_INTEROP: "/run/WSL/1_interop" })).toBeNull();
		expect(wslDistro.imageProtocol).toBeNull();
		expect(wslInterop.imageProtocol).toBeNull();
	});

	it("leaves synchronized output off by default and honors hyperlink force-on", () => {
		expect(shouldEnableSynchronizedOutputByDefault({}, "warp")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({}, "warp")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ PI_FORCE_HYPERLINKS: "1" }, "warp")).toBe(true);
	});
});

/**
 * Build a child-process env for the TERMINAL resolution subprocesses: inherits
 * the runner's environment, strips every terminal-identification marker and
 * image-protocol pin, then applies the caller's overrides. Keeps the suite
 * independent of which terminal it runs inside (full-suite safe).
 */
function subprocessEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...Bun.env };
	for (const key of [
		"PI_FORCE_IMAGE_PROTOCOL",
		"PASEO_TERMINAL_ID",
		"KITTY_WINDOW_ID",
		"GHOSTTY_RESOURCES_DIR",
		...TERMINAL_MULTIPLEXER_ENV_KEYS,
		"WEZTERM_PANE",
		"ITERM_SESSION_ID",
		"VSCODE_PID",
		"ALACRITTY_WINDOW_ID",
	]) {
		delete env[key];
	}
	return { ...env, ...overrides };
}

describe("otty terminal capabilities", () => {
	it("recognizes TERM_PROGRAM=otty before the true-color fallback", () => {
		// Env as reported in #12660: otty sets TERM_PROGRAM=otty with a plain
		// xterm TERM, so detection used to fall through to trueColor.
		const env = {
			TERM_PROGRAM: "otty",
			TERM_PROGRAM_VERSION: "1.5.1",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		};
		expect(detectTerminalId(env)).toBe("otty");
	});

	it("is Kitty-capable with true color, OSC 8 hyperlinks and OSC 99 notifications", () => {
		const otty = getTerminalInfo("otty");
		expect(otty.imageProtocol).toBe(ImageProtocol.Kitty);
		expect(otty.trueColor).toBe(true);
		expect(otty.hyperlinks).toBe(true);
		expect(otty.notifyProtocol).toBe(NotifyProtocol.Osc99);
		// Unverified capabilities stay off (docs confirm Kitty graphics,
		// hyperlinks, notifications and synchronized output only).
		expect(otty.deccara).toBe(false);
		expect(otty.supportsTextSizing).toBe(false);
	});

	it("resolves the Kitty image protocol for an otty session", () => {
		const env = { TERM_PROGRAM: "otty", TERM: "xterm-256color", COLORTERM: "truecolor" };
		expect(resolveImageProtocol("otty", env, true)).toBe(ImageProtocol.Kitty);
	});

	it("resolves the process-wide terminal id and image protocol from TERM_PROGRAM=otty", async () => {
		const env = subprocessEnv({
			TERM_PROGRAM: "otty",
			TERM_PROGRAM_VERSION: "1.5.1",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		});

		const proc = Bun.spawn({
			cmd: [
				process.execPath,
				"--eval",
				`import { ImageProtocol, TERMINAL, TERMINAL_ID } from "@oh-my-pi/pi-tui/terminal-capabilities";
console.log(JSON.stringify({ id: TERMINAL_ID, imageProtocol: TERMINAL.imageProtocol, expected: ImageProtocol.Kitty }));`,
			],
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const resolved = JSON.parse(stdout) as { id: string; imageProtocol: string | null; expected: string };
		expect(resolved.id).toBe("otty");
		expect(resolved.imageProtocol).toBe(resolved.expected);
	});
});

describe("Herdr image protocol mask", () => {
	it("rejects a leaked Ghostty protocol when Herdr owns the pane grid", () => {
		const env = {
			COLORTERM: "truecolor",
			GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty",
			HERDR_ENV: "1",
			TERM: "xterm-256color",
			TERM_PROGRAM: "ghostty",
		};
		const terminalId = detectTerminalId(env);

		expect(terminalId).toBe("ghostty");
		expect(resolveImageProtocol(terminalId, env, true)).toBeNull();
	});

	it("rejects a leaked Ghostty protocol when HERDR_PANE_ID is set without HERDR_ENV", () => {
		const env = {
			COLORTERM: "truecolor",
			GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty",
			HERDR_PANE_ID: "p1",
			TERM: "xterm-256color",
			TERM_PROGRAM: "ghostty",
		};
		const terminalId = detectTerminalId(env);

		expect(terminalId).toBe("ghostty");
		expect(resolveImageProtocol(terminalId, env, true)).toBeNull();
	});
});

describe("Paseo embedder carve-out", () => {
	it("detects Paseo via PASEO_TERMINAL_ID", () => {
		expect(isPaseoEmbedder({})).toBe(false);
		expect(isPaseoEmbedder({ PASEO_TERMINAL_ID: "term-1" })).toBe(true);
	});

	it("drops the multiplexer-restored Kitty fallback inside Paseo", () => {
		// Regression (getpaseo/paseo#3850): tmux inside a Paseo pane resolves to
		// base (null static protocol) and TERM=tmux-* would restore Kitty via
		// the fallback — the embedder carve-out must win over the fallback.
		expect(resolveImageProtocol("base", { TERM: "tmux-256color", PASEO_TERMINAL_ID: "term-1" }, true)).toBeNull();
		expect(resolveImageProtocol("base", { TERM: "tmux-256color" }, true)).toBe(ImageProtocol.Kitty);
	});

	it("drops Kitty graphics when Paseo hosts the terminal", async () => {
		const env = subprocessEnv({ TERM_PROGRAM: "kitty", PASEO_TERMINAL_ID: "term-1" });

		const proc = Bun.spawn({
			cmd: [
				process.execPath,
				"--eval",
				`import { ImageProtocol, TERMINAL, TERMINAL_ID } from "@oh-my-pi/pi-tui/terminal-capabilities";
console.log(JSON.stringify({ id: TERMINAL_ID, imageProtocol: TERMINAL.imageProtocol, expected: ImageProtocol.Kitty }));`,
			],
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const resolved = JSON.parse(stdout) as { id: string; imageProtocol: string | null };
		expect(resolved.id).toBe("kitty");
		// Paseo's xterm.js renderer implements neither Kitty graphics nor
		// Unicode placeholders (getpaseo/paseo#3850).
		expect(resolved.imageProtocol).toBeNull();
	});

	it("keeps Kitty graphics for a real kitty without PASEO_TERMINAL_ID", async () => {
		const env = subprocessEnv({ TERM_PROGRAM: "kitty" });

		const proc = Bun.spawn({
			cmd: [
				process.execPath,
				"--eval",
				`import { ImageProtocol, TERMINAL, TERMINAL_ID } from "@oh-my-pi/pi-tui/terminal-capabilities";
console.log(JSON.stringify({ id: TERMINAL_ID, imageProtocol: TERMINAL.imageProtocol, expected: ImageProtocol.Kitty }));`,
			],
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const resolved = JSON.parse(stdout) as { id: string; imageProtocol: string | null; expected: string };
		expect(resolved.id).toBe("kitty");
		expect(resolved.imageProtocol).toBe(resolved.expected);
	});
});

describe("hyperlinksUserOverride", () => {
	it("returns null when neither override is set", () => {
		expect(hyperlinksUserOverride({})).toBeNull();
		expect(hyperlinksUserOverride({ TERM: "xterm-256color" })).toBeNull();
	});

	it("returns true for the force-on flag", () => {
		expect(hyperlinksUserOverride({ PI_FORCE_HYPERLINKS: "1" })).toBe(true);
	});

	it("returns false for the opt-out flag", () => {
		expect(hyperlinksUserOverride({ PI_NO_HYPERLINKS: "1" })).toBe(false);
	});

	it("resolves opt-out ahead of force-on when both are set", () => {
		expect(hyperlinksUserOverride({ PI_NO_HYPERLINKS: "1", PI_FORCE_HYPERLINKS: "1" })).toBe(false);
	});

	it("ignores values other than the literal '1'", () => {
		// Mirrors the sync-output knobs: only the canonical `1` toggles them;
		// `true`/`yes` are not accepted to keep the contract obvious.
		expect(hyperlinksUserOverride({ PI_FORCE_HYPERLINKS: "true" })).toBeNull();
		expect(hyperlinksUserOverride({ PI_FORCE_HYPERLINKS: "0" })).toBeNull();
		expect(hyperlinksUserOverride({ PI_NO_HYPERLINKS: "0" })).toBeNull();
	});
});

describe("shouldEnableHyperlinksByDefault", () => {
	it("enables hyperlinks on every known direct terminal", () => {
		for (const id of ["kitty", "ghostty", "wezterm", "iterm2", "alacritty", "vscode"] as const) {
			expect(shouldEnableHyperlinksByDefault({}, id)).toBe(true);
		}
	});

	it("keeps the base/trueColor fallback terminals off", () => {
		expect(shouldEnableHyperlinksByDefault({}, "base")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({}, "trueColor")).toBe(false);
	});

	it("keeps GNU screen always off, even when the inner terminal supports OSC 8", () => {
		expect(shouldEnableHyperlinksByDefault({ STY: "1234.pts-0.host" }, "wezterm")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ TERM: "screen-256color" }, "kitty")).toBe(false);
	});

	it("treats TMUX as authoritative even when TERM is screen-family (tmux's historical default-terminal)", () => {
		// tmux's historical `default-terminal` is `screen-256color`, so a tmux
		// session can have a screen-family TERM. The TMUX env signals tmux is the
		// immediate layer and its version gate must run regardless of TERM.
		expect(
			shouldEnableHyperlinksByDefault(
				{
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM: "screen-256color",
					TERM_PROGRAM: "tmux",
					TERM_PROGRAM_VERSION: "3.4",
				},
				"wezterm",
			),
		).toBe(true);
		expect(
			shouldEnableHyperlinksByDefault(
				{
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM: "screen",
					TERM_PROGRAM: "tmux",
					TERM_PROGRAM_VERSION: "3.3a",
				},
				"wezterm",
			),
		).toBe(false);
	});

	it("lets GNU screen's STY marker veto tmux enabling in nested multiplexer sessions", () => {
		expect(
			shouldEnableHyperlinksByDefault(
				{
					STY: "1234.pts-0.host",
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM_PROGRAM: "tmux",
					TERM_PROGRAM_VERSION: "3.4",
				},
				"wezterm",
			),
		).toBe(false);
		expect(
			shouldEnableHyperlinksByDefault(
				{
					STY: "1234.pts-0.host",
					TMUX: "/tmp/tmux-1000/default,1,0",
					TERM: "screen-256color",
					TERM_PROGRAM: "tmux",
					TERM_PROGRAM_VERSION: "3.5a",
				},
				"kitty",
			),
		).toBe(false);
	});

	it("keeps tmux off when no version is reported (old tmux without TERM_PROGRAM_VERSION)", () => {
		expect(shouldEnableHyperlinksByDefault({ TMUX: "/tmp/tmux-1000/default,1,0" }, "wezterm")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ TERM: "tmux-256color" }, "wezterm")).toBe(false);
	});

	it("keeps tmux off when self-reported version is below 3.4", () => {
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.3a" },
				"wezterm",
			),
		).toBe(false);
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "2.9" },
				"kitty",
			),
		).toBe(false);
	});

	it("enables tmux >= 3.4 since tmux forwards OSC 8 cell attributes to the outer terminal", () => {
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.4" },
				"wezterm",
			),
		).toBe(true);
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.5a" },
				"wezterm",
			),
		).toBe(true);
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "4.0" },
				"kitty",
			),
		).toBe(true);
	});

	it("respects the static per-terminal flag even when force-on is absent", () => {
		expect(
			shouldEnableHyperlinksByDefault(
				{ TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.5a" },
				"base",
			),
		).toBe(false);
	});

	it("enables Herdr panes: Herdr renders OSC 8 in its own grid and opens links itself", () => {
		expect(shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", TERM: "xterm-256color" }, "base")).toBe(true);
		expect(shouldEnableHyperlinksByDefault({ HERDR_PANE_ID: "w1:p1", TERM: "xterm-256color" }, "base")).toBe(true);
	});

	it("keeps screen/tmux nested in a Herdr pane on their own rules", () => {
		expect(shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", STY: "1234.pts-0.host" }, "base")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", TMUX: "/tmp/tmux-1000/default,1,0" }, "base")).toBe(
			false,
		);
		expect(shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", PI_NO_HYPERLINKS: "1" }, "base")).toBe(false);
	});

	it("keeps Herdr's own rendering when the other nested layers have no OSC 8 policy", () => {
		// Zellij has no hyperlink policy, and a stale screen-family TERM is not a
		// session, so neither overrides the Herdr pane.
		expect(shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", ZELLIJ: "0" }, "base")).toBe(true);
		expect(shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", TERM: "screen-256color" }, "base")).toBe(true);
	});

	it("gates a Herdr pane nested with tmux on tmux's version, and screen still vetoes it", () => {
		const tmux34 = { TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.4" };
		expect(shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", ...tmux34 }, "kitty")).toBe(true);
		expect(
			shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", ...tmux34, TERM_PROGRAM_VERSION: "3.3a" }, "kitty"),
		).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ HERDR_ENV: "1", ...tmux34, STY: "1234.pts-0.host" }, "kitty")).toBe(
			false,
		);
	});

	it("treats a multiplexer TERM as off under a session without an OSC 8 policy", () => {
		expect(shouldEnableHyperlinksByDefault({ ZELLIJ: "0", TERM: "screen-256color" }, "kitty")).toBe(false);
		expect(shouldEnableHyperlinksByDefault({ ZELLIJ: "0", TERM: "xterm-256color" }, "kitty")).toBe(true);
	});

	it("lets PI_NO_HYPERLINKS beat every positive heuristic", () => {
		expect(shouldEnableHyperlinksByDefault({ PI_NO_HYPERLINKS: "1" }, "kitty")).toBe(false);
		expect(
			shouldEnableHyperlinksByDefault(
				{ PI_NO_HYPERLINKS: "1", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.5a", TMUX: "1" },
				"wezterm",
			),
		).toBe(false);
	});

	it("lets PI_FORCE_HYPERLINKS override the conservative defaults (old tmux, screen, base terminal)", () => {
		expect(shouldEnableHyperlinksByDefault({ PI_FORCE_HYPERLINKS: "1" }, "base")).toBe(true);
		expect(shouldEnableHyperlinksByDefault({ PI_FORCE_HYPERLINKS: "1", TMUX: "1" }, "wezterm")).toBe(true);
		expect(shouldEnableHyperlinksByDefault({ PI_FORCE_HYPERLINKS: "1", STY: "1.pts-0" }, "kitty")).toBe(true);
	});
});

describe("detectStyledUnderlineSupport", () => {
	it("enables the colon form only on terminals that implement styled underlines", () => {
		expect(detectStyledUnderlineSupport("kitty", {})).toBe(true);
		expect(detectStyledUnderlineSupport("ghostty", {})).toBe(true);
		expect(detectStyledUnderlineSupport("monstar", {})).toBe(true);
		expect(detectStyledUnderlineSupport("wezterm", {})).toBe(true);
		expect(detectStyledUnderlineSupport("iterm2", { TERM_PROGRAM_VERSION: "3.5.0" })).toBe(true);
	});

	it("keeps Apple Terminal and other unproven hosts on the flat underline", () => {
		// Apple Terminal advertises no id marker and resolves to `base`, where the
		// colon-form reset paints a black bar — so base and every fallback stay off.
		expect(detectTerminalId({ TERM_PROGRAM: "Apple_Terminal" })).toBe("base");
		expect(detectStyledUnderlineSupport("base")).toBe(false);
		expect(detectStyledUnderlineSupport("trueColor")).toBe(false);
		expect(detectStyledUnderlineSupport("vscode")).toBe(false);
		expect(detectStyledUnderlineSupport("alacritty")).toBe(false);
		expect(detectStyledUnderlineSupport("warp")).toBe(false);
		expect(detectStyledUnderlineSupport("orca")).toBe(false);
	});

	it("enables iTerm2 only on a confirmed version >= 3.5, else flat fallback", () => {
		expect(detectStyledUnderlineSupport("iterm2", { TERM_PROGRAM_VERSION: "2.1.4" })).toBe(false);
		expect(detectStyledUnderlineSupport("iterm2", { TERM_PROGRAM_VERSION: "3.4.0" })).toBe(false);
		expect(detectStyledUnderlineSupport("iterm2", { TERM_PROGRAM_VERSION: "3.5.0" })).toBe(true);
		expect(detectStyledUnderlineSupport("iterm2", { TERM_PROGRAM_VERSION: "4.0.0" })).toBe(true);
		expect(detectStyledUnderlineSupport("iterm2", {})).toBe(false);
	});

	it("disables the colon form under a multiplexer even when a proven terminal id leaks through", () => {
		expect(detectStyledUnderlineSupport("kitty", { TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(false);
		expect(detectStyledUnderlineSupport("ghostty", { STY: "1234.pts-0.host" })).toBe(false);
		expect(detectStyledUnderlineSupport("wezterm", { TERM: "screen-256color" })).toBe(false);
		expect(detectStyledUnderlineSupport("iterm2", { TERM_PROGRAM_VERSION: "3.5.0", ZELLIJ: "0" })).toBe(false);
	});
});
