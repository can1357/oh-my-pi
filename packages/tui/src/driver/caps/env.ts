/**
 * Capabilities derived from the environment alone: the starting point the
 * startup probes refine.
 */
import type { TerminalCapabilities } from "../contract";
import { classifyMultiplexer, contractMultiplexer, type Env, hasMultiplexerSession, isSsh } from "../mux/detect";
import { type TerminalId, TERMINAL_PROFILES } from "./identity";

/** A user's explicit synchronized-output preference; opt-out beats force-on. */
export function synchronizedOutputOverride(env: Env): boolean | null {
	if (env.PI_NO_SYNC_OUTPUT === "1" || env.PI_TUI_SYNC_OUTPUT === "0") return false;
	if (env.PI_FORCE_SYNC_OUTPUT === "1" || env.PI_TUI_SYNC_OUTPUT === "1") return true;
	return null;
}

/** A user's explicit hyperlink preference; only the literal `1` counts and opt-out wins. */
export function hyperlinksOverride(env: Env): boolean | null {
	if (env.PI_NO_HYPERLINKS === "1") return false;
	if (env.PI_FORCE_HYPERLINKS === "1") return true;
	return null;
}

function termFamilyIsMux(env: Env): boolean {
	const term = env.TERM?.toLowerCase() ?? "";
	return /^(tmux|screen)([-.]|$)/.test(term);
}

/** Whether DEC 2026 synchronized output should be used before (or without) a DECRQM answer. */
export function synchronizedOutputDefault(env: Env, id: TerminalId): boolean {
	const override = synchronizedOutputOverride(env);
	if (override !== null) return override;
	// Herdr renders panes in its own grid and implements 2026 itself.
	if (hasMultiplexerSession("herdr", env)) return true;
	// TERM_FEATURES is a run of capability tokens (`ClSyTc`); `Sy` advertises 2026.
	if (env.TERM_FEATURES?.match(/[A-Z][a-z0-9]*/g)?.includes("Sy")) return true;
	const mux = classifyMultiplexer(env);
	if ((mux !== null && mux !== "orca") || termFamilyIsMux(env)) return false;
	if (env.WT_SESSION && (id === "trueColor" || id === "base")) {
		return !env.TERM_PROGRAM || env.TERM_PROGRAM === "Windows_Terminal";
	}
	return TERMINAL_PROFILES[id].synchronizedOutput;
}

function versionAtLeast(version: string | undefined, major: number, minor: number): boolean {
	const match = /^(\d+)\.(\d+)/.exec(version ?? "");
	if (!match) return false;
	const [maj, min] = [Number(match[1]), Number(match[2])];
	return maj > major || (maj === major && min >= minor);
}

/** Whether OSC 8 hyperlinks reach a terminal that renders them. */
export function hyperlinksDefault(env: Env, id: TerminalId): boolean {
	const override = hyperlinksOverride(env);
	if (override !== null) return override;
	// GNU screen never forwards OSC 8, wherever it sits in the stack.
	if (hasMultiplexerSession("screen", env)) return false;
	// tmux ≥ 3.4 forwards OSC 8 cell attributes to the outer terminal.
	if (hasMultiplexerSession("tmux", env)) {
		const version = env.TERM_PROGRAM === "tmux" ? env.TERM_PROGRAM_VERSION : undefined;
		return TERMINAL_PROFILES[id].hyperlinks && versionAtLeast(version, 3, 4);
	}
	// Herdr renders OSC 8 in its own grid and opens links itself.
	if (hasMultiplexerSession("herdr", env)) return true;
	if (termFamilyIsMux(env)) return false;
	return TERMINAL_PROFILES[id].hyperlinks;
}

const FORCED_IMAGES: Readonly<Record<string, TerminalCapabilities["images"]>> = {
	kitty: "kitty",
	sixel: "sixel",
	iterm: "iterm",
	iterm2: "iterm",
	none: null,
	off: null,
	"0": null,
};

/** `PI_FORCE_IMAGE_PROTOCOL`: undefined when unset or unrecognized. */
export function forcedImageProtocol(env: Env): TerminalCapabilities["images"] | undefined {
	const value = env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase();
	if (!value || !(value in FORCED_IMAGES)) return undefined;
	return FORCED_IMAGES[value];
}

/**
 * `PI_CELL_SIZE` (`<width>x<height>` in pixels, e.g. `12x24`): null when unset or malformed.
 * A pinned size takes precedence over the terminal's own reports, which some
 * hosts (Windows OpenSSH) answer with placeholder pixel sizes.
 */
