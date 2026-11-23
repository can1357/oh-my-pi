import type { TerminalMultiplexerModule } from "./types";

/** Recognize Tern for launches without changing its existing direct-terminal rendering. */
export const ternMultiplexer = {
	id: "tern",
	precedence: "outerApp",
	sessionEnvKeys: ["TERN_PANE", "TERN_PANE_SOCKET"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		const pane = env.TERN_PANE?.trim();
		return Boolean(pane && /^\d+$/.test(pane) && Number.isSafeInteger(Number(pane)) && env.TERN_PANE_SOCKET?.trim());
	},
} as const satisfies TerminalMultiplexerModule;
