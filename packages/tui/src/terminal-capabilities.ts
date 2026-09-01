import { encodeSixel } from "@oh-my-pi/pi-natives";
import { $env, isBunTestRuntime, isTerminalHeadless } from "@oh-my-pi/pi-utils";
import { sendDesktopNotification, shouldDeliverDesktopNotification } from "./desktop-notify";
import {
	detectKittyUnicodePlaceholdersSupport,
	getKittyGraphics,
	KITTY_PLACEHOLDER,
	kittyPlaceholdersFit,
	renderKittyPlaceholderLines,
	setKittyGraphics,
} from "./kitty-graphics";
import { isInsideTmux, wrapTmuxPassthrough, wrapTmuxPassthroughIfNeeded } from "./tmux";
import type { HangulCompatibilityJamoWidth } from "./utils";

export { isInsideTmux, wrapTmuxPassthrough } from "./tmux";

export enum ImageProtocol {
	Kitty = "\x1b_G",
	Iterm2 = "\x1b]1337;File=",
	Sixel = "\x1bPq",
}

export enum NotifyProtocol {
	Bell = "\x07",
	Osc99 = "\x1b]99;;",
	Osc9 = "\x1b]9;",
}

export type TerminalId =
	| "kitty"
	| "ghostty"
	| "wezterm"
	| "iterm2"
	| "vscode"
	| "alacritty"
	| "warp"
	| "orca"
	| "base"
	| "trueColor";

const CMUX_NOTIFICATION_TITLE = "Oh My Pi";
const CMUX_SURFACE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

/**
 * Route a notification through cmux when the process belongs to a concrete
 * surface. Workspace/socket state alone is not enough: only the injected
 * surface UUID identifies the pane that should receive the notification.
 * Returns whether cmux owns delivery so the caller can preserve every existing
 * terminal fallback unchanged when no valid surface is present.
 */
