/**
 * Pinned Hugging Face file installs for on-device model weights (SmolLM2
 * word completion, the local TTS checkpoint): every file fetched from one repo
 * revision and verified by size and SHA-256, installed under a cross-process
 * lock as `.part` downloads renamed into place, and stamped with a ready
 * marker listing every digest, so a warm start is one small read and any
 * change to the pinned set reads as not ready.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import { sha256File } from "../utils/file-hash";
import { downloadFile } from "../utils/tools-manager";

/** One file fetched from `repo` at `revision` into the install directory. */
export interface PinnedHubFile {
	repo: string;
	revision: string;
	/** Path inside the repo. */
	source: string;
	/** Path inside the install directory. */
	target: string;
	size: number;
	sha256: string;
}

/** Bytes fetched so far: of the file being fetched, and across the whole set. */
export interface PinnedHubFileProgress {
	target: string;
	loaded: number;
	size: number;
	totalLoaded: number;
}

/** Options for {@link installPinnedHubFiles}. */
export interface InstallPinnedHubFilesOptions {
	signal?: AbortSignal;
	onProgress?: (progress: PinnedHubFileProgress) => void;
}

const HF_RESOLVE_BASE = "https://huggingface.co";
const READY_MARKER = ".omp-ready";
/** Whole-file transfer bound, sized for weight files of a few hundred MB. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** Ready-marker content: changes whenever a pinned file does. */
function readyStamp(files: readonly PinnedHubFile[]): string {
	return files.map(file => `${file.target} ${file.sha256}`).join("\n");
}

async function readReadyMarker(dir: string): Promise<string | null> {
	try {
		return (await Bun.file(path.join(dir, READY_MARKER)).text()).trim();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function hasVerifiedFile(filePath: string, file: PinnedHubFile): Promise<boolean> {
	try {
		if ((await fs.stat(filePath)).size !== file.size) return false;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	return (await sha256File(filePath)) === file.sha256;
}

async function fetchVerified(
	dir: string,
	file: PinnedHubFile,
	signal: AbortSignal | undefined,
	onBytes: (loaded: number) => void,
): Promise<void> {
	const target = path.join(dir, file.target);
	if (await hasVerifiedFile(target, file)) return;
	const part = `${target}.part`;
	const url = `${HF_RESOLVE_BASE}/${file.repo}/resolve/${file.revision}/${file.source}`;
	const startedAt = performance.now();
	logger.debug("pinned hub files: downloading", { url, bytes: file.size });
	await fs.mkdir(path.dirname(target), { recursive: true });
	try {
		await downloadFile(url, part, { signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, onProgress: onBytes });
		const { size } = await fs.stat(part);
		if (size !== file.size) throw new Error(`${file.target}: expected ${file.size} bytes, received ${size}`);
		const digest = await sha256File(part);
		if (digest !== file.sha256) throw new Error(`${file.target}: SHA-256 mismatch (${digest})`);
		// Rename, never rewrite in place: a running engine may have the old file mapped.
		await fs.rename(part, target);
	} catch (error) {
		await fs.rm(part, { force: true });
		throw error;
	}
	logger.debug("pinned hub files: downloaded", {
		file: file.target,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
}

/** Whether every file of `files` is installed and verified in `dir` (one small file read). */
export async function pinnedHubFilesReady(dir: string, files: readonly PinnedHubFile[]): Promise<boolean> {
	return (await readReadyMarker(dir)) === readyStamp(files);
}

/**
 * Ensure every file of `files` is present and verified in `dir`, downloading
 * any that are missing or corrupt. Cross-process safe via an OS file lock.
 *
 * @throws when a download fails, is aborted through `signal`, or does not
 * match its pinned size/digest.
 */
export async function installPinnedHubFiles(
	dir: string,
	files: readonly PinnedHubFile[],
	options: InstallPinnedHubFilesOptions = {},
): Promise<void> {
	const { signal, onProgress } = options;
	const stamp = readyStamp(files);
	if ((await readReadyMarker(dir)) === stamp) return;
	await fs.mkdir(dir, { recursive: true });
	await withFileLock(`${dir}.install`, async () => {
		if ((await readReadyMarker(dir)) === stamp) return;
		let finished = 0;
		for (const file of files) {
			signal?.throwIfAborted();
			const report = (loaded: number) =>
				onProgress?.({ target: file.target, loaded, size: file.size, totalLoaded: finished + loaded });
			report(0);
			await fetchVerified(dir, file, signal, report);
			finished += file.size;
			report(file.size);
		}
		await Bun.write(path.join(dir, READY_MARKER), `${stamp}\n`);
		logger.debug("pinned hub files: ready", { dir, files: files.map(file => file.target) });
	});
}
