/** Anchored `/cleanse` overlay rendering the host's live board above the editor. */
import { Text, type TUI } from "../index";
import type { AgentProgress } from "../tools/task";
import { replaceTabs } from "../render/render-utils";
import { theme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent, type StreamingPanelPresentation } from "../chrome/streaming-panel";
import { interruptKey } from "../chrome/keybinding-hints";
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

export class CleansePanelComponent extends OverlayPanel {
	readonly interactive = true;

	readonly #tui: TUI;
	readonly #model: CleanseBoardModel;
	readonly #logLines: string[] = [];
	#outcome: CleansePanelOutcome | undefined;
	#errorMessage: string | undefined;
	#frame = 0;
	#timer: NodeJS.Timeout | undefined;
	#liveClosed = false;
	readonly #content: StreamingPanelContent;

	constructor(options: CleansePanelComponentOptions) {
		super(options.request ? `/cleanse ${replaceTabs(options.request)}` : "/cleanse");
		this.#tui = options.tui;
		this.#model = options.model;
		this.#content = new StreamingPanelContent(() => this.#presentation());
		this.addChild(this.#content);
		this.#timer = setInterval(() => {
			this.#frame = (this.#frame + 1) % theme.getSpinnerFrames("activity").length;
			this.#rebuild();
		}, SPINNER_INTERVAL_MS);
		this.#timer.unref?.();
		this.#rebuild();
	}

	log(text: string): void {
		this.#logLines.push(text);
		if (this.#logLines.length > MAX_LOG_LINES) this.#logLines.splice(0, this.#logLines.length - MAX_LOG_LINES);
		this.#rebuild();
	}

	/** Permanent line styled as a failure (the core's stderr-equivalent). */
	logError(text: string): void {
		this.log(theme.fg("error", text));
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
		this.log(this.#model.checkerFinished(check, durationMs));
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
	}

	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void {
		this.log(this.#model.agentFinished(outcome, assignment));
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

	#rebuild(): void {
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
