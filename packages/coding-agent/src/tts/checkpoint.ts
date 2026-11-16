/**
 * On-disk checkpoints of the local TTS models: `<tiny-models>/tts/<key>/`,
 * filled with the model's pinned files by {@link installPinnedHubFiles}. The
 * TTS worker installs on first load; `omp setup speech` drives the same path
 * through the worker's `download` request.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir, logger } from "@oh-my-pi/pi-utils";
import { installPinnedHubFiles, type PinnedHubFileProgress } from "../downloads/pinned-hub-files";
import type { TtsLocalModelSpec } from "./models";

/** Directory `PhononTts.load` reads a model's checkpoint from. */
export function getTtsModelDir(spec: TtsLocalModelSpec): string {
	return path.join(getTinyModelsCacheDir(), "tts", spec.key);
}

/**
 * Caches of the Kokoro-82M backend this checkpoint replaced: its
 * transformers.js weights and the `kokoro-js` side runtime.
 */
function obsoleteTtsCaches(): string[] {
	const tinyModels = getTinyModelsCacheDir();
	return [
		path.join(tinyModels, "onnx-community", "Kokoro-82M-v1.0-ONNX"),
		path.join(tinyModels, "onnx-community_Kokoro-82M-v1.0-ONNX"),
		path.join(path.dirname(tinyModels), "tts-runtime"),
	];
}

/**
 * Ensure `spec`'s checkpoint is installed and verified, then drop the
 * obsolete Kokoro caches, and return the model directory.
 *
 * @throws when a download fails or a file does not match its pinned digest.
 */
export async function ensureTtsCheckpoint(
	spec: TtsLocalModelSpec,
	onProgress?: (progress: PinnedHubFileProgress) => void,
): Promise<string> {
	const dir = getTtsModelDir(spec);
	await installPinnedHubFiles(dir, spec.files, { onProgress });
	for (const obsolete of obsoleteTtsCaches()) {
		await fs.rm(obsolete, { recursive: true, force: true }).catch((error: unknown) => {
			logger.debug("tts: could not remove obsolete cache", { path: obsolete, error: String(error) });
		});
	}
	return dir;
}
