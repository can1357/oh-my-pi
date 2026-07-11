import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent, logger, peekFileEnds, Snowflake, toError } from "@pk-nerdsaver-ai/pi-utils";

const utf8Decoder = new TextDecoder("utf-8");

export interface SessionStorageStat {
	size: number;
	mtimeMs: number;
	mtime: Date;
}

export interface SessionStorageWriter {
	/**
	 * Append one newline-terminated line. File and memory storage perform the
	 * write synchronously in-body; indexed backends queue in call order.
	 *
	 * `line` MUST include the trailing newline.
	 */
	append(line: string): Promise<void>;
	/** Resolve once all queued appends complete. No fsync. */
	flush(): Promise<void>;
	/** False once close() has begun/finished. */
	isOpen(): boolean;
	close(): Promise<void>;
	getError(): Error | undefined;
}

export interface SessionStorage {
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	writeTextSync(path: string, content: string): void;
	statSync(path: string): SessionStorageStat;
	listFilesSync(dir: string, pattern: string): string[];

	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;
	/** Read the requested UTF-8 byte windows from the head and tail of the file. */
	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	writeText(path: string, content: string): Promise<void>;
	writeTextAtomic(path: string, content: string): Promise<void>;
	rename(path: string, nextPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter;
}

// FinalizationRegistry to clean up leaked file descriptors
const writerRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {
		// Ignore - fd may already be closed or invalid
	}
});

class FileSessionStorageWriter implements SessionStorageWriter {
	#fd: number;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(fpath: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		this.#onError = options?.onError;
		const flags = options?.flags ?? "a";
		// Ensure parent directory exists
		const dir = path.dirname(fpath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Open file once, keep fd for lifetime
		this.#fd = fs.openSync(fpath, flags === "w" ? "w" : "a");
		// Register for cleanup if abandoned without close()
		writerRegistry.register(this, this.#fd, this);
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	async append(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			const buf = Buffer.from(line, "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// Unregister from finalization - we're closing properly
		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch {
			// Ignore close errors
		}
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

export class FileSessionStorage implements SessionStorage {
	ensureDirSync(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	existsSync(path: string): boolean {
		return fs.existsSync(path);
	}

	writeTextSync(fpath: string, content: string): void {
		const dir = path.dirname(fpath);
		this.ensureDirSync(dir);
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		try {
			fs.writeFileSync(tempPath, content);
			fs.renameSync(tempPath, fpath);
		} catch (err) {
			try {
				if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
			} catch (cleanupErr) {
				if (!isEnoent(cleanupErr)) {
					logger.warn("Failed to remove session rewrite temp file", {
						sessionFile: fpath,
						tempPath,
						error: toError(cleanupErr).message,
					});
				}
			}
			if (hasFsCode(err, "EPERM")) {
				fs.writeFileSync(fpath, content);
				return;
			}
			throw toError(err);
		}
	}

	statSync(path: string): SessionStorageStat {
		const stats = fs.statSync(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs, mtime: stats.mtime };
	}

	listFilesSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
		} catch {
			return [];
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return peekFileEnds(path, prefixBytes, suffixBytes, (head, tail) => [
			utf8Decoder.decode(head),
			utf8Decoder.decode(tail),
		]);
	}

	async writeText(path: string, content: string): Promise<void> {
		await Bun.write(path, content, { createPath: true });
	}

	async writeTextAtomic(fpath: string, content: string): Promise<void> {
		const dir = path.resolve(fpath, "..");
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		await fs.promises.mkdir(dir, { recursive: true });
		try {
			await fs.promises.writeFile(tempPath, content);
			try {
				await this.rename(tempPath, fpath);
				return;
			} catch (err) {
				if (!hasFsCode(err, "EPERM")) throw toError(err);
				await this.#replaceSessionFileAfterEperm(tempPath, fpath, err);
				return;
			}
		} catch (err) {
			try {
				await this.unlink(tempPath);
			} catch (cleanupErr) {
				if (!isEnoent(cleanupErr)) {
					logger.warn("Failed to remove session rewrite temp file", {
						sessionFile: fpath,
						tempPath,
						error: toError(cleanupErr).message,
					});
				}
			}
			throw toError(err);
		}
	}

	async #replaceSessionFileAfterEperm(tempPath: string, targetPath: string, renameError: unknown): Promise<void> {
		const dir = path.resolve(targetPath, "..");
		const backupPath = path.join(dir, `${path.basename(targetPath)}.${Snowflake.next()}.bak`);
		try {
			await this.rename(targetPath, backupPath);
		} catch (moveAsideError) {
			if (isEnoent(moveAsideError)) {
				await this.rename(tempPath, targetPath);
				return;
			}
			throw toError(renameError);
		}
		try {
			await this.rename(tempPath, targetPath);
		} catch (replaceError) {
			try {
				await this.rename(backupPath, targetPath);
			} catch (rollbackErr) {
				const rollbackError = toError(rollbackErr);
				throw new Error(
					`Failed to replace session file after EPERM (original: ${toError(renameError).message}; retry: ${
						toError(replaceError).message
					}; rollback: ${rollbackError.message})`,
					{ cause: toError(renameError) },
				);
			}
			throw toError(replaceError);
		}
		try {
			await this.unlink(backupPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite backup", {
					sessionFile: targetPath,
					backupPath,
					error: toError(err).message,
				});
			}
		}
	}

	async rename(path: string, nextPath: string): Promise<void> {
		try {
			await fs.promises.rename(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	unlink(path: string): Promise<void> {
		return fs.promises.unlink(path);
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new FileSessionStorageWriter(path, options);
	}

	/**
	 * Delete a session file and its artifacts directory.
	 * Artifacts are stored in a sibling directory with the same name minus .jsonl extension.
	 */
	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		// Delete the session file itself
		await this.unlink(sessionPath);

		// Compute artifacts directory: /path/to/session.jsonl -> /path/to/session
		const artifactsDir = sessionPath.slice(0, -6);

		// Delete artifacts directory if it exists. Missing directories are fine, but
		// surface real cleanup failures because the session file is already gone.
		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{
					cause: error,
				},
			);
		}
	}
}

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		return name.endsWith(pattern.slice(1));
	}
	return name === pattern;
}

