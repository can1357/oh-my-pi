/**
 * Terminal identity: which emulator we talk to, from environment variables,
 * and what that emulator is known to support.
 */
import type { JamoWidth } from "../../text/width";
import { type Env, insideMultiplexer } from "../mux/detect";

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
	| "monstar";

function profile(
	id: TerminalId,
	images: TerminalProfile["images"],
	trueColor: boolean,
	hyperlinks: boolean,
	synchronizedOutput: boolean,
	notify: NotifyProtocol,
	quirks: { readonly jamoWidth?: JamoWidth; readonly progressKeepalive?: boolean; readonly textSizing?: boolean } = {},
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
	};
}

/** The identity table. */
export const TERMINAL_PROFILES: Readonly<Record<TerminalId, TerminalProfile>> = {
	base: profile("base", null, false, false, false, "bell"),
	trueColor: profile("trueColor", null, true, false, false, "bell"),
	kitty: profile("kitty", "kitty", true, true, true, "osc99", { textSizing: true }),
	// libghostty draws compatibility jamo wide and drops OSC 9;4 progress without a heartbeat.
	ghostty: profile("ghostty", "kitty", true, true, true, "osc9", { jamoWidth: 2, progressKeepalive: true }),
	wezterm: profile("wezterm", "kitty", true, true, true, "osc9"),
	iterm2: profile("iterm2", "iterm", true, true, true, "osc9"),
	vscode: profile("vscode", null, true, true, true, "bell"),
	alacritty: profile("alacritty", null, true, true, true, "bell"),
	// Warp: Kitty graphics (macOS/Linux), no OSC 8; sync output left to the DECRQM probe.
	warp: profile("warp", "kitty", true, false, false, "osc9", { jamoWidth: 1 }),
	orca: profile("orca", null, true, false, false, "bell", { jamoWidth: 2 }),
	otty: profile("otty", "kitty", true, true, false, "osc99"),
	// rio parses OSC 9/777, but Windows silently drops its unpackaged toast; BEL keeps the D-Bus fallback on Linux.
	rio: profile("rio", "kitty", true, true, false, "bell"),
	rex: profile("rex", "kitty", true, true, false, "bell"),
	tern: profile("tern", "kitty", true, true, true, "osc99"),
	// Built on libghostty: wide jamo; clears OSC 9;4 progress after 15 s without an update.
	monstar: profile("monstar", "kitty", true, true, true, "osc9", { jamoWidth: 2, progressKeepalive: true }),
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

/** Tern names itself in `TERM_PROGRAM`; a multiplexer started in a Tern pane may leave it behind. */
export function isTernPane(env: Env): boolean {
	return env.TERM_PROGRAM?.toLowerCase() === "tern";
}
