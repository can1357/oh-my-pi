import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir, isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import { downloadFile } from "../utils/tools-manager";

/**
 * On-demand weights for the `smollm` word-completion engine
 * (`pi_predict::smollm`): the upstream SmolLM2-135M base checkpoint
 * (Apache-2.0), pinned to one revision and verified by size and SHA-256.
 *
 * Format: the original bf16 `model.safetensors` (269 MB). candle converts it at
 * load (f16 on Metal, f32 on CPU), so there is no quality loss against the
 * research runs; a 4-bit export would be ~75–90 MB but changes the logits the
 * engine's confidence gate was tuned on.
 *
 * Layout follows the tiny-model cache: `<tiny-models>/predict/<org>--<name>/`,
 * a cross-process install lock next to it, `.part` downloads renamed into
 * place, and a ready marker holding the revision so a warm start is one read.
 */

const SMOLLM_REPO = "HuggingFaceTB/SmolLM2-135M";
const SMOLLM_REVISION = "93efa2f097d58c2a74874c7e644dbc9b0cee75a2";
const HF_RESOLVE_BASE = "https://huggingface.co";
const READY_MARKER = ".omp-ready";
/** Whole-file transfer bound; the safetensors file is 269 MB. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

interface WeightFile {
	name: string;
	size: number;
	sha256: string;
}

/** Everything `pi_predict::smollm::open` reads from the model dir. */
const SMOLLM_FILES: readonly WeightFile[] = [
	{ name: "config.json", size: 704, sha256: "1d556eab73b69c7f11f64c557a2f9c6f440bd4c6b89bb2584a6b498c92603843" },
	{
		name: "tokenizer.json",
		size: 2_104_556,
		sha256: "9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c",
	},
	{
		name: "model.safetensors",
		size: 269_060_552,
		sha256: "80521b40281d6ce74e35c9282c22539e75aa0ac8578892b2a59955ef78d55da1",
	},
];

/** Directory `ensureSmolLmWeights` fills. */
export function getSmolLmModelDir(): string {
	return path.join(getTinyModelsCacheDir(), "predict", SMOLLM_REPO.replace("/", "--"));
}

async function readReadyMarker(dir: string): Promise<string | null> {
	try {
		return (await Bun.file(path.join(dir, READY_MARKER)).text()).trim();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function hasVerifiedFile(filePath: string, file: WeightFile): Promise<boolean> {
	try {
		if ((await fs.stat(filePath)).size !== file.size) return false;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	return (await sha256File(filePath)) === file.sha256;
}

async function fetchVerified(dir: string, file: WeightFile, signal: AbortSignal | undefined): Promise<void> {
	const target = path.join(dir, file.name);
	if (await hasVerifiedFile(target, file)) return;
	const part = `${target}.part`;
	const url = `${HF_RESOLVE_BASE}/${SMOLLM_REPO}/resolve/${SMOLLM_REVISION}/${file.name}`;
	const startedAt = performance.now();
	logger.debug("smollm weights: downloading", { url, bytes: file.size });
	try {
		await downloadFile(url, part, signal, DOWNLOAD_TIMEOUT_MS);
		const { size } = await fs.stat(part);
		if (size !== file.size) throw new Error(`${file.name}: expected ${file.size} bytes, received ${size}`);
		const digest = await sha256File(part);
		if (digest !== file.sha256) throw new Error(`${file.name}: SHA-256 mismatch (${digest})`);
		// Rename, never rewrite in place: a running engine may have the old file mapped.
		await fs.rename(part, target);
	} catch (error) {
		await fs.rm(part, { force: true });
		throw error;
	}
	logger.debug("smollm weights: downloaded", {
		file: file.name,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
}

/**
 * Ensure the pinned SmolLM2-135M files are present and verified, downloading
 * any that are missing or corrupt, and return the model directory to pass as
 * `TextPredictorOptions.modelDir`. Cross-process safe via an OS file lock.
 *
 * @throws when a download fails, is aborted through `signal`, or does not
 * match the pinned size/digest.
 */
export async function ensureSmolLmWeights(signal?: AbortSignal): Promise<string> {
	const dir = getSmolLmModelDir();
	if ((await readReadyMarker(dir)) === SMOLLM_REVISION) return dir;
	await fs.mkdir(dir, { recursive: true });
	return withFileLock(`${dir}.install`, async () => {
		if ((await readReadyMarker(dir)) === SMOLLM_REVISION) return dir;
		for (const file of SMOLLM_FILES) {
			signal?.throwIfAborted();
			await fetchVerified(dir, file, signal);
		}
		await Bun.write(path.join(dir, READY_MARKER), `${SMOLLM_REVISION}\n`);
		logger.debug("smollm weights: ready", { dir, revision: SMOLLM_REVISION });
		return dir;
	});
}
