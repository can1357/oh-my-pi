import type { PipeStreamInfo, PipeStreams } from "@oh-my-pi/pi-natives";

/** Bytes off a stream's end a view reads: screens of text, not the megabyte a stream keeps. */
const STREAM_TAIL_BYTES = 64 * 1024;

/**
 * A place a run's command writes that is not its own output: a pipe between
 * two of its stages, or a file it redirects into.
 */
export interface ShellStream {
	/** Stable within the run (`pipe:1`, `file:2`, see {@link shellStreamId}). */
	readonly id: string;
	readonly kind: "pipe" | "file";
	/** Source text of the stage writing a pipe, or of the command whose redirection opened a file. */
	readonly producer: string;
	/** Source text of the stage reading a pipe; a file's absolute path. */
	readonly consumer: string;
	/** Node key (`unit:0:node`) of the command writing it, in the run trace's key space; absent when unknown. */
	readonly node?: string;
	/** Bytes written so far; a file's size. */
	readonly bytes: number;
	/** Whether more may arrive. */
	readonly open: boolean;
	/** Milliseconds since the UNIX epoch of its last write (a pipe's open time before any; 0 when unknown). */
	readonly modified: number;
	/** Its newest text, from a whole line on; undefined when it carries binary data. Read for the shown stream only. */
	tail(): string | undefined;
}

/** A stream's id among its run's sources: `pipe:<n>`, or `file:<n>` for a redirected file. */
export function shellStreamId(info: PipeStreamInfo): string {
	return `${info.file ? "file" : "pipe"}:${info.id}`;
}

/** The newest text of stream `id` from its first whole line on; undefined for binary data. */
function streamTail(streams: PipeStreams, id: number, total: number): string | undefined {
	const chunk = streams.read(id, Math.max(0, total - STREAM_TAIL_BYTES));
	if (!chunk) return "";
	if (chunk.data.indexOf(0) !== -1) return undefined;
	const text = new TextDecoder().decode(chunk.data);
	// A read that starts past the stream's head starts mid-line, maybe mid-character.
	return chunk.start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

/** A run's tapped pipes and redirected files as {@link ShellStream}s, oldest first. */
export function nativeShellStreams(streams: PipeStreams): ShellStream[] {
	return streams.list().map(info => ({
		id: shellStreamId(info),
		kind: info.file ? "file" : "pipe",
		producer: info.producer,
		consumer: info.consumer,
		...(info.node !== undefined ? { node: info.node } : {}),
		bytes: info.total,
		open: info.open,
		modified: info.modified,
		tail: () => streamTail(streams, info.id, info.total),
	}));
}

/** One entry of a view's source menu: the run's own output, or one stream. */
export interface ShellStepSource {
	/** {@link OWN_OUTPUT} or a stream id. */
	readonly id: string;
	/** Short name: `Output`, a file's name (with its directory when names collide), a pipe's two programs. */
	readonly label: string;
	/** What it is on one line: a file's path or a pipe's two stages, and its size. */
	readonly detail?: string;
}

/** The source a {@link ShellSteps} view shows now. */
export interface ShellStepView {
	/** {@link OWN_OUTPUT}, a stream id, or `step:<node>` for a step's slice of the own output. */
	readonly id: string;
	/** Its name: a source's {@link ShellStepSource.label}, or a step's command text. */
	readonly label: string;
	/** What it is: a stream's {@link ShellStepSource.detail}; for a step's slice, that it is the step's own output. */
	readonly note?: string;
	/** The shown stream. */
	readonly stream?: ShellStream;
	/** Its text; undefined for a stream of binary data. */
	readonly text: string | undefined;
	/** More may arrive. */
	readonly open: boolean;
	/** It was written within {@link FLOW_WINDOW_MS}. */
	readonly flowing: boolean;
	/** The user chose it (a step or a menu entry); otherwise the view follows the run. */
	readonly pinned: boolean;
	/** Execution nodes of the presentation that write it: the step the command highlights. */
	readonly focus: readonly string[];
	/** The run's own output, then each stream, labelled. */
	readonly sources: readonly ShellStepSource[];
}
