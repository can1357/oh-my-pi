/**
 * Multiplexer detection from the environment.
 *
 * Session markers (`TMUX`, `STY`, `ZELLIJ`, …) name the layer we run in;
 * a multiplexer-family `TERM` only classifies when no marker does (it survives
 * `sudo` without `-E`, `su` and env-sanitizing launchers that strip the
 * markers). Nested layers resolve innermost-first in a fixed precedence order;
 * outer applications (Orca) rank last so a multiplexer running inside them wins.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/** Every multiplexer (or pane host) the driver recognizes. */
export type MultiplexerId = "herdr" | "tmux" | "screen" | "zellij" | "cmux" | "wmux" | "orca";

const SESSION_MARKERS: Record<MultiplexerId, (env: Env) => boolean> = {
	// HERDR_ENV=1 or a pane/tab/workspace id (they survive launchers that drop HERDR_ENV);
	// client-only paths (socket, bin, session, config) are not a session.
	herdr: env => env.HERDR_ENV === "1" || Boolean(env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID),
	tmux: env => Boolean(env.TMUX),
	screen: env => Boolean(env.STY),
	zellij: env => Boolean(env.ZELLIJ),
	// CMUX_SOCKET_PATH is a CLI socket override and can be set outside a cmux terminal.
	cmux: env => Boolean(env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT),
	// WMUX_CLI / WMUX_PIPE are CLI overrides and can be set outside a wmux terminal.
	wmux: env => env.WMUX === "1" || Boolean(env.WMUX_SURFACE_ID),
	// Orca terminals expose paired, nonempty pane/worktree ids.
	orca: env => Boolean(env.ORCA_PANE_KEY?.trim() && env.ORCA_WORKTREE_ID?.trim()),
};

/** Session-marker precedence when several layers are present (the first match is the layer we talk to). */
const PRECEDENCE: readonly MultiplexerId[] = ["herdr", "tmux", "screen", "zellij", "cmux", "wmux"];

/** Every environment variable multiplexer classification reads, including the `TERM` fallback. */
export const MULTIPLEXER_ENV_KEYS: readonly string[] = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"TMUX",
	"STY",
	"ZELLIJ",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_REMOTE_TRANSPORT",
	"WMUX",
	"WMUX_SURFACE_ID",
	"ORCA_PANE_KEY",
	"ORCA_WORKTREE_ID",
	"TERM",
];

/**
 * Whether `env` carries a session marker of `id`. `TERM` never counts: it is a
 * classification fallback, not proof that a session of `id` owns the grid.
 */
export function hasMultiplexerSession(id: MultiplexerId, env: Env): boolean {
	return SESSION_MARKERS[id](env);
}

/** The multiplexer a `tmux`/`screen` `TERM` names, whether or not its session markers survived. */
function multiplexerForTerm(env: Env): "tmux" | "screen" | null {
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("tmux")) return "tmux";
	if (term.startsWith("screen")) return "screen";
	return null;
}

/**
 * The multiplexer hosting the process, or null for a direct terminal: session
 * markers first, then the `TERM` fallback, then Orca.
 */
export function classifyMultiplexer(env: Env): MultiplexerId | null {
	for (const id of PRECEDENCE) if (SESSION_MARKERS[id](env)) return id;
	const family = multiplexerForTerm(env);
	if (family) return family;
	if (SESSION_MARKERS.orca(env)) return "orca";
	return null;
}

/**
 * Whether the classified multiplexer owns the screen grid (no scrollback
 * rebuild, anchored resize, skipped probes). Orca keeps the direct-terminal path.
 */
export function insideMultiplexer(env: Env): boolean {
	const id = classifyMultiplexer(env);
	return id !== null && id !== "orca";
}

/** Whether this is a remote session (the terminal is on the other side of an SSH hop). */
export function isSsh(env: Env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

/** The contract's coarse multiplexer field. */
export function contractMultiplexer(id: MultiplexerId | null): "tmux" | "zellij" | "screen" | null {
	return id === "tmux" || id === "zellij" || id === "screen" ? id : null;
}

/**
 * Whether a multiplexer session answers CSI ?996n with its own light/dark mode
 * (CSI ?997;Pn n) while it forwards OSC 11 to the host (Zellij), so that mode
 * outranks the host background's luminance.
 */
export function multiplexerOwnsColorScheme(env: Env): boolean {
	return hasMultiplexerSession("zellij", env);
}

/**
 * Whether this process runs in a Herdr desktop terminal (herdr-core). Herdr
 * desktop sets `HC_TERMINAL_ID`, not the older multiplexer's `HERDR_*` pane
 * identity, and keeps the pty size in step with what it shows.
 */
export function isHerdrDesktopTerminal(env: Env): boolean {
	return Boolean(env.HC_TERMINAL_ID);
}
