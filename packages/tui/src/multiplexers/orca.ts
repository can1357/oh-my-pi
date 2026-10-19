import type { TerminalMultiplexerModule } from "./types";

/**
 * Orca is an xterm.js-based IDE whose terminals expose paired pane/worktree IDs.
 * It is recognized for launches, but it ranks below nested multiplexers and keeps
 * the direct-terminal render path it used before it was recognized.
 */
export const orcaMultiplexer = {
	id: "orca",
	precedence: "outerApp",
	sessionEnvKeys: ["ORCA_PANE_KEY", "ORCA_WORKTREE_ID"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.ORCA_PANE_KEY?.trim() && env.ORCA_WORKTREE_ID?.trim());
	},
} as const satisfies TerminalMultiplexerModule;
