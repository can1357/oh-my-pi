import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import {
	type Component,
	extractPrintableText,
	matchesKey,
	padding,
	parseKey,
	parseKittySequence,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type * as XtermModule from "@oh-my-pi/pi-utils/vterm";
import type { Terminal as XtermTerminalType } from "@oh-my-pi/pi-utils/vterm";
import { Settings } from "../config/settings";
import type { Theme } from "../modes/theme/theme";
import { OutputSink, type OutputSummary } from "../session/streaming-output";
import { sanitizeWithOptionalSixelPassthrough } from "../utils/sixel";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { formatStatusIcon, replaceTabs } from "./render-utils";
import { readTerminalRows, styleTerminalRow } from "./terminal-output";

export interface BashInteractiveResult extends OutputSummary {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
}

function normalizeCaptureChunk(chunk: string): string {
	const normalized = chunk.replace(/\r\n?/gu, "\n");
	return sanitizeWithOptionalSixelPassthrough(normalized, sanitizeText);
}

// Caps only the live xterm display backlog; OutputSink remains the bounded
// source of truth for the final captured output.
const MAX_LIVE_WRITE_QUEUE_CHUNKS = 512;

// The virtual terminal is only needed once an interactive PTY session actually starts,
// so it is loaded lazily (and memoized) instead of weighing down CLI startup.
let xtermTerminalCtor: typeof XtermModule.Terminal | undefined;

/** Lazily load the headless xterm Terminal shared by PTY render paths. */
export async function loadXtermTerminal(): Promise<typeof XtermModule.Terminal> {
	if (!xtermTerminalCtor) {
		const mod = (await import("@oh-my-pi/pi-utils/vterm")) as typeof XtermModule & { default?: typeof XtermModule };
		xtermTerminalCtor = (mod.default ?? mod).Terminal;
	}
	return xtermTerminalCtor;
}

function normalizeInputForPty(data: string, applicationCursorKeysMode: boolean): string {
	const kitty = parseKittySequence(data);
	if (kitty?.eventType === 3) {
		return "";
	}
	const printableText = extractPrintableText(data);
	if (printableText) {
		return printableText;
	}
	if (!kitty) {
		return data;
	}
	const keyId = parseKey(data);
	if (!keyId) {
		return data;
	}
	const normalizedKey = keyId.toLowerCase();
	if (normalizedKey === "up") return applicationCursorKeysMode ? "\x1bOA" : "\x1b[A";
	if (normalizedKey === "down") return applicationCursorKeysMode ? "\x1bOB" : "\x1b[B";
	if (normalizedKey === "right") return applicationCursorKeysMode ? "\x1bOC" : "\x1b[C";
	if (normalizedKey === "left") return applicationCursorKeysMode ? "\x1bOD" : "\x1b[D";
	if (normalizedKey === "home") return applicationCursorKeysMode ? "\x1bOH" : "\x1b[H";
	if (normalizedKey === "end") return applicationCursorKeysMode ? "\x1bOF" : "\x1b[F";
	if (normalizedKey === "pageup") return "\x1b[5~";
	if (normalizedKey === "pagedown") return "\x1b[6~";
	if (normalizedKey === "insert") return "\x1b[2~";
	if (normalizedKey === "delete") return "\x1b[3~";
	if (normalizedKey === "shift+tab") return "\x1b[Z";
	if (normalizedKey === "enter") return "\r";
	if (normalizedKey === "tab") return "\t";
	if (normalizedKey === "space") return " ";
	if (normalizedKey === "backspace") return "\x7f";
	if (normalizedKey === "escape") return "\x1b";
	const ctrlMatch = /^ctrl\+([a-z])$/u.exec(normalizedKey);
	if (ctrlMatch) {
		const letter = ctrlMatch[1]!;
		return String.fromCharCode(letter.charCodeAt(0) - 96);
	}
	const altMatch = /^alt\+([a-z])$/u.exec(normalizedKey);
	if (altMatch) {
		return `\x1b${altMatch[1]!}`;
	}
	// For any other Kitty sequence with a printable codepoint, emit the character directly
	if (kitty.codepoint >= 32 && kitty.codepoint < 127) {
		let ch = String.fromCharCode(kitty.codepoint);
		// Apply ctrl modifier if present (modifier bit 4 = ctrl)
		if (kitty.modifier & 4) {
			const code = kitty.codepoint;
			if (code >= 97 && code <= 122) {
				ch = String.fromCharCode(code - 96);
			}
		}
		// Apply alt modifier if present (modifier bit 2 = alt)
		if (kitty.modifier & 2) {
			ch = `\x1b${ch}`;
		}
		return ch;
	}
	return data;
}
class BashInteractiveOverlayComponent implements Component {
	#terminal: XtermTerminalType;
	#state: "running" | "complete" | "timed_out" | "killed" = "running";
	#exitCode: number | undefined;
	#onInput: (data: string) => void = () => {};
	#onDismiss: () => void = () => {};
	#onDispose: () => void = () => {};
	#session: PtySession | null = null;
	#lastCols = 0;
	#lastRows = 0;
	#writeQueue: string[] = [];
	#writeOffset = 0;
	#flushResolvers: Array<() => void> = [];
	#writing = false;

	constructor(
		private readonly command: string,
		private readonly uiTheme: Theme,
		private readonly getTerminalRows: () => number,
		terminalCtor: typeof XtermModule.Terminal,
	) {
		this.#terminal = new terminalCtor({
			cols: 120,
			rows: 40,
			disableStdin: true,
			allowProposedApi: true,
			scrollback: 10_000,
		});
	}

	setHandlers(onInput: (data: string) => void, onDismiss: () => void, onDispose: () => void): void {
		this.#onInput = onInput;
		this.#onDismiss = onDismiss;
		this.#onDispose = onDispose;
	}

	appendOutput(chunk: string): void {
		this.#writeQueue.push(chunk);
		this.#trimWriteQueue();
		this.#drainQueue();
	}

	#trimWriteQueue(): void {
		// Compact the consumed prefix first: the queue only self-resets on a
		// full drain, which never happens while a fast producer keeps a
		// backlog alive, so already-written chunks must be released here to
		// keep the retained array itself bounded.
		if (this.#writeOffset > 0) {
			this.#writeQueue.splice(0, this.#writeOffset);
			this.#writeOffset = 0;
		}
		const firstPending = this.#writing ? 1 : 0;
		const overflow = this.#writeQueue.length - firstPending - MAX_LIVE_WRITE_QUEUE_CHUNKS;
		if (overflow > 0) {
			this.#writeQueue.splice(firstPending, overflow);
			// Dropped chunks can split an in-flight DCS/OSC/APC string (e.g. a
			// sixel payload) across the gap; a stray string terminator is a
			// no-op in the ground state but resynchronizes the parser if the
			// terminator was dropped.
			this.#writeQueue[firstPending] = `\u001b\\${this.#writeQueue[firstPending]}`;
		}
	}

	#drainQueue(): void {
		if (this.#writing) return;
		if (this.#writeOffset >= this.#writeQueue.length) {
			this.#resolveFlushWaiters();
			return;
		}
		this.#writing = true;
		const data = this.#writeQueue[this.#writeOffset]!;
		this.#terminal.write(data, () => {
			this.#writing = false;
			this.#writeOffset += 1;
			if (this.#writeOffset >= this.#writeQueue.length) {
				this.#writeQueue = [];
				this.#writeOffset = 0;
				this.#resolveFlushWaiters();
			}
			this.#drainQueue();
		});
	}

	#resolveFlushWaiters(): void {
		if (this.#writing || this.#writeOffset < this.#writeQueue.length) return;
		if (this.#flushResolvers.length === 0) return;
		const resolvers = this.#flushResolvers;
		this.#flushResolvers = [];
		for (const resolve of resolvers) {
			resolve();
		}
	}

	flushOutput(): Promise<void> {
		if (!this.#writing && this.#writeOffset >= this.#writeQueue.length) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#flushResolvers.push(resolve);
		return promise;
	}

	setSession(session: PtySession): void {
		this.#session = session;
	}

	setComplete(result: { exitCode: number | undefined; cancelled: boolean; timedOut: boolean }): void {
		this.#exitCode = result.exitCode;
		if (result.timedOut) {
			this.#state = "timed_out";
			return;
		}
		if (result.cancelled) {
			this.#state = "killed";
			return;
		}
		this.#state = "complete";
	}

	handleInput(data: string): void {
		if (this.#state === "running" && (matchesKey(data, "escape") || matchesKey(data, "esc"))) {
			this.#onDismiss();
			return;
		}
		if (this.#state !== "running") {
			return;
		}
		const normalizedInput = normalizeInputForPty(data, this.#terminal.modes.applicationCursorKeysMode);
		if (!normalizedInput) {
			return;
		}
		this.#onInput(normalizedInput);
	}
	#stateText(): string {
		if (this.#state === "running") return this.uiTheme.fg("warning", "running");
		if (this.#state === "timed_out") return this.uiTheme.fg("warning", "timed out");
		if (this.#state === "killed") return this.uiTheme.fg("warning", "killed");
		if (this.#exitCode === 0) return this.uiTheme.fg("success", "exit 0");
		if (this.#exitCode === undefined) return this.uiTheme.fg("warning", "exited");
		return this.uiTheme.fg("error", `exit ${this.#exitCode}`);
	}

	#readViewport(innerWidth: number, maxContentRows: number): string[] {
		this.#terminal.resize(innerWidth, maxContentRows);
		const viewportY = this.#terminal.buffer.active.viewportY;
		return readTerminalRows(this.#terminal, viewportY, maxContentRows).map(line =>
			truncateToWidth(styleTerminalRow(line, this.uiTheme.getFgAnsi("toolOutput")), innerWidth),
		);
	}
	render(width: number): readonly string[] {
		const safeWidth = Math.max(20, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const maxOverlayRows = Math.max(5, Math.floor(this.getTerminalRows() * 0.8));
		const chromeRows = 4;
		const maxContentRows = Math.max(1, maxOverlayRows - chromeRows);
		// Propagate terminal resize to PTY session
		const currentCols = innerWidth;
		const currentRows = maxContentRows;
		if (this.#session && (currentCols !== this.#lastCols || currentRows !== this.#lastRows)) {
			this.#lastCols = currentCols;
			this.#lastRows = currentRows;
			try {
				this.#session.resize(currentCols, currentRows);
			} catch {
				// Session may have ended
			}
		}
		const statusIcon =
			this.#state === "running"
				? formatStatusIcon("running", this.uiTheme)
				: this.#state === "complete" && this.#exitCode === 0
					? this.uiTheme.styledSymbol("tool.bash", "accent")
					: formatStatusIcon("warning", this.uiTheme);
		const title = this.uiTheme.fg("accent", "Console");
		const statusBadge = `${this.uiTheme.fg("dim", this.uiTheme.format.bracketLeft)}${this.#stateText()}${this.uiTheme.fg("dim", this.uiTheme.format.bracketRight)}`;
		const prefix = `${statusIcon} ${title} `;
		const suffix = ` ${statusBadge}`;
		const available = Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(suffix));
		const cmd = truncateToWidth(this.uiTheme.fg("muted", replaceTabs(this.command)), available);
		const header = truncateToWidth(`${prefix}${cmd}${suffix}`, innerWidth);
		const footer =
			this.#state === "running"
				? truncateToWidth(
						`${this.uiTheme.fg("warning", "esc")} ${this.uiTheme.fg("dim", "force-kill")} ${this.uiTheme.fg("dim", "· input forwarded to PTY")}`,
						innerWidth,
					)
				: truncateToWidth(this.uiTheme.fg("dim", "session finished"), innerWidth);
		const visibleLines = this.#readViewport(innerWidth, maxContentRows);
		const content = visibleLines.length > 0 ? visibleLines : [padding(innerWidth)];
		const borderHorizontal = this.uiTheme.fg("border", this.uiTheme.boxRound.horizontal.repeat(innerWidth));
		const borderVertical = this.uiTheme.fg("border", this.uiTheme.boxRound.vertical);
		const boxLine = (line: string) =>
			`${borderVertical}${line}${padding(Math.max(0, innerWidth - visibleWidth(line)))}${borderVertical}`;
		return [
			`${this.uiTheme.fg("border", this.uiTheme.boxRound.topLeft)}${borderHorizontal}${this.uiTheme.fg("border", this.uiTheme.boxRound.topRight)}`,
			boxLine(header),
			...content.map(boxLine),
			boxLine(footer),
			`${this.uiTheme.fg("border", this.uiTheme.boxRound.bottomLeft)}${borderHorizontal}${this.uiTheme.fg("border", this.uiTheme.boxRound.bottomRight)}`,
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.#terminal.dispose();
		this.#onDispose();
	}
}

export async function runInteractiveBashPty(
	ui: NonNullable<AgentToolContext["ui"]>,
	options: {
		command: string;
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		env?: Record<string, string>;
		artifactPath?: string;
		artifactId?: string;
	},
): Promise<BashInteractiveResult> {
	const settings = await Settings.init();
	// Load the xterm Terminal ctor here (async boundary) — the ui.custom factory below is sync.
	const XtermTerminal = await loadXtermTerminal();
	const { shell: resolvedShell } = settings.getShellConfig();
	const sink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
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
				);
				component.setSession(session);
				let finished = false;
				const finalize = (run: PtyRunResult) => {
					if (finished) return;
					finished = true;
					component.setComplete({ exitCode: run.exitCode, cancelled: run.cancelled, timedOut: run.timedOut });
					tui.requestRender();
					void (async () => {
						await component.flushOutput();
						const summary = await sink.dump();
						done({
							exitCode: run.exitCode,
							cancelled: run.cancelled,
							timedOut: run.timedOut,
							...summary,
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
					.start(
						{
							command: options.command,
							cwd: options.cwd,
							timeoutMs: options.timeoutMs,
							// Interactive PTY: inherit the user's environment (the Rust side
							// applies these as overrides), with a real TERM so editors,
							// pagers, and TUIs behave like a normal terminal.
							env: {
								TERM: "xterm-256color",
								...options.env,
							},
							signal: options.signal,
							cols,
							rows,
							shell: resolvedShell,
						},
						(err, chunk) => {
							if (finished || err || !chunk) return;
							component.appendOutput(chunk);
							const normalizedChunk = normalizeCaptureChunk(chunk);
							sink.push(normalizedChunk);
							tui.requestRender();
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
