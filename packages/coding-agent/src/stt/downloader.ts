import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";
import { sttClient } from "./asr-client";
import type { SttProgressStatus } from "./asr-protocol";
import { resolveSttModelSpec } from "./models";

export interface DownloadProgress {
	stage: string;
	percent?: number;
}

export interface EnsureOptions {
	modelName?: string;
	signal?: AbortSignal;
	onProgress?: (progress: DownloadProgress) => void;
}

// ── ONNX Whisper model ─────────────────────────────────────────────

/**
 * Real-progress event for a speech-model download, surfaced to UI callers.
 * `percent` is an integer 0–100 aggregated across all model files (encoder +
 * decoder shards), so it advances monotonically toward completion.
 */
export interface SttDownloadProgress {
	status: SttProgressStatus;
	/** Integer 0–100 aggregated across files. */
	percent: number;
	/** Bytes downloaded so far across all files. */
	loaded: number;
	/** Total bytes across all files seen so far. */
	total: number;
	/** The file currently downloading, when known. */
	file?: string;
	repo: string;
	label: string;
}

/**
 * Whether the selected model is fully present in the local cache. For
 * transformers.js Whisper tiers a complete download leaves `config.json` plus
 * matching `encoder*.onnx` and `decoder*.onnx` shards under `onnx/` (a partial
 * fetch with only one shard, or a bare `config.json`, reads as not-cached); for
 * sherpa-onnx tiers every model file (encoder/decoder/joiner + tokens) must be
 * present (`.part` sidecars from an interrupted fetch are ignored).
 */
export async function isSttModelCached(key: string): Promise<boolean> {
	const spec = resolveSttModelSpec(key);
	const repoDir = path.join(getTinyModelsCacheDir(), spec.repo);
	if (spec.engine === "sherpa") {
		try {
			const root = new Set(await fs.readdir(repoDir));
			for (const role in spec.files) {
				if (!root.has(spec.files[role as keyof typeof spec.files])) return false;
			}
			return true;
		} catch {
			return false;
		}
	}
	try {
		const root = await fs.readdir(repoDir);
		if (!root.includes("config.json")) return false;
		// Whisper tiers are encoder-decoder: a complete download leaves both an
		// `encoder*.onnx` and a `decoder*.onnx` (the dtype suffix varies). Require
		// both rather than any single `.onnx`, so an interrupted fetch that landed
		// only one shard reads as not-cached and the caller takes the foreground
		// download path with progress instead of silently fetching mid-recording.
		const onnxFiles = await fs.readdir(path.join(repoDir, "onnx")).catch(() => [] as string[]);
		const hasEncoder = onnxFiles.some(file => file.startsWith("encoder") && file.endsWith(".onnx"));
		const hasDecoder = onnxFiles.some(file => file.startsWith("decoder") && file.endsWith(".onnx"));
		return hasEncoder && hasDecoder;
	} catch {
		return false;
	}
}

/**
 * Download (or warm from cache) the selected ONNX Whisper model via the speech
 * worker, resolving once the model is fully present and loaded. Streams real
 * Hub progress with an aggregated integer percent. Rejects if the worker cannot
 * obtain the model. Safe to call non-interactively.
 */
export async function downloadSttModel(
	key: string,
	onProgress?: (progress: SttDownloadProgress) => void,
	options?: { signal?: AbortSignal },
): Promise<void> {
	const spec = resolveSttModelSpec(key);
	const files = new Map<string, { loaded: number; total: number }>();
	const result = await sttClient.downloadModel(spec.key, {
		signal: options?.signal,
		onProgress: event => {
			if ((event.status === "progress" || event.status === "progress_total") && event.file) {
				if (typeof event.loaded === "number" && typeof event.total === "number" && event.total > 0) {
					files.set(event.file, { loaded: event.loaded, total: event.total });
				}
			}
			let loaded = 0;
			let total = 0;
			for (const file of files.values()) {
				loaded += file.loaded;
				total += file.total;
			}
			const settled = event.status === "ready" || event.status === "done";
			const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : settled ? 100 : 0;
			onProgress?.({
				status: event.status,
				percent,
				loaded,
				total,
				file: event.file,
				repo: spec.repo,
				label: spec.label,
			});
		},
	});
	if (!result.ok) {
		const detail = result.error ? `: ${result.error}` : ". Check your network connection.";
		throw new Error(`Failed to download speech model (${spec.repo})${detail}`);
	}
	if (!(await isSttModelCached(spec.key))) {
		throw new Error(`Speech model download finished without required files (${spec.repo}).`);
	}
}

// ── Public API ─────────────────────────────────────────────────────

export async function ensureSTTDependencies(options?: EnsureOptions): Promise<void> {
	await downloadSttModel(
		resolveSttModelSpec(options?.modelName).key,
		progress => {
			const stage =
				progress.status === "ready" || progress.status === "done"
					? `Speech model ${progress.label} ready`
					: `Downloading speech model ${progress.label}`;
			options?.onProgress?.({ stage, percent: progress.percent });
		},
		{ signal: options?.signal },
	);
}
