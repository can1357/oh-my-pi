/**
 * tmux helpers: the attached client's terminal identity, the pane's
 * passthrough policy, and the passthrough envelopes.
 *
 * tmux ≥ 3.2 replaces the pane's `TERM_PROGRAM` with `tmux`; the server still
 * records the attached client's terminal-type reply (`#{client_termtype}`)
 * and `TERM` (`#{client_termname}`), so asking it recovers the emulator.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Env, MultiplexerId } from "./detect";

/** Runs `tmux <args>` and returns stdout, or null on failure/timeout. */
export type TmuxRunner = (args: readonly string[], env: Env, timeoutMs: number) => string | null;

/** The attached client lookup gets a long budget: a lost race silently downgrades the whole session. */
const CLIENT_LOOKUP_TIMEOUT_MS = 2_000;
const OPTION_LOOKUP_TIMEOUT_MS = 500;

/** Runs the real `tmux` binary found on `env.PATH`. */
export const spawnTmux: TmuxRunner = (args, env, timeoutMs) => {
	const tmux = Bun.which("tmux", { PATH: env.PATH ?? "" });
	if (!tmux) return null;
	try {
		const result = Bun.spawnSync([tmux, ...args], {
			env: { ...env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: timeoutMs,
		});
		if (!result.success) return null;
		return result.stdout.toString();
	} catch (error) {
		logger.debug("tmux query failed", { args, error: String(error) });
		return null;
	}
};

/**
 * Emulator name candidates from a `#{client_termtype}<TAB>#{client_termname}`
 * report: the terminal-type reply's leading word first (`WezTerm 2026…`),
 * then the client's `TERM` with and without its `xterm-` prefix
 * (`xterm-kitty` → `kitty`).
 */
export function tmuxClientNamesFromReport(report: string): string[] {
	const [termtype = "", termname = ""] = report.trim().split("\t");
	const names: string[] = [];
	const program = /^([A-Za-z][\w.-]*)/.exec(termtype.trim())?.[1];
	if (program) names.push(program);
	const term = termname.trim();
	if (term) {
		names.push(term);
		if (term.startsWith("xterm-")) names.push(term.slice("xterm-".length));
	}
	return names;
}

/** Candidate emulator names of the attached tmux client (empty outside tmux or when tmux does not answer). */
export function tmuxClientTerminalNames(env: Env, run: TmuxRunner = spawnTmux): readonly string[] {
	if (!env.TMUX) return [];
	const report = run(
		["display-message", "-p", "#{client_termtype}\t#{client_termname}"],
		env,
		CLIENT_LOOKUP_TIMEOUT_MS,
	);
	return report ? tmuxClientNamesFromReport(report) : [];
}

/**
 * Whether the pane forwards `DCS tmux; … ST` envelopes. tmux 3.3+ defaults
 * `allow-passthrough` to off; older tmux has no option (empty answer) and
 * always forwards.
 */
export function tmuxAllowsPassthrough(env: Env, run: TmuxRunner = spawnTmux): boolean {
	const target = env.TMUX_PANE ? ["-t", env.TMUX_PANE] : [];
	const value = run(["show-options", "-Apqv", ...target, "allow-passthrough"], env, OPTION_LOOKUP_TIMEOUT_MS)?.trim();
	return value !== "off";
}

/** A merged terminal description line saying the client draws SIXEL. */
const SIXEL_CAPABILITY = /^\s*\d+: Sxl: \(flag\) true$/m;

/**
 * Whether tmux draws SIXEL to the attached client. A tmux built with SIXEL
 * answers every pane's DA1 with attribute 4 and draws a text placeholder for
 * clients that cannot show it, so the pane's DA1 says nothing about the
 * outer terminal; the client's merged terminal description (`Sxl`, from
 * terminfo, overrides or the `sixel` feature) does.
 */
export function tmuxClientRendersSixel(env: Env, run: TmuxRunner = spawnTmux): boolean {
	if (!env.TMUX) return false;
	const client = run(["display-message", "-p", "#{client_name}"], env, OPTION_LOOKUP_TIMEOUT_MS)?.trim();
	if (!client) return false;
	return SIXEL_CAPABILITY.test(run(["show-messages", "-T", "-t", client], env, OPTION_LOOKUP_TIMEOUT_MS) ?? "");
}

/** `sequence` in tmux's passthrough envelope (every ESC of the payload doubled). */
export function wrapTmuxPassthrough(sequence: string): string {
	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** GNU screen caps a DCS string, so the payload rides in chunks of this many characters. */
const SCREEN_CHUNK = 768;

/** `sequence` in GNU screen's DCS passthrough, chunked under screen's string limit. */
export function wrapScreenPassthrough(sequence: string): string {
	let out = "";
	for (let i = 0; i < sequence.length; i += SCREEN_CHUNK) {
		out += `\x1bP${sequence.slice(i, i + SCREEN_CHUNK)}\x1b\\`;
	}
	return out;
}

/** `sequence` wrapped for the multiplexer layer, unchanged when there is none (or it routes escapes itself). */
export function wrapPassthrough(sequence: string, multiplexer: MultiplexerId | null): string {
	if (multiplexer === "tmux") return wrapTmuxPassthrough(sequence);
	if (multiplexer === "screen") return wrapScreenPassthrough(sequence);
	return sequence;
}

/**
 * Whether the terminal hosting this tmux session draws TSP programs natively:
 * it sets the session user option `@tern-tsp` while it watches the session.
 */
export function tmuxSessionSpeaksTsp(env: Env, run: TmuxRunner = spawnTmux): boolean {
	if (!env.TMUX) return false;
	return (run(["show-options", "-qv", "@tern-tsp"], env, OPTION_LOOKUP_TIMEOUT_MS)?.trim() ?? "") !== "";
}

/**
 * Stop (`on` false) or restore (`on` true) tmux turning this pane's APC
 * strings into its title, which would otherwise swallow every TSP message.
 */
export function setTmuxPaneApcTitles(on: boolean, env: Env, run: TmuxRunner = spawnTmux): void {
	const pane = env.TMUX_PANE;
	if (!pane) return;
	const args = on
		? ["set-option", "-pu", "-t", pane, "allow-set-title"]
		: ["set-option", "-p", "-t", pane, "allow-set-title", "off"];
	run(args, env, OPTION_LOOKUP_TIMEOUT_MS);
}
