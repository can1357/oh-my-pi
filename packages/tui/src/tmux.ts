import * as fs from "node:fs";
import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { tmuxMultiplexer, wrapTmuxPassthrough } from "./multiplexers/tmux";

export { wrapTmuxPassthrough } from "./multiplexers/tmux";

/** Pass a control sequence through tmux, leaving direct-terminal output unchanged. */
export function wrapTmuxPassthroughIfNeeded(payload: string, env: NodeJS.ProcessEnv = Bun.env): string {
	return tmuxMultiplexer.isInside(env) ? wrapTmuxPassthrough(payload) : payload;
}

const CLIENT_TERMTYPE_NAME = /^([A-Za-z][A-Za-z0-9._+-]*)(?=\s|\(|$)/u;
// One `tmux display-message` round trip over the server socket, which answers in
// single-digit milliseconds when healthy. 500ms kept losing the race on a loaded
// machine (fork/exec of the tmux client alone can exceed it on a saturated box),
// and a lost race is indistinguishable from "not tmux": the process then falls
// back to the true-color profile for the whole session. 2s bounds the startup
// stall only when tmux is genuinely wedged.
const CLIENT_TERMINAL_TIMEOUT_MS = 2_000;
/** Client `TERM` values that name their emulator; tmux records this on every version. */
const CLIENT_TERMNAME_PROGRAMS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^xterm-kitty$/u, "kitty"],
	[/^xterm-ghostty$/u, "ghostty"],
	[/^wezterm$/u, "wezterm"],
];
let cachedClientTerminalNames: readonly string[] | undefined;

/**
 * Emulator name candidates from a `#{client_termtype}<TAB>#{client_termname}`
 * line, best first: the terminal-type reply (tmux 3.4+, XTVERSION), then the
 * emulator the client's `TERM` names when it ships its own terminfo entry. Both
 * are kept because the reply can name an unrecognized program (a nested tmux
 * answers `tmux 3.4`) while `TERM` still identifies the emulator.
 */
export function tmuxClientProgramsFromReport(report: string): string[] {
	// Split before trimming: an empty terminal type leaves the line starting with the tab.
	const [termtype = "", termname = ""] = report.split("\t");
	const programs: string[] = [];
	const program = CLIENT_TERMTYPE_NAME.exec(termtype.trim())?.[1];
	if (program) programs.push(program);
	const term = termname.trim().toLowerCase();
	const termProgram = CLIENT_TERMNAME_PROGRAMS.find(([pattern]) => pattern.test(term))?.[1];
	if (termProgram) programs.push(termProgram);
	return programs;
}