function sendCmuxNotification(message: string | TerminalNotification, env: NodeJS.ProcessEnv = Bun.env): boolean {
	const surfaceId = env.CMUX_SURFACE_ID?.trim();
	if (!surfaceId || !CMUX_SURFACE_ID_PATTERN.test(surfaceId)) return false;

	const title =
		typeof message === "string" ? CMUX_NOTIFICATION_TITLE : message.title?.trim() || CMUX_NOTIFICATION_TITLE;
	const body = typeof message === "string" ? message : (message.body ?? "");
	try {
		const child = Bun.spawn({
			cmd: ["cmux", "notify", "--surface", surfaceId, "--title", title, "--body", body],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		child.unref();
	} catch {
		// A missing cmux binary leaves delivery to the existing terminal fallback.
		return false;
	}
	return true;
}

function hasNeedleBefore(line: string, needle: string, limit: number): boolean {
	const index = line.indexOf(needle);
	return index !== -1 && index + needle.length <= limit;
}

function hasSixelDcsStart(line: string): boolean {
	const limit = Math.min(line.length, 128);
	let from = 0;
	for (;;) {
		const start = line.indexOf("\x1bP", from);
		if (start === -1 || start + 3 > limit) return false;
		let i = start + 2;
		while (i < limit) {
			const code = line.charCodeAt(i);
			if ((code >= 0x30 && code <= 0x39) || code === 0x3b) {
				i++;
				continue;
			}
			break;
		}
		if (i < limit && line.charCodeAt(i) === 0x71) return true;
		from = start + 2;
	}
}

/** Terminal capability details used for rendering and protocol selection. */
export class TerminalInfo {
	constructor(
		public readonly id: TerminalId,
		public readonly imageProtocol: ImageProtocol | null,
		public readonly trueColor: boolean,
		public readonly hyperlinks: boolean,
		public readonly notifyProtocol: NotifyProtocol = NotifyProtocol.Bell,
		public readonly deccara: boolean = false,
		readonly supportsScreenToScrollback: boolean = false,
		/** Renders the Kitty OSC 66 text-sizing protocol (scaled spans). Kitty only. */
		public readonly supportsTextSizing: boolean = false,
		/**
		 * Hangul Compatibility Jamo (U+3131..=U+318E) cell width. Ghostty and Orca follow
		 * UAX#11 (2 cells); Warp paints 1; "platform" keeps the OS default
		 * (macOS narrow, otherwise UAX#11).
		 */
		public readonly hangulJamoWidth: HangulCompatibilityJamoWidth = "platform",
	) {}

	/**
	 * Mutable clone for the {@link TERMINAL} singleton: copies every field and
	 * keeps the prototype methods, so the builder and runtime setters flip
	 * runtime-resolved {@link RuntimeTerminal} capabilities in place instead of
	 * reconstructing positional constructor args.
	 */
	clone(): RuntimeTerminal {
		return Object.assign(Object.create(TerminalInfo.prototype), this) as RuntimeTerminal;
	}

	isImageLine(line: string): boolean {
		if (!this.imageProtocol) return false;
		if (this.imageProtocol === ImageProtocol.Sixel) {
			return hasSixelDcsStart(line);
		}
		// 512-unit window: placeholder cells can sit deep in a composed row —
		// the composer attachment band prefixes each thumbnail row with border
		// SGRs and stacks cards side by side, so the first placeholder of a
		// later card starts hundreds of units in. Rows past the window would
		// silently lose the verbatim image-line path (no truncation, no SGR
		// coalescing) that placeholder grids and placement APCs rely on.
		return hasNeedleBefore(line, this.imageProtocol, 512) || hasNeedleBefore(line, KITTY_PLACEHOLDER, 512);
	}

	formatNotification(message: string | TerminalNotification): string {
		if (this.notifyProtocol === NotifyProtocol.Bell) {
			return NotifyProtocol.Bell;
		}
		// Structured notifications use OSC 99's rich metadata only once the
		// terminal confirms support; otherwise collapse to a single message line
		// (basic OSC 99 / OSC 9 still work).
		if (typeof message !== "string") {
			if (this.notifyProtocol === NotifyProtocol.Osc99 && osc99CapabilitiesConfirmed) {
				return formatOsc99Notification(message);
			}
			return `${this.notifyProtocol}${notificationToLine(message)}\x1b\\`;
		}
		return `${this.notifyProtocol}${message}\x1b\\`;
	}

	sendNotification(message: string | TerminalNotification): void {
		if (isNotificationSuppressed() || isTerminalHeadless()) return;
		if (sendCmuxNotification(message)) return;
		const formatted = this.formatNotification(message);
		// Under tmux, terminals whose notify protocol is OSC 9 / OSC 99 would
		// otherwise lose the notification entirely: tmux does not forward bare
		// OSC 9/99 to the outer terminal, and the bare sequence does not flag
		// tmux's own `monitor-bell` / `monitor-activity`. Wrap the OSC in tmux's
		// DCS passthrough envelope so users with `allow-passthrough on` still
		// get the desktop toast, then append a BEL so `monitor-bell` flags the
		// pane/window for everyone else — the only signal a backgrounded pane
		// has that the agent finished or is waiting for input. `Bell` protocol
		// already self-flags via tmux's bell monitoring, so leave it alone.
		if (this.notifyProtocol !== NotifyProtocol.Bell && isInsideTmux()) {
			process.stdout.write(`${wrapTmuxPassthrough(formatted)}\x07`);
			return;
		}
		// Zellij drops OSC 9/99 and has no DCS passthrough envelope, but raises its
		// `[!]` bell flag on a bare BEL — the same backgrounded-pane signal tmux
		// users get. So follow the (Zellij-swallowed) OSC with a plain BEL.
		if (this.notifyProtocol !== NotifyProtocol.Bell && isInsideZellij()) {
			process.stdout.write(`${formatted}\x07`);
			return;
		}
		process.stdout.write(formatted);
		// VTE-family terminals (Ptyxis, GNOME Terminal, Tilix, …) plus Alacritty
		// and bare xterm-on-Wayland have no in-band escape that surfaces an
		// arbitrary desktop toast (#3685). When the chosen `notifyProtocol` is
		// BEL on a Linux session bus, also fan the notification out via
		// libnotify so users see the toast and the BEL still fires for tmux
		// `monitor-bell` / X11 urgency hints / audible bell.
		if (this.notifyProtocol === NotifyProtocol.Bell && shouldDeliverDesktopNotification(this.id, true)) {
			sendDesktopNotification(message);
		}
	}
}

/** Detect terminal multiplexers where scrollback clearing and height-change redraws are hostile. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	// TMUX/STY/ZELLIJ, Herdr, and CMUX workspace/surface/remote-transport
	// markers are authoritative session signals. TERM can also survive when those are
	// stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh). Do not
	// use CMUX_SOCKET_PATH here: it is a CLI socket override and can be set
	// outside a CMUX terminal.
	if (env.TMUX || env.STY || env.ZELLIJ || env.HERDR_ENV === "1") return true;
	if (env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT) return true;
	const term = env.TERM?.toLowerCase() ?? "";
	return term.startsWith("tmux") || term.startsWith("screen");
}

/**
 * Whether the agent process is running inside a Zellij session. Read fresh on
 * each call (like {@link isInsideTmux}) so a session attached/detached mid-run
 * is observed and tests can toggle `Bun.env.ZELLIJ` per case.
 */
export function isInsideZellij(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return Boolean(env.ZELLIJ);
}

export function isNotificationSuppressed(): boolean {
	const value = $env.PI_NOTIFICATIONS;
	if (!value) return false;
	return value === "off" || value === "0" || value === "false";
}

function getForcedImageProtocol(): ImageProtocol | null | undefined {
	const raw = $env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "kitty") return ImageProtocol.Kitty;
	if (raw === "iterm2" || raw === "iterm") return ImageProtocol.Iterm2;
	if (raw === "sixel") return ImageProtocol.Sixel;
	if (raw === "off" || raw === "none" || raw === "0" || raw === "false") return null;
	return null;
}

/**
 * Whether `PI_FORCE_IMAGE_PROTOCOL` pins the image protocol, including its
 * `off`/`none` kill switch. A runtime capability probe must not override an
 * explicit user choice: a forced protocol is already applied to {@link TERMINAL},
 * and a forced "off" leaves `imageProtocol` null on purpose.
 */
export function isImageProtocolForced(): boolean {
	return getForcedImageProtocol() !== undefined;
}

function parseMajorMinorVersion(versionRaw?: string): { major: number; minor: number } | null {
	if (!versionRaw) return null;
	const match = /^(\d+)\.(\d+)/u.exec(versionRaw.trim());
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
	return { major, minor };
}

/**
 * Returns true when running in Windows Terminal with known SIXEL support.
 *
 * Windows Terminal introduced SIXEL support in preview 1.22.
 */
export function isWindowsTerminalPreviewSixelSupported(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	if (!env.WT_SESSION) return false;
	if (env.TERM_PROGRAM && env.TERM_PROGRAM.toLowerCase() !== "windows_terminal") {
		return false;
	}
	const version = parseMajorMinorVersion(env.TERM_PROGRAM_VERSION);
	if (!version) return false;
	return version.major > 1 || (version.major === 1 && version.minor >= 22);
}

/**
 * Resolve an explicit user override for DEC 2026 synchronized output. Returns
 * `false` for an opt-out, `true` for a force-on, or `null` when the user has
 * expressed no preference. Shared by the static default and the runtime DECRQM
 * probe so both honor the same precedence — an opt-out beats a force-on.
 */
export function synchronizedOutputUserOverride(env: NodeJS.ProcessEnv = Bun.env): boolean | null {
	if (env.PI_NO_SYNC_OUTPUT || env.PI_TUI_SYNC_OUTPUT === "0") return false;
	if (env.PI_FORCE_SYNC_OUTPUT === "1" || env.PI_TUI_SYNC_OUTPUT === "1") return true;
	return null;
}

/**
 * Whether `TERM_FEATURES` advertises DEC 2026 synchronized output via the `Sy`
 * capability token. `TERM_FEATURES` is a run of capitalized two-letter codes
 * (e.g. `…Sy…`), so a case-sensitive substring match is unambiguous: `Sy`
 * cannot straddle a code boundary because those are always lowercase→uppercase.
 */
function advertisesSynchronizedOutput(termFeatures: string | undefined): boolean {
	return termFeatures?.includes("Sy") ?? false;
}

/**
 * Whether DEC 2026 synchronized-output wrappers should be enabled by default.
 *
 * Policy (highest precedence first):
 *   1. Explicit user override (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0` off,
 *      `PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1` on).
 *   2. Positive `TERM_FEATURES` advertisement (`Sy`) — survives SSH/mux wrapping.
 *   3. Windows Terminal (1.24+) via `WT_SESSION`, on native win32 and the
 *      WSL/SSH-fronted host alike.
 *   4. Known direct terminals with confirmed support. SSH does *not* disable —
 *      DEC 2026 passes through SSH when the outer terminal honors it.
 *   5. Everything else starts off, including risky multiplexers; the runtime
 *      DECRQM probe upgrades any of them when the terminal actually reports
 *      `?2026` supported (current zellij, tmux master, foot, contour, mintty…).
 */
export function shouldEnableSynchronizedOutputByDefault(
	env: NodeJS.ProcessEnv = Bun.env,
	terminalId: TerminalId = TERMINAL_ID,
): boolean {
	const override = synchronizedOutputUserOverride(env);
	if (override !== null) return override;

	if (advertisesSynchronizedOutput(env.TERM_FEATURES)) return true;
	if (env.WT_SESSION) return true;

	// Risky multiplexers start off even when an inner terminal id leaks through:
	// older tmux/screen synchronized-output handling is flaky and a mux may not
	// pass DEC 2026 to the outer host. The DECRQM probe re-enables sync when the
	// mux reports `?2026` supported.
	if (isInsideTerminalMultiplexer(env)) {
		return false;
	}

	switch (terminalId) {
		case "kitty":
		case "ghostty":
		case "wezterm":
		case "iterm2":
		case "alacritty":
		case "vscode":
			return true;
		default:
			// VTE family, GNU screen, Apple Terminal, Warp, legacy native console
			// host (no WT_SESSION), and bare/unknown xterm profiles stay off until
			// the DECRQM probe proves support.
			return false;
	}
}

/**
 * Whether the terminal applies Kitty-style DECCARA rectangular SGR changes
 * (`CSI Pt ; Pl ; Pb ; Pr ; <sgr> $ r`) extended to background color, so large
 * filled regions can be painted as rectangles instead of background-padded
 * strings on every row.
 *
 * Verified against terminal sources rather than terminfo, because a bare
 * `Cara`/DECCARA terminfo capability does not imply the Kitty SGR-background
 * extension:
 * - Kitty implements it for *all* SGR attributes including background (see
 *   kitty `docs/deccara.rst` and the `test_deccara` parser test).
 * - Ghostty does NOT: its `CSI $ r` dispatch falls through to an "unknown CSI"
 *   warning and DECCARA/DECSACE are tracked as unsupported
 *   (ghostty-org/ghostty#632). Enabling it there would silently drop panel
 *   backgrounds, so ghostty stays on the padded-string fallback.
 *
 * Disabled under tmux/screen/zellij multiplexers — screen-coordinate rectangle
 * protocols are not safe to assume through a multiplexer — and via the
 * `PI_NO_DECCARA` kill switch. Pure helper for tests and `TERMINAL` construction.
 */
export function detectRectangularSgrSupport(terminalId: TerminalId, env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (terminalId !== "kitty") return false;
	const kill = env.PI_NO_DECCARA;
	if (kill && kill !== "0" && kill.toLowerCase() !== "false") return false;
	if (isInsideTerminalMultiplexer(env)) {
		return false;
	}
	return true;
}
/**
 * Resolve an explicit user override for OSC 8 hyperlinks. Returns `false` for
 * an opt-out, `true` for a force-on, or `null` when the user has expressed no
 * preference. Opt-out beats force-on so a kill switch is unambiguous, mirroring
 * {@link synchronizedOutputUserOverride}.
 */
export function hyperlinksUserOverride(env: NodeJS.ProcessEnv = Bun.env): boolean | null {
	if (env.PI_NO_HYPERLINKS === "1") return false;
	if (env.PI_FORCE_HYPERLINKS === "1") return true;
	return null;
}

/**
 * Parse tmux's self-reported version from `TERM_PROGRAM_VERSION`. tmux sets
 * `TERM_PROGRAM=tmux` and `TERM_PROGRAM_VERSION=<version>` automatically since
 * 3.2a; older releases (or any path that does not surface the version) yield
 * `null` and the caller treats tmux conservatively.
 */
function parseTmuxVersionFromEnv(env: NodeJS.ProcessEnv): { major: number; minor: number } | null {
	if (env.TERM_PROGRAM?.toLowerCase() !== "tmux") return null;
	return parseMajorMinorVersion(env.TERM_PROGRAM_VERSION);
}

/**
 * Whether OSC 8 hyperlinks should be enabled by default.
 *
 * Policy (highest precedence first):
 *   1. Explicit user override (`PI_NO_HYPERLINKS=1` off, `PI_FORCE_HYPERLINKS=1`
 *      on). Opt-out wins ties.
 *   2. Static terminal capability — terminals whose {@link TerminalInfo} marks
 *      `hyperlinks: false` (e.g. `base`) stay off unless the user forced on.
 *   3. GNU screen's explicit session marker (`STY`) always off, even if tmux is
 *      also present: a screen layer anywhere in the path cannot forward OSC 8.
 *   4. tmux session (`TMUX` set): enabled when tmux self-reports >= 3.4 via
 *      `TERM_PROGRAM_VERSION` (tmux 3.4 stores OSC 8 as a cell attribute and
 *      forwards it to outer terminals whose `terminal-features` include
 *      `hyperlinks`). Older or unknown versions stay off; on outer terminals
 *      without the feature configured, tmux silently drops the sequence —
 *      identical to today. Checked before the screen-family TERM heuristic
 *      because tmux's historical `default-terminal` is `screen-256color`, so
 *      `TERM=screen*` inside a tmux session must NOT short-circuit to off.
 *   5. screen-family TERM without `TMUX` always off: screen never gained OSC 8
 *      support.
 *   6. tmux-family TERM without `TMUX` env — unusual (e.g. inspection scripts);
 *      no version available, so off.
 *   7. Otherwise honor the static terminal capability.
 */
export function shouldEnableHyperlinksByDefault(
	env: NodeJS.ProcessEnv = Bun.env,
	terminalId: TerminalId = TERMINAL_ID,
): boolean {
	const override = hyperlinksUserOverride(env);
	if (override !== null) return override;

	if (!getTerminalInfo(terminalId).hyperlinks) return false;

	// STY is GNU screen's explicit session marker. It vetoes tmux enabling when
	// multiplexers are nested because screen cannot forward OSC 8 anywhere in the
	// path.
	if (env.STY) return false;

	// tmux check before TERM heuristics: TMUX is the authoritative current-session
	// signal and supersedes TERM, which may be `screen-256color` under tmux's
	// historical default-terminal setting.
	if (env.TMUX) {
		const version = parseTmuxVersionFromEnv(env);
		if (!version) return false;
		return version.major > 3 || (version.major === 3 && version.minor >= 4);
	}

	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("screen")) return false;
	if (term.startsWith("tmux")) return false;

	return true;
}

