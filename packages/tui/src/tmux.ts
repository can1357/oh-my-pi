import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { wrapToolCommand } from "@oh-my-pi/pi-utils/tool-cgroup";

/** Whether the process is running inside a tmux session. */
export function isInsideTmux(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return Boolean(env.TMUX);
}

/** Wrap a control sequence in tmux's DCS passthrough envelope. */
export function wrapTmuxPassthrough(payload: string): string {
	return `\x1bPtmux;${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** Pass a control sequence through tmux, leaving direct-terminal output unchanged. */
export function wrapTmuxPassthroughIfNeeded(payload: string, env: NodeJS.ProcessEnv = Bun.env): string {
	return isInsideTmux(env) ? wrapTmuxPassthrough(payload) : payload;
}

const CLIENT_TERMTYPE_NAME = /^([A-Za-z][A-Za-z0-9._+-]*)(?=\s|\(|$)/u;
const CLIENT_TERMTYPE_TIMEOUT_MS = 500;
let cachedClientTerminalName: string | null | undefined;

function queryTmuxClientTerminalName(env: NodeJS.ProcessEnv): string | null {
	const tmux = $which("tmux", { PATH: env.PATH });
	if (!tmux) return null;
	try {
		const result = Bun.spawnSync(wrapToolCommand([tmux, "display-message", "-p", "#{client_termtype}"]), {
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

/**
 * Resolve the terminal emulator name recorded for this tmux client.
 *
 * tmux overwrites pane identity variables with its own values, but retains the
 * attached client's terminal-type reply in `#{client_termtype}`. The local IPC
 * query runs once per process and degrades to `null` when unavailable.
 */
export function resolveTmuxClientTerminalName(env: NodeJS.ProcessEnv = Bun.env): string | null {
	if (!isInsideTmux(env) || isBunTestRuntime()) return null;
	if (cachedClientTerminalName === undefined) cachedClientTerminalName = queryTmuxClientTerminalName(env);
	return cachedClientTerminalName;
}