function queryTmuxClientTerminalNames(env: NodeJS.ProcessEnv): readonly string[] {
	const tmux = $which("tmux", { PATH: env.PATH });
	if (!tmux) return [];
	try {
		const result = Bun.spawnSync([tmux, "display-message", "-p", "#{client_termtype}\t#{client_termname}"], {
			env,
			stdout: "pipe",
			stderr: "ignore",
			timeout: CLIENT_TERMINAL_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		if (result.exitCode !== 0) return [];
		return tmuxClientProgramsFromReport(result.stdout.toString());
	} catch {
		return [];
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
 * Resolve the terminal emulator names recorded for this tmux client, best first.
 *
 * tmux overwrites pane identity variables with its own values, but retains the
 * attached client's terminal-type reply in `#{client_termtype}` and its `TERM`
 * in `#{client_termname}` (see {@link tmuxClientProgramsFromReport}). The local
 * IPC query runs once per process and degrades to `[]` when unavailable.
 */
export function resolveTmuxClientTerminalNames(env: NodeJS.ProcessEnv = Bun.env): readonly string[] {
	if (!tmuxMultiplexer.isInside(env) || isBunTestRuntime()) return [];
	cachedClientTerminalNames ??= queryTmuxClientTerminalNames(env);
	return cachedClientTerminalNames;
}

const SIXEL_CAPABILITY = /^\s*\d+: Sxl: \(flag\) true$/mu;
let cachedClientSixel: { tmux: string; renders: boolean } | undefined;

function queryTmuxClientRendersSixel(env: NodeJS.ProcessEnv): boolean {
	const client = runTmux(["display-message", "-p", "#{client_name}"], env)?.trim();
	if (!client) return false;
	return SIXEL_CAPABILITY.test(runTmux(["show-messages", "-T", "-t", client], env) ?? "");
}

/**
 * Whether tmux draws SIXEL to the client attached to this session: its
 * effective terminal description for that client carries `Sxl`.
 *
 * A tmux built with SIXEL answers every pane's DA1 with attribute 4 and draws a
 * `SIXEL IMAGE (WxH)` text placeholder for clients without SIXEL, so the pane's
 * DA1 says nothing about the outer terminal. tmux itself renders SIXEL only
 * when the client's terminal has `Sxl`, whether from terminfo,
 * `terminal-overrides`, or the `sixel` feature (DA1 or `terminal-features`),
 * and `show-messages -T` reports that merged description. The TUI consults
 * this before trusting the pane's DA1 attribute. Queried once per tmux
 * session; `false` outside tmux, with no attached client, or when the query
 * fails. Nested tmux usually reports no `Sxl`: the inner client's terminal is
 * the outer tmux, whose DA1 starts with level 1, which tmux does not parse
 * for features.
 */
export function tmuxClientRendersSixel(env: NodeJS.ProcessEnv = Bun.env): boolean {
	const tmux = env.TMUX;
	if (!tmux) return false;
	if (cachedClientSixel?.tmux !== tmux) cachedClientSixel = { tmux, renders: queryTmuxClientRendersSixel(env) };
	return cachedClientSixel.renders;
}

let cachedPanePassthrough: { key: string; allowed: boolean } | undefined;

function queryTmuxPaneAllowsPassthrough(env: NodeJS.ProcessEnv): boolean {
	const pane = env.TMUX_PANE;
	const target = pane ? ["-t", pane] : [];
	const value = runTmux(["show-options", "-Apqv", ...target, "allow-passthrough"], env)?.trim();
	if (value === undefined) return false;
	// tmux before 3.3 has no `allow-passthrough` option (`-q` prints nothing)
	// and always forwards DCS passthrough.
	return value === "" || value === "on" || value === "all";
}

/**
 * Whether tmux forwards this pane's `\x1bPtmux;…\x1b\\` passthrough envelopes
 * to the attached client. tmux 3.3+ defaults `allow-passthrough` to `off` and
 * then silently drops every wrapped sequence, so Kitty graphics sent through
 * the envelope never reach a Kitty-capable outer terminal. Resolves the
 * effective pane value (pane → window → global). Queried once per pane;
 * `false` outside tmux or when the query fails.
 */
export function tmuxPaneAllowsPassthrough(env: NodeJS.ProcessEnv = Bun.env): boolean {
	const tmux = env.TMUX;
	if (!tmux) return false;
	const key = `${tmux}\0${env.TMUX_PANE ?? ""}`;
	if (cachedPanePassthrough?.key !== key) {
		cachedPanePassthrough = { key, allowed: queryTmuxPaneAllowsPassthrough(env) };
	}
	return cachedPanePassthrough.allowed;
}

/**
 * Whether this process can ask tmux how many clients watch its pane: it runs
 * inside tmux, tmux told it which pane it owns, and a `tmux` binary is on
 * `PATH`. A caller that gets `false` must never spawn the query.
 */
export function canQueryTmuxAttachment(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (!tmuxMultiplexer.isInside(env) || !env.TMUX_PANE) return false;
	return $which("tmux", { PATH: env.PATH }) !== null;
}

/**
 * The one report every attachment answer is read from. `pane_tty` is in it so
 * the answer can be rejected when the pane it describes is not the terminal
 * this process writes to: `TMUX` and `TMUX_PANE` are inherited by anything a
 * pane launches, so a GUI terminal started from a tmux pane
 * (`alacritty -e omp &`) would otherwise take that pane's audience for its own
 * window's.
 */
const TMUX_ATTACHMENT_FORMAT = "#{session_attached}\t#{session_group_attached}\t#{pane_tty}";

/**
 * Read a {@link TMUX_ATTACHMENT_FORMAT} report. `true` when a client watches
 * the pane, `false` when none does, and `undefined` when the report does not
 * settle it — an empty or short report (a pane the server no longer has still
 * exits 0), no parseable count, or a pane whose tty is not this process's
 * (`ownsTty` decides, and a tty it cannot compare answers `false`).
 *
 * Both counts are read, because a grouped session (`tmux new-session -t`)
 * shares its windows with its siblings: a client on a sibling is watching this
 * pane, and tmux resolves a pane target to whichever of them it judges best,
 * so `session_attached` alone reports 0 for a pane someone is looking at. A
 * tmux too old for `session_group_attached` leaves that field empty, which
 * parses as absent and leaves `session_attached` to decide.
 */
export function parseTmuxAttachmentReport(report: string, ownsTty: (paneTty: string) => boolean): boolean | undefined {
	const [attached, groupAttached, paneTty] = report.split("\t");
	if (!paneTty?.trim() || !ownsTty(paneTty.trim())) return undefined;
	const counts = [attached, groupAttached]
		.map(field => Number.parseInt(field ?? "", 10))
		.filter(count => !Number.isNaN(count));
	return counts.length === 0 ? undefined : counts.some(count => count > 0);
}

/** Whether `paneTty` is the character device this process's stdout writes to. */
function stdoutIsPaneTty(paneTty: string): boolean {
	try {
		return fs.statSync(paneTty).rdev === fs.fstatSync(1).rdev;
	} catch {
		return false;
	}
}

/**
 * Same round trip as {@link CLIENT_TERMINAL_TIMEOUT_MS} and bounded the same
 * way, for the same reason: a lost race reads as "cannot tell", and here that
 * keeps the full frame rate on exactly the loaded machines the floor is worth
 * most on. The probe is async and its gap is derived from its own wall time,
 * so a slow answer costs nothing but a longer gap.
 */
const AUDIENCE_PROBE_TIMEOUT_MS = CLIENT_TERMINAL_TIMEOUT_MS;

/**
 * Whether a tmux client is attached to the session that holds this pane:
 * `true` with at least one, `false` with none, and `undefined` whenever the
 * answer cannot be established — outside tmux, without a `tmux` binary, when
 * the query fails or times out, or when the report does not settle it (see
 * {@link parseTmuxAttachmentReport}). A caller that reads `undefined` must
 * assume the pane is watched.
 *
 * Async because callers poll it from the render path: `runTmux`'s
 * `Bun.spawnSync` would stall the event loop for the whole round trip, and on
 * a saturated machine the fork/exec alone takes tens of milliseconds. The
 * child is unreferenced so a probe in flight never holds up a clean exit.
 *
 * Measured on tmux 3.8: a read-only client (`attach -r`), a control-mode
 * client and a client on a grouped sibling all count, and a window put into
 * another attached session with `link-window` resolves to that session, so it
 * counts too.
 */
export async function tmuxSessionHasAttachedClients(env: NodeJS.ProcessEnv = Bun.env): Promise<boolean | undefined> {
	const pane = env.TMUX_PANE;
	if (!pane) return undefined;
	const tmux = $which("tmux", { PATH: env.PATH });
	if (!tmux) return undefined;
	try {
		const child = Bun.spawn([tmux, "display-message", "-p", "-t", pane, TMUX_ATTACHMENT_FORMAT], {
			env,
			stdout: "pipe",
			stderr: "ignore",
			timeout: AUDIENCE_PROBE_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		child.unref();
		const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		if (child.exitCode !== 0) return undefined;
		return parseTmuxAttachmentReport(text.trimEnd(), stdoutIsPaneTty);
	} catch {
		return undefined;
	}
}
