import type { TerminalMultiplexerModule } from "./types";

/**
 * wmux is a Windows multiplexer (Electron + xterm.js) modeled on cmux/herdr that
 * repaints its pane in place. WMUX_CLI / WMUX_PIPE are CLI path overrides and can
 * be set outside a wmux terminal.
 */
export const wmuxMultiplexer = {
	id: "wmux",
	precedence: "session",
	sessionEnvKeys: ["WMUX", "WMUX_SURFACE_ID"],
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return env.WMUX === "1" || Boolean(env.WMUX_SURFACE_ID);
	},
} as const satisfies TerminalMultiplexerModule;
