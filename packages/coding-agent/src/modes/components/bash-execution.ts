/**
 * Component for displaying bash command execution with streaming output.
 */

import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	Container,
	Ellipsis,
	getImageDimensions,
	Image,
	imageFallback,
	ImageProtocol,
	type Loader,
	TERMINAL,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Terminal as XtermTerminalType } from "@oh-my-pi/pi-utils/vterm";
import { theme } from "../../modes/theme/theme";
import { loadXtermTerminal } from "../../tools/bash-interactive";
import type { TruncationMeta } from "../../tools/output-meta";
import { resolveImageOptions } from "../../tools/render-utils";
import { readTerminalRows, styleTerminalRow } from "../../tools/terminal-output";
import { getSixelLineMask, isSixelPassthroughEnabled, sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import {
	buildExecutionFrame,
	buildStatusFooter,
	createCollapsedPreview,
	type ExecutionStatus,
	resolveExecutionStatus,
} from "./execution-shared";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;
const STREAMING_LINE_CAP = PREVIEW_LINES * 5;
const MAX_DISPLAY_LINE_CHARS = 4000;
// Minimum interval between processing incoming chunks for display (ms).
// Chunks arriving faster than this are accumulated and processed in one batch.
const CHUNK_THROTTLE_MS = 50;
// Scrollback retained by the PTY replay terminal; bounds memory and the
// expanded view for long-running commands.
const PTY_SCROLLBACK_ROWS = 4096;
// Caps the unwritten PTY chunk backlog while xterm.write drains.
const MAX_PTY_QUEUE_CHUNKS = 512;
let nextBashExecutionId = 0;

/** PTY size for `!` commands: the execution frame's inner content area. */
export function bashPtyViewport(ui: TUI): { cols: number; rows: number } {
	return {
		cols: Math.max(20, (ui.terminal?.columns ?? 80) - 2),
		rows: Math.max(5, (ui.terminal?.rows ?? 24) - 4),
	};
}

export class BashExecutionComponent extends Container {
	#outputLines: string[] = [];
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	// Post-finalize mutation counter (FinalizableBlock.getTranscriptBlockVersion):
	// a completed command's block still mutates on expansion toggles, and the
	// transcript's width-epoch resolution and committed-render bypass must
	// observe that.
	#blockVersion = 0;
	#displayDirty = false;
	#chunkGate = false;
	#contentContainer: Container;
	#headerText: Text;
	#ui: TUI;
	// PTY replay state: raw terminal bytes stream into a headless xterm and the
	// display lines are re-read from its screen+scrollback (same pipeline as
	// `launch` logs), so color survives and CR/cursor movement render correctly.
	#ptyMode = false;
	#ptyTerminal?: XtermTerminalType;
	#ptyLoadStarted = false;
	#ptyQueue: string[] = [];
	#ptyWriting = false;
	#ptyRefreshQueued = false;
	#images: readonly ImageContent[] = [];
	#showImages = true;
	readonly #instanceId = nextBashExecutionId++;

	constructor(
		private readonly command: string,
		ui: TUI,
		excludeFromContext = false,
	) {
		super();
		this.#ui = ui;

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		// Command header
		this.#headerText = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
		this.#contentContainer.addChild(this.#headerText);
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed
	 * streaming preview rewrites its tail window every chunk, so the block must
	 * stay out of native scrollback until the command completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#displayDirty = false;
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		if (this.#ptyMode) return;
		// During high-throughput output (e.g. seq 1 500M), processing every
		// chunk would saturate the event loop. Instead, accept one chunk per
		// throttle window and drop the rest — the OutputSink captures everything
		// for the artifact, and setComplete() replaces with the final output.
		if (this.#chunkGate) return;
		this.#chunkGate = true;
		setTimeout(() => {
			this.#chunkGate = false;
		}, CHUNK_THROTTLE_MS);

		const incomingLines = chunk.split("\n");
		if (this.#outputLines.length > 0 && incomingLines.length > 0) {
			const lastIndex = this.#outputLines.length - 1;
			const mergedLines = [`${this.#outputLines[lastIndex]}${incomingLines[0]}`, ...incomingLines.slice(1)];
			const clampedMergedLines = this.#clampLinesPreservingSixel(mergedLines);
			this.#outputLines[lastIndex] = clampedMergedLines[0] ?? "";
			this.#outputLines.push(...clampedMergedLines.slice(1));
		} else {
			this.#outputLines.push(...this.#clampLinesPreservingSixel(incomingLines));
		}

		// Cap stored lines during streaming to avoid unbounded memory growth
		if (this.#outputLines.length > STREAMING_LINE_CAP) {
			this.#outputLines = this.#outputLines.slice(-STREAMING_LINE_CAP);
		}

		this.#displayDirty = true;
	}

	/** Switch to PTY rendering and feed raw terminal bytes through the vterm replay. */
	appendPtyChunk(chunk: string): void {
		if (this.#status !== "running" && !this.#ptyWriting && this.#ptyQueue.length === 0) return;
		this.#ptyMode = true;
		this.#ptyQueue.push(chunk);
		if (this.#ptyQueue.length > MAX_PTY_QUEUE_CHUNKS) {
			const firstPending = this.#ptyWriting ? 1 : 0;
			this.#ptyQueue.splice(firstPending, this.#ptyQueue.length - firstPending - MAX_PTY_QUEUE_CHUNKS);
			// A dropped chunk can split an in-flight DCS/OSC string; a stray string
			// terminator is a no-op in the ground state but resynchronizes the parser.
			this.#ptyQueue[firstPending] = `\u001b\\${this.#ptyQueue[firstPending]}`;
		}
		if (!this.#ptyLoadStarted) {
			this.#ptyLoadStarted = true;
			void loadXtermTerminal().then(Terminal => {
				const { cols, rows } = bashPtyViewport(this.#ui);
				this.#ptyTerminal = new Terminal({
					cols,
					rows,
					disableStdin: true,
					allowProposedApi: true,
					scrollback: PTY_SCROLLBACK_ROWS,
				});
				this.#drainPtyQueue();
			});
		}
		this.#drainPtyQueue();
	}

	#drainPtyQueue(): void {
		const terminal = this.#ptyTerminal;
		if (!terminal || this.#ptyWriting) return;
		const chunk = this.#ptyQueue.shift();
		if (chunk === undefined) {
			if (this.#status !== "running") this.#finalizePtyOutput();
			return;
		}
		this.#ptyWriting = true;
		terminal.write(chunk, () => {
			this.#ptyWriting = false;
			this.#schedulePtyRefresh();
			this.#drainPtyQueue();
		});
	}

	#schedulePtyRefresh(): void {
		if (this.#chunkGate) {
			this.#ptyRefreshQueued = true;
			return;
		}
		this.#chunkGate = true;
		this.#refreshPtyLines(false);
		setTimeout(() => {
			this.#chunkGate = false;
			if (this.#ptyRefreshQueued) {
				this.#ptyRefreshQueued = false;
				this.#schedulePtyRefresh();
			}
		}, CHUNK_THROTTLE_MS);
	}

	/** Re-read display lines from the replay terminal (tail window while streaming). */
	#refreshPtyLines(full: boolean): void {
		const terminal = this.#ptyTerminal;
		if (!terminal) return;
		const buffer = terminal.buffer.active;
		const startRow = full ? 0 : Math.max(0, buffer.length - STREAMING_LINE_CAP);
		const rows = readTerminalRows(terminal, startRow, buffer.length - startRow);
		while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
		const base = theme.getFgAnsi("muted");
		this.#outputLines = rows.map(row => (row ? styleTerminalRow(row, base) : ""));
		this.#displayDirty = true;
	}

	/** Final full-scrollback read; the terminal is disposed once lines are snapshotted. */
	#finalizePtyOutput(): void {
		const terminal = this.#ptyTerminal;
		if (!terminal) return;
		this.#refreshPtyLines(true);
		this.#ptyTerminal = undefined;
		terminal.dispose();
		this.#blockVersion++;
		this.#updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: {
			output?: string;
			truncation?: TruncationMeta;
			images?: readonly ImageContent[];
			showImages?: boolean;
		},
	): void {
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#truncation = options?.truncation;
		this.#images = options?.images ?? [];
		this.#showImages = options?.showImages ?? true;
		if (options?.output !== undefined && !this.#ptyMode) {
			this.#setOutput(options.output);
		}

		// Stop loader
		this.#loader.stop();
		// PTY lines still queued keep draining; the empty-queue drain finalizes.
		if (this.#ptyMode && !this.#ptyWriting && this.#ptyQueue.length === 0) {
			this.#finalizePtyOutput();
		}

		this.#updateDisplay();
	}

	override render(width: number): readonly string[] {
		if (this.#displayDirty) {
			this.#displayDirty = false;
			this.#updateDisplay();
		}
		return super.render(width);
	}

	#updateDisplay(): void {
		const availableLines = this.#outputLines;

		// Full output is shown when expanded or when sixel passthrough renders
		// the raw payload; the collapsed preview shows only the tail window.
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const sixelLineMask =
			TERMINAL.imageProtocol === ImageProtocol.Sixel && isSixelPassthroughEnabled()
				? getSixelLineMask(availableLines)
				: undefined;
		const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
		const showingAllLines = this.#expanded || hasSixelOutput;
		// Only the collapsed preview hides lines; when the full output is shown
		// the footer must not keep advertising hidden lines / ctrl+o.
		const hiddenLineCount = showingAllLines ? 0 : availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.#contentContainer.clear();

		// Command header
		this.#contentContainer.addChild(this.#headerText);

		// Output
		if (availableLines.length > 0) {
			if (showingAllLines) {
				const displayText = availableLines
					.map((line, index) => (sixelLineMask?.[index] ? line : this.#styleDisplayLine(line)))
					.join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				// Use shared visual truncation utility, recomputed per render width
				const styledOutput = previewLogicalLines.map(line => this.#styleDisplayLine(line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, PREVIEW_LINES));
			}
		}

		for (let index = 0; index < this.#images.length; index++) {
			const image = this.#images[index]!;
			if (TERMINAL.imageProtocol && this.#showImages) {
				this.#contentContainer.addChild(
					new Image(
						image.data,
						image.mimeType,
						{ fallbackColor: text => theme.fg("muted", text) },
						{
							...resolveImageOptions(),
							budget: this.#ui.imageBudget,
							imageKey: `be${this.#instanceId}:${index}`,
						},
					),
				);
			} else {
				const dimensions = getImageDimensions(image.data, image.mimeType) ?? undefined;
				this.#contentContainer.addChild(
					new Text(theme.fg("muted", imageFallback(image.mimeType, dimensions)), 1, 0),
				);
			}
		}

		// Loader or status
		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				hiddenLineCount,
				suppressHiddenCount: hasSixelOutput,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	/** PTY replay rows arrive pre-styled (safe SGR + reset); plain lines get muted. */
	#styleDisplayLine(line: string): string {
		return this.#ptyMode ? line : theme.fg("muted", line);
	}

	#clampDisplayLine(line: string): string {
		const visible = visibleWidth(line);
		if (visible <= MAX_DISPLAY_LINE_CHARS) {
			return line;
		}
		const omitted = visible - MAX_DISPLAY_LINE_CHARS;
		return `${truncateToWidth(line, MAX_DISPLAY_LINE_CHARS, Ellipsis.Omit)}… [${omitted} visible columns omitted]`;
	}

	#clampLinesPreservingSixel(lines: string[]): string[] {
		if (lines.length === 0) return [];
		const sixelLineMask = getSixelLineMask(lines);
		if (!sixelLineMask.some(Boolean)) {
			return lines.map(line => this.#clampDisplayLine(line));
		}
		return lines.map((line, index) => (sixelLineMask[index] ? line : this.#clampDisplayLine(line)));
	}

	#setOutput(output: string): void {
		const clean = sanitizeWithOptionalSixelPassthrough(output, sanitizeText);
		this.#outputLines = clean ? this.#clampLinesPreservingSixel(clean.split("\n")) : [];
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