function getFallbackImageProtocol(
	terminalId: TerminalId,
	env: NodeJS.ProcessEnv = Bun.env,
	isTTY: boolean = process.stdout.isTTY === true,
): ImageProtocol | null {
	if (!isTTY) return null;
	if (terminalId === "vscode" || terminalId === "alacritty") return null;
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.includes("screen") || term.includes("tmux") || term.includes("ghostty")) {
		return ImageProtocol.Kitty;
	}
	return null;
}
/**
 * Warp implements the Kitty graphics protocol only on macOS/Linux; its Windows
 * build (including Warp-hosted WSL shells) renders the same APC sequences as
 * visible garbage. Keep platform/env injectable so the carve-out is testable
 * without mutating `process.platform`.
 */
export function resolveWarpImageProtocol(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): ImageProtocol | null {
	const windowsHost =
		platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
	return windowsHost ? null : ImageProtocol.Kitty;
}

/**
 * Paseo (getpaseo/paseo) hardcodes `TERM_PROGRAM=kitty` into every PTY
 * (`buildTerminalEnvironment`) while its xterm.js renderer implements neither
 * Kitty graphics nor Unicode placeholders — trusting the advertisement turns
 * image previews into literal PUA garbage (getpaseo/paseo#3850). Paseo
 * injects `PASEO_TERMINAL_ID` into every terminal it hosts, which makes a
 * reliable embedder signal.
 */
