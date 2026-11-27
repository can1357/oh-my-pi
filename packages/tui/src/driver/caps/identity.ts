/**
 * Terminal identity: which emulator we talk to, from environment variables,
 * and what that emulator is known to support.
 */
import type { JamoWidth } from "../../text/width";
import type { EmojiSupport } from "../../theme/contract";
import { classifyMultiplexer, type Env, insideMultiplexer, isSsh } from "../mux/detect";

/** Static facts about one emulator. */
export interface TerminalProfile {
	readonly id: TerminalId;
	readonly images: "kitty" | "iterm" | null;
	readonly trueColor: boolean;
	/** Renders OSC 8 hyperlinks. */
	readonly hyperlinks: boolean;
	/** Implements DEC 2026 synchronized output (used when no DECRQM answer arrives). */
	readonly synchronizedOutput: boolean;
	/** How the emulator raises a desktop notification (see `driver/notify.ts`). */
	readonly notify: NotifyProtocol;
	/** Cells it draws a Hangul Compatibility Jamo in (`platform`: the OS default, see `text/width.ts`). */
	readonly jamoWidth: JamoWidth;
	/** Expires OSC 9;4 progress without a heartbeat, so an active progress is re-sent periodically. */
	readonly progressKeepalive: boolean;
	/** Draws OSC 66 sized text (Kitty's text-sizing protocol). */
	readonly textSizing: boolean;
	/**
	 * How far a text-default emoji followed by U+FE0F advances: two cells (`wide`),
	 * one (`narrow`), or unknown until measured at startup (`probe`).
	 */
	readonly emojiVs16: "wide" | "narrow" | "probe";
	/** Whether a bare text-default emoji is drawn inside its one cell (`fits`) or overflows into the next (`spills`). */
	readonly emojiBare: "fits" | "spills";
}

/** In-band notification sequence: a bare BEL, OSC 9 (one message line) or Kitty's OSC 99 (structured). */
export type NotifyProtocol = "bell" | "osc9" | "osc99";

export type TerminalId =
	| "base"
	| "trueColor"
	| "kitty"
	| "ghostty"
	| "wezterm"
	| "iterm2"
	| "vscode"
	| "alacritty"
	| "warp"
	| "orca"
	| "otty"
	| "rio"
	| "rex"
	| "tern"
	| "monstar"
	| "windowsTerminal";

interface ProfileQuirks {
	readonly jamoWidth?: JamoWidth;
	readonly progressKeepalive?: boolean;
	readonly textSizing?: boolean;
	readonly emojiVs16?: TerminalProfile["emojiVs16"];
	readonly emojiBare?: TerminalProfile["emojiBare"];
}

function profile(
	id: TerminalId,
	images: TerminalProfile["images"],
	trueColor: boolean,
	hyperlinks: boolean,
	synchronizedOutput: boolean,
	notify: NotifyProtocol,
	quirks: ProfileQuirks = {},
): TerminalProfile {
	return {
		id,
		images,
		trueColor,
		hyperlinks,
		synchronizedOutput,
		notify,
		jamoWidth: quirks.jamoWidth ?? "platform",
		progressKeepalive: quirks.progressKeepalive ?? false,
		textSizing: quirks.textSizing ?? false,
		emojiVs16: quirks.emojiVs16 ?? "probe",
		emojiBare: quirks.emojiBare ?? "spills",
	};
}

/** The identity table. */
export const TERMINAL_PROFILES: Readonly<Record<TerminalId, TerminalProfile>> = {
	base: profile("base", null, false, false, false, "bell"),
	trueColor: profile("trueColor", null, true, false, false, "bell"),
	kitty: profile("kitty", "kitty", true, true, true, "osc99", {
		textSizing: true,
		emojiVs16: "wide",
		emojiBare: "fits",
	}),
	// libghostty draws compatibility jamo wide and drops OSC 9;4 progress without a heartbeat.
	ghostty: profile("ghostty", "kitty", true, true, true, "osc9", {
		jamoWidth: 2,
		progressKeepalive: true,
		emojiVs16: "wide",
		emojiBare: "fits",
	}),
	// U+FE0F advances one cell at WezTerm's default Unicode 9; the driver pushes Unicode 14 at start.
	wezterm: profile("wezterm", "kitty", true, true, true, "osc9", { emojiVs16: "narrow", emojiBare: "fits" }),
	// VS16 stays narrow on iTerm2's alternate screen.
	iterm2: profile("iterm2", "iterm", true, true, true, "osc9", { emojiVs16: "narrow" }),
	vscode: profile("vscode", null, true, true, true, "bell", { emojiVs16: "narrow" }),
	alacritty: profile("alacritty", null, true, true, true, "bell", { emojiVs16: "narrow" }),
	// Warp: Kitty graphics (macOS/Linux), no OSC 8; sync output left to the DECRQM probe.
	warp: profile("warp", "kitty", true, false, false, "osc9", { jamoWidth: 1 }),
	orca: profile("orca", null, true, false, false, "bell", { jamoWidth: 2 }),
	otty: profile("otty", "kitty", true, true, false, "osc99"),
	// rio parses OSC 9/777, but Windows silently drops its unpackaged toast; BEL keeps the D-Bus fallback on Linux.
	rio: profile("rio", "kitty", true, true, false, "bell", { emojiVs16: "wide" }),
	rex: profile("rex", "kitty", true, true, false, "bell"),
	tern: profile("tern", "kitty", true, true, true, "osc99"),
	// Built on libghostty: wide jamo; clears OSC 9;4 progress after 15 s without an update.
	monstar: profile("monstar", "kitty", true, true, true, "osc9", {
		jamoWidth: 2,
		progressKeepalive: true,
		emojiVs16: "wide",
		emojiBare: "fits",
	}),
	// A local Windows Terminal session (see `isWindowsTerminal`): images come from its DA1 SIXEL bit.
	windowsTerminal: profile("windowsTerminal", null, true, false, true, "bell", { emojiVs16: "wide" }),
};

