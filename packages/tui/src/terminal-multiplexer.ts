/** Detect whether a terminal multiplexer owns the current screen grid. */
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
