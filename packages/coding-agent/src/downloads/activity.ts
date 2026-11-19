/**
 * Process-wide registry of automatic background work: downloads and installs
 * (model weights, tool binaries, browsers, side runtimes) and optimization
 * passes counted in steps (skill descriptions). The interactive TUI renders
 * them in its download HUD so a feature waiting on a first-use fetch is
 * visibly busy (or visibly failed) instead of silently idle.
 *
 * Producers wrap the work in {@link withDownload} (or drive a
 * {@link DownloadTracker} from {@link trackDownload}); work made of many
 * concurrent steps counts each with {@link trackStep}. The HUD subscribes with
 * {@link onDownloadActivity}. Headless modes simply have no subscriber.
 *
 * @example
 * await withDownload("SmolLM2-135M", tracker =>
 *   downloadFile(url, dest, { onProgress: (loaded, total) => tracker.update({ loaded, total }) }),
 * );
 */

/** What a {@link DownloadActivity}'s `loaded` and `total` count. */
export type DownloadUnit = "bytes" | "steps";

/** Snapshot of one download, install or optimization pass. */
export interface DownloadActivity {
	/** Unique for the lifetime of the process. */
	id: number;
	/** What is being fetched, e.g. `SmolLM2-135M` or `yt-dlp`. */
	label: string;
	/** Current step or file, e.g. `model.safetensors` or `installing mlx-lm`. */
	detail?: string;
	/** Amount finished so far in {@link unit}s, when known. */
	loaded?: number;
	/** Expected amount in {@link unit}s, when known. */
	total?: number;
	/** Bytes when omitted; `steps` are whole units of work, shown as `3/12`. */
	unit?: DownloadUnit;
	state: "running" | "done" | "failed";
	/** Failure reason when `state` is `failed`. */
	error?: string;
}

/** Progress fields a producer may report; omitted fields keep their last value. */
export interface DownloadProgressUpdate {
	loaded?: number;
	total?: number;
	detail?: string;
	/** Set with the first report. */
	unit?: DownloadUnit;
}

/** Handle for one tracked download; `done`/`fail` end it and later calls are ignored. */
export interface DownloadTracker {
	update(progress: DownloadProgressUpdate): void;
	done(): void;
	fail(error: unknown): void;
}

type Listener = (activity: DownloadActivity) => void;

/** Byte progress is coalesced to this cadence; state, detail and step changes emit immediately. */
const PROGRESS_INTERVAL_MS = 100;

const listeners = new Set<Listener>();
let nextId = 1;

function emit(activity: DownloadActivity): void {
	for (const listener of listeners) listener({ ...activity });
}

/** Subscribe to every download's updates; returns the unsubscribe function. */
export function onDownloadActivity(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Start tracking a download or install labelled `label`. */
export function trackDownload(label: string, initial: DownloadProgressUpdate = {}): DownloadTracker {
	const activity: DownloadActivity = { id: nextId++, label, state: "running", ...initial };
	emit(activity);
	let lastEmit = Date.now();
	return {
		update(progress) {
			if (activity.state !== "running") return;
			const detailChanged = progress.detail !== undefined && progress.detail !== activity.detail;
			Object.assign(activity, progress);
			const now = Date.now();
			// The next byte count replaces a skipped one within the interval; a step count can stand for minutes.
			const coalesced = activity.unit !== "steps" && !detailChanged;
			if (coalesced && now - lastEmit < PROGRESS_INTERVAL_MS) return;
			lastEmit = now;
			emit(activity);
		},
		done() {
			if (activity.state !== "running") return;
			activity.state = "done";
			emit(activity);
		},
		fail(error) {
			if (activity.state !== "running") return;
			activity.state = "failed";
			activity.error = error instanceof Error ? error.message : String(error);
			emit(activity);
		},
	};
}

/**
 * Run `work` as a tracked download: done when it resolves, failed (and
 * rethrown) when it rejects.
 */
export async function withDownload<T>(
	label: string,
	work: (tracker: DownloadTracker) => Promise<T>,
	initial?: DownloadProgressUpdate,
): Promise<T> {
	const tracker = trackDownload(label, initial);
	try {
		const result = await work(tracker);
		tracker.done();
		return result;
	} catch (error) {
		tracker.fail(error);
		throw error;
	}
}

/** One open {@link trackStep} row. */
interface StepRow {
	tracker: DownloadTracker;
	total: number;
	settled: number;
	failed: number;
	/** Reason the first failed step gave. */
	failure?: string;
}

const stepRows = new Map<string, StepRow>();

/**
 * Count one step of the work labelled `label` in a row shared by every step
 * pending under that label (`Optimizing skills 3/12`). The row opens with the
 * first step and ends once none is pending: done, or failed with the first
 * failure and how many steps failed. A step begun after that opens a new row.
 * A row holding one step has no fraction to show and reports no count.
 *
 * @returns Settles the step; call it once, with the reason when the step failed.
 */
export function trackStep(label: string): (failure?: string) => void {
	let open = stepRows.get(label);
	if (open) {
		open.total++;
		open.tracker.update({ loaded: open.settled, total: open.total });
	} else {
		open = { tracker: trackDownload(label, { unit: "steps" }), total: 1, settled: 0, failed: 0 };
		stepRows.set(label, open);
	}
	const row = open;
	return failure => {
		row.settled++;
		if (failure !== undefined) {
			row.failed++;
			row.failure ??= failure;
		}
		if (row.settled < row.total) {
			row.tracker.update({ loaded: row.settled });
			return;
		}
		stepRows.delete(label);
		if (row.failed === 0) row.tracker.done();
		else row.tracker.fail(row.failed === row.total ? row.failure : `${row.failed} of ${row.total}: ${row.failure}`);
	};
}
