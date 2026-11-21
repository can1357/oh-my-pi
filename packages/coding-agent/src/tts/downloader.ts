import { pinnedHubFilesReady } from "../downloads/pinned-hub-files";
import { getTtsModelDir } from "./checkpoint";
import { getTtsLocalModelSpec } from "./models";
import { ttsClient } from "./tts-client";

export interface TtsDownloadProgress {
	stage: string;
	/** Integer 0–100 download percent when known. */
	percent?: number;
}

/** Whether the selected local TTS model's pinned checkpoint is installed and verified. */
export async function isTtsModelCached(modelKey: string): Promise<boolean> {
	const spec = getTtsLocalModelSpec(modelKey);
	if (!spec) return false;
	return pinnedHubFilesReady(getTtsModelDir(spec), spec.files);
}

/**
 * Ensure the selected local TTS model is installed (and warm in the worker),
 * reporting integer-percent progress across every checkpoint file. The worker
 * resolves the request once the model has loaded. Returns `false` if the
 * worker is unavailable or the download failed.
 */
export async function downloadTtsModel(
	modelKey: string,
	onProgress?: (progress: TtsDownloadProgress) => void,
	signal?: AbortSignal,
): Promise<boolean> {
	const spec = getTtsLocalModelSpec(modelKey);
	if (!spec) return false;
	const totalBytes = spec.files.reduce((sum, file) => sum + file.size, 0);
	const fileBytes = new Map<string, number>();
	onProgress?.({ stage: `Preparing ${spec.label}...` });
	return ttsClient.downloadModel(spec.key, {
		signal,
		onProgress: event => {
			if (event.status === "ready") {
				onProgress?.({ stage: `${spec.label} ready`, percent: 100 });
				return;
			}
			if (event.file === undefined || event.loaded === undefined) return;
			fileBytes.set(event.file, event.loaded);
			let loaded = 0;
			for (const bytes of fileBytes.values()) loaded += bytes;
			onProgress?.({ stage: `Downloading ${spec.label}`, percent: Math.round((loaded / totalBytes) * 100) });
		},
	});
}
