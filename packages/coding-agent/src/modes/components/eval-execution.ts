/**
 * Component for displaying user-initiated eval execution with streaming output.
 * Shares the same kernel session as the agent's eval tool.
 */

import { Container, type Loader, Text, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { highlightCode, theme } from "../../modes/theme/theme";
import type { TruncationMeta } from "../../tools/output-meta";
import {
	buildExecutionFrame,
	buildStatusFooter,
	createCollapsedPreview,
	type ExecutionColorKey,
	type ExecutionStatus,
	resolveExecutionStatus,
} from "./execution-shared";

const PREVIEW_LINES = 20;
const MAX_DISPLAY_LINE_CHARS = 4000;

export type EvalExecutionLanguage = "python" | "js";

export class EvalExecutionComponent extends Container {
	#outputLines: string[] = [];
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	// Post-finalize mutation counter (FinalizableBlock.getTranscriptBlockVersion):
	// a completed cell's block still mutates on expansion toggles, and the
	// transcript's width-epoch resolution and committed-render bypass must
	// observe that.
	#blockVersion = 0;
	#contentContainer: Container;

	#highlightLang(): "python" | "javascript" {
		return this.language === "js" ? "javascript" : "python";
	}

	#formatHeader(colorKey: ExecutionColorKey): Text {
		const prompt = theme.fg(colorKey, theme.bold(">>>"));
		const continuation = theme.fg(colorKey, "    ");
		const codeLines = highlightCode(this.code, this.#highlightLang());
		const headerLines = codeLines.map((line, index) =>
			index === 0 ? `${prompt} ${line}` : `${continuation}${line}`,
		);
		return new Text(headerLines.join("\n"), 1, 0);
	}

	constructor(
		private readonly code: string,
		ui: TUI,
		private readonly excludeFromContext = false,
		private readonly language: EvalExecutionLanguage = "python",
	) {
		super();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		this.#contentContainer.addChild(this.#formatHeader(colorKey));
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed
	 * streaming preview rewrites its tail window every chunk, so the block must
	 * stay out of native scrollback until the cell completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Chunk is pre-sanitized by OutputSink.push() — no need to sanitize again.
		const newLines = chunk.split("\n").map(line => this.#clampDisplayLine(line));
		if (this.#outputLines.length > 0 && newLines.length > 0) {
			this.#outputLines[this.#outputLines.length - 1] = this.#clampDisplayLine(
				`${this.#outputLines[this.#outputLines.length - 1]}${newLines[0]}`,
			);
			this.#outputLines.push(...newLines.slice(1));
		} else {
			this.#outputLines.push(...newLines);
		}

		this.#updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta },
	): void {
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#truncation = options?.truncation;
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}

		this.#loader.stop();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		const availableLines = this.#outputLines;
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		// Only the collapsed preview hides lines; when expanded the footer must
		// not keep advertising hidden lines / ctrl+o.
		const hiddenLineCount = this.#expanded ? 0 : availableLines.length - previewLogicalLines.length;

		this.#contentContainer.clear();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		this.#contentContainer.addChild(this.#formatHeader(colorKey));

		if (availableLines.length > 0) {
			if (this.#expanded) {
				const displayText = availableLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, PREVIEW_LINES));
			}
		}

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				hiddenLineCount,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#clampDisplayLine(line: string): string {
		if (line.length <= MAX_DISPLAY_LINE_CHARS) {
			return line;
		}
		const omitted = line.length - MAX_DISPLAY_LINE_CHARS;
		return `${line.slice(0, MAX_DISPLAY_LINE_CHARS)}… [${omitted} chars omitted]`;
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		this.#outputLines = clean ? clean.split("\n").map(line => this.#clampDisplayLine(line)) : [];
	}

	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	getCode(): string {
		return this.code;
	}
}
