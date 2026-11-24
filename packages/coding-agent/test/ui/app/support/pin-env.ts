/**
 * Determinism preamble for the app-corpus replay, matching the environment the
 * corpus was captured in. Import it FIRST (before any app module): terminal
 * identity and color depth are read from the
 * environment at module load / theme load, and clocks/randomness are read while
 * rendering (spinner frames, elapsed times, tips).
 *
 * Pinned: a plain truecolor terminal (no terminal-program identity, no
 * multiplexer, no SSH), images off, OSC 8 hyperlinks off, UTC, a fixed clock at
 * 2023-11-14T22:13:20Z and a seeded Math.random.
 *
 * This module has no imports on purpose so its body runs before the app's.
 */

const SCRUB = [
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"VSCODE_PID",
	"ALACRITTY_WINDOW_ID",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TERM_FEATURES",
	"LC_TERMINAL",
	"LC_TERMINAL_VERSION",
	"TMUX",
	"TMUX_PANE",
	"STY",
	"ZELLIJ",
	"HERDR",
	"WT_SESSION",
	"SSH_CONNECTION",
	"SSH_TTY",
	"SSH_CLIENT",
	"NO_COLOR",
	"FORCE_COLOR",
	"PI_FORCE_HYPERLINKS",
	"PI_NO_DECCARA",
	"PI_NOTIFICATIONS",
];
for (const key of SCRUB) delete process.env[key];
process.env.TERM = "xterm-256color";
process.env.COLORTERM = "truecolor";
process.env.PI_FORCE_IMAGE_PROTOCOL = "off";
process.env.PI_NO_HYPERLINKS = "1";
process.env.TZ = "UTC";
// Text attributes: chalk decides its color level from FORCE_COLOR before anything else. Without it a
// non-TTY capture drops bold/italic/underline/strike/inverse/dim, unlike a real terminal.
process.env.FORCE_COLOR = "3";

/** The pinned wall clock (ms since epoch): 2023-11-14T22:13:20.000Z. */
export const PINNED_NOW = 1_700_000_000_000;

let clock = PINNED_NOW;
Date.now = () => clock;
performance.now = () => clock - PINNED_NOW;
const RealDate = Date;
class PinnedDate extends RealDate {
	constructor(...args: unknown[]) {
		if (args.length === 0) super(clock);
		else super(...(args as [number]));
	}
	static override now(): number {
		return clock;
	}
}
globalThis.Date = PinnedDate as DateConstructor;

/** Move the pinned clock (spinner frames, elapsed timers). */
export function setPinnedNow(ms: number): void {
	clock = ms;
}

let seed = 0x2f6b_1d3a;
Math.random = () => {
	// mulberry32
	seed = (seed + 0x6d2b79f5) | 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Reset Math.random to its initial seed (call per case for order-independent output). */
export function reseedRandom(value = 0x2f6b_1d3a): void {
	seed = value;
}

// Terminal geometry: several screens size previews and windows from the process's stdout, which differs
// between a TTY and a pipe. Pin a non-TTY 120×40 terminal.
for (const [name, value] of [
	["columns", 120],
	["rows", 40],
	["isTTY", false],
] as const) {
	Object.defineProperty(process.stdout, name, { value, configurable: true, writable: true });
}
