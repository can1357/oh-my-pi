/**
 * Mid-run reports of a background process's output: the lines matching the
 * `notify` regex its caller gave (`bash`).
 *
 * An {@link OutputNotifier} reads the output as it grows, groups matching lines
 * that arrive close together into a {@link NotifyBatch}, and hands each batch
 * on: a job's tool sends it to the session that started the job, the launch
 * broker to the session owning a service. Either delivers it like the process's
 * result. A process that matches too often loses its notices, not its run: once
 * the allowance of {@link NOTIFY_BURST} batches is spent the notifier sends one
 * last batch marked `stopped`. A job's allowance refills over time, as the job
 * ends at its deadline; a service, which has none, gets the burst once per
 * start.
 *
 * ```ts
 * const pattern = compileNotifyPattern("ERROR|FAILED");
 * const notifier = new OutputNotifier(pattern, outputTap, batch => deliver(batch));
 * outputTap.append(chunk);
 * notifier.poll();
 * ```
 */
import { LineMatcher } from "@oh-my-pi/pi-natives";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { truncate } from "@oh-my-pi/pi-utils";
import { SourceLineReader } from "../job-widgets/runtime";
import type { JobTextSource } from "../job-widgets/types";

/** Matching lines arriving within this long of a batch's first one join it. */
const NOTIFY_BATCH_MS = 200;
/** Lines one notice reports; further matches are only counted. */
export const NOTIFY_MAX_LINES = 50;
/** Characters kept of one reported line. */
const NOTIFY_MAX_LINE_CHARS = 400;
/** Batches a process may send in quick succession before its notices stop; all a service ever gets per start. */
export const NOTIFY_BURST = 30;
/** How long it takes one batch of a refilling allowance to come back. */
const NOTIFY_REFILL_MS = 20_000;

/** A `notify` regex ready to match output lines. */
export interface NotifyPattern {
	readonly source: string;
	readonly matcher: LineMatcher;
}

/**
 * Compile a `notify` regex; the syntax is the one `grep` takes (linear-time, no look-around).
 *
 * @throws ToolError `Invalid notify regex: …` with the regex engine's message when `source` does not compile.
 */
export function compileNotifyPattern(source: string): NotifyPattern {
	try {
		return { source, matcher: new LineMatcher([source]) };
	} catch (error) {
		// The matcher names the failing pattern's index; a notify regex is its only one.
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Invalid notify regex: ${message.replace(/^pattern 0: /, "")}`);
	}
}

/** The matching lines of one batching window. */
export interface NotifyBatch {
	/** Matching lines, oldest first, each cut to a bounded length. */
	lines: string[];
	/** Matching lines of the window left out of `lines`. */
	omitted: number;
	/** The process matched too often: this batch is its last. */
	stopped: boolean;
}

/** How an {@link OutputNotifier} spends its allowance. */
export interface OutputNotifierOptions {
	/**
	 * Spent allowance comes back, one batch per {@link NOTIFY_REFILL_MS}. Default true; false for a
	 * process without a deadline, which would otherwise report for as long as it runs.
	 */
	refill?: boolean;
}

/**
 * Matches a growing {@link JobTextSource} against a {@link NotifyPattern} and
 * emits the matching lines in batches. The owner calls {@link poll} after each
 * append ({@link skip} while nobody can receive a notice), then {@link finish}
 * once the process exits with nothing else to report its last output, or
 * {@link stop} once that output is reported elsewhere or the process is
 * cancelled.
 */
export class OutputNotifier {
	readonly #matcher: LineMatcher;
	readonly #reader: SourceLineReader;
	readonly #emit: (batch: NotifyBatch) => void;
	/** Matches of the open batching window. */
	#lines: string[] = [];
	#omitted = 0;
	#timer: NodeJS.Timeout | undefined;
	/** Batches still allowed before the notices stop, and when the allowance last grew. */
	#allowance = NOTIFY_BURST;
	#refilledAt = Date.now();
	readonly #refill: boolean;
	#stopped = false;

	constructor(
		pattern: NotifyPattern,
		source: JobTextSource,
		emit: (batch: NotifyBatch) => void,
		options: OutputNotifierOptions = {},
	) {
		this.#matcher = pattern.matcher;
		this.#reader = new SourceLineReader(source);
		this.#emit = emit;
		this.#refill = options.refill ?? true;
	}

	/** Match the complete lines that arrived since the last call; blank lines never count. */
	poll(): void {
		if (this.#stopped) return;
		this.#collect(this.#reader.read(false).lines);
		if (this.#lines.length > 0) this.#timer ??= setTimeout(() => this.#flush(), NOTIFY_BATCH_MS);
	}

	/**
	 * Read past the complete lines that arrived since the last call without matching them: output
	 * nobody is there to receive is neither reported nor counted. Reading it, rather than leaving it
	 * out of the source, keeps line boundaries: a line cut short here is not later joined to the
	 * start of another.
	 */
	skip(): void {
		if (this.#stopped) return;
		this.#reader.read(false);
	}

	/**
	 * End the notices once the process exited: the matches not sent yet go out now, the line it
	 * left unterminated included, without waiting for the batching window.
	 */
	finish(): void {
		if (this.#stopped) return;
		this.#collect(this.#reader.read(true).lines);
		const batch: NotifyBatch = { lines: this.#lines, omitted: this.#omitted, stopped: false };
		this.stop();
		if (batch.lines.length > 0) this.#emit(batch);
	}

	/** End the notices: matches not sent yet are dropped and later output is ignored. */
	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#lines = [];
		this.#omitted = 0;
	}

	#collect(lines: readonly string[]): void {
		if (lines.length === 0) return;
		for (const index of this.#matcher.matchLines(lines.join("\n")).lines) {
			const line = lines[index];
			if (line.trim().length === 0) continue;
			if (this.#lines.length < NOTIFY_MAX_LINES) this.#lines.push(truncate(line, NOTIFY_MAX_LINE_CHARS));
			else this.#omitted += 1;
		}
	}

	#flush(): void {
		const refill = this.#refill ? Math.floor((Date.now() - this.#refilledAt) / NOTIFY_REFILL_MS) : 0;
		if (refill > 0) {
			this.#allowance = Math.min(NOTIFY_BURST, this.#allowance + refill);
			this.#refilledAt += refill * NOTIFY_REFILL_MS;
		}
		this.#allowance -= 1;
		const batch: NotifyBatch = { lines: this.#lines, omitted: this.#omitted, stopped: this.#allowance <= 0 };
		this.#timer = undefined;
		this.#lines = [];
		this.#omitted = 0;
		this.#stopped = batch.stopped;
		this.#emit(batch);
	}
}
