import type { TerminalMultiplexerModule } from "./types";

export const screenMultiplexer = {
	id: "screen",
	precedence: "session",
	sessionEnvKeys: ["STY"],
	termPrefix: "screen",
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.STY);
	},
	// GNU screen never gained OSC 8 support, so a screen layer anywhere in the
	// path vetoes hyperlinks, even under a nested tmux.
	hyperlinks: "drop",
} as const satisfies TerminalMultiplexerModule;
