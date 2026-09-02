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

/** Detect whether a terminal multiplexer owns the current screen grid. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	// TMUX/STY/ZELLIJ, Herdr, and CMUX workspace/surface/remote-transport
	// markers are authoritative session signals. TERM can also survive when those are
	// stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh). Do not
	// use CMUX_SOCKET_PATH here: it is a CLI socket override and can be set
	// outside a CMUX terminal.
	if (env.TMUX || env.STY || env.ZELLIJ || isInsideHerdr(env)) return true;
	if (env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT) return true;
	const term = env.TERM?.toLowerCase() ?? "";
	return term.startsWith("tmux") || term.startsWith("screen");
}
