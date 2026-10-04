import type * as XtermModule from "@oh-my-pi/pi-utils/vterm";
import type { Terminal as XtermTerminalType } from "@oh-my-pi/pi-utils/vterm";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { Component } from "../tui";
import { ansi, col, row, span, text } from "../native/describe";
import { Memo } from "../native/memo";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { extractPrintableText, matchesKey, parseKey, parseKittySequence } from "../keys";
import { padding, truncateToWidth, visibleWidth } from "../utils";
import type { Theme } from "../theme/theme";
import { formatKeyHint } from "../app-keybindings";
import { formatStatusIcon, replaceTabs } from "../render/render-utils";
import { readTerminalRows, styleTerminalRow } from "./terminal-output";

/** Resize-only backend exposed by an interactive PTY controller. */
export interface BashInteractiveTerminalBackend {
	resize(columns: number, rows: number): void;
}

// The capture sink owns final output; this caps only the live display backlog.
const MAX_LIVE_WRITE_QUEUE_CHUNKS = 512;
// Cells the native full sheet's insets take from the pane width.
const NATIVE_SHEET_INSET_COLS = 8;
// Action id of the native Force kill button (mirrors Esc).
const KILL_ACTION = "kill";

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
/** Interactive terminal overlay driven by an external PTY controller. */
export class BashInteractiveOverlayComponent implements Component {
	/** Native sheet: a full-pane glass overlay titled Console. */
	readonly nativeOverlay = { role: "omp.overlay.console", size: "full", head: "Console" } as const;
	#terminal: XtermTerminalType;
	#state: "running" | "complete" | "timed_out" | "killed" = "running";
	#exitCode: number | undefined;
	#onInput: (data: string) => void = () => {};
	#onDismiss: () => void = () => {};
	#onDispose: () => void = () => {};
	readonly #backend: BashInteractiveTerminalBackend;
	readonly #command: string;
	readonly #uiTheme: Theme;
	readonly #getTerminalRows: () => number;
	#lastCols = 0;
	#lastRows = 0;
	#writeQueue: string[] = [];
	#writeOffset = 0;
	#flushResolvers: Array<() => void> = [];
	#writing = false;
	/** Bumped whenever the virtual terminal processed a chunk, so `describe` knows the screen changed. */
	#screenVersion = 0;
	readonly #native = new Memo();

