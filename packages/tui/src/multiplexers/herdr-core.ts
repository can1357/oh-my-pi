import type { TerminalMultiplexerModule } from "./types";

// Core provides persistent PTYs; the attached viewer owns terminal emulation
// and rendering. Its capabilities must not be inferred from the Core ID.
export const herdrCoreMultiplexer = {
	id: "herdr-core",
	precedence: "outerApp",
	sessionEnvKeys: ["HC_TERMINAL_ID"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.HC_TERMINAL_ID?.trim());
	},
} as const satisfies TerminalMultiplexerModule;
