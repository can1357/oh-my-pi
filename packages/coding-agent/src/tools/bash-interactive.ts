import { BashInteractiveOverlayComponent } from "@oh-my-pi/pi-tui/tools/bash-interactive";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { loadXtermTerminal } from "@oh-my-pi/pi-tui/tools/terminal-output";
import { Settings } from "../config/settings";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import { OutputSink, type OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { StreamNewlineNormalizer } from "../utils/stream-newlines";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";
import { resolveOutputMaxColumns, resolveOutputSinkArtifactMaxBytes, resolveOutputSinkHeadBytes } from "./output-meta";

export interface BashInteractiveResult extends OutputSummary {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
	/** Terminal graphics extracted from raw PTY output before transcript sanitization. */
	images?: ImageContent[];
}

/**
 * The environment of a command with a user at its terminal, from the session
 * shell's exports. Those carry the guards unattended commands run under
 * (pagers and editors off, `CI`, `NO_COLOR`, a dumb `TERM`, a pinned locale):
 * each one still at its guard value is left out, which hands the command the
 * value omp itself was launched with, and a `TERM` left out that way names the
 * terminal the command gets. A value the session set itself stays.
 */
function terminalEnv(exports: Record<string, string>): Record<string, string> {
	const env = { ...exports };
	const guards = buildNonInteractiveEnv();
	for (const name in guards) {
		if (env[name] === guards[name]) delete env[name];
	}
	// procmgr's spawn env marks the session's stdin as no terminal.
	if (env.GPG_TTY === "not a tty") delete env.GPG_TTY;
	env.TERM ??= "xterm-256color";
	return env;
}

/**
 * Run `application` with `args` on a pseudo-terminal the user drives through
 * an overlay; `command` is what the overlay shows it as.
 */
export async function runInteractiveBashPty(
	ui: Pick<NonNullable<AgentToolContext["ui"]>, "custom">,
	options: {
		command: string;
		application: string;
		args: string[];
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		/** The session shell's exports the program starts from. */
		env: Record<string, string>;
		artifactPath?: string;
		artifactId?: string;
		/** Called with the program's pid once the terminal spawned it. */
		onStart?: (pid: number) => void;
	},
): Promise<BashInteractiveResult> {
	const settings = await Settings.init();
	// Load the xterm Terminal ctor here (async boundary) — the ui.custom factory below is sync.
	const XtermTerminal = await loadXtermTerminal();
	const graphics = new TerminalGraphicsDecoder();
	const newlines = new StreamNewlineNormalizer();
	const sink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});
	try {
		const result = await ui.custom<BashInteractiveResult>(
			(tui, uiTheme, _keybindings, done) => {
				const session = new PtySession();
				const component = new BashInteractiveOverlayComponent(
					options.command,
					uiTheme,
					() => tui.terminal.rows,
					XtermTerminal,
					{ resize: (columns, rows) => session.resize(columns, rows) },
				);
				let finished = false;
				const finalize = (run: PtyRunResult) => {
					if (finished) return;
					finished = true;
					component.setComplete({ exitCode: run.exitCode, cancelled: run.cancelled, timedOut: run.timedOut });
					tui.requestRender();
					void (async () => {
						await component.flushOutput();
						const tail = graphics.finish();
						if (tail) sink.push(tail);
						const [summary, images] = await Promise.all([sink.dump(), graphics.images()]);
						done({
							exitCode: run.exitCode,
							cancelled: run.cancelled,
							timedOut: run.timedOut,
							...summary,
							...(images.length > 0 ? { images } : {}),
						});
					})();
				};
				const cols = Math.max(20, tui.terminal.columns - 2);
				const rows = Math.max(5, tui.terminal.rows - 4);
				component.setHandlers(
					data => {
						try {
							session.write(data);
						} catch {
							// ignore writes after command exits
						}
					},
					() => {
						try {
							session.kill();
						} catch {
							// ignore
						}
					},
					() => {
						try {
							session.kill();
						} catch {
							// ignore
						}
					},
				);
				void session
					.startArgv(
						{
							application: options.application,
							args: options.args,
							cwd: options.cwd,
							timeoutMs: options.timeoutMs,
							env: terminalEnv(options.env),
							signal: options.signal,
							cols,
							rows,
						},
						(err, chunk) => {
							if (finished || err || !chunk) return;
							component.appendOutput(chunk);
							const clean = graphics.push(chunk);
							if (clean) sink.push(newlines.push(clean));
							tui.requestRender();
						},
						(err, pid) => {
							if (!err) options.onStart?.(pid);
						},
					)
					.then(finalize)
					.catch(error => {
						sink.push(`PTY error: ${error instanceof Error ? error.message : String(error)}\n`);
						finalize({ exitCode: undefined, cancelled: false, timedOut: false });
					});
				return component;
			},
			{ overlay: true },
		);
		return result;
	} finally {
		await sink.dispose();
	}
}
