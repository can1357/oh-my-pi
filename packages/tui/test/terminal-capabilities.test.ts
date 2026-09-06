import { describe, expect, it } from "bun:test";
import {
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
} from "@oh-my-pi/pi-tui/terminal-capabilities";

describe("detectTerminalId", () => {
	it("recognizes Warp before the true-color fallback", () => {
		expect(detectTerminalId({ TERM_PROGRAM: "WarpTerminal", COLORTERM: "truecolor" })).toBe("warp");
	});

	it("falls back to trueColor on VTE/Ptyxis environments — VTE OSC 9 is ConEmu progress, not a notification protocol", () => {
		const env = { TERM: "xterm-256color", TERM_PROGRAM: "", COLORTERM: "truecolor", VTE_VERSION: "8400" };

		expect(detectTerminalId(env)).toBe("trueColor");
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
		for (const id of ["kitty", "ghostty", "wezterm", "iterm2", "alacritty", "vscode"] as const) {
			expect(shouldEnableSynchronizedOutputByDefault({}, id)).toBe(true);
		}
	});

	it("enables sync in Windows Terminal / WSL via WT_SESSION regardless of terminal id", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ WT_SESSION: "abc" }, "trueColor")).toBe(true);
		// WSL shape: Linux + WT_SESSION + COLORTERM=truecolor collapses to trueColor id.
		expect(shouldEnableSynchronizedOutputByDefault({ WT_SESSION: "abc", COLORTERM: "truecolor" }, "trueColor")).toBe(
			true,
		);
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
	it("recognizes TERM_PROGRAM=WarpTerminal before the true-color fallback", () => {
		expect(detectTerminalId({ TERM_PROGRAM: "WarpTerminal", COLORTERM: "truecolor" })).toBe("warp");
	});

	it("resolves the process-wide Warp terminal id and image protocol from TERM_PROGRAM", async () => {
		const env: Record<string, string | undefined> = {
			...Bun.env,
			TERM_PROGRAM: "WarpTerminal",
			COLORTERM: "truecolor",
		};
		for (const key of [
			"PI_FORCE_IMAGE_PROTOCOL",
			"WSL_DISTRO_NAME",
			"WSL_INTEROP",
			"KITTY_WINDOW_ID",
			"GHOSTTY_RESOURCES_DIR",
			"WEZTERM_PANE",
			"ITERM_SESSION_ID",
			"VSCODE_PID",
			"ALACRITTY_WINDOW_ID",
		]) {
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
		"WEZTERM_PANE",
		"ITERM_SESSION_ID",
		"VSCODE_PID",
		"ALACRITTY_WINDOW_ID",
	]) {
		delete env[key];
	}
	return { ...env, ...overrides };
}

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
