import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";
import { getTtsLocalModelSpec } from "./models";
import { isTtsRuntimeCached } from "./runtime";
import { ttsClient } from "./tts-client";

export interface TtsDownloadProgress {
	stage: string;
	/** Integer 0–100 download percent when known. */
	percent?: number;
}

/**
 * Whether the selected local TTS model and the side Kokoro runtime are already
 * present. transformers.js stores `main`-revision files at
 * `<cacheDir>/<repo>/...`, so any `.onnx` weight under the repo dir means the
 * model weights can load without a network fetch; the Kokoro package runtime is
 * version-keyed separately and must also exist before setup can report ready.
 */
export async function isTtsModelCached(modelKey: string): Promise<boolean> {
	const spec = getTtsLocalModelSpec(modelKey);
	if (!spec) return false;
	const repoDir = path.join(getTinyModelsCacheDir(), ...spec.repo.split("/"));
	try {
		const entries = await fs.readdir(repoDir, { recursive: true });
		const hasWeights = entries.some(entry => typeof entry === "string" && entry.endsWith(".onnx"));
		return hasWeights && (await isTtsRuntimeCached());
	} catch {
		return false;
	}
}

/**
 * Ensure the selected local TTS model is downloaded into the transformers.js
 * cache (and warm in the worker), streaming integer-percent Hub progress. The
 * worker resolves the request once every model file is cached. Returns `false`
 * if the worker is unavailable or the download failed.
 */
export async function downloadTtsModel(
	modelKey: string,
	onProgress?: (progress: TtsDownloadProgress) => void,
	signal?: AbortSignal,
): Promise<boolean> {
	const spec = getTtsLocalModelSpec(modelKey);
	if (!spec) return false;
	onProgress?.({ stage: `Preparing ${spec.label}...` });
	return ttsClient.downloadModel(spec.key, {
		signal,
		onProgress: event => {
			if (event.status === "ready" || event.status === "done") {
				onProgress?.({ stage: `${spec.label} ready`, percent: 100 });
				return;
			}
			const percent =
				typeof event.total === "number" && event.total > 0 && typeof event.loaded === "number"
					? Math.round((event.loaded / event.total) * 100)
					: typeof event.progress === "number"
						? Math.round(event.progress)
						: undefined;
			onProgress?.({ stage: `Downloading ${spec.label}`, percent });
		},
	});
}
