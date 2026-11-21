import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { mapWithConcurrencyLimit } from "../task/parallel";

const BAR_WIDTH = 16;

/** Minimal output contract used by the interactive progress reporter. */
export interface ProgressOutput {
	isTTY?: boolean;
	/** Terminal width; a bar wider than this would wrap and stop redrawing in place. */
	columns?: number;
	write(text: string): boolean;
}

/** Renders completed units of work on one transient terminal line. */
export interface ProgressReporter {
	readonly interactive: boolean;
	start(total: number): void;
	complete(): void;
	/** End the bar, leaving it on screen. */
	finish(): void;
	/** End the bar, erasing it. */
	clear(): void;
}

/**
 * Runs loops under progress bars, one bar per loop; created by
 * {@link createProgressTracker}. Never nest tracked loops: their bars share one line.
 */
export interface ProgressTracker {
	/** Iterate `items` in order; an item counts as done once the loop advances past it. */
	each<T>(label: string, items: readonly T[]): Iterable<T>;
	/**
	 * Run `work` on every item, at most `options.concurrency` at once, counting
	 * an item done when its `work` settles. Fails like {@link mapWithConcurrencyLimit}:
	 * the first rejection stops new work and is rethrown once launched work drains.
	 */
	pool<T>(label: string, items: T[], options: PoolOptions, work: (item: T) => Promise<void>): Promise<void>;
}

/** How {@link ProgressTracker.pool} runs its items. */
export interface PoolOptions {
	/** Most items whose work runs at once. */
	concurrency: number;
	/** Status after the count, re-read on every redraw, e.g. a running tally of changes. */
	detail?: () => string;
}

/**
 * Create a TTY-only completion bar labelled `label`, e.g. `Repairing [████░░░░] 4/8`,
 * followed by `detail()` when given: `Stripping [██░░] 4/8 · 3/3 stripped`.
 *
 * Non-interactive output disables rendering entirely, so callers can print plain
 * per-item lines instead by checking {@link ProgressReporter.interactive}.
 */
export function createProgressReporter(
	label: string,
	output: ProgressOutput = process.stdout,
	detail?: () => string,
): ProgressReporter {
	const interactive = output.isTTY === true;
	let total = 0;
	let completed = 0;
	let rendered = false;

	const render = (): void => {
		if (!interactive || total === 0) return;
		const ratio = Math.min(completed / total, 1);
		const filled = Math.round(ratio * BAR_WIDTH);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
		let line = `${label} [${bar}] ${completed}/${total}`;
		if (detail) line += ` · ${detail()}`;
		// One column spare: a line filling the last column wraps on some terminals.
		if (output.columns) line = truncateToWidth(line, output.columns - 1);
		output.write(`\r${line}\x1b[K`);
		rendered = true;
	};

	return {
		interactive,
		start(nextTotal) {
			total = Math.max(nextTotal, 0);
			completed = 0;
			render();
		},
		complete() {
			completed = Math.min(completed + 1, total);
			render();
		},
		finish() {
			if (!rendered) return;
			output.write("\n");
			rendered = false;
		},
		clear() {
			if (!rendered) return;
			output.write("\r\x1b[K");
			rendered = false;
		},
	};
}

/**
 * Create a {@link ProgressTracker} drawing on `output`. Each bar is erased when
 * its loop ends, by `break` or throw included. Without a TTY output, loops run
 * without bars.
 */
export function createProgressTracker(output?: ProgressOutput): ProgressTracker {
	const bar = (label: string, total: number, detail?: () => string): ProgressReporter | undefined => {
		if (output?.isTTY !== true) return undefined;
		const progress = createProgressReporter(label, output, detail);
		progress.start(total);
		return progress;
	};
	return {
		*each<T>(label: string, items: readonly T[]): Generator<T> {
			const progress = bar(label, items.length);
			try {
				for (const item of items) {
					yield item;
					progress?.complete();
				}
			} finally {
				progress?.clear();
			}
		},
		async pool<T>(label: string, items: T[], options: PoolOptions, work: (item: T) => Promise<void>) {
			const progress = bar(label, items.length, options.detail);
			try {
				await mapWithConcurrencyLimit(items, options.concurrency, async item => {
					await work(item);
					progress?.complete();
				});
			} finally {
				progress?.clear();
			}
		},
	};
}
