import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { tmuxMultiplexer, wrapTmuxPassthrough } from "./multiplexers/tmux";

export { wrapTmuxPassthrough } from "./multiplexers/tmux";

/** Pass a control sequence through tmux, leaving direct-terminal output unchanged. */
export function wrapTmuxPassthroughIfNeeded(payload: string, env: NodeJS.ProcessEnv = Bun.env): string {
	return tmuxMultiplexer.isInside(env) ? wrapTmuxPassthrough(payload) : payload;
}

const CLIENT_TERMTYPE_NAME = /^([A-Za-z][A-Za-z0-9._+-]*)(?=\s|\(|$)/u;
const CLIENT_TERMTYPE_TIMEOUT_MS = 500;
let cachedClientTerminalName: string | null | undefined;

function queryTmuxClientTerminalName(env: NodeJS.ProcessEnv): string | null {
	const tmux = $which("tmux", { PATH: env.PATH });
	if (!tmux) return null;
	try {
		const result = Bun.spawnSync([tmux, "display-message", "-p", "#{client_termtype}"], {
			env,
			stdout: "pipe",
			stderr: "ignore",
			timeout: CLIENT_TERMTYPE_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		if (result.exitCode !== 0) return null;
		return CLIENT_TERMTYPE_NAME.exec(result.stdout.toString().trim())?.[1] ?? null;
	} catch {
		return null;
	}
}

const TMUX_COMMAND_TIMEOUT_MS = 500;

/** Run a tmux command against the current server; its stdout, or null on failure. */
function runTmux(args: string[], env: NodeJS.ProcessEnv): string | null {
	const tmux = $which("tmux", { PATH: env.PATH });
	if (!tmux) return null;
	try {
		const result = Bun.spawnSync([tmux, ...args], {
			env,
			stdout: "pipe",
			stderr: "ignore",
			timeout: TMUX_COMMAND_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		return result.exitCode === 0 ? result.stdout.toString() : null;
	} catch {
		return null;
	}
}

/**
 * Whether the terminal hosting this tmux session draws TSP programs natively:
 * it sets the session user option `@tern-tsp` while it watches the session.
 */
export function tmuxSessionSpeaksTsp(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return (runTmux(["show-options", "-qv", "@tern-tsp"], env)?.trim() ?? "") !== "";
}

/**
 * Stop (`on` false) or restore (`on` true) tmux turning this pane's APC
 * strings into its title, which would otherwise swallow every TSP message.
 */
export function setTmuxPaneApcTitles(on: boolean, env: NodeJS.ProcessEnv = Bun.env): void {
	const pane = env.TMUX_PANE;
	if (!pane) return;
	runTmux(
		on
			? ["set-option", "-pu", "-t", pane, "allow-set-title"]
			: ["set-option", "-p", "-t", pane, "allow-set-title", "off"],
		env,
	);
}

/**
 * Resolve the terminal emulator name recorded for this tmux client.
 *
 * tmux overwrites pane identity variables with its own values, but retains the
 * attached client's terminal-type reply in `#{client_termtype}`. The local IPC
 * query runs once per process and degrades to `null` when unavailable.
 */
export function resolveTmuxClientTerminalName(env: NodeJS.ProcessEnv = Bun.env): string | null {
	if (!tmuxMultiplexer.isInside(env) || isBunTestRuntime()) return null;
	if (cachedClientTerminalName === undefined) cachedClientTerminalName = queryTmuxClientTerminalName(env);
	return cachedClientTerminalName;
}
