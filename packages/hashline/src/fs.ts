/**
 * Storage seam for the hashline patcher. {@link Filesystem} is intentionally
 * minimal — `readText`, `writeText`, `exists` — so any backing store can be
 * adapted: disk, memory, S3, an LSP text-document protocol, a Git tree, a
 * VFS, etc.
 *
 * The patcher does its own BOM stripping and LF normalization between
 * {@link Filesystem.readText} and {@link Filesystem.writeText}; the FS deals
 * only in raw text strings.
 */
import * as fs from "node:fs/promises";
import * as pathModule from "node:path";

/**
 * Result returned by {@link Filesystem.writeText}. The patcher echoes back
 * `text` so adapters that transform on serialization (e.g. notebooks) can
 * report what actually landed on disk.
 */
export interface WriteResult {
	/** Final text that was persisted. May differ from the input if the FS transformed it. */
	text: string;
}

import type { FileOp } from "./types";

/** Optional hints for {@link Filesystem.preflightWrite}. */
export interface PreflightWriteOptions {
	fileOp?: FileOp;
}

/**
 * ENOENT-like error thrown by {@link Filesystem.readText} when a path is
 * missing. Carrying a `code` property keeps the contract compatible with
 * `node:fs` callers that already check `err.code === "ENOENT"`.
 */
export class NotFoundError extends Error {
	readonly code = "ENOENT";

	constructor(path: string, cause?: unknown) {
		super(`File not found: ${path}`);
		this.name = "NotFoundError";
		if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
	}
}

/** Type guard for {@link NotFoundError} and structurally-compatible errors. */
export function isNotFound(error: unknown): boolean {
	if (error instanceof NotFoundError) return true;
	if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") return true;
	return false;
}

/**
 * Abstract storage backend the {@link Patcher} reads from and writes to.
 * Subclass for new backends; the package ships {@link InMemoryFilesystem} and
 * {@link NodeFilesystem} for the most common cases.
 *
 * Implementations work with raw text — the patcher handles BOM stripping and
 * line-ending normalization itself. `readText` MUST throw {@link
 * NotFoundError} (or any error for which {@link isNotFound} returns true)
 * when the path doesn't exist; that's how the patcher detects a create-vs-
 * update.
 */
export abstract class Filesystem {
	/** Read the file's full text content. Throw on missing file. */
	abstract readText(path: string): Promise<string>;

	/** Validate that `path` is writable before a prepared batch starts committing. */
	async preflightWrite(_path: string, _options?: PreflightWriteOptions): Promise<void> {}

	/** Persist `content` at `path`. Returns the actual final text that was written. */
	abstract writeText(path: string, content: string): Promise<WriteResult>;

	/** Delete the file at `path`. Default: not supported. */
	async delete(path: string): Promise<void> {
		throw new Error(`Filesystem does not support delete: ${path}`);
	}

	/**
	 * Move/rename `from` to `to`. When `content` is provided the destination
	 * receives that text; otherwise implementations may preserve the source bytes.
	 */
	async move(from: string, to: string, content?: string): Promise<void> {
		void content;
		throw new Error(`Filesystem does not support move: ${from} -> ${to}`);
	}

	/** Return true when the path exists and can be read. Default: probe via {@link readText}. */
	async exists(path: string): Promise<boolean> {
		try {
			await this.readText(path);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	/**
	 * Canonical path used as a key by external caches (e.g. snapshot
	 * stores). The default is identity; override to return an absolute or
	 * otherwise canonicalised path so producers and consumers of cached
	 * snapshots agree on the key without each having to redo the resolution.
	 */
	canonicalPath(path: string): string {
		return path;
	}

	/**
	 * Whether a section whose authored path is missing may be redirected to
	 * the file its snapshot tag names (tag-based path recovery in
	 * {@link Patcher.prepare}). `resolvedPath` is the canonical path the
	 * redirect would read and write. Default: allow.
	 *
	 * Hosts that grant write privileges by path shape override this to refuse
	 * redirects that could escalate beyond what the caller approved — e.g. an
	 * internal-URL authored target (approved read-only), or a `resolvedPath`
	 * outside the working tree (a sandbox/vault/out-of-tree write).
	 */
	allowTagPathRecovery(_authoredPath: string, _resolvedPath: string): boolean {
		return true;
	}
}

/**
 * In-memory {@link Filesystem}. Useful for tests, sandboxes, dry-runs, and as
 * a building block for stacked adapters (e.g. an LRU layer on top).
 */
export class InMemoryFilesystem extends Filesystem {
	#files = new Map<string, string>();

	constructor(initial?: Iterable<readonly [string, string]>) {
		super();
		if (initial) {
			for (const [path, content] of initial) this.#files.set(path, content);
		}
	}

	async readText(path: string): Promise<string> {
		const text = this.#files.get(path);
		if (text === undefined) throw new NotFoundError(path);
		return text;
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		this.#files.set(path, content);
		return { text: content };
	}

	async delete(path: string): Promise<void> {
		if (!this.#files.delete(path)) throw new NotFoundError(path);
	}

	async move(from: string, to: string, content?: string): Promise<void> {
		const existing = this.#files.get(from);
		if (existing === undefined) throw new NotFoundError(from);
		const finalContent = content ?? existing;
		this.#files.set(to, finalContent);
		this.#files.delete(from);
	}

	async exists(path: string): Promise<boolean> {
		return this.#files.has(path);
	}

	/** Synchronous helper for setting up fixtures without awaiting. */
	set(path: string, content: string): void {
		this.#files.set(path, content);
	}

	/** Synchronous helper for inspecting state without awaiting. */
	get(path: string): string | undefined {
		return this.#files.get(path);
	}

	/** Wipe all entries. */
	clear(): void {
		this.#files.clear();
	}

	/** Iterate `[path, content]` pairs. */
	entries(): IterableIterator<[string, string]> {
		return this.#files.entries();
	}
}

/**
 * Disk-backed {@link Filesystem} using Bun's file APIs. The default for CLI
 * use. Paths are accepted as-is; callers responsible for any cwd or
 * jail/sandbox resolution should wrap this with their own subclass.
 */
export class NodeFilesystem extends Filesystem {
	async readText(path: string): Promise<string> {
		const file = Bun.file(path);
		if (!(await file.exists())) throw new NotFoundError(path);
		return file.text();
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		await Bun.write(path, content);
		return { text: content };
	}

	async delete(path: string): Promise<void> {
		try {
			await fs.rm(path);
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(path, error);
			throw error;
		}
	}

	async move(from: string, to: string, content?: string): Promise<void> {
		if (content !== undefined) {
			await Bun.write(to, content);
			await this.delete(from);
			return;
		}
		try {
			await fs.rename(from, to);
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(from, error);
			throw error;
		}
	}

	canonicalPath(path: string): string {
		return pathModule.resolve(path);
	}

	async exists(path: string): Promise<boolean> {
		return Bun.file(path).exists();
	}
}