const PROGRAM_IDS: Readonly<Record<string, TerminalId>> = {
	kitty: "kitty",
	ghostty: "ghostty",
	wezterm: "wezterm",
	"iterm.app": "iterm2",
	iterm2: "iterm2",
	vscode: "vscode",
	alacritty: "alacritty",
	warpterminal: "warp",
	orca: "orca",
	otty: "otty",
	rio: "rio",
	tern: "tern",
	monstar: "monstar",
	rex: "rex",
	"xterm-kitty": "kitty",
	"xterm-ghostty": "ghostty",
	"xterm-rex": "rex",
};

/** The id an emulator name (TERM_PROGRAM, a tmux client name) stands for, if known. */
export function terminalIdFromProgram(program: string | undefined): TerminalId | null {
	if (!program) return null;
	return PROGRAM_IDS[program.toLowerCase()] ?? null;
}

/**
 * Detect the emulator from `env`. Emulator-specific markers win, then
 * `TERM_PROGRAM`, the iTerm2 marker forwarded over SSH (`LC_TERMINAL`), the
 * attached tmux client (`tmuxClientNames`, see `mux/tmux.ts`), `TERM`, and
 * finally the `COLORTERM` true-color fallback.
 */
export function detectTerminalId(env: Env, tmuxClientNames: readonly string[] = []): TerminalId {
	if (env.KITTY_WINDOW_ID) return "kitty";
	if (env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (env.WEZTERM_PANE) return "wezterm";
	if (env.ITERM_SESSION_ID) return "iterm2";
	if (env.VSCODE_PID) return "vscode";
	if (env.ALACRITTY_WINDOW_ID) return "alacritty";
	const program = terminalIdFromProgram(env.TERM_PROGRAM);
	if (program) return program;
	if (isWindowsTerminal(env)) return "windowsTerminal";
	// iTerm2 forwards LC_TERMINAL over SSH; inside a multiplexer its OSC 1337 has no passthrough.
	if (env.LC_TERMINAL?.toLowerCase() === "iterm2" && !insideMultiplexer(env)) return "iterm2";
	for (const name of tmuxClientNames) {
		const id = terminalIdFromProgram(name);
		if (id) return id;
	}
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.includes("ghostty")) return "ghostty";
	if (term === "monstar") return "monstar";
	if (term === "xterm-rex") return "rex";
	const colorterm = env.COLORTERM?.toLowerCase();
	if (colorterm === "truecolor" || colorterm === "24bit") return "trueColor";
	return "base";
}

/**
 * Paradev (paradevai/paradev, formerly Superset) renders its terminals with
 * xterm.js and the Unicode 11 width table, which draws Hangul Compatibility
 * Jamo at 2 cells. Its PTYs drop `TERM_PROGRAM` and carry `SUPERSET_TERMINAL_ID`
 * (and `PARADEV_TERMINAL_ID` on newer builds) instead.
 */
export function isParadevEmbedder(env: Env): boolean {
	return Boolean(env.PARADEV_TERMINAL_ID || env.SUPERSET_TERMINAL_ID);
}

/**
 * Hangul Compatibility Jamo width for terminal `id`, with embedder carve-outs.
 * Inside a multiplexer the multiplexer owns the cell grid, so the embedder's
 * width does not apply there.
 */
export function resolveJamoWidth(id: TerminalId, env: Env): JamoWidth {
	if (isParadevEmbedder(env) && !insideMultiplexer(env)) return 2;
	return TERMINAL_PROFILES[id].jamoWidth;
}

/**
 * A genuine local Windows Terminal session: `WT_SESSION` is set and `TERM_PROGRAM`
 * names nothing else. Multiplexers and SSH sessions inherit `WT_SESSION` while
 * another program owns the grid (or the terminal is on the far side of the hop).
 */
export function isWindowsTerminal(env: Env): boolean {
	if (!env.WT_SESSION || isSsh(env) || classifyMultiplexer(env) !== null) return false;
	return !env.TERM_PROGRAM || env.TERM_PROGRAM === "Windows_Terminal";
}

/**
 * Emoji handling `id` implies before any reply. Inside a multiplexer its own
 * grid decides the advance of U+FE0F forms and may disagree with the outer
 * terminal, so they stay off; how a bare glyph draws is the outer terminal's.
 */
export function emojiSupportFor(id: TerminalId, env: Env): EmojiSupport {
	const profile = TERMINAL_PROFILES[id];
	const bareFits = profile.emojiBare === "fits";
	if (insideMultiplexer(env)) return { vs16Wide: false, bareFits };
	return { vs16Wide: profile.emojiVs16 === "wide", bareFits };
}

/** Tern names itself in `TERM_PROGRAM`; a multiplexer started in a Tern pane may leave it behind. */
export function isTernPane(env: Env): boolean {
	return env.TERM_PROGRAM?.toLowerCase() === "tern";
}
