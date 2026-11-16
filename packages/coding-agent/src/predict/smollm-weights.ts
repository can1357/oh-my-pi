import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir, logger } from "@oh-my-pi/pi-utils";
import { withDownload } from "../downloads/activity";
import { installPinnedHubFiles, type PinnedHubFile, pinnedHubFilesReady } from "../downloads/pinned-hub-files";

/**
 * On-demand weights for the `smollm` word-completion engine
 * (`pi_predict::smollm`): the SmolLM2-135M base checkpoint (Apache-2.0), every
 * file pinned to one repo revision and verified by size and SHA-256.
 *
 * Format: `config.json` and `tokenizer.json` from the upstream repo, and the
 * weights as llama.cpp's `Q8_0` GGUF export (145 MB; 32 weights per 8-bit
 * block with an f16 scale) from QuantFactory/SmolLM2-135M-GGUF, which both
 * decoders run as stored. Provenance, checked against the upstream bf16
 * `model.safetensors` (269 MB): every `Q8_0` block is byte-identical to
 * quantizing it (after llama.cpp's q/k row permutation, which the loader
 * undoes) and the F32 norms are equal, so replay quality matches the bf16
 * research runs.
 *
 * Layout follows the tiny-model cache: `<tiny-models>/predict/<org>--<name>/`,
 * installed through {@link installPinnedHubFiles}, so an install of other
 * files (e.g. the bf16 weights) reads as not ready.
 *
 * Only interactive processes download (the composer on first use through
 * {@link prefetchSmolLmWeights}, shown in the download HUD, or
 * `omp tiny-models download smollm`); the prediction daemon just checks
 * {@link smolLmWeightsReady} and serves ngram until then.
 */

/** Human label for the weights (HUD, CLI). */
export const SMOLLM_LABEL = "SmolLM2-135M";
/** Upstream repo; also names the model dir. */
const SMOLLM_REPO = "HuggingFaceTB/SmolLM2-135M";
const SMOLLM_REVISION = "93efa2f097d58c2a74874c7e644dbc9b0cee75a2";
const GGUF_REPO = "QuantFactory/SmolLM2-135M-GGUF";
const GGUF_REVISION = "d948db3614be18259a175aafd7689a70f1cb4e2f";

/** Everything `pi_predict::smollm::open` reads from the model dir. */
const SMOLLM_FILES: readonly PinnedHubFile[] = [
	{
		repo: SMOLLM_REPO,
		revision: SMOLLM_REVISION,
		source: "config.json",
		target: "config.json",
		size: 704,
		sha256: "1d556eab73b69c7f11f64c557a2f9c6f440bd4c6b89bb2584a6b498c92603843",
	},
	{
		repo: SMOLLM_REPO,
		revision: SMOLLM_REVISION,
		source: "tokenizer.json",
		target: "tokenizer.json",
		size: 2_104_556,
		sha256: "9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c",
	},
	{
		repo: GGUF_REPO,
		revision: GGUF_REVISION,
		source: "SmolLM2-135M.Q8_0.gguf",
		target: "SmolLM2-135M.Q8_0.gguf",
		size: 144_810_464,
		sha256: "b761d9ccdfce67726e41ca2ef30e9dfbcf6a32ca2aaef47df5c049ec362d04cd",
	},
];

/** Files of earlier installs, removed once the current set is in place. */
const OBSOLETE_FILES = ["model.safetensors"];

/** Total download size in bytes. */
export const SMOLLM_TOTAL_BYTES = SMOLLM_FILES.reduce((sum, file) => sum + file.size, 0);

/** Directory `ensureSmolLmWeights` fills. */
export function getSmolLmModelDir(): string {
	return path.join(getTinyModelsCacheDir(), "predict", SMOLLM_REPO.replace("/", "--"));
}

/** Whether the pinned weights are fully downloaded and verified (one small file read). */
export async function smolLmWeightsReady(): Promise<boolean> {
	return pinnedHubFilesReady(getSmolLmModelDir(), SMOLLM_FILES);
}

/** Options for {@link ensureSmolLmWeights}. */
export interface EnsureSmolLmWeightsOptions {
	signal?: AbortSignal;
	/** Bytes present so far out of {@link SMOLLM_TOTAL_BYTES}, and the file being fetched. */
	onProgress?: (loaded: number, file: string) => void;
}

/**
 * Ensure the pinned SmolLM2-135M files are present and verified, downloading
 * any that are missing or corrupt, and return the model directory to pass as
 * `TextPredictorOptions.modelDir`. Cross-process safe via an OS file lock.
 *
 * @throws when a download fails, is aborted through `signal`, or does not
 * match the pinned size/digest.
 */
export async function ensureSmolLmWeights(options: EnsureSmolLmWeightsOptions = {}): Promise<string> {
	const { signal, onProgress } = options;
	const dir = getSmolLmModelDir();
	if (await pinnedHubFilesReady(dir, SMOLLM_FILES)) return dir;
	await installPinnedHubFiles(dir, SMOLLM_FILES, {
		signal,
		onProgress: progress => onProgress?.(progress.totalLoaded, progress.target),
	});
	onProgress?.(SMOLLM_TOTAL_BYTES, "verified");
	// Engines read their weights at load, so a running one is unaffected.
	for (const name of OBSOLETE_FILES) await fs.rm(path.join(dir, name), { force: true });
	return dir;
}

/** After a failed background fetch, wait this long before the next attempt. */
const PREFETCH_RETRY_MS = 10 * 60_000;
let prefetching = false;
let prefetchRetryAt = 0;
let weightsReady = false;

/**
 * Start fetching the weights in the background, shown in the download HUD,
 * unless they are ready, already downloading, or a failure is backing off.
 * Called by the composer's word-completion backend on each `smollm`
 * request, so the fetch starts on first use; cheap after that.
 */
export function prefetchSmolLmWeights(): void {
	if (weightsReady || prefetching || Date.now() < prefetchRetryAt) return;
	prefetching = true;
	void (async () => {
		if (await smolLmWeightsReady()) return;
		await withDownload(
			SMOLLM_LABEL,
			tracker => ensureSmolLmWeights({ onProgress: (loaded, file) => tracker.update({ loaded, detail: file }) }),
			{ loaded: 0, total: SMOLLM_TOTAL_BYTES, detail: "word completion model" },
		);
	})()
		.then(
			() => {
				weightsReady = true;
			},
			(error: unknown) => {
				prefetchRetryAt = Date.now() + PREFETCH_RETRY_MS;
				logger.warn("smollm weights: download failed; word completion stays on n-gram", {
					error: String(error),
				});
			},
		)
		.finally(() => {
			prefetching = false;
		});
}
