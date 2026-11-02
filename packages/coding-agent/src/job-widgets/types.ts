/**
 * Contracts between jobs and their live widgets: what a job offers a widget
 * to read ({@link JobWidgetInputs}), and the registry that turns those inputs
 * into a `JobWidgetView` for the `wait` card, the HUD and the jobs sheet
 * ({@link JobWidgetRegistry}).
 */
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AsyncJob } from "../async/job-manager";

/** Id of a task job's source carrying its subagent's finished tool calls. */
export const TOOLS_SOURCE_ID = "tools";
/**
 * What opens each tool call in the {@link TOOLS_SOURCE_ID} source
 * (`» <tool> <intent>`, then the result text): omp's marker, not output the
 * subagent produced, so no widget rule may read it.
 */
export const TOOL_CALL_MARK = "» ";

/** Retained text of a {@link JobTextSource} from some offset on. */
export interface JobTextChunk {
	/** Offset of `text`'s first unit; past the requested `from` when older text was dropped. */
	start: number;
	/** Offset just past `text`: the next read's `from`. */
	end: number;
	text: string;
	/** Whether more text may arrive. */
	open: boolean;
}

/**
 * Text a job produces over time, readable from any offset still retained.
 * Offsets are opaque, increasing numbers in the source's own unit (bytes for
 * a pipe, UTF-16 units for a tap); a reader only hands back an `end` it got.
 */
export interface JobTextSource {
	/** Stable id a widget rule names in `from`: `out`, `pipe:1`, `tools`, `bg_7:pipe:1`. */
	readonly id: string;
	/** What the text is, for the widget author (`cargo nextest run … → tail -n 5`). */
	readonly label: string;
	read(from: number): JobTextChunk;
}

/** What the job is for, as the widget author reads it. */
export interface JobWidgetBrief {
	kind: "bash" | "task";
	/** bash: the full command line. */
	command?: string;
	/** bash: seconds until the command is killed; absent when it has no timeout. */
	timeoutSec?: number;
	/** task: the assignment the subagent was given. */
	task?: string;
	/** The model's intent line on the call that started the job. */
	intent?: string;
	/** task: what the subagent says is worth watching, from its completion probe. */
	watch?: string;
	/** task: the subagent's current stage, from its completion probe. */
	stage?: string;
}

/** What a job offers its widget; set at registration by jobs that can be watched (bash, task). */
export interface JobWidgetInputs {
	/** The job's text sources now; a task's list grows as its subagent starts jobs. */
	sources(): readonly JobTextSource[];
	brief(): JobWidgetBrief;
}

/**
 * The widgets of one root session's jobs, shared by every agent of that root
 * through its `AsyncJobManager`.
 */
export interface JobWidgetRegistry {
	/**
	 * The job's widget now, after reading the output that arrived since the
	 * last call; `undefined` for a job without inputs or with widgets turned
	 * off. A call also marks the widget as shown, which is what lets a cheap
	 * model start writing its spec.
	 */
	view(job: AsyncJob): JobWidgetView | undefined;
	/**
	 * One line on what a command's job does and when it ends, written by the
	 * cheap model once the job has run a while; `undefined` until then, for a
	 * command that reads at a glance, or with widgets turned off.
	 */
	caption(job: AsyncJob): string | undefined;
	/**
	 * Asks for a running command's caption without showing its widget (so no
	 * spec is written), for a listing that prints the command; the caption
	 * shows on a later listing. Same once-per-job rules as a shown widget.
	 */
	requestCaption(job: AsyncJob): void;
	/** Called after a background refresh changed a shown widget or a caption landed, so a surface that is not polling repaints. */
	subscribe(listener: () => void): () => void;
	/** Drops a job's widget and caption, once its row is evicted. */
	forget(jobId: string): void;
	dispose(): void;
}