export function forcedCellSize(env: Env): TerminalCapabilities["cell"] {
	const match = /^(\d+)x(\d+)$/.exec(env.PI_CELL_SIZE?.trim() ?? "");
	if (!match) return null;
	const w = Number(match[1]);
	const h = Number(match[2]);
	return w > 0 && h > 0 ? { w, h } : null;
}

export interface ImageContext {
	readonly platform: NodeJS.Platform;
	/** WSL: the Windows host renders. */
	readonly wsl: boolean;
	/** Whether tmux forwards passthrough envelopes (only consulted inside tmux). */
	readonly tmuxPassthrough: boolean;
}

/**
 * What `TERM` alone says of a terminal whose profile knows no protocol: Kitty
 * graphics under `screen`/`ghostty` names; nothing inside tmux, whose `TERM`
 * names the pane and not the client (the SIXEL probe may still find one).
 */
function imageProtocolFromTerm(id: TerminalId, env: Env): TerminalCapabilities["images"] {
	if (id === "vscode" || id === "alacritty") return null;
	const term = env.TERM?.toLowerCase() ?? "";
	if (env.TMUX || term.includes("tmux")) return null;
	return term.includes("screen") || term.includes("ghostty") ? "kitty" : null;
}

/**
 * The image protocol to use without probing: the terminal's own (Warp's only
 * off Windows), else what `TERM` says; none for hosts that draw no graphics
 * (Paseo, Herdr) and for Kitty graphics behind a tmux that drops passthrough.
 * Null means "none known" (the startup probe may still find SIXEL).
 */
export function imageProtocolFromEnv(id: TerminalId, env: Env, context: ImageContext): TerminalCapabilities["images"] {
	const forced = forcedImageProtocol(env);
	if (forced !== undefined) return forced;
	const images =
		id === "warp"
			? context.platform === "win32" || context.wsl
				? null
				: "kitty"
			: (TERMINAL_PROFILES[id].images ?? imageProtocolFromTerm(id, env));
	if (images === null || env.PASEO_TERMINAL_ID || hasMultiplexerSession("herdr", env)) return null;
	if (images === "kitty" && env.TMUX && !context.tmuxPassthrough) return null;
	return images;
}

/** Whether the background is dark according to `COLORFGBG` (`fg;bg`), or null when it says nothing. */
export function darkFromColorFgBg(env: Env): boolean | null {
	const value = env.COLORFGBG;
	if (!value) return null;
	const bg = Number(value.split(";").at(-1));
	if (!Number.isInteger(bg) || bg < 0 || bg > 15) return null;
	return !(bg === 7 || bg >= 9);
}

export interface EnvCapabilityContext extends ImageContext {
	readonly id: TerminalId;
}

/** The capabilities `env` implies before any probe reply. */
export function capabilitiesFromEnv(env: Env, context: EnvCapabilityContext): TerminalCapabilities {
	const { id } = context;
	const colorterm = env.COLORTERM?.toLowerCase();
	const truecolor =
		TERMINAL_PROFILES[id].trueColor || colorterm === "truecolor" || colorterm === "24bit" || Boolean(env.WT_SESSION);
	const colors = truecolor ? 16_777_216 : (env.TERM ?? "").includes("256") ? 256 : 16;
	const multiplexer = contractMultiplexer(classifyMultiplexer(env));
	return {
		truecolor,
		colors,
		synchronizedOutput: synchronizedOutputDefault(env, id),
		hyperlinks: hyperlinksDefault(env, id),
		// A multiplexer redraws its panes from its own grid, which has no multicell glyphs.
		textSizing: TERMINAL_PROFILES[id].textSizing && multiplexer === null,
		images: imageProtocolFromEnv(id, env, context),
		kittyKeyboard: false,
		bracketedPaste: true,
		background: null,
		dark: darkFromColorFgBg(env) ?? true,
		cell: forcedCellSize(env),
		multiplexer,
		tsp: false,
	};
}

/** WSL: Linux userland behind a Windows pseudoconsole. */
export function isWsl(env: Env, platform: NodeJS.Platform): boolean {
	return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

/**
 * Raw `0x08` means Ctrl+Backspace only in a genuine local Windows Terminal
 * session (multiplexers and SSH inherit `WT_SESSION` but send `0x08` for plain
 * Backspace), or when the user opts in explicitly.
 */
export function rawBackspaceIsCtrl(env: Env): boolean {
	if (env.PI_TUI_RAW_BACKSPACE_IS_CTRL === "1") return true;
	if (!env.WT_SESSION || isSsh(env)) return false;
	return classifyMultiplexer(env) === null;
}