class MemorySessionStorageWriter implements SessionStorageWriter {
	#storage: MemorySessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(
		storage: MemorySessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		if ((options?.flags ?? "a") === "w") {
			this.#storage.writeTextSync(path, "");
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	async append(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			// O(1) append — push onto the path's indexed in-memory entry.
			this.#storage.appendSync(this.#path, line);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

interface MemoryFileEntry {
	chunks: string[];
	cumulativeBytes: number[];
	size: number;
	mtimeMs: number;
}

function createMemoryFileEntry(content: string, mtimeMs: number): MemoryFileEntry {
	const size = Buffer.byteLength(content, "utf-8");
	return {
		chunks: size === 0 ? [] : [content],
		cumulativeBytes: size === 0 ? [] : [size],
		size,
		mtimeMs,
	};
}

function appendMemoryChunk(entry: MemoryFileEntry, chunk: string): void {
	const chunkSize = Buffer.byteLength(chunk, "utf-8");
	if (chunkSize === 0) return;
	entry.size += chunkSize;
	entry.chunks.push(chunk);
	entry.cumulativeBytes.push(entry.size);
}

function normalizeByteLimit(maxBytes: number, size: number): number {
	if (!(maxBytes > 0) || size === 0) return 0;
	return Math.min(Math.trunc(maxBytes), size);
}

function lowerBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function upperBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] <= target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function joinChunkRange(chunks: readonly string[], start: number, end: number): string {
	const count = end - start;
	if (count <= 0) return "";
	if (count === 1) return chunks[start] ?? "";

	let content = "";
	for (let i = start; i < end; i++) {
		content += chunks[i];
	}
	return content;
}

function decodeChunkByteRange(chunk: string, startByte: number, endByte: number, chunkSize: number): string {
	if (startByte >= endByte) return "";
	if (startByte === 0 && endByte === chunkSize) return chunk;
	if (chunk.length === chunkSize) return chunk.slice(startByte, endByte);
	const bytes = Buffer.from(chunk, "utf-8");
	return utf8Decoder.decode(bytes.subarray(startByte, endByte));
}

function materializeMemoryEntry(entry: MemoryFileEntry): string {
	const { chunks } = entry;
	if (chunks.length === 0) return "";
	if (chunks.length === 1) return chunks[0];

	const content = chunks.join("");
	entry.chunks = [content];
	entry.cumulativeBytes = [entry.size];
	return content;
}

function sliceChunksHead(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const boundaryIndex = lowerBound(entry.cumulativeBytes, limit);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	if (chunkEnd === limit) return joinChunkRange(entry.chunks, 0, boundaryIndex + 1);

	const chunk = entry.chunks[boundaryIndex];
	const chunkPrefix = decodeChunkByteRange(chunk, 0, limit - chunkStart, chunkEnd - chunkStart);
	return joinChunkRange(entry.chunks, 0, boundaryIndex) + chunkPrefix;
}

function sliceChunksTail(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const startByte = entry.size - limit;
	const boundaryIndex = upperBound(entry.cumulativeBytes, startByte);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	const chunkOffset = startByte - chunkStart;
	if (chunkOffset === 0) return joinChunkRange(entry.chunks, boundaryIndex, entry.chunks.length);

	const chunk = entry.chunks[boundaryIndex];
	const chunkSuffix = decodeChunkByteRange(chunk, chunkOffset, chunkEnd - chunkStart, chunkEnd - chunkStart);
	return chunkSuffix + joinChunkRange(entry.chunks, boundaryIndex + 1, entry.chunks.length);
}

export class MemorySessionStorage implements SessionStorage {
	// Each path keeps appended string chunks plus cumulative UTF-8 byte offsets.
	// Full reads materialize the chunks into one string chunk, so repeated reads
	// do not re-join stale history. Later appends still stay O(1) by pushing
	// after that materialized chunk. Prefix/suffix reads binary-search byte
	// offsets and join only the requested window.
	#files = new Map<string, MemoryFileEntry>();

	#requireEntry(path: string): MemoryFileEntry {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return entry;
	}

	ensureDirSync(_dir: string): void {
		// No-op for in-memory storage.
	}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	writeTextSync(path: string, content: string): void {
		this.#files.set(path, createMemoryFileEntry(content, Date.now()));
	}

	/**
	 * Internal O(1) append used by {@link MemorySessionStorageWriter}. Lazily
	 * creates the entry. External callers should go through `openWriter()`
	 * rather than touching the mirror directly.
	 */
	appendSync(path: string, chunk: string): void {
		const mtimeMs = Date.now();
		let entry = this.#files.get(path);
		if (!entry) {
			entry = createMemoryFileEntry("", mtimeMs);
			this.#files.set(path, entry);
		}
		appendMemoryChunk(entry, chunk);
		entry.mtimeMs = mtimeMs;
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#requireEntry(path);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const files: string[] = [];
		for (const path of this.#files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/") || name.includes("\\")) continue;
			if (!matchesPattern(name, pattern)) continue;
			files.push(path);
		}
		return files;
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	readText(path: string): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(materializeMemoryEntry(entry));
	}

	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve([sliceChunksHead(entry, prefixBytes), sliceChunksTail(entry, suffixBytes)]);
	}

	writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	writeTextAtomic(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	rename(path: string, nextPath: string): Promise<void> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
		return Promise.resolve();
	}

	unlink(path: string): Promise<void> {
		this.#files.delete(path);
		return Promise.resolve();
	}
	deleteSessionWithArtifacts(_sessionPath: string): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}
