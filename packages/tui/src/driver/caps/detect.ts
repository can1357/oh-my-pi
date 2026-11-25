/**
 * Everything the environment alone says about the terminal: its identity and
 * the capabilities the startup probes start from. The process driver refines
 * both; callers without a running driver use them as they are.
 */
import type { TerminalCapabilities } from "../contract";
import type { TerminalIdentity } from "../io";
import { classifyMultiplexer, type Env, isSsh } from "../mux/detect";
import { type TmuxRunner, tmuxAllowsPassthrough, tmuxClientTerminalNames } from "../mux/tmux";
import { capabilitiesFromEnv, isWsl } from "./env";
import { detectTerminalId, TERMINAL_PROFILES, terminalIdFromProgram } from "./identity";

export interface DetectTerminalOptions {
	readonly platform: NodeJS.Platform;
	/** A Windows pseudoconsole sits between us and the terminal (default: Windows or WSL). */
	readonly conpty?: boolean;
	/** Runs tmux for the client identity and passthrough lookups. */
	readonly tmux?: TmuxRunner;
}

export interface DetectedTerminal {
	readonly identity: TerminalIdentity;
	readonly capabilities: TerminalCapabilities;
	/** WSL: Linux userland behind a Windows pseudoconsole. */
	readonly wsl: boolean;
}

/** Identity and pre-probe capabilities of the terminal `env` describes. */
export function detectTerminal(env: Env, options: DetectTerminalOptions): DetectedTerminal {
	const { platform, tmux } = options;
	const wsl = isWsl(env, platform);
	const conpty = options.conpty ?? (platform === "win32" || wsl);
	const multiplexer = classifyMultiplexer(env);
	// Inside tmux the pane's TERM_PROGRAM is tmux; the server knows the attached client's emulator.
	const clientNames = env.TMUX && !terminalIdFromProgram(env.TERM_PROGRAM) ? tmuxClientTerminalNames(env, tmux) : [];
	const id = detectTerminalId(env, clientNames);
	const tmuxPassthrough =
		multiplexer === "tmux" && TERMINAL_PROFILES[id].images === "kitty" ? tmuxAllowsPassthrough(env, tmux) : true;
	return {
		identity: {
			id,
			multiplexer,
			ssh: isSsh(env),
			conpty,
			version: null,
			notify: TERMINAL_PROFILES[id].notify,
			richNotifications: false,
			glyphs: false,
		},
		capabilities: capabilitiesFromEnv(env, { id, platform, wsl, tmuxPassthrough }),
		wsl,
	};
}
