import { BashInteractiveOverlayComponent } from "@oh-my-pi/pi-tui/tools/bash-interactive";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type PtyArgvStartOptions, type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { loadXtermTerminal } from "@oh-my-pi/pi-tui/tools/terminal-output";
import { Settings } from "../config/settings";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import { cfgPtyNotify } from "../modes/settings";
import { type ArtifactAllocator, OutputSink, type OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { containedProcessEnv } from "../sandbox/env";
import { SandboxRuntime } from "../sandbox/runtime";
import { SandboxedPtySession } from "../sandbox/shell-client";
import type { SandboxResultMeta } from "../sandbox/types";
import { StreamNewlineNormalizer } from "../utils/stream-newlines";
import { holdBlockedStatus } from "../utils/run-status";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";
import { appendImageLinks } from "../utils/image-temp";
import { resolveOutputMaxColumns, resolveOutputSinkArtifactMaxBytes, resolveOutputSinkHeadBytes } from "./output-meta";

export interface BashInteractiveResult extends OutputSummary {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
	/** Terminal graphics extracted from raw PTY output before transcript sanitization. */
	images?: ImageContent[];
	/** Set when the command ran inside the OS sandbox. */
	sandbox?: SandboxResultMeta;
}

/** The `PtySession` surface this runner drives: native, or relayed from a sandbox host. */
interface InteractivePty {
	startArgv(
		options: PtyArgvStartOptions,
		onChunk?: (error: Error | null, chunk: string) => void,
		onStart?: (error: Error | null, pid: number) => void,
	): Promise<PtyRunResult>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	/** Whether the program waits on terminal input; `null` when that cannot be inspected. */
	awaitsInput(): boolean | null;
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

/** How often a running console is checked for a program waiting on keys. */
const INPUT_POLL_MS = 250;
/** Checks in a row a program must wait before it counts: a TUI turns echo off briefly to query the terminal. */
const INPUT_WAIT_POLLS = 2;
/**
 * Where the OS cannot tell an echoing line prompt from a busy program (macOS),
 * output silent this long with the cursor after text counts as a prompt.
 */
const PROMPT_QUIET_MS = 2000;
/** Keys sent this recently mean the user is at the console: a new wait sends no notification. */
const USER_PRESENT_MS = 10_000;

/**
 * Watches whether a console's program waits on the user's keys. While it does,
 * the run shows as blocked on the user (title `!`, OSC 7501 `blocked`); each new
 * wait also sends a terminal notification unless `pty.notify` is off or the user
 * typed into the console within {@link USER_PRESENT_MS}.
 */
class InputWaitWatch {
	readonly #command: string;
	readonly #settings: Settings;
	readonly #session: InteractivePty;
	readonly #screen: BashInteractiveOverlayComponent;
	readonly #timer: NodeJS.Timeout;
	#lastOutput = Date.now();
	#lastInput = 0;
	#streak = 0;
	#release: (() => void) | undefined;

	constructor(command: string, settings: Settings, session: InteractivePty, screen: BashInteractiveOverlayComponent) {
		this.#command = command;
		this.#settings = settings;
		this.#session = session;
		this.#screen = screen;
		this.#timer = setInterval(() => this.#poll(), INPUT_POLL_MS);
	}

	/** Records program output, which restarts the silence the prompt fallback waits for. */
	output(): void {
		this.#lastOutput = Date.now();
	}

	/** Records keys the user sent to the program. */
	input(): void {
		this.#lastInput = Date.now();
	}

	/** Stops watching and drops the blocked status. */
	stop(): void {
		clearInterval(this.#timer);
		this.#unblock();
	}

	#waits(): boolean {
		const known = this.#session.awaitsInput();
		if (known !== null) return known;
		return Date.now() - this.#lastOutput >= PROMPT_QUIET_MS && this.#screen.cursorAfterText();
	}

	#poll(): void {
		if (!this.#waits()) {
			this.#streak = 0;
			this.#unblock();
			return;
		}
		this.#streak += 1;
		if (this.#release || this.#streak < INPUT_WAIT_POLLS) return;
		this.#release = holdBlockedStatus({ state: "blocked", kind: "question", msg: `Console: ${this.#command}` });
		if (Date.now() - this.#lastInput < USER_PRESENT_MS) return;
		if (cfgPtyNotify.get(this.#settings) === "off") return;
		TERMINAL.sendNotification({
			title: "omp",
			body: "Console waiting for input",
			type: "console",
			urgency: "normal",
			actions: "focus",
		});
	}

	#unblock(): void {
		this.#release?.();
		this.#release = undefined;
	}
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
		allocateArtifact?: ArtifactAllocator;
		/** Called with the program's pid once the terminal spawned it. */
		onStart?: (pid: number) => void;
		/** The agent session's workspace; the command runs in the OS sandbox when it applies there. */
		sandboxWorkspace?: string;
		/** Host directories a contained run may also write (the session's `local://` root). */
		sandboxExtraWrite?: readonly string[];
	},
): Promise<BashInteractiveResult> {
	const settings = await Settings.init();
	// Throws when the sandbox is required but unavailable: never a silent uncontained PTY.
	const workspace = options.sandboxWorkspace;
	const sandbox = workspace === undefined ? undefined : await SandboxRuntime.forScope(workspace, "bash");
	// Load the xterm Terminal ctor here (async boundary) — the ui.custom factory below is sync.
	const XtermTerminal = await loadXtermTerminal();
	const graphics = new TerminalGraphicsDecoder();
	const newlines = new StreamNewlineNormalizer();
	const sink = new OutputSink({
		allocateArtifact: options.allocateArtifact,
		headBytes: resolveOutputSinkHeadBytes(settings),
		artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});
	let watch: InputWaitWatch | undefined;
	try {
		const result = await ui.custom<BashInteractiveResult>(
			(tui, uiTheme, _keybindings, done) => {
				const session: InteractivePty = sandbox
					? new SandboxedPtySession(sandbox, { cwd: workspace!, extraWrite: options.sandboxExtraWrite })
					: new PtySession();
				const blockedSince = Date.now();
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
					watch?.stop();
					component.setComplete({ exitCode: run.exitCode, cancelled: run.cancelled, timedOut: run.timedOut });
					tui.requestRender();
					void (async () => {
						await component.flushOutput();
						const tail = graphics.finish();
						if (tail) sink.push(tail);
						const [summary, images] = await Promise.all([sink.dump(), graphics.images()]);
						const output = await appendImageLinks(summary.output, images);
						done({
							exitCode: run.exitCode,
							cancelled: run.cancelled,
							timedOut: run.timedOut,
							...summary,
							output,
							...(images.length > 0 ? { images } : {}),
							sandbox: sandbox?.resultMeta({
								blockedSince,
								output: run.exitCode !== 0 ? summary.output : undefined,
								exitCode: run.exitCode,
							}),
						});
					})();
				};
				const cols = Math.max(20, tui.terminal.columns - 2);
				const rows = Math.max(5, tui.terminal.rows - 4);
				const inputWatch = new InputWaitWatch(options.command, settings, session, component);
				watch = inputWatch;
				component.setHandlers(
					data => {
						inputWatch.input();
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
							// Contained: the container's temp dir and (allowlist) proxy apply over the terminal env.
							env: sandbox ? containedProcessEnv(sandbox, terminalEnv(options.env)) : terminalEnv(options.env),
							signal: options.signal,
							cols,
							rows,
						},
						(err, chunk) => {
							if (finished || err || !chunk) return;
							inputWatch.output();
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
		watch?.stop();
		await sink.dispose();
	}
}
