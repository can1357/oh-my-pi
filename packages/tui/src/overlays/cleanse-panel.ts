/** Anchored `/cleanse` overlay rendering the host's live board above the editor. */
import { Text, type TUI } from "../index";
import type { AgentProgress } from "../tools/task";
import { replaceTabs } from "../render/render-utils";
import { theme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent, type StreamingPanelPresentation } from "../chrome/streaming-panel";
import { boundKeys, interruptKey } from "../chrome/keybinding-hints";
import type { TspTone } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode } from "../native/node";
import { col, node, span, text } from "../native/describe";
import { hintsRow, type NativeHint, statusHintsRow } from "../native/overlay";
import { plainText } from "../native/spans";
import { isNativeRendering } from "../native/state";
import type {
	CleanseBoardModel,
	CleanseCheckerDescriptor,
	CleanseCheckResult,
	CleanseAssignment,
	CleanseAgentOutcome,
} from "../apps/cleanse-board";

const SPINNER_INTERVAL_MS = 80;
const MAX_LOG_LINES = 14;

export type CleansePanelRunStatus = "clean" | "unresolved" | "unsupported" | "cancelled";

interface CleansePanelComponentOptions {
	model: CleanseBoardModel;
	/** Free-form request shown in the header; omitted for checker-discovery runs. */
	request?: string;
	tui: TUI;
}

/** Terminal state of the run, mirrored into the footer once the core settles. */
type CleansePanelOutcome = CleansePanelRunStatus | "error";

/** Tone of the finished sheet per outcome. */
const OUTCOME_TONE: Record<CleansePanelOutcome, TspTone> = {
	clean: "success",
	unresolved: "warning",
	unsupported: "warning",
	cancelled: "warning",
	error: "error",
};

export class CleansePanelComponent extends OverlayPanel {
	readonly interactive = true;

	readonly #tui: TUI;
	readonly #model: CleanseBoardModel;
	readonly #logLines: string[] = [];
	/** Semantic twins of {@link #logLines}, keyed by a running sequence so scrolled-off entries keep their ids. */
	readonly #nativeLog: NativeNode[] = [];
	#logSeq = 0;
	readonly #request: string | undefined;
	#native: NativeNode | undefined;
	#outcome: CleansePanelOutcome | undefined;
	#errorMessage: string | undefined;
	#frame = 0;
	#timer: NodeJS.Timeout | undefined;
	#liveClosed = false;
	readonly #content: StreamingPanelContent;

