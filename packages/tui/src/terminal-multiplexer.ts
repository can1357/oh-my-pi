/** True when this process is running inside a Herdr pane. */
export function isInsideHerdr(env: NodeJS.ProcessEnv = Bun.env): boolean {
	// HERDR_ENV=1 is canonical. Identity vars survive env-sanitizing launchers
	// that drop HERDR_ENV. Do not use HERDR_SOCKET_PATH, HERDR_BIN_PATH,
	// HERDR_SESSION, HERDR_CONFIG_PATH, or HERDR_CLIENT_SOCKET_PATH here: they
	// are client-side and can be set outside a Herdr pane, matching the
	// CMUX_SOCKET_PATH warning below.
	if (env.HERDR_ENV === "1") return true;
	if (env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID) return true;
	return false;
}

/** Terminal multiplexers omp recognizes as owning the screen grid. */
export type TerminalMultiplexer = "herdr" | "tmux" | "screen" | "zellij" | "cmux" | "wmux";

/**
 * Classify which terminal multiplexer owns the current screen grid, or `null`
 * for a direct terminal. Single source of truth for both the render-path gate
 * (`isInsideTerminalMultiplexer`) and the debug snapshot label.
 *
 * TMUX/STY/ZELLIJ, Herdr, and the CMUX/WMUX workspace/surface/remote-transport
 * markers are authoritative session signals. TERM can also survive when those
 * are stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh). Do not
 * use CMUX_SOCKET_PATH / WMUX_CLI / WMUX_PIPE here: they are CLI socket/path
 * overrides and can be set outside a CMUX/WMUX terminal. wmux is a Windows
 * multiplexer (Electron + xterm.js) modeled on cmux/herdr that repaints its
 * pane in place and exports WMUX=1 plus a native WMUX_SURFACE_ID.
 */
export function classifyTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): TerminalMultiplexer | null {
	if (isInsideHerdr(env)) return "herdr";
	if (env.TMUX) return "tmux";
	if (env.STY) return "screen";
	if (env.ZELLIJ) return "zellij";
	if (env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT) return "cmux";
	if (env.WMUX === "1" || env.WMUX_SURFACE_ID) return "wmux";
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("tmux")) return "tmux";
	if (term.startsWith("screen")) return "screen";
	return null;
}

/** True when a terminal multiplexer owns the current screen grid. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return classifyTerminalMultiplexer(env) !== null;
}
