/**
 * Bridges the progress events of the local model workers (tiny text models,
 * speech-to-text, text-to-speech) into the download registry: one tracker per
 * in-flight model load, bytes aggregated across the model's files, and
 * side-runtime installs (`pkg@version`) shown as the current step.
 */
import { type DownloadProgressUpdate, type DownloadTracker, trackDownload } from "./activity";

/** Structural subset of the tiny/STT/TTS worker progress events. */
export interface ModelLoadProgressEvent {
	modelKey: string;
	status: "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";
	name?: string;
	file?: string;
	loaded?: number;
	total?: number;
	files?: Record<string, { loaded: number; total: number }>;
}

/**
 * A cache hit reads every file in a short burst right after the load starts;
 * bytes still streaming past this window mean a real network download.
 */
const CACHE_READ_GRACE_MS = 150;

interface ModelLoad {
	startedAt: number;
	/** Per-file bytes, summed for the overall bar. */
	files: Map<string, { loaded: number; total: number }>;
	/** Overall bytes from producers that report only a running total (MLX). */
	aggregate?: { loaded: number; total: number };
	/** Latest file to start; concurrent files would otherwise flip the label every chunk. */
	detail?: string;
	tracker?: DownloadTracker;
}

/**
 * Per-client model load tracking. The client feeds every progress event to
 * {@link observe}; a load ends on `ready`, and on `error` when the client passes
 * the failure reason. Cache hits never create a tracker. A model that fails
 * before reporting any progress (offline first use) still shows its failure,
 * once, until a later load attempt reports progress again.
 */
export class ModelDownloadActivity {
	readonly #loads = new Map<string, ModelLoad>();
	/** How each model's last load ended; errors after `ready` are generation failures, not load failures. */
	readonly #settled = new Map<string, "ready" | "failed">();
	readonly #label: (modelKey: string) => string;

	constructor(label: (modelKey: string) => string) {
		this.#label = label;
	}

	observe(event: ModelLoadProgressEvent, error?: string): void {
		const { modelKey, status } = event;
		if (status === "ready") {
			this.#loads.get(modelKey)?.tracker?.done();
			this.#loads.delete(modelKey);
			this.#settled.set(modelKey, "ready");
			return;
		}
		if (status === "error") {
			const load = this.#loads.get(modelKey);
			if (!load && this.#settled.has(modelKey)) return;
			this.#loads.delete(modelKey);
			this.#settled.set(modelKey, "failed");
			// Worker errors carry stack traces; the row shows the reason line.
			const reason = error?.split("\n", 1)[0] || "model load failed";
			(load?.tracker ?? trackDownload(this.#label(modelKey))).fail(reason);
			return;
		}
		let load = this.#loads.get(modelKey);
		if (!load) {
			load = { startedAt: Date.now(), files: new Map() };
			this.#loads.set(modelKey, load);
			this.#settled.delete(modelKey);
		}
		if (event.file === undefined && event.name !== undefined && status !== "progress_total") {
			// Side-runtime installs (`pkg@version`) and the MLX repo download are
			// announced only when they actually fetch, so they show immediately.
			if (status === "done") return;
			this.#report(modelKey, load, {
				detail: event.name.includes("@") ? `installing ${event.name}` : "downloading",
			});
			return;
		}
		if (event.file && (status === "download" || (status === "progress_total" && !event.files))) {
			load.detail = event.file.slice(event.file.lastIndexOf("/") + 1);
		}
		if (status === "progress_total") {
			if (event.files) {
				for (const file in event.files) load.files.set(file, event.files[file]);
			} else if (event.loaded !== undefined && event.total !== undefined) {
				load.aggregate = { loaded: event.loaded, total: event.total };
			}
		} else if (status === "progress" && event.file && event.loaded !== undefined && event.total !== undefined) {
			load.files.set(event.file, { loaded: event.loaded, total: event.total });
		}
		let loaded = 0;
		let total = 0;
		if (load.aggregate) {
			({ loaded, total } = load.aggregate);
		} else {
			for (const bytes of load.files.values()) {
				loaded += bytes.loaded;
				total += bytes.total;
			}
		}
		if (!load.tracker) {
			const streaming = total > 0 && loaded < total;
			if (!streaming || Date.now() - load.startedAt < CACHE_READ_GRACE_MS) return;
		}
		const update: DownloadProgressUpdate = total > 0 ? { loaded, total } : {};
		if (load.detail) update.detail = load.detail;
		this.#report(modelKey, load, update);
	}

	#report(modelKey: string, load: ModelLoad, update: DownloadProgressUpdate): void {
		if (load.tracker) load.tracker.update(update);
		else load.tracker = trackDownload(this.#label(modelKey), update);
	}
}