	constructor(options: CleansePanelComponentOptions) {
		super(options.request ? `/cleanse ${replaceTabs(options.request)}` : "/cleanse", "omp.overlay.cleanse");
		this.#tui = options.tui;
		this.#model = options.model;
		this.#request = options.request === undefined ? undefined : replaceTabs(options.request);
		this.#content = new StreamingPanelContent(() => this.#presentation());
		this.addChild(this.#content);
		// The spinner frame only repaints; a native terminal clocks the described spinners itself.
		if (!isNativeRendering()) {
			this.#timer = setInterval(() => {
				this.#frame = (this.#frame + 1) % theme.getSpinnerFrames("activity").length;
				this.#rebuild();
			}, SPINNER_INTERVAL_MS);
			this.#timer.unref?.();
		}
		this.#rebuild();
	}

	log(line: string): void {
		this.#pushLog(line, text(replaceTabs(line), { wrap: "word" }));
	}

	/** Permanent line styled as a failure (the core's stderr-equivalent). */
	logError(line: string): void {
		this.#pushLog(theme.fg("error", line), text([span(replaceTabs(line), "error")], { wrap: "word" }));
	}

	#pushLog(line: string, described: NativeNode | undefined): void {
		this.#logLines.push(line);
		if (this.#logLines.length > MAX_LOG_LINES) this.#logLines.splice(0, this.#logLines.length - MAX_LOG_LINES);
		const entry = described ?? text(plainText(line), { wrap: "word" });
		this.#nativeLog.push({ ...entry, key: `log-${this.#logSeq++}` });
		if (this.#nativeLog.length > MAX_LOG_LINES) this.#nativeLog.splice(0, this.#nativeLog.length - MAX_LOG_LINES);
		this.#rebuild();
	}

	phase(text: string | undefined): void {
		this.#model.phase(text);
		this.#rebuild();
	}

	checkerStarted(checker: CleanseCheckerDescriptor): void {
		this.#model.checkerStarted(checker);
		this.#rebuild();
	}

	checkerFinished(check: CleanseCheckResult, durationMs: number): void {
		const line = this.#model.checkerFinished(check, durationMs);
		this.#pushLog(line, this.#model.lastSettled);
	}

	repairFinished(): void {
		this.#model.repairFinished();
		this.#rebuild();
	}

	agentStarted(name: string, assignment: CleanseAssignment): void {
		this.#model.agentStarted(name, assignment);
		this.#rebuild();
	}

	agentProgress(name: string, progress: AgentProgress): void {
		this.#model.agentProgress(name, progress);
		// The ANSI view picks progress up on its next spinner repaint; natively nothing else repaints.
		if (isNativeRendering()) this.#rebuild();
	}

	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void {
		const line = this.#model.agentFinished(outcome, assignment);
		this.#pushLog(line, this.#model.lastSettled);
	}

	/** Stop the live area; the panel stays mounted until the user dismisses it. */
	close(): void {
		this.#liveClosed = true;
		this.#stopTimer();
		this.#rebuild();
	}

	/** Record the settled run result and switch the footer to its dismiss hint. */
	finish(status: CleansePanelRunStatus): void {
		this.#outcome = status;
		this.close();
	}

	/** Record an unexpected failure and switch the footer to its dismiss hint. */
	markError(message: string): void {
		this.#outcome = "error";
		this.#errorMessage = message;
		this.close();
	}

	/** Release the repaint timer during teardown. */
	override dispose(): void {
		this.#stopTimer();
		super.dispose();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#presentation(): StreamingPanelPresentation {
		const frames = theme.getSpinnerFrames("activity");
		const liveLines = this.#liveClosed ? [] : this.#model.renderLive(frames[this.#frame % frames.length]);
		return {
			sections: [
				this.#logLines.length > 0 ? this.#logLines.map(line => new Text(replaceTabs(line), 0, 0)) : undefined,
				liveLines.length > 0 ? liveLines.map(line => new Text(replaceTabs(line), 0, 0)) : undefined,
				this.#errorMessage ? new Text(theme.fg("error", replaceTabs(this.#errorMessage)), 0, 0) : undefined,
			],
			footer: this.#footerLine(),
		};
	}

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	override describe(cx: DescribeContext): NativeNode {
		if (this.#native) return this.#native;
		// Inline in the dock, styled as a sheet by role: a borderless column headed by the request.
		const title =
			this.#request === undefined
				? [span("/cleanse", "accent")]
				: [span("/cleanse", "accent"), span(` ${this.#request}`)];
		const head = node(
			"row",
			{ role: "omp.sheet.head", gap: "sm", align: "center" },
			[...(this.#outcome === undefined ? [node("spinner", {})] : []), text(title, { truncate: "end", lines: 1 })],
			"head",
		);
		const body: NativeNode[] = [head];
		if (this.#nativeLog.length > 0) body.push(node("col", undefined, [...this.#nativeLog], "log"));
		const live = this.#liveClosed ? undefined : this.#model.describeLive(cx);
		if (live) body.push({ ...live, key: "live" });
		if (this.#errorMessage) {
			body.push(
				node("text", { spans: [span(replaceTabs(this.#errorMessage), "error")], wrap: "word" }, undefined, "error"),
			);
		}
		body.push({ ...this.#describeFooter(), key: "footer" });
		this.#native = col(body, {
			role: this.nativeRole,
			gap: "sm",
			tone: this.#outcome === undefined ? undefined : OUTCOME_TONE[this.#outcome],
		});
		return this.#native;
	}

	#describeFooter(): NativeNode {
		const esc: NativeHint = { keys: boundKeys("app.interrupt", ["escape"]).slice(0, 1), label: "dismiss" };
		switch (this.#outcome) {
			case undefined:
				return hintsRow([{ ...esc, label: "cancel /cleanse" }]);
			case "clean":
				return statusHintsRow([span(`${theme.status.success} Clean`, "success")], [esc]);
			case "unresolved":
				return statusHintsRow([span(`${theme.status.warning} Diagnostics remain`, "warning")], [esc]);
			case "unsupported":
				return statusHintsRow([span(`${theme.status.warning} No runnable checker`, "warning")], [esc]);
			case "cancelled":
				return statusHintsRow([span(`${theme.status.warning} Cancelled`, "warning")], [esc]);
			case "error":
				return statusHintsRow([span(`${theme.status.error} Error`, "error")], [esc]);
		}
	}

	#rebuild(): void {
		this.#native = undefined;
		this.#content.refresh();
		this.#tui.requestRender();
	}

	#footerLine(): string {
		// The main editor routes `app.interrupt` (Escape by default) to the panel.
		const esc = interruptKey();
		switch (this.#outcome) {
			case undefined:
				return theme.fg("muted", `${esc} cancel /cleanse`);
			case "clean":
				return theme.fg("success", `${theme.status.success} Clean · ${esc} dismiss`);
			case "unresolved":
				return theme.fg("warning", `${theme.status.warning} Diagnostics remain · ${esc} dismiss`);
			case "unsupported":
				return theme.fg("warning", `${theme.status.warning} No runnable checker · ${esc} dismiss`);
			case "cancelled":
				return theme.fg("warning", `${theme.status.warning} Cancelled · ${esc} dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · ${esc} dismiss`);
		}
	}
}