export function isPaseoEmbedder(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return Boolean(env.PASEO_TERMINAL_ID);
}

/**
 * Resolve the image protocol for a non-forced runtime: static per-terminal
 * support (with Warp's platform carve-out), then the multiplexer fallback,
 * then the Paseo embedder carve-out. `isTTY` is injectable because the
 * fallback only fires on a real TTY — a piped subprocess cannot exercise
 * that path, so regression tests call this directly.
 */
export function resolveImageProtocol(
	terminalId: TerminalId,
	env: NodeJS.ProcessEnv = Bun.env,
	isTTY: boolean = process.stdout.isTTY === true,
): ImageProtocol | null {
	let imageProtocol: ImageProtocol | null;
	if (terminalId === "warp") {
		// Warp advertises Kitty graphics on macOS/Linux only; drop it on win32.
		imageProtocol = resolveWarpImageProtocol(process.platform, env);
	} else {
		imageProtocol = getTerminalInfo(terminalId).imageProtocol;
		if (!imageProtocol) {
			const fallbackImageProtocol = getFallbackImageProtocol(terminalId, env, isTTY);
			if (fallbackImageProtocol) imageProtocol = fallbackImageProtocol;
		}
	}
	// Paseo's xterm.js renderer draws neither Kitty APC nor placeholders —
	// applied after the multiplexer fallback so tmux/screen inside a Paseo
	// pane cannot restore Kitty via getFallbackImageProtocol
	// (getpaseo/paseo#3850).
	if (imageProtocol !== null && isPaseoEmbedder(env)) {
		return null;
	}
	return imageProtocol;
}

