import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";

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

/**
 * Terminal identity tmux holds for its attached client, from the client's own
 * answer to the terminal-type query (XTVERSION, `CSI > 0 q`).
 */
export interface TmuxClientTerminal {
	/** Emulator name as the client reported it, e.g. `WezTerm`, `kitty`, `iTerm2`. */
	name: string;
	/** Version from the same reply, e.g. `20260905-175422-0f4b5596`; `null` when the reply carried none. */
	version: string | null;
}

/**
 * Parse a `#{client_termtype}` value: the client's terminal-type reply verbatim,
 * i.e. a name optionally followed by a version — space-separated
 * (`WezTerm 20260905-175422-0f4b5596`, `iTerm2 3.5.0`) or parenthesized
 * (`kitty(0.31.0)`, `XTerm(370)`). Empty input (no client answered, or a tmux
 * release that expands the unknown format to nothing) and replies that do not
 * start with a name yield `null`, leaving detection on the pane environment.
 */
export function parseTmuxClientTermtype(raw: string | undefined): TmuxClientTerminal | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	const match = /^([A-Za-z][A-Za-z0-9._+-]*)(?:\s*\(([^)]*)\)|\s+(\S.*))?$/u.exec(trimmed);
	const name = match?.[1];
	if (!name) return null;
	const version = (match?.[2] ?? match?.[3] ?? "").trim();
	return { name, version: version.length > 0 ? version : null };
}

/**
 * Hard cap for the client terminal-type probe. `tmux display` is local IPC and
 * answers in single-digit milliseconds; a wedged server must not stall startup,
 * so past this ceiling the client stays unidentified and detection keeps
 * running off the pane environment. The child is SIGKILLed on timeout, matching
 * the other startup probes.
 */
const CLIENT_TERMTYPE_PROBE_TIMEOUT_MS = 500;

/**
 * Run `tmux display -p '#{client_termtype}'`. The child inherits this process's
 * environment so the tmux client reaches the server this pane belongs to.
 */
function queryTmuxClientTerminal(): TmuxClientTerminal | null {
	try {
		const result = Bun.spawnSync(["tmux", "display", "-p", "#{client_termtype}"], {
			stdout: "pipe",
			stderr: "ignore",
			timeout: CLIENT_TERMTYPE_PROBE_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		if (result.exitCode !== 0) return null;
		return parseTmuxClientTermtype(result.stdout.toString());
	} catch {
		// No `tmux` on PATH, or the spawn failed outright: the pane environment
		// stays the only source of identity.
		return null;
	}
}

let cachedClientTerminal: TmuxClientTerminal | null | undefined;

/**
 * Terminal identity of the client attached to this tmux session, asked of the
 * tmux server rather than read from the pane environment: tmux >= 3.2 rewrites
 * `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, and `COLORTERM` with its own values
 * (`environ_for_session()` in `environ.c`), so an emulator reached through tmux
 * has no marker left in `env` — while the server still holds the client's
 * terminal-type reply (`#{client_termtype}`, documented since at least tmux 3.3
 * as "Terminal type of client, if available").
 *
 * Queried once per process — the attached client cannot change under a running
 * omp, so a session whose first call happens before a client attached stays
 * unidentified. Returns `null` outside tmux, when no client answered
 * ("if available"), on tmux releases that expand the unknown format to nothing,
 * and from the test runner — tests inject the value instead of shelling out.
 * With several clients attached to one session, tmux answers for the current
 * client, so the identity is best-effort.
 */
export function resolveTmuxClientTerminal(env: NodeJS.ProcessEnv = Bun.env): TmuxClientTerminal | null {
	if (!isInsideTmux(env)) return null;
	if (isBunTestRuntime()) return null;
	if (cachedClientTerminal === undefined) cachedClientTerminal = queryTmuxClientTerminal();
	return cachedClientTerminal;
}
