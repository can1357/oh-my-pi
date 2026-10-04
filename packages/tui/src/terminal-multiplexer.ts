import { cmuxMultiplexer } from "./multiplexers/cmux";
import { herdrMultiplexer } from "./multiplexers/herdr";
import { screenMultiplexer } from "./multiplexers/screen";
import { wmuxMultiplexer } from "./multiplexers/wmux";
import { zellijMultiplexer } from "./multiplexers/zellij";
import { tmuxMultiplexer } from "./tmux";

/** Terminal multiplexers omp recognizes as owning the screen grid. */
export type TerminalMultiplexer = "herdr" | "tmux" | "screen" | "zellij" | "cmux" | "wmux";

/**
 * Whether an explicit session marker identifies the current provider.
 *
 * TERM is intentionally excluded: it is a classification fallback, not proof
 * that a particular multiplexer session owns the current grid.
 */
export function hasTerminalMultiplexerSession(
	multiplexer: TerminalMultiplexer,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	switch (multiplexer) {
		case "herdr":
			return herdrMultiplexer.isInside(env);
		case "tmux":
			return tmuxMultiplexer.isInside(env);
		case "screen":
			return screenMultiplexer.isInside(env);
		case "zellij":
			return zellijMultiplexer.isInside(env);
		case "cmux":
			return cmuxMultiplexer.isInside(env);
		case "wmux":
			return wmuxMultiplexer.isInside(env);
	}
}

/**
 * Classify which terminal multiplexer owns the current screen grid, or `null`
 * for a direct terminal. Single source of truth for both the render-path gate
 * (`isInsideTerminalMultiplexer`) and the debug snapshot label.
 *
 * TMUX/STY/ZELLIJ, Herdr, and the CMUX/WMUX workspace/surface/remote-transport
 * markers are authoritative session signals. TERM can also survive when those
 * are stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh). Do not
 * use CMUX_SOCKET_PATH / WMUX_CLI / WMUX_PIPE here: they are CLI socket/path
 * overrides and can be set outside a CMUX/WMUX terminal. wmux is a Windows
 * multiplexer (Electron + xterm.js) modeled on cmux/herdr that repaints its
 * pane in place and exports WMUX=1 plus a native WMUX_SURFACE_ID.
 */
export function classifyTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): TerminalMultiplexer | null {
	if (hasTerminalMultiplexerSession("herdr", env)) return "herdr";
	if (hasTerminalMultiplexerSession("tmux", env)) return "tmux";
	if (hasTerminalMultiplexerSession("screen", env)) return "screen";
	if (hasTerminalMultiplexerSession("zellij", env)) return "zellij";
	if (hasTerminalMultiplexerSession("cmux", env)) return "cmux";
	if (hasTerminalMultiplexerSession("wmux", env)) return "wmux";
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("tmux")) return "tmux";
	if (term.startsWith("screen")) return "screen";
	return null;
}

/** True when a terminal multiplexer owns the current screen grid. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return classifyTerminalMultiplexer(env) !== null;
}