function getWarpTerminalInfo(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = Bun.env): TerminalInfo {
	return new TerminalInfo(
		"warp",
		resolveWarpImageProtocol(platform, env),
		true,
		false,
		NotifyProtocol.Osc9,
		false,
		false,
		false,
		1,
	);
}
const KNOWN_TERMINALS = Object.freeze({
	// Fallback terminals
	base: new TerminalInfo("base", null, false, false, NotifyProtocol.Bell),
	trueColor: new TerminalInfo("trueColor", null, true, false, NotifyProtocol.Bell),
	// Recognized terminals
	kitty: new TerminalInfo("kitty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc99, true, true, true),
	ghostty: new TerminalInfo("ghostty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9, false, false, false, 2),
	wezterm: new TerminalInfo("wezterm", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
	iterm2: new TerminalInfo("iterm2", ImageProtocol.Iterm2, true, true, NotifyProtocol.Osc9),
	vscode: new TerminalInfo("vscode", null, true, true, NotifyProtocol.Bell),
	alacritty: new TerminalInfo("alacritty", null, true, true, NotifyProtocol.Bell),
	orca: new TerminalInfo("orca", null, true, false, NotifyProtocol.Bell, false, false, false, 2),
	// Warp identifies via TERM_PROGRAM=WarpTerminal and ships the Kitty graphics
	// protocol on macOS/Linux (direct placement only — no Unicode placeholders, so
	// detectKittyUnicodePlaceholdersSupport correctly excludes it). It does not
	// honor OSC 8 yet (the escape renders as visible text), so hyperlinks stay off,
	// but it does support OSC 9 notifications.
	warp: new TerminalInfo("warp", ImageProtocol.Kitty, true, false, NotifyProtocol.Osc9, false, false, false, 1),
});

/** Resolve terminal identity from environment markers used by common emulators. */
export function detectTerminalId(env: NodeJS.ProcessEnv = Bun.env): TerminalId {
	function caseEq(a: string, b: string): boolean {
		return a.toLowerCase() === b.toLowerCase(); // For compiler to pattern match
	}

	const {
		KITTY_WINDOW_ID,
		GHOSTTY_RESOURCES_DIR,
		WEZTERM_PANE,
		ITERM_SESSION_ID,
		VSCODE_PID,
		ALACRITTY_WINDOW_ID,
		TERM_PROGRAM,
		TERM,
		COLORTERM,
	} = env;

	if (KITTY_WINDOW_ID) return "kitty";
	if (GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (WEZTERM_PANE) return "wezterm";
	if (ITERM_SESSION_ID) return "iterm2";
	if (VSCODE_PID) return "vscode";
	if (ALACRITTY_WINDOW_ID) return "alacritty";

	if (TERM_PROGRAM) {
		if (caseEq(TERM_PROGRAM, "kitty")) return "kitty";
		if (caseEq(TERM_PROGRAM, "ghostty")) return "ghostty";
		if (caseEq(TERM_PROGRAM, "wezterm")) return "wezterm";
		if (caseEq(TERM_PROGRAM, "iterm.app")) return "iterm2";
		if (caseEq(TERM_PROGRAM, "vscode")) return "vscode";
		if (caseEq(TERM_PROGRAM, "alacritty")) return "alacritty";
		if (caseEq(TERM_PROGRAM, "warpterminal")) return "warp";
		if (caseEq(TERM_PROGRAM, "orca")) return "orca";
	}

	if (TERM?.toLowerCase().includes("ghostty")) return "ghostty";

	if (COLORTERM) {
		if (caseEq(COLORTERM, "truecolor") || caseEq(COLORTERM, "24bit")) return "trueColor";
	}
	return "base";
}

export const TERMINAL_ID: TerminalId = detectTerminalId(Bun.env);

/**
 * The process-wide {@link TERMINAL} singleton: a {@link TerminalInfo} whose
 * post-construction capabilities — the image protocol and the probe-driven
 * flags — are writable, so the runtime setters and tests mutate them directly
 * instead of through an unsound cast. Every other field stays readonly.
 */
export interface RuntimeTerminal extends TerminalInfo {
	imageProtocol: ImageProtocol | null;
	hyperlinks: boolean;
	deccara: boolean;
	supportsScreenToScrollback: boolean;
	/** Whether OSC 66 text sizing is currently enabled. */
	textSizing: boolean;
}

export const TERMINAL: RuntimeTerminal = (() => {
	const resolved = getTerminalInfo(TERMINAL_ID).clone();
	// Detection records support; hosts opt into OSC 66 separately.
	resolved.textSizing = false;

	const forcedImageProtocol = getForcedImageProtocol();
	if (forcedImageProtocol !== undefined) {
		resolved.imageProtocol = forcedImageProtocol;
	} else {
		resolved.imageProtocol = resolveImageProtocol(resolved.id, Bun.env, process.stdout.isTTY === true);
	}
	// Hyperlink (OSC 8) capability. The static per-terminal flag lives on
	// KNOWN_TERMINALS; shouldEnableHyperlinksByDefault folds in runtime context —
	// PI_FORCE_HYPERLINKS / PI_NO_HYPERLINKS overrides plus a tmux>=3.4 gate so
	// modern tmux forwards OSC 8 to outer terminals that opt in via
	// `terminal-features "*:hyperlinks"`.
	resolved.hyperlinks = shouldEnableHyperlinksByDefault(Bun.env, resolved.id);
	// DECCARA rectangular-SGR background fills. The static per-terminal capability
	// lives on KNOWN_TERMINALS; here we fold in runtime context — multiplexer and
	// the PI_NO_DECCARA kill switch via detectRectangularSgrSupport — and force it
	// off inside the test runtime so the xterm.js-backed virtual terminal (which
	// ignores DECCARA) exercises the padded-string fallback. Integration tests opt
	// in explicitly through setTerminalDeccara.
	resolved.deccara = detectRectangularSgrSupport(resolved.id, Bun.env) && !isBunTestRuntime();
	return resolved;
})();

// Seed Kitty Unicode placeholder support from the resolved terminal id. Only
// kitty/ghostty are known to honor `U=1` placement; other Kitty-protocol paths
// (wezterm, tmux/screen fallback) treat the placeholder cells as literal PUA
// glyphs, which is the "ASCII artifact + laggy scrolling" reported in #1877.
setKittyGraphics({ unicodePlaceholders: detectKittyUnicodePlaceholdersSupport(TERMINAL.id, Bun.env) });

/**
 * Override terminal image protocol at runtime after capability probes complete.
 */
export function setTerminalImageProtocol(imageProtocol: ImageProtocol | null): void {
	TERMINAL.imageProtocol = imageProtocol;
}

/**
 * Override DECCARA rectangular-SGR capability at runtime. Used by tests to
 * exercise the optimizer and fallback paths deterministically — the default is
 * resolved once at import and force-disabled under the test runtime.
 */
export function setTerminalDeccara(enabled: boolean): void {
	TERMINAL.deccara = enabled;
}

/** Override screen-to-scrollback clear support for targeted renderer tests. */
export function setTerminalScreenToScrollback(enabled: boolean): void {
	TERMINAL.supportsScreenToScrollback = enabled;
}

/**
 * Enable/disable OSC 66 text-sizing at runtime. The coding-agent calls this from
 * the `tui.textSizing` setting (gated on the terminal's static `supportsTextSizing`
 * capability); tests flip it directly to exercise the scaled-heading path.
 */
export function setTerminalTextSizing(enabled: boolean): void {
	TERMINAL.textSizing = enabled;
}

/**
 * Override OSC 8 hyperlink capability at runtime. The coding-agent calls this
 * from the `tui.hyperlinks` setting so its resolved policy (`off`/`auto`/`always`)
 * drives every renderer that gates on {@link TERMINAL}`.hyperlinks` — notably the
 * Markdown component's `[text](url)`/bare-URL links — consistently with the
 * path/resource links that already consult the setting directly. Tests flip it
 * to exercise the OSC 8 and plain-text paths deterministically.
 */
export function setTerminalHyperlinks(enabled: boolean): void {
	TERMINAL.hyperlinks = enabled;
}

export function getTerminalInfo(
	terminalId: TerminalId,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): TerminalInfo {
	return terminalId === "warp" ? getWarpTerminalInfo(platform, env) : KNOWN_TERMINALS[terminalId];
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/**
	 * Stable Kitty image id (`i=`). When set, the image is displayed via a
	 * transmit-once + placement scheme keyed off this id instead of re-sending the
	 * base64 each frame.
	 */
	imageId?: number;
	/** Stable Kitty placement id (`p=`); defaults to {@link imageId}. */
	placementId?: number;
	/** When true (Kitty + {@link imageId}), also return the one-time transmit sequence. */
	includeTransmit?: boolean;
}

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

function chunkKittyApc(leadParams: string, base64Data: string): string {
	const CHUNK_SIZE = 4096;
	if (base64Data.length <= CHUNK_SIZE) {
		return wrapTmuxPassthroughIfNeeded(`\x1b_G${leadParams};${base64Data}\x1b\\`);
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(wrapTmuxPassthroughIfNeeded(`\x1b_G${leadParams},m=1;${chunk}\x1b\\`));
			isFirst = false;
		} else if (isLast) {
			chunks.push(wrapTmuxPassthroughIfNeeded(`\x1b_Gq=2,m=0;${chunk}\x1b\\`));
		} else {
			chunks.push(wrapTmuxPassthroughIfNeeded(`\x1b_Gq=2,m=1;${chunk}\x1b\\`));
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/** Transmit-and-display (`a=T`) — the self-contained form used when no stable id is available. */
export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
	} = {},
): string {
	const params: string[] = ["a=T", "f=100", "q=2", "C=1"];
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);
	return chunkKittyApc(params.join(","), base64Data);
}

/**
 * Transmit image data only (`a=t`), keyed by `imageId`, without displaying it.
 * Sent once per image; the data then persists in the terminal's store (it
 * survives scroll-off and text clears for images with a non-zero id), so
 * subsequent frames display it with the tiny {@link encodeKittyPlacement}
 * sequence instead of re-sending the base64.
 */
export function encodeKittyTransmit(base64Data: string, imageId: number): string {
	return chunkKittyApc(`a=t,f=100,q=2,i=${imageId}`, base64Data);
}

/**
 * Display a previously transmitted image (`a=p`) at the cursor. `C=1` keeps
 * the terminal cursor anchored at the placement origin so the renderer's
 * explicit cursor movement remains the only row accounting. Carrying a stable
 * `placementId` (`p=`) means re-emitting the sequence on a repaint *replaces*
 * the existing placement (moving/resizing it without flicker) rather than
 * stacking a duplicate.
 */
export function encodeKittyPlacement(options: {
	imageId: number;
	placementId?: number;
	columns?: number;
	rows?: number;
}): string {
	const params: string[] = ["a=p", "q=2", "C=1", `i=${options.imageId}`];
	if (options.placementId) params.push(`p=${options.placementId}`);
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	return wrapTmuxPassthroughIfNeeded(`\x1b_G${params.join(",")}\x1b\\`);
}

/**
 * Exact shape of the direct-placement line {@link Image} emits as its block's
 * last row: optional `ESC 7` + `CUU(rows-1)` prefix, the {@link encodeKittyPlacement}
 * APC, optional `ESC 8` suffix. tmux-passthrough-wrapped lines deliberately do
 * not match (passthrough placements stay untouched).
 */
const KITTY_DIRECT_PLACEMENT_LINE =
	/^(?:\x1b7(?:\x1b\[(\d+)A)?)?\x1b_Ga=p,q=2,C=1,i=(\d+)(?:,p=(\d+))?(?:,c=(\d+))?(?:,r=(\d+))?\x1b\\(?:\x1b8)?$/;

export interface ParsedKittyPlacementLine {
	imageId: number;
	placementId: number | undefined;
	columns: number;
	rows: number;
}

/**
 * Parse a frame line that consists solely of a Kitty direct placement (the
 * last line of an {@link Image} block). Returns null for anything else —
 * placeholder grids, tmux-wrapped placements, sixel/iTerm2 payloads — so
 * callers fall back to writing the line verbatim.
 */
export function parseKittyDirectPlacementLine(line: string): ParsedKittyPlacementLine | null {
	const m = KITTY_DIRECT_PLACEMENT_LINE.exec(line);
	if (!m) return null;
	const columns = m[4] !== undefined ? Number(m[4]) : 0;
	const rows = m[5] !== undefined ? Number(m[5]) : 0;
	if (columns <= 0 || rows <= 0) return null;
	return {
		imageId: Number(m[2]),
		placementId: m[3] !== undefined ? Number(m[3]) : undefined,
		columns,
		rows,
	};
}

/**
 * Rebuild an {@link Image} direct-placement line for the viewport row it is
 * written at. The component-rendered line encodes `CUU(rows-1)`, which clamps
 * at the viewport top once the block's leading rows have scrolled out — the
 * placement then re-anchors the full image shifted down over foreign rows.
 * Anchor at the block's first *visible* row instead, clipping the source
 * rectangle (`y=`/`h=`, image pixels) to the visible bottom slice.
 */
export function encodeKittyPlacementLine(options: {
	imageId: number;
	placementId: number;
	columns: number;
	/** Total cell rows of the image block. */
	rows: number;
	/** Viewport row the block's last line is being written at. */
	screenRow: number;
	/** Source image height in pixels, for the clipped source rectangle. */
	imageHeightPx: number;
}): string {
	// Without a source pixel height the slice cannot be expressed — emit the
	// component's own full form (status quo) rather than squashing the whole
	// image into the reduced row count.
	const clippable = options.imageHeightPx > 0;
	const hiddenRows = clippable ? Math.max(0, options.rows - 1 - options.screenRow) : 0;
	const visibleRows = options.rows - hiddenRows;
	const params: string[] = ["a=p", "q=2", "C=1", `i=${options.imageId}`, `p=${options.placementId}`];
	params.push(`c=${options.columns}`, `r=${visibleRows}`);
	if (hiddenRows > 0) {
		const srcY = Math.floor((options.imageHeightPx * hiddenRows) / options.rows);
		params.push(`y=${srcY}`, `h=${Math.max(1, options.imageHeightPx - srcY)}`);
	}
	// No tmux passthrough: inside tmux the component's own line arrives
	// wrapped, never parses, and never reaches this rewrite.
	const apc = `\x1b_G${params.join(",")}\x1b\\`;
	const cuu = visibleRows - 1;
	return cuu > 0 ? `\x1b7\x1b[${cuu}A${apc}\x1b8` : apc;
}

/**
 * Kitty graphics delete command for a single image id. Uses `d=I` (capital)
 * which removes the image and every one of its placements — on screen *and* in
 * scrollback — and frees the backing data. `q=2` suppresses the terminal reply.
 * Text-clearing escapes (`CSI 2 J` / `CSI 3 J`) do not remove Kitty graphics, so
 * this is the only way to actually purge a placed image.
 */
export function encodeKittyDeleteImage(imageId: number): string {
	return wrapTmuxPassthroughIfNeeded(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`);
}
/**
 * Delete every Kitty image and placement in the terminal. Used only by an
 * explicit destructive display reset: text erases leave untracked placements
 * painted, so per-image bookkeeping cannot guarantee a clean viewport.
 */
export function encodeKittyDeleteAllImages(): string {
	return wrapTmuxPassthroughIfNeeded("\x1b_Ga=d,d=A,q=2\x1b\\");
}

/**
 * Delete a single placement of an image (`d=i`, lowercase): removes its cells
 * and registry entry but keeps the transmitted data, so a later `a=p` under a
 * fresh placement id needs no retransmit. Used to clear stale placement-epoch
 * entries after a destructive history clear.
 */
export function encodeKittyDeletePlacement(imageId: number, placementId: number): string {
	return wrapTmuxPassthroughIfNeeded(`\x1b_Ga=d,d=i,i=${imageId},p=${placementId},q=2\x1b\\`);
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toBase64();
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);
	return Math.max(1, rows);
}

function calculateImageFit(
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions,
	cellDims: CellDimensions,
): { columns: number; rows: number } {
	const maxColumns = options.maxWidthCells !== undefined ? Math.max(1, Math.floor(options.maxWidthCells)) : undefined;
	const maxRows = options.maxHeightCells !== undefined ? Math.max(1, Math.floor(options.maxHeightCells)) : undefined;

	if (maxColumns === undefined && maxRows === undefined) {
		const columns = Math.max(1, Math.ceil(imageDimensions.widthPx / cellDims.widthPx));
		const rows = Math.max(1, Math.ceil(imageDimensions.heightPx / cellDims.heightPx));
		return { columns, rows };
	}

	const maxWidthPx = maxColumns !== undefined ? maxColumns * cellDims.widthPx : Number.POSITIVE_INFINITY;
	const maxHeightPx = maxRows !== undefined ? maxRows * cellDims.heightPx : Number.POSITIVE_INFINITY;
	const scale = Math.min(maxWidthPx / imageDimensions.widthPx, maxHeightPx / imageDimensions.heightPx);
	const fittedWidthPx = imageDimensions.widthPx * scale;
	const fittedHeightPx = imageDimensions.heightPx * scale;

	const columns = Math.max(1, Math.floor(fittedWidthPx / cellDims.widthPx));
	const rows = Math.max(1, Math.ceil(fittedHeightPx / cellDims.heightPx));

	return {
		columns: maxColumns !== undefined ? Math.min(columns, maxColumns) : columns,
		rows: maxRows !== undefined ? Math.min(rows, maxRows) : rows,
	};
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence?: string; lines?: string[]; rows: number; transmit?: string } | null {
	if (!TERMINAL.imageProtocol) {
		return null;
	}

	const cellDims = getCellDimensions();
	const fit = calculateImageFit(imageDimensions, options, cellDims);

	if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
		if (options.imageId != null) {
			const placementId = options.placementId ?? options.imageId;
			const graphics = getKittyGraphics();
			// Transmit-once (keyed by id). Repaints reuse the stored image, so the
			// transmit is only emitted when requested.
			let transmit: string | undefined;
			if (options.includeTransmit) {
				transmit = encodeKittyTransmit(base64Data, options.imageId);
			}
			// Unicode placeholders render the image as real text cells (which survive
			// horizontal slicing, reflow and overlaps) instead of a cursor-positioned
			// `a=p` placement. Falls back to direct placement when disabled or when the
			// grid exceeds the diacritic table's addressable cell range.
			if (graphics.unicodePlaceholders && kittyPlaceholdersFit(fit.columns, fit.rows)) {
				const lines = renderKittyPlaceholderLines({
					imageId: options.imageId,
					placementId,
					columns: fit.columns,
					rows: fit.rows,
				});
				return { lines, rows: fit.rows, transmit };
			}
			// Direct placement: re-emit only the tiny `a=p` on repaints.
			const sequence = encodeKittyPlacement({
				imageId: options.imageId,
				placementId,
				columns: fit.columns,
				rows: fit.rows,
			});
			return { sequence, rows: fit.rows, transmit };
		}
		// No stable id (e.g. no budget): self-contained transmit-and-display.
		const sequence = encodeKitty(base64Data, {
			columns: fit.columns,
			rows: fit.rows,
		});
		return { sequence, rows: fit.rows };
	}

	if (TERMINAL.imageProtocol === ImageProtocol.Sixel) {
		try {
			// SIXEL encodes in 6-pixel vertical bands. A height that is not a
			// multiple of 6 is padded with transparent rows, but the terminal
			// still allocates cell rows for the padded height. When the padded
			// height crosses a cell boundary the terminal uses one more row
			// than fit.rows, so the next line of content overwrites the bottom
			// of the image — a visible slice stripped from the image. Round the
			// encode height DOWN to the largest multiple of 6 that fits within
			// the requested row budget, so the band boundary aligns without
			// padding and the reserved row count never exceeds fit.rows. Scale
			// the width by the same ratio so resize_exact preserves the aspect
			// ratio instead of squashing the image vertically.
			const rawHeightPx = Math.max(1, fit.rows * cellDims.heightPx);
			const targetHeightPx = Math.max(6, Math.floor(rawHeightPx / 6) * 6);
			const heightScale = targetHeightPx / rawHeightPx;
			const targetWidthPx = Math.max(1, Math.round(fit.columns * cellDims.widthPx * heightScale));
			const rows = Math.max(1, Math.ceil(targetHeightPx / cellDims.heightPx));
			const decoded = new Uint8Array(Buffer.from(base64Data, "base64"));
			const sequence = encodeSixel(decoded, targetWidthPx, targetHeightPx);
			return { sequence, rows };
		} catch {
			return null;
		}
	}
	if (TERMINAL.imageProtocol === ImageProtocol.Iterm2) {
		const sequence = encodeITerm2(base64Data, {
			width: fit.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows: fit.rows };
	}

	return null;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}

/**
 * Structured terminal notification. Rich fields are honored only by OSC 99
 * (Kitty) once support is confirmed; other protocols and the unconfirmed Kitty
 * path collapse to a single `title: body` line.
 */
export interface TerminalNotification {
	title?: string;
	body?: string;
	id?: string;
	type?: string | string[];
	urgency?: "low" | "normal" | "critical";
	iconName?: string;
	sound?: "silent" | "system" | "info" | "warning" | "error" | "question";
	actions?: "focus" | "report" | "focus-report" | "none";
	expiresMs?: number;
}

/**
 * Whether the terminal confirmed OSC 99 desktop-notification support via the
 * `p=?` query probe. Until confirmed, structured notifications collapse to a
 * single message line.
 */
let osc99CapabilitiesConfirmed = false;

/** Record the OSC 99 capability-probe result (called by ProcessTerminal). */
export function setOsc99Supported(supported: boolean): void {
	osc99CapabilitiesConfirmed = supported;
}

/** True when OSC 99 structured notifications have been confirmed available. */
export function isOsc99Supported(): boolean {
	return osc99CapabilitiesConfirmed;
}

/** Collapse a structured notification to a single line for non-OSC-99 sinks. */
function notificationToLine(n: TerminalNotification): string {
	if (n.title && n.body) return `${n.title}: ${n.body}`;
	return n.title ?? n.body ?? "";
}

// C0/C1 control characters that are unsafe inside an OSC payload (must base64).
const OSC99_UNSAFE = /[\x00-\x1f\x7f\x80-\x9f]/u;
const OSC99_MAX_PAYLOAD_BYTES = 2048;
const OSC99_APP_NAME = "Oh My Pi";
let nextOsc99NotificationId = 1;

function base64Utf8(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

function sanitizeOsc99Id(id: string | undefined): string {
	if (!id) return "";
	const safe = id.replace(/[^a-zA-Z0-9_+\-.]/gu, "");
	return safe === "0" ? "" : safe;
}

function osc99Id(id: string | undefined): string {
	return sanitizeOsc99Id(id) || `omp-${nextOsc99NotificationId++}`;
}

function utf8CodePointBytes(char: string): number {
	const codePoint = char.codePointAt(0) ?? 0;
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

function chunkUtf8(payload: string): string[] {
	if (payload === "") return [""];
	const chunks: string[] = [];
	let start = 0;
	let index = 0;
	let bytes = 0;
	for (const char of payload) {
		const charBytes = utf8CodePointBytes(char);
		if (bytes > 0 && bytes + charBytes > OSC99_MAX_PAYLOAD_BYTES) {
			chunks.push(payload.slice(start, index));
			start = index;
			bytes = 0;
		}
		bytes += charBytes;
		index += char.length;
	}
	chunks.push(payload.slice(start));
	return chunks;
}

function osc99Chunk(meta: string[], payload: string): string {
	if (OSC99_UNSAFE.test(payload)) {
		return `\x1b]99;${[...meta, "e=1"].join(":")};${base64Utf8(payload)}\x1b\\`;
	}
	return `\x1b]99;${meta.join(":")};${payload}\x1b\\`;
}

function osc99Payload(meta: string[], payload: string, holdUntilLaterPayload: boolean): string {
	const chunks = chunkUtf8(payload);
	let out = "";
	for (let i = 0; i < chunks.length; i++) {
		const chunkMeta = [...meta];
		if (holdUntilLaterPayload || i < chunks.length - 1) chunkMeta.push("d=0");
		out += osc99Chunk(chunkMeta, chunks[i]!);
	}
	return out;
}

function osc99Urgency(urgency: TerminalNotification["urgency"]): string | undefined {
	switch (urgency) {
		case "low":
			return "0";
		case "normal":
			return "1";
		case "critical":
			return "2";
		default:
			return undefined;
	}
}

function osc99Actions(actions: TerminalNotification["actions"]): string | undefined {
	switch (actions) {
		case "focus":
			return "focus";
		case "report":
			return "report";
		case "focus-report":
			return "focus,report";
		case "none":
			return "-focus";
		default:
			return undefined;
	}
}

/**
 * Format a structured notification as OSC 99 title/body payloads. Title and
 * body chunks share one id. Every non-final chunk carries `d=0`; the final
 * title or body chunk displays the notification. Metadata values that require
 * it (application name, type, icon name, sound) are base64-encoded.
 */
function formatOsc99Notification(n: TerminalNotification): string {
	const id = osc99Id(n.id);
	const meta: string[] = [`i=${id}`, `f=${base64Utf8(OSC99_APP_NAME)}`];
	const actions = osc99Actions(n.actions);
	if (actions) meta.push(`a=${actions}`);
	const urgency = osc99Urgency(n.urgency);
	if (urgency) meta.push(`u=${urgency}`);
	const types = n.type === undefined ? [] : Array.isArray(n.type) ? n.type : [n.type];
	for (const t of types) meta.push(`t=${base64Utf8(t)}`);
	if (n.iconName) meta.push(`n=${base64Utf8(n.iconName)}`);
	if (n.sound) meta.push(`s=${base64Utf8(n.sound)}`);
	if (n.expiresMs !== undefined && Number.isFinite(n.expiresMs)) {
		meta.push(`w=${Math.max(-1, Math.trunc(n.expiresMs))}`);
	}

	const title = n.title ?? n.body ?? "";
	const body = n.title ? n.body : undefined;

	if (body !== undefined && body !== "") {
		return osc99Payload(meta, title, true) + osc99Payload([`i=${id}`, "p=body"], body, false);
	}
	return osc99Payload(meta, title, false);
}
