/**
 * Component for displaying bash command execution with streaming output.
 */

import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Image } from "../components/image";
import type { Loader } from "../components/loader";
import { Text } from "../components/text";
import { getImageDimensions, imageFallback, ImageProtocol, TERMINAL } from "../terminal-capabilities";
import { Container, type TUI } from "../tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { BufferLine, BufferView, Terminal as XtermTerminalType } from "@oh-my-pi/pi-utils/vterm";
import { theme } from "../theme/theme";
import type { OutputArtifactError } from "../tools/streaming-output";
import type { TruncationMeta } from "../tools/output-meta";
import { resolveImageOptions } from "../render/render-utils";
import { OutputPane } from "../render/output-pane";
import {
	activeStyleAtRowEnd,
	loadXtermTerminal,
	readTerminalRows,
	splitTerminalRowAt,
	styleTerminalRow,
} from "../tools/terminal-output";
import {
	createRawSixelExtractor,
	getSixelLineMask,
	isSixelPassthroughEnabled,
	sanitizeWithOptionalSixelPassthrough,
	type RawSixelExtractor,
} from "../render/sixel";
import {
	buildExecutionFrame,
	buildStatusFooter,
	clampDisplayLine,
	describeExecutionCard,
	describeExecutionTool,
	type ExecutionColorKey,
	type ExecutionStatus,
	PREVIEW_LINES,
	resolveExecutionStatus,
} from "./execution-shared";
import { span, text } from "../native/describe";
import { type DescribeContext, type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { NativeImageCache } from "../native/blobs";
import { imageLinksEnabled, linkedImageSpan, linkedImageText } from "../prompt/image-references";
import { Memo } from "../native/memo";

const STREAMING_LINE_CAP = PREVIEW_LINES * 5;
// Minimum interval between processing incoming chunks for display (ms).
// Chunks arriving faster than this are accumulated and processed in one batch.
const CHUNK_THROTTLE_MS = 50;
// Scrollback retained by the PTY replay terminal; bounds memory and the
// expanded view for long-running commands.
const PTY_SCROLLBACK_ROWS = 4096;
// Caps the unwritten PTY chunk backlog while xterm.write drains.
const MAX_PTY_QUEUE_CHUNKS = 512;
// Sixel payloads are retained for the final full replay read; this bounds the
// retained set so a long PTY stream cannot grow it without limit.
const MAX_PTY_SIXEL_SPANS = 256;

/** One queued PTY replay unit: raw bytes, or a sixel payload held out of the vterm. */
type PtyQueueUnit =
	| { kind: "text"; text: string }
	| { kind: "sixel"; payload: string; line?: BufferLine; column?: number };

/**
 * A sixel payload retained with the buffer line it was emitted on. The line is
 * the anchor, not its index: once the scrollback is full every added row is
 * spliced off the front while `buffer.length` stays at its cap, so an index
 * recorded earlier addresses a newer row and the payload would reappear
 * somewhere it was never emitted. `offset` is the position the frame landed on
 * inside that row, so a frame emitted between two text runs can be spliced
 * back between them instead of after the row's completed text.
 */
interface PtySixelSpan {
	line: BufferLine;
	payload: string;
	offset: number;
}
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
	#artifactError?: OutputArtifactError;
	#expanded = false;
	// Post-finalize mutation counter (FinalizableBlock.getTranscriptBlockVersion):
	// a completed command's block still mutates on expansion toggles, and the
	// transcript's width-epoch resolution and committed-render bypass must
	// observe that.
	#blockVersion = 0;
	#displayDirty = false;
	#chunkGate = false;
	#contentContainer: Container;
	#outputPane: OutputPane;
	#headerText: Text;
	#ui: TUI;
	// PTY replay state: raw terminal bytes stream into a headless xterm and the
	// display lines are re-read from its screen+scrollback (same pipeline as
	// `launch` logs), so color survives and CR/cursor movement render correctly.
	#ptyMode = false;
	#ptyTerminal?: XtermTerminalType;
	#ptyLoadStarted = false;
	#ptyQueue: PtyQueueUnit[] = [];
	#ptyWriting = false;
	#ptyRefreshQueued = false;
	#ptyReplayFinalized = false;
	// Sixel passthrough: payloads are pulled out of the raw byte stream (the
	// vterm swallows DCS strings) and stitched back onto their replay rows.
	#ptySixelExtractor?: RawSixelExtractor;
	#ptySixelSpans: PtySixelSpan[] = [];
	#images: readonly ImageContent[] = [];
	#showImages = true;
	readonly #instanceId = nextBashExecutionId++;
	readonly #command: string;
	readonly #colorKey: ExecutionColorKey;
	readonly #startedAt = performance.now();
	#endedAt: number | undefined;
	// Bumped whenever the displayed output lines change.
	#outputVersion = 0;
	readonly #native = new Memo();
	readonly #nativeImages = new NativeImageCache();

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		super();
		this.#command = command;
		this.#ui = ui;

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		this.#colorKey = colorKey;
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;
		this.#outputPane = new OutputPane(theme, {
			expanded: false,
			collapsedMaxLines: PREVIEW_LINES,
			edge: "tail",
			visual: true,
			paddingX: 1,
			leadingBlank: true,
			showHiddenMarker: false,
			showExpandHint: false,
			styleLine: line => this.#styleDisplayLine(line),
		});

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
		return this.#status !== "running" && (!this.#ptyMode || this.#ptyReplayFinalized);
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
		this.#outputPane.setExpanded(expanded);
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#displayDirty = false;
		this.#updateDisplay();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.setExpanded(expanded);
	}

	/**
	 * The agent's bash `tool` frame (role `omp.bash`) with a `you` badge: the
	 * command in the head, the output as an `ansi` mini terminal following its
	 * tail. Terminals without the `tool` kind get a `card` headed by the
	 * command.
	 */
	override describe(cx?: DescribeContext): NativeNode {
		const dataFirst = cx?.supports("tool") === true;
		const key = [
			dataFirst,
			this.#outputVersion,
			this.#blockVersion,
			this.#status,
			this.#expanded,
			this.#showImages,
			this.#images.length,
			// Image nodes and placeholders carry links only under an enabled policy.
			imageLinksEnabled(),
		];
		return this.#native.get(key, () => {
			const images = this.#images.map((image, index) =>
				this.#showImages
					? this.#nativeImages.get(`img${index}`, image.data, image.mimeType)
					: text([
							linkedImageSpan(
								imageFallback(image.mimeType, getImageDimensions(image.data, image.mimeType) ?? undefined),
								image,
								undefined,
								"muted",
							),
						]),
			);
			const common = {
				role: "omp.bash",
				status: this.#status,
				startedAt: this.#startedAt,
				expanded: this.#expanded,
				output: this.#outputLines.join("\n"),
				images,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				artifactError: this.#artifactError,
			};
			return dataFirst
				? describeExecutionTool({
						...common,
						name: "bash",
						title: "Bash",
						command: this.#command,
						lang: "bash",
						excluded: this.#colorKey === "dim",
						endedAt: this.#endedAt,
					})
				: describeExecutionCard({
						...common,
						head: [span(`$ ${this.#command}`, `${this.#colorKey} strong`)],
						muted: this.#colorKey === "dim",
					});
		});
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
		this.#outputVersion++;
	}

	/** Switch to PTY rendering and feed raw terminal bytes through the vterm replay. */
	appendPtyChunk(chunk: string): void {
		if (this.#status !== "running" && !this.#ptyWriting && this.#ptyQueue.length === 0) return;
		this.#ptyMode = true;
		this.#ptyReplayFinalized = false;
		if (isSixelPassthroughEnabled()) {
			// Sixel never enters the vterm: it swallows DCS strings, so the payload
			// would vanish from the replay rows. It is extracted here and stitched
			// back onto the row it was emitted on in #refreshPtyLines.
			const extractSixel = (this.#ptySixelExtractor ??= createRawSixelExtractor());
			for (const segment of extractSixel(chunk)) {
				this.#ptyQueue.push(
					segment.kind === "sixel"
						? { kind: "sixel", payload: segment.payload }
						: { kind: "text", text: segment.text },
				);
			}
		} else {
			this.#ptyQueue.push({ kind: "text", text: chunk });
		}
		if (this.#ptyQueue.length > MAX_PTY_QUEUE_CHUNKS) {
			const firstPending = this.#ptyWriting ? 1 : 0;
			this.#ptyQueue.splice(firstPending, this.#ptyQueue.length - firstPending - MAX_PTY_QUEUE_CHUNKS);
			// A dropped chunk can split an in-flight DCS/OSC string; a stray string
			// terminator is a no-op in the ground state but resynchronizes the parser.
			const next = this.#ptyQueue[firstPending];
			if (next?.kind === "text") next.text = `\u001b\\${next.text}`;
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
		const buffer = terminal.buffer.active;
		const unit = this.#ptyQueue.shift();
		if (unit === undefined) {
			if (this.#status !== "running") this.#finalizePtyOutput();
			return;
		}
		if (unit.kind === "sixel") {
			// The line is anchored by the preceding text write; a leading payload
			// (nothing written yet) belongs to the cursor's row.
			this.#anchorPtySixelPayload(unit.payload, unit.line, unit.column ?? buffer.cursorX);
			// No write follows the payload, so the pending refresh (queued by the
			// preceding text write) already ran without it.
			this.#schedulePtyRefresh();
			this.#drainPtyQueue();
			return;
		}
		this.#ptyWriting = true;
		terminal.write(unit.text, () => {
			this.#ptyWriting = false;
			// A payload queued behind this text belongs to the row the cursor
			// now sits on: the vterm consumed the sequence without moving it.
			const next = this.#ptyQueue[0];
			if (next?.kind === "sixel" && next.line === undefined) {
				next.line = buffer.getLine(buffer.baseY + buffer.cursorY);
				// The payload is held out of the vterm, so the cursor still sits
				// exactly where the frame landed: the row it belongs to and the
				// column inside that row.
				next.column = buffer.cursorX;
			}
			this.#schedulePtyRefresh();
			this.#drainPtyQueue();
		});
	}

	/** Retains a payload with the buffer line it was emitted on. */
	#anchorPtySixelPayload(payload: string, line: BufferLine | undefined, column: number): void {
		const buffer = this.#ptyTerminal?.buffer.active;
		if (!buffer) return;
		const anchored = line ?? buffer.getLine(buffer.baseY + buffer.cursorY) ?? buffer.getLine(buffer.length - 1);
		if (anchored === undefined) return;
		// A payload never moves the cursor, so the column it was queued at is
		// where the frame landed. `readTerminalRows` renders each row per cell, so
		// the column is resolved into the plain characters that precede it: that is
		// the offset the row's text is styled from and the position the payload
		// has to be spliced back into.
		this.#ptySixelSpans.push({
			line: anchored,
			payload,
			offset: anchored.translateToString(false, 0, column).length,
		});
		if (this.#ptySixelSpans.length > MAX_PTY_SIXEL_SPANS) this.#ptySixelSpans.shift();
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
		const spansByRow = this.#collectPtySixelSpans(startRow, buffer);
		const lastPayloadRow = spansByRow.size > 0 ? Math.max(...spansByRow.keys()) : -1;
		// Trailing blank rows are trimmed, but never past a row carrying a
		// payload — an image is frequently the last thing a command emits.
		let end = rows.length;
		while (end > lastPayloadRow + 1 && end > 0 && rows[end - 1] === "") end--;
		end = Math.max(end, lastPayloadRow + 1);
		const base = theme.getFgAnsi("muted");
		this.#outputLines = Array.from({ length: end }, (_, index) => {
			const row = index < rows.length ? rows[index]! : "";
			const spans = spansByRow.get(index);
			if (spans === undefined || spans.length === 0) return row ? styleTerminalRow(row, base) : "";
			// The payloads are spliced back in at the positions they landed on, so
			// a frame emitted between two text runs stays between them and the row
			// is what the PTY produced. Payload rows are emitted raw: the DCS bytes
			// must survive the sanitize/styling pass so the terminal can rasterize
			// the image.
			let emitted = "";
			let remaining = row;
			let consumed = 0;
			// The style active where a payload split the row carries into what
			// follows it: a frame does not reset SGR, so text emitted after it
			// was still styled. The carry rides ahead of each segment's base
			// color, and the segment's own runs still override it.
			let carry = "";
			for (const span of spans) {
				const [head, tail] = splitTerminalRowAt(remaining, span.offset - consumed);
				emitted += `${styleTerminalRow(carry + head, base)}${span.payload}`;
				carry = activeStyleAtRowEnd(head);
				consumed = span.offset;
				remaining = tail;
			}
			return `${emitted}${styleTerminalRow(carry + remaining, base)}`;
		});
		this.#displayDirty = true;
		this.#outputVersion++;
	}

	/** Groups retained payloads by replay row, keyed relative to `startRow`. */
	#collectPtySixelSpans(startRow: number, buffer: BufferView): Map<number, PtySixelSpan[]> {
		const lines: Array<BufferLine | undefined> = [];
		for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row));
		const spansByRow = new Map<number, PtySixelSpan[]>();
		for (const span of this.#ptySixelSpans) {
			// Trimming splices rows off the front, so the index is resolved from
			// the anchored line. A line that is gone belonged to trimmed
			// scrollback: the payload is dropped rather than pinned onto a newer
			// row that never carried it.
			const index = lines.indexOf(span.line);
			if (index < 0) continue;
			// Above the streaming window: the final full read picks it up.
			const relative = index - startRow;
			if (relative < 0) continue;
			const rowSpans = spansByRow.get(relative);
			if (rowSpans) rowSpans.push(span);
			else spansByRow.set(relative, [span]);
		}
		return spansByRow;
	}

	/** Final full-scrollback read; the terminal is disposed once lines are snapshotted. */
	#finalizePtyOutput(): void {
		const terminal = this.#ptyTerminal;
		if (!terminal) return;
		this.#refreshPtyLines(true);
		this.#ptyTerminal = undefined;
		terminal.dispose();
		this.#ptyReplayFinalized = true;
		this.#blockVersion++;
		this.#updateDisplay();
		this.#ui.requestComponentRender(this);
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: {
			output?: string;
			truncation?: TruncationMeta;
			artifactError?: OutputArtifactError;
			images?: readonly ImageContent[];
			showImages?: boolean;
		},
	): void {
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#endedAt ??= performance.now();
		this.#truncation = options?.truncation;
		this.#artifactError = options?.artifactError;
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
		const sixelLineMask =
			TERMINAL.imageProtocol === ImageProtocol.Sixel && isSixelPassthroughEnabled()
				? getSixelLineMask(availableLines)
				: undefined;
		const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
		const showingAllLines = this.#expanded || hasSixelOutput;
		// Only the collapsed preview hides lines; when the full output is shown
		// the footer must not keep advertising hidden lines / ctrl+o.
		const hiddenLineCount = showingAllLines ? 0 : Math.max(0, availableLines.length - PREVIEW_LINES);
		this.#outputPane.configure({ uncapSixel: hasSixelOutput });
		this.#outputPane.setLines(availableLines);
		// The PTY executor also decodes every graphics frame it saw into an
		// image. A sixel payload rendered raw through the replay rows already
		// rasterizes in the host terminal, so handing that decode through here
		// would draw the same image a second time below the output. Only
		// sixel-sourced decodes are suppressed: a Kitty frame's APC was already
		// consumed by the replay terminal, so its decode is the only rendering.
		const images = hasSixelOutput ? this.#images.filter(image => image.source !== "sixel") : this.#images;

		// Rebuild content container
		this.#contentContainer.clear();

		// Command header
		this.#contentContainer.addChild(this.#headerText);

		// Output
		if (availableLines.length > 0) this.#contentContainer.addChild(this.#outputPane);

		for (let index = 0; index < images.length; index++) {
			const image = images[index]!;
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
					new Text(theme.fg("muted", linkedImageText(imageFallback(image.mimeType, dimensions), image)), 1, 0),
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
				artifactError: this.#artifactError,
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

	#clampLinesPreservingSixel(lines: string[]): string[] {
		if (lines.length === 0) return [];
		const sixelLineMask = getSixelLineMask(lines);
		if (!sixelLineMask.some(Boolean)) {
			return lines.map(clampDisplayLine);
		}
		return lines.map((line, index) => (sixelLineMask[index] ? line : clampDisplayLine(line)));
	}

	#setOutput(output: string): void {
		const clean = sanitizeWithOptionalSixelPassthrough(output, sanitizeText);
		this.#outputLines = clean ? this.#clampLinesPreservingSixel(clean.split("\n")) : [];
		this.#outputVersion++;
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
		return this.#command;
	}
}
