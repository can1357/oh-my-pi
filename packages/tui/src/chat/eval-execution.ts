/**
 * Component for displaying user-initiated eval execution with streaming output.
 * Shares the same kernel session as the agent's eval tool.
 */

import type { Loader } from "../components/loader";
import { Text } from "../components/text";
import { Container, type TUI } from "../tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { highlightCode, theme } from "../theme/theme";
import type { OutputArtifactError } from "../tools/streaming-output";
import type { TruncationMeta } from "../tools/output-meta";
import { OutputPane } from "../render/output-pane";
import {
	buildExecutionFrame,
	buildStatusFooter,
	clampDisplayLine,
	type ExecutionColorKey,
	type ExecutionStatus,
	PREVIEW_LINES,
	resolveExecutionStatus,
} from "./execution-shared";

export type EvalExecutionLanguage = "python" | "js";

export class EvalExecutionComponent extends Container {
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#artifactError?: OutputArtifactError;
	#expanded = false;
	// Post-finalize mutation counter (FinalizableBlock.getTranscriptBlockVersion):
	// a completed cell's block still mutates on expansion toggles, and the
	// transcript's width-epoch resolution and committed-render bypass must
	// observe that.
	#blockVersion = 0;
	#contentContainer: Container;
	#outputPane: OutputPane;
	readonly #code: string;
	readonly #excludeFromContext: boolean;
	readonly #language: EvalExecutionLanguage;

	#highlightLang(): "python" | "javascript" {
		return this.#language === "js" ? "javascript" : "python";
	}

	#formatHeader(colorKey: ExecutionColorKey): Text {
		const prompt = theme.fg(colorKey, theme.bold(">>>"));
		const continuation = theme.fg(colorKey, "    ");
		const codeLines = highlightCode(this.#code, this.#highlightLang());
		const headerLines = codeLines.map((line, index) =>
			index === 0 ? `${prompt} ${line}` : `${continuation}${line}`,
		);
		return new Text(headerLines.join("\n"), 1, 0);
	}

	constructor(code: string, ui: TUI, excludeFromContext = false, language: EvalExecutionLanguage = "python") {
		super();
		this.#code = code;
		this.#excludeFromContext = excludeFromContext;
		this.#language = language;

		const colorKey: ExecutionColorKey = this.#excludeFromContext ? "dim" : "pythonMode";
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
			styleLine: line => theme.fg("muted", line),
			normalizeLine: clampDisplayLine,
		});

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
		this.#outputPane.setExpanded(expanded);
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Chunk is pre-sanitized by OutputSink.push() — no need to sanitize again.
		this.#outputPane.append(chunk);
		this.#updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta; artifactError?: OutputArtifactError },
	): void {
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#truncation = options?.truncation;
		this.#artifactError = options?.artifactError;
		this.#outputPane.finish();
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}

		this.#loader.stop();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		// Only the collapsed preview hides lines; when expanded the footer must
		// not keep advertising hidden lines / ctrl+o.
		const hiddenLineCount = this.#expanded ? 0 : Math.max(0, this.#outputPane.lineCount - PREVIEW_LINES);

		this.#contentContainer.clear();

		const colorKey: ExecutionColorKey = this.#excludeFromContext ? "dim" : "pythonMode";
		this.#contentContainer.addChild(this.#formatHeader(colorKey));

		if (this.#outputPane.lineCount > 0) this.#contentContainer.addChild(this.#outputPane);

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				artifactError: this.#artifactError,
				hiddenLineCount,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		this.#outputPane.setText(clean);
	}

	getOutput(): string {
		return this.#outputPane.getText();
	}

	getCode(): string {
		return this.#code;
	}
}
