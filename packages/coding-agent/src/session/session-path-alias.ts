import * as path from "node:path";
import type {
	SessionStorageBackend,
	SessionStorageIndexEntry,
} from "./indexed-session-storage";
import type { SessionTitleUpdate } from "./session-title-slot";

/**
 * Bidirectional prefix alias between this machine's caller-space session
 * paths and the shared storage's row keys.
 *
 * A machine that mirrors the canonical machine's directory layout under a
 * different absolute root (a VPS `~/Developer` at `/home/zbornheimer`
 * mirroring the Mac's `/Users/zbornheimer`) must read and write the same
 * rows — resume, fork, and the picker all key off the row path. Every path
 * crossing the storage-backend boundary is rewritten through this alias:
 * caller paths become storage keys on the way down, index rows become caller
 * paths on the way up. The in-memory index and `SessionManager`'s
 * `directChildKeyName` matching therefore keep operating in this machine's
 * own path space, and no session is ever stored under two keys.
 */
export interface SessionPathPrefixAlias {
	/** Absolute prefix this machine's callers resolve (e.g. `/home/zbornheimer`). */
	readonly localPrefix: string;
	/** Absolute prefix the storage keys rows under (e.g. `/Users/zbornheimer`). */
	readonly storagePrefix: string;
	/**
	 * Backend row key for a caller-space path. Paths outside `localPrefix`
	 * (and rows a sibling like `/home/zbornheimer2` starts with) pass
	 * through unchanged.
	 */
	storageKey(callerPath: string): string;
	/**
	 * Caller-space path for a backend row key. Keys outside `storagePrefix`
	 * pass through unchanged, so rows no machine aliases stay visible as-is.
	 */
	localPath(storageKey: string): string;
}

/**
 * Parses `OMP_SESSION_PATH_PREFIX_ALIAS`: `"<localPrefix>=<storagePrefix>"`
 * (the first `=` separates the sides), e.g.
 * `/home/zbornheimer=/Users/zbornheimer`. Unset or blank means no alias —
 * every key is used verbatim. A value that is not two absolute non-root
 * directory prefixes throws, so a typo fails every session-bearing call
 * site loudly instead of silently splitting rows across machines.
 */
export function parseSessionPathPrefixAlias(
	raw: string | undefined,
): SessionPathPrefixAlias | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	const separator = value.indexOf("=");
	const local = parsePrefixSide(
		separator === -1 ? "" : value.slice(0, separator),
		"local",
		value,
	);
	const storage = parsePrefixSide(
		separator === -1 ? "" : value.slice(separator + 1),
		"storage",
		value,
	);
	return {
		localPrefix: local,
		storagePrefix: storage,
		storageKey: callerPath => rewritePrefix(callerPath, local, storage),
		localPath: storageKey => rewritePrefix(storageKey, storage, local),
	};
}

/** Whole-prefix rewrite shared by both directions; never a partial string match. */
function rewritePrefix(value: string, from: string, to: string): string {
	if (value === from) return to;
	return value.startsWith(from + path.sep) ? to + value.slice(from.length) : value;
}

function parsePrefixSide(side: string, role: "local" | "storage", raw: string): string {
	let prefix = side.trim();
	while (prefix.length > 1 && prefix.endsWith(path.sep)) prefix = prefix.slice(0, -1);
	if (!prefix || !path.isAbsolute(prefix) || prefix === path.sep) {
		throw new Error(
			`OMP_SESSION_PATH_PREFIX_ALIAS must be "<localPrefix>=<storagePrefix>" ` +
				`(e.g. "/home/zbornheimer=/Users/zbornheimer"); its ${role} side ` +
				`${JSON.stringify(side)} in ${JSON.stringify(raw)} is not an absolute directory prefix`,
		);
	}
	return prefix;
}

/**
 * Exposes `backend` with every path translated through `alias`: paths handed
 * down (`writeFull`/`append`/`readFull`/`readSlices`/`move`/`remove`/…) are
 * rewritten to storage keys, and `loadIndex` rows are rewritten back to
 * caller paths before they reach the in-memory index. This is the only seam
 * that needs aliasing — `IndexedSessionStorage` funnels every backend call
 * through it, so no caller-space path reaches the backend unaliased and no
 * storage key leaks back unconverted.
 */
export class SessionPathAliasBackend implements SessionStorageBackend {
	readonly #backend: SessionStorageBackend;
	readonly #alias: SessionPathPrefixAlias;

	constructor(backend: SessionStorageBackend, alias: SessionPathPrefixAlias) {
		this.#backend = backend;
		this.#alias = alias;
	}

	init(): Promise<void> {
		return this.#backend.init();
	}

	async loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		const rows = await this.#backend.loadIndex();
		return Array.from(rows, row => ({ ...row, path: this.#alias.localPath(row.path) }));
	}

	readFull(callerPath: string): Promise<string | null> {
		return this.#backend.readFull(this.#alias.storageKey(callerPath));
	}

	readSlices(
		callerPath: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[string, string]> {
		return this.#backend.readSlices(this.#alias.storageKey(callerPath), prefixBytes, suffixBytes);
	}

	writeFull(
		callerPath: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		return this.#backend.writeFull(
			this.#alias.storageKey(callerPath),
			content,
			mtimeMs,
			title,
			expectedSize,
		);
	}

	append(callerPath: string, line: string, mtimeMs: number): Promise<void> {
		return this.#backend.append(this.#alias.storageKey(callerPath), line, mtimeMs);
	}

	updateSessionTitle(
		callerPath: string,
		title: SessionTitleUpdate,
		mtimeMs: number,
	): Promise<void> {
		return this.#backend.updateSessionTitle(this.#alias.storageKey(callerPath), title, mtimeMs);
	}

	truncate(callerPath: string, mtimeMs: number): Promise<void> {
		return this.#backend.truncate(this.#alias.storageKey(callerPath), mtimeMs);
	}

	async remove(callerPaths: string[]): Promise<void> {
		await this.#backend.remove(callerPaths.map(callerPath => this.#alias.storageKey(callerPath)));
	}

	move(srcCallerPath: string, dstCallerPath: string, mtimeMs: number): Promise<void> {
		return this.#backend.move(
			this.#alias.storageKey(srcCallerPath),
			this.#alias.storageKey(dstCallerPath),
			mtimeMs,
		);
	}
}
