import type { TerminalMultiplexerModule } from "./types";

/**
 * Ghostty is a terminal application, not a session multiplexer: it hosts the
 * process directly, so it ranks with the outer applications — a real
 * multiplexer (tmux, Zellij, …) running inside Ghostty still wins. Ghostty
 * keeps the direct-terminal render path; recognition exists so terminal
 * launches can split its surfaces and open tabs through the AppleScript
 * dictionary Ghostty ships since 1.4.
 */
export const ghosttyMultiplexer = {
	id: "ghostty",
	precedence: "outerApp",
	sessionEnvKeys: ["TERM_PROGRAM"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return env.TERM_PROGRAM?.toLowerCase() === "ghostty";
	},
} as const satisfies TerminalMultiplexerModule;
