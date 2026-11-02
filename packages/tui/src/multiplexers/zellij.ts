import type { TerminalMultiplexerModule } from "./types";

export const zellijMultiplexer = {
	id: "zellij",
	precedence: "session",
	sessionEnvKeys: ["ZELLIJ"],
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.ZELLIJ);
	},
	notifier: {
		tier: "inBand",
		// Zellij drops OSCs and has no DCS passthrough; a bare BEL raises its bell
		// flag. Bell notifications already provide that signal.
		send({ sequence, write }) {
			if (sequence === null) return false;
			write(`${sequence}\x07`);
			return true;
		},
	},
	// Zellij currently breaks OSC 11 passthrough on macOS, so terminal-derived
	// appearance cannot be trusted there.
	backgroundQueryBrokenOn: ["darwin"],
} as const satisfies TerminalMultiplexerModule;
