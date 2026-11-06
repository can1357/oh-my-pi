import type { TerminalMultiplexerModule } from "./types";

/**
 * The Herdr desktop app runs its terminals on herdr-core (CLI `hc`), which
 * exposes each terminal's address and control socket. It is a separate product
 * from the Herdr TUI (`herdr`, `HERDR_*`). It is recognized for launches, but it
 * ranks below nested multiplexers and keeps the direct-terminal render path it
 * used before it was recognized.
 */
export const herdrCoreMultiplexer = {
	id: "herdr-core",
	precedence: "outerApp",
	sessionEnvKeys: ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.HC_TERMINAL_ID?.trim() && env.HC_TERMINAL_SOCKET?.trim());
	},
} as const satisfies TerminalMultiplexerModule;