	constructor(
		command: string,
		uiTheme: Theme,
		getTerminalRows: () => number,
		terminalCtor: typeof XtermModule.Terminal,
		backend: BashInteractiveTerminalBackend,
	) {
		this.#command = command;
		this.#uiTheme = uiTheme;
		this.#getTerminalRows = getTerminalRows;
		this.#backend = backend;
		this.#terminal = new terminalCtor({
			cols: 120,
			rows: 40,
			disableStdin: true,
			allowProposedApi: true,
			scrollback: 10_000,
		});
	}

	/** Connects normalized keyboard input and overlay lifecycle events to the controller. */
	setHandlers(onInput: (data: string) => void, onDismiss: () => void, onDispose: () => void): void {
		this.#onInput = onInput;
		this.#onDismiss = onDismiss;
		this.#onDispose = onDispose;
	}

	/** Queues a raw terminal output chunk for virtual-terminal rendering. */
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
			this.#screenVersion += 1;
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

	/** Resolves when the virtual terminal has processed all queued output. */
	flushOutput(): Promise<void> {
		if (!this.#writing && this.#writeOffset >= this.#writeQueue.length) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#flushResolvers.push(resolve);
		return promise;
	}

	/** Records process completion and stops forwarding keyboard input. */
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
			this.#forceKill();
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

	/** The Force kill button runs the Esc path. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === KILL_ACTION) this.#forceKill();
	}

	#forceKill(): void {
		if (this.#state === "running") this.#onDismiss();
	}

	#syncPtySize(cols: number, rows: number): void {
		if (cols === this.#lastCols && rows === this.#lastRows) return;
		this.#lastCols = cols;
		this.#lastRows = rows;
		try {
			this.#backend.resize(cols, rows);
		} catch {
			// Session may have ended
		}
	}

	#maxContentRows(): number {
		const maxOverlayRows = Math.max(5, Math.floor(this.#getTerminalRows() * 0.8));
		return Math.max(1, maxOverlayRows - 4);
	}

	#stateSpan(): TspSpan {
		if (this.#state === "running") return span("running", "warning");
		if (this.#state === "timed_out") return span("timed out", "warning");
		if (this.#state === "killed") return span("killed", "warning");
		if (this.#exitCode === 0) return span("exit 0", "success");
		if (this.#exitCode === undefined) return span("exited", "warning");
		return span(`exit ${this.#exitCode}`, "error");
	}

	/**
	 * Native view: the command with its state badge, the PTY screen as an
	 * `ansi` node (SGR kept, fixed to the PTY grid), and a footer with the
	 * Force kill action while running.
	 */
	describe(cx: DescribeContext): NativeNode {
		const cols = Math.max(20, cx.cols - NATIVE_SHEET_INSET_COLS);
		const rows = this.#maxContentRows();
		this.#syncPtySize(cols, rows);
		this.#terminal.resize(cols, rows);
		const deps = [this.#screenVersion, cols, rows, this.#state, this.#exitCode];
		return this.#native.get(deps, () => {
			const viewportY = this.#terminal.buffer.active.viewportY;
			const screen = readTerminalRows(this.#terminal, viewportY, rows).map(line => styleTerminalRow(line, ""));
			const head = row(
				[
					text([span(replaceTabs(this.#command), "muted")], { wrap: "none", truncate: "end" }),
					text([span("[", "dim"), this.#stateSpan(), span("]", "dim")]),
				],
				{ gap: "sm", align: "baseline", justify: "between" },
			);
			const footer =
				this.#state === "running"
					? actionBar([
							text([span("Input forwarded to PTY", "dim")]),
							null,
							actionButton("Force kill", KILL_ACTION, { keys: "escape", tone: "error" }),
						])
					: actionBar([text([span("Session finished", "dim")])]);
			return col([head, ansi(screen.join("\n"), { cols }), footer], { gap: "sm" });
		});
	}
	#stateText(): string {
		if (this.#state === "running") return this.#uiTheme.fg("warning", "running");
		if (this.#state === "timed_out") return this.#uiTheme.fg("warning", "timed out");
		if (this.#state === "killed") return this.#uiTheme.fg("warning", "killed");
		if (this.#exitCode === 0) return this.#uiTheme.fg("success", "exit 0");
		if (this.#exitCode === undefined) return this.#uiTheme.fg("warning", "exited");
		return this.#uiTheme.fg("error", `exit ${this.#exitCode}`);
	}

	#readViewport(innerWidth: number, maxContentRows: number): string[] {
		this.#terminal.resize(innerWidth, maxContentRows);
		const viewportY = this.#terminal.buffer.active.viewportY;
		return readTerminalRows(this.#terminal, viewportY, maxContentRows).map(line =>
			truncateToWidth(styleTerminalRow(line, this.#uiTheme.getFgAnsi("toolOutput")), innerWidth),
		);
	}
	render(width: number): readonly string[] {
		const safeWidth = Math.max(20, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const maxContentRows = this.#maxContentRows();
		this.#syncPtySize(innerWidth, maxContentRows);
		const statusIcon =
			this.#state === "running"
				? formatStatusIcon("running", this.#uiTheme)
				: this.#state === "complete" && this.#exitCode === 0
					? this.#uiTheme.styledSymbol("tool.bash", "accent")
					: formatStatusIcon("warning", this.#uiTheme);
		const title = this.#uiTheme.fg("accent", "Console");
		const statusBadge = `${this.#uiTheme.fg("dim", this.#uiTheme.format.bracketLeft)}${this.#stateText()}${this.#uiTheme.fg("dim", this.#uiTheme.format.bracketRight)}`;
		const prefix = `${statusIcon} ${title} `;
		const suffix = ` ${statusBadge}`;
		const available = Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(suffix));
		const cmd = truncateToWidth(this.#uiTheme.fg("muted", replaceTabs(this.#command)), available);
		const header = truncateToWidth(`${prefix}${cmd}${suffix}`, innerWidth);
		const footer =
			this.#state === "running"
				? truncateToWidth(
						`${this.#uiTheme.fg("warning", formatKeyHint("escape"))} ${this.#uiTheme.fg("dim", "force-kill")} ${this.#uiTheme.fg("dim", "· input forwarded to PTY")}`,
						innerWidth,
					)
				: truncateToWidth(this.#uiTheme.fg("dim", "session finished"), innerWidth);
		const visibleLines = this.#readViewport(innerWidth, maxContentRows);
		const content = visibleLines.length > 0 ? visibleLines : [padding(innerWidth)];
		const borderHorizontal = this.#uiTheme.fg("border", this.#uiTheme.boxRound.horizontal.repeat(innerWidth));
		const borderVertical = this.#uiTheme.fg("border", this.#uiTheme.boxRound.vertical);
		const boxLine = (line: string) =>
			`${borderVertical}${line}${padding(Math.max(0, innerWidth - visibleWidth(line)))}${borderVertical}`;
		return [
			`${this.#uiTheme.fg("border", this.#uiTheme.boxRound.topLeft)}${borderHorizontal}${this.#uiTheme.fg("border", this.#uiTheme.boxRound.topRight)}`,
			boxLine(header),
			...content.map(boxLine),
			boxLine(footer),
			`${this.#uiTheme.fg("border", this.#uiTheme.boxRound.bottomLeft)}${borderHorizontal}${this.#uiTheme.fg("border", this.#uiTheme.boxRound.bottomRight)}`,
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.#terminal.dispose();
		this.#onDispose();
	}
}
