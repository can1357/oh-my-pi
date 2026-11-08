import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";

/** A sherpa-onnx model archive; the release artifact is a `.tar.bz2`. */
export interface SherpaArchiveSpec {
	url: string;
}

export interface SherpaModelProgress {
	status: "download" | "progress" | "done";
	/** File currently being downloaded; absent for the archive extraction phase. */
	file?: string;
	loaded: number;
	total: number;
}

export interface EnsureSherpaModelOptions {
	/** Cache-relative model directory, also used as the Hugging Face repo for file downloads. */
	repo: string;
	files: Record<string, string>;
	directories?: readonly string[];
	archive?: SherpaArchiveSpec;
	onProgress?: (progress: SherpaModelProgress) => void;
	signal?: AbortSignal;
}

const HF_RESOLVE_BASE = "https://huggingface.co";
const PROGRESS_EMIT_BYTES = 4_000_000;

export function sherpaModelDir(repo: string): string {
	return path.join(getTinyModelsCacheDir(), ...repo.split("/"));
}

function isSafeRelativePath(value: string): boolean {
	if (path.isAbsolute(value)) return false;
	const normalized = path.normalize(value);
	return normalized !== ".." && !normalized.startsWith(`..${path.sep}`) && !normalized.includes(`..${path.sep}`);
}

async function isFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/** Whether every required file and directory is present under the model cache. */
export async function isSherpaModelCached(options: {
	repo: string;
	files: Record<string, string>;
	directories?: readonly string[];
}): Promise<boolean> {
	const dir = sherpaModelDir(options.repo);
	for (const filename of Object.values(options.files)) {
		if (!isSafeRelativePath(filename)) return false;
		if (!(await isFile(path.join(dir, filename)))) return false;
	}
	for (const entry of options.directories ?? []) {
		if (!isSafeRelativePath(entry)) return false;
		if (!(await isDirectory(path.join(dir, entry)))) return false;
	}
	return true;
}

async function downloadFile(
	url: string,
	dest: string,
	signal: AbortSignal | undefined,
	onProgress: ((progress: SherpaModelProgress) => void) | undefined,
	name: string,
): Promise<void> {
	const response = await fetch(url, { redirect: "follow", signal });
	if (!response.ok || !response.body) throw new Error(`Failed to download ${name}: HTTP ${response.status}`);
	const total = Number(response.headers.get("content-length") ?? 0);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	const part = `${dest}.part`;
	const handle = await fs.open(part, "w");
	let loaded = 0;
	let lastEmitted = 0;
	onProgress?.({ status: "download", file: name, loaded: 0, total });
	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			await handle.write(value);
			loaded += value.byteLength;
			if (loaded - lastEmitted >= PROGRESS_EMIT_BYTES || (total > 0 && loaded >= total)) {
				lastEmitted = loaded;
				onProgress?.({ status: "progress", file: name, loaded, total: total || loaded });
			}
		}
	} finally {
		await handle.close();
	}
	await fs.rename(part, dest);
}

async function runTar(args: string[]): Promise<string> {
	const proc = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`tar ${args[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
	return stdout;
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
	const output = await runTar(["-tjf", archivePath]);
	return output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

async function extractArchive(archivePath: string, dest: string): Promise<void> {
	const entries = await listArchiveEntries(archivePath);
	if (entries.length === 0) throw new Error(`Model archive is empty: ${archivePath}`);
	for (const entry of entries) {
		if (!isSafeRelativePath(entry)) throw new Error(`Model archive contains an unsafe path: ${entry}`);
	}
	await fs.rm(dest, { recursive: true, force: true });
	await fs.mkdir(dest, { recursive: true });
	await runTar(["-xjf", archivePath, "-C", dest]);
}

async function installArchive(archivePath: string, repoDir: string): Promise<void> {
	const temp = `${repoDir}.extract`;
	await extractArchive(archivePath, temp);
	const topLevel = await fs.readdir(temp);
	const only = topLevel.length === 1 ? path.join(temp, topLevel[0]!) : undefined;
	const source = only && (await isDirectory(only)) ? only : temp;
	await fs.rm(repoDir, { recursive: true, force: true });
	await fs.mkdir(path.dirname(repoDir), { recursive: true });
	await fs.rename(source, repoDir);
	if (source !== temp) await fs.rm(temp, { recursive: true, force: true });
}

async function ensureArchive(options: EnsureSherpaModelOptions, repoDir: string): Promise<void> {
	const archive = options.archive;
	if (!archive) return;
	const archiveDir = path.join(getTinyModelsCacheDir(), ".archives");
	await fs.mkdir(archiveDir, { recursive: true });
	const archiveName = `${options.repo.replaceAll("/", "__")}.tar.bz2`;
	const archivePath = path.join(archiveDir, archiveName);
	if (!(await isFile(archivePath))) {
		await downloadFile(archive.url, archivePath, options.signal, options.onProgress, archiveName);
	}
	await installArchive(archivePath, repoDir);
	await fs.rm(archivePath, { force: true });
	options.onProgress?.({ status: "done", file: archiveName, loaded: 0, total: 0 });
}

async function ensureFiles(options: EnsureSherpaModelOptions, repoDir: string): Promise<void> {
	for (const filename of Object.values(options.files)) {
		if (!isSafeRelativePath(filename)) throw new Error(`Unsafe model file path: ${filename}`);
		const dest = path.join(repoDir, filename);
		if (await isFile(dest)) continue;
		const url = `${HF_RESOLVE_BASE}/${options.repo}/resolve/main/${filename}`;
		await downloadFile(url, dest, options.signal, options.onProgress, filename);
	}
	options.onProgress?.({ status: "done", loaded: 0, total: 0 });
}

/**
 * Ensure a sherpa-onnx model's files exist in the shared tiny-model cache.
 * Archives are preferred when the release only publishes a `.tar.bz2`; otherwise
 * individual files are streamed from the Hugging Face repository.
 */
export async function ensureSherpaModelFiles(options: EnsureSherpaModelOptions): Promise<Record<string, string>> {
	const repoDir = sherpaModelDir(options.repo);
	await fs.mkdir(repoDir, { recursive: true });
	if (await isSherpaModelCached(options)) {
		return Object.fromEntries(Object.entries(options.files).map(([key, file]) => [key, path.join(repoDir, file)]));
	}
	try {
		if (options.archive) await ensureArchive(options, repoDir);
		else await ensureFiles(options, repoDir);
		if (!(await isSherpaModelCached(options))) {
			throw new Error(`Model download finished without the required files (${options.repo}).`);
		}
	} catch (error) {
		await fs.rm(repoDir, { recursive: true, force: true });
		throw error;
	}
	return Object.fromEntries(Object.entries(options.files).map(([key, file]) => [key, path.join(repoDir, file)]));
}
