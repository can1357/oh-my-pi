/**
 * Blob registry shared by the in-process broker and the daemon worker:
 * capability-token entries, lazy producers, a byte-budgeted RAM cache — and,
 * when serving, a persistent disk layer.
 *
 * Persistence keeps two promises at once:
 * - **Resume-stable links.** The key→token index survives restarts in
 *   `~/.omp/agent/blobs/urls-index-<project>.json`, and eager bytes live in
 *   the same content-addressed session blob store conversation images are
 *   already externalized to — so re-decorating a resumed conversation yields
 *   byte-identical URLs without copying anything.
 * - **Limited serving window.** Every entry carries a TTL anchored to its
 *   last registration. An active (or resumed) conversation re-registers its
 *   images each turn, re-arming the window; an abandoned link expires and
 *   serves 410.
 *
 * Lazy entries hold a fetcher instead of bytes — nothing renders until a
 * provider actually GETs the URL, and RAM eviction drops only cached bytes
 * (the fetcher survives, so a later cache-miss refetch re-renders).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { identifyImageFetcher } from "@oh-my-pi/pi-catalog/wire/image-fetchers";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { BlobStore as SessionBlobStore } from "../session/blob-store";
import {
	BLOB_FETCH_EVENT_LIMIT,
	type BlobBrokerMetrics,
	type BlobBrokerPurgeRequest,
	type BlobBrokerPurgeResponse,
	type BlobFetchAttributionEvent,
	type BlobStoreStatus,
} from "./protocol";
import type { BlobPublication } from "./publication";

/** Produces a lazy blob's bytes on demand; `null` when the source is gone. */
export type LazyBlobFetcher = () => Promise<Uint8Array | null>;

/** Disk layer configuration for serving registries. */
export interface BlobPersistence {
	/** Content-addressed session blob store holding (or receiving) eager bytes. */
	blobsDir: string;
	/** Key→token index path; per project scope so sibling daemons never clobber. */
	indexPath: string;
	/** Serving window measured from the last registration; `<= 0` never expires. */
	ttlMs: number;
}

/** Stable store registration returned to a local blob backend. */
export interface BlobRegistryEntry {
	/** Capability path relative to the public serving origin. */
	path: string;
	/** Known blob size, or zero until a lazy producer first resolves. */
	bytes: number;
	/** Durable publication metadata attached by the owning backend. */
	publication?: BlobPublication;
}

interface StoredBlob {
	token: string;
	mimeType: string;
	ext: string;
	/** Raw-bytes SHA-256 — the session blob store address. Eager entries only. */
	sha: string | undefined;
	/** Known byte length, retained even when bytes live only on disk. */
	bytesCount: number;
	lazy: boolean;
	/** TTL anchor: last registration (not last fetch), persisted. */
	touchedAt: number;
	/** RAM cache: memory-mode eager bytes, or a lazy entry's rendered bytes. */
	bytes: Uint8Array | undefined;
	fetcher: LazyBlobFetcher | undefined;
	/** In-flight fetch, shared across concurrent GETs (OpenAI fetches twice). */
	pending: Promise<Uint8Array | null> | undefined;
	lastServe: number;
	successfulGets: number;
	publication: BlobPublication | undefined;
}

interface PersistedEntry {
	key: string;
	token: string;
	mimeType: string;
	ext: string;
	sha?: string;
	bytes?: number;
	lazy?: boolean;
	touchedAt: number;
	gets?: number;
	publication?: BlobPublication;
}

interface PersistedCounters {
	bytesServed?: number;
	hits?: number;
	misses?: number;
	duplicateTokenGets?: number;
}

interface PersistedIndex {
	entries?: PersistedEntry[];
	counters?: PersistedCounters;
	recentFetches?: BlobFetchAttributionEvent[];
}

export const EXT_BY_MIME: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

export const BLOB_PATH_PATTERN = /^\/([0-9a-f]{32})\.[a-z0-9]{1,5}$/;
/** Resident-byte budget before least-recently-served blobs shed RAM bytes. */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const INDEX_SAVE_DEBOUNCE_MS = 500;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function randomToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("hex");
}

/** Token/byte registry with content-keyed dedup and optional persistence. */
export class BlobRegistry {
	#entries = new Map<string, StoredBlob>();
	#tokenByKey = new Map<string, string>();
	#keyByToken = new Map<string, string>();
	#residentBytes = 0;
	#maxBytes: number;
	#persist: BlobPersistence | undefined;
	#sessionStore: SessionBlobStore | undefined;
	#saveTimer: Timer | undefined;
	#lastSweep = 0;
	#bytesServed = 0;
	#hits = 0;
	#misses = 0;
	#duplicateTokenGets = 0;
	#recentFetches: BlobFetchAttributionEvent[] = [];

	#now: () => number;

	constructor(options?: { maxBytes?: number; persist?: BlobPersistence | undefined; now?: () => number }) {
		this.#maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#persist = options?.persist;
		this.#now = options?.now ?? Date.now;
		if (this.#persist) {
			this.#sessionStore = new SessionBlobStore(this.#persist.blobsDir);
			this.#loadIndex(this.#persist.indexPath);
			this.#sweep();
		}
	}

	#loadIndex(indexPath: string): void {
		let parsed: PersistedIndex;
		try {
			parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as PersistedIndex;
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("blob-broker: unreadable url index; starting fresh", {
					indexPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		const counters = parsed.counters;
		this.#bytesServed = counters?.bytesServed ?? 0;
		this.#hits = counters?.hits ?? 0;
		this.#misses = counters?.misses ?? 0;
		this.#duplicateTokenGets = counters?.duplicateTokenGets ?? 0;
		if (Array.isArray(parsed.recentFetches)) {
			this.#recentFetches = parsed.recentFetches.slice(-BLOB_FETCH_EVENT_LIMIT);
		}
		const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
		for (const persisted of entries) {
			if (!persisted.key || !persisted.token) continue;
			this.#adopt(persisted.key, {
				token: persisted.token,
				mimeType: persisted.mimeType,
				ext: persisted.ext,
				sha: persisted.sha,
				bytesCount: persisted.bytes ?? persisted.publication?.bytes ?? 0,
				lazy: persisted.lazy === true,
				touchedAt: persisted.touchedAt ?? 0,
				bytes: undefined,
				fetcher: undefined,
				pending: undefined,
				lastServe: 0,
				successfulGets: persisted.gets ?? 0,
				publication: persisted.publication,
			});
		}
	}

	#adopt(key: string, entry: StoredBlob): void {
		this.#entries.set(entry.token, entry);
		this.#tokenByKey.set(key, entry.token);
		this.#keyByToken.set(entry.token, key);
	}

	#scheduleSave(): void {
		const persist = this.#persist;
		if (!persist) return;
		if (this.#saveTimer) return;
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			this.#saveIndex(persist);
		}, INDEX_SAVE_DEBOUNCE_MS);
		this.#saveTimer.unref?.();
	}

	#saveIndex(persist: BlobPersistence): void {
		const entries: PersistedEntry[] = [];
		for (const [key, token] of this.#tokenByKey) {
			const entry = this.#entries.get(token);
			if (!entry) continue;
			entries.push({
				key,
				token: entry.token,
				mimeType: entry.mimeType,
				ext: entry.ext,
				...(entry.sha ? { sha: entry.sha } : {}),
				bytes: entry.bytesCount,
				...(entry.lazy ? { lazy: true } : {}),
				touchedAt: entry.touchedAt,
				...(entry.successfulGets > 0 ? { gets: entry.successfulGets } : {}),
				...(entry.publication ? { publication: entry.publication } : {}),
			});
		}
		const tmpPath = `${persist.indexPath}.tmp`;
		try {
			fs.mkdirSync(path.dirname(persist.indexPath), { recursive: true });
			fs.writeFileSync(
				tmpPath,
				JSON.stringify({
					version: 2,
					entries,
					counters: {
						bytesServed: this.#bytesServed,
						hits: this.#hits,
						misses: this.#misses,
						duplicateTokenGets: this.#duplicateTokenGets,
					},
					recentFetches: this.#recentFetches,
				}),
			);
			fs.renameSync(tmpPath, persist.indexPath);
		} catch (error) {
			logger.warn("blob-broker: failed to persist url index", {
				indexPath: persist.indexPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#expired(entry: StoredBlob): boolean {
		const now = this.#now();
		if (entry.publication?.expiresAt !== undefined && now >= entry.publication.expiresAt) return true;
		const ttl = this.#persist?.ttlMs ?? 0;
		return ttl > 0 && now - entry.touchedAt > ttl;
	}

	#drop(entry: StoredBlob): void {
		if (entry.bytes) this.#residentBytes -= entry.bytes.byteLength;
		this.#entries.delete(entry.token);
		const key = this.#keyByToken.get(entry.token);
		this.#keyByToken.delete(entry.token);
		if (key !== undefined) this.#tokenByKey.delete(key);
	}

	/** Prune expired entries; rate-limited so serve/register paths can call freely. */
	#sweep(force = false): void {
		const now = this.#now();
		if (!force && now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
		this.#lastSweep = now;
		let dropped = 0;
		for (const entry of this.#entries.values()) {
			if (!this.#expired(entry)) continue;
			this.#drop(entry);
			dropped++;
		}
		if (dropped > 0) this.#scheduleSave();
	}

	#touch(entry: StoredBlob): void {
		entry.touchedAt = this.#now();
		this.#scheduleSave();
	}

	/**
	 * Resolve an existing key registration, re-arming its serving window.
	 * `null` when unknown or expired — the caller then supplies bytes.
	 */
	lookup(key: string): BlobRegistryEntry | null {
		this.#sweep();
		const token = this.#tokenByKey.get(key);
		const entry = token !== undefined ? this.#entries.get(token) : undefined;
		if (!entry) return null;
		if (this.#expired(entry)) {
			this.#drop(entry);
			this.#scheduleSave();
			return null;
		}
		this.#touch(entry);
		return this.#describe(entry);
	}

	/**
	 * Register eager bytes under a content key and return its registration. With
	 * persistence, bytes land in the content-addressed session blob store
	 * (idempotent — conversation images are usually already there) and are
	 * never held in RAM.
	 */
	async registerBytes(key: string, mimeType: string, bytes: Uint8Array): Promise<BlobRegistryEntry> {
		const existing = this.lookup(key);
		if (existing) return existing;
		const entry = this.#insert(key, mimeType, false);
		if (this.#sessionStore) {
			const sha = new Bun.SHA256().update(bytes).digest("hex");
			entry.sha = sha;
			if (!(await this.#sessionStore.has(sha))) {
				await this.#sessionStore.put(Buffer.from(bytes), { extension: EXT_BY_MIME[mimeType] });
			}
		} else {
			this.#retain(entry, bytes);
		}
		entry.bytesCount = bytes.byteLength;
		this.#scheduleSave();
		return this.#describe(entry);
	}

	/**
	 * Register a lazy blob under a caller key. Re-registration replaces the
	 * fetcher (a restarted session supplies fresh producers) but keeps the
	 * token, so URLs stay stable for provider caches and resumed histories.
	 */
	registerLazy(key: string, mimeType: string, fetcher: LazyBlobFetcher): BlobRegistryEntry {
		this.#sweep();
		const token = this.#tokenByKey.get(key);
		const existing = token !== undefined ? this.#entries.get(token) : undefined;
		if (existing && !this.#expired(existing)) {
			existing.fetcher = fetcher;
			this.#touch(existing);
			return this.#describe(existing);
		}
		if (existing) this.#drop(existing);
		const entry = this.#insert(key, mimeType, true);
		entry.fetcher = fetcher;
		this.#scheduleSave();
		return this.#describe(entry);
	}

	/** Persist an uploader publication that has no locally served bytes. */
	recordPublication(key: string, mimeType: string, publication: BlobPublication): BlobRegistryEntry {
		const existing = this.lookup(key);
		if (existing) {
			this.setPublication(key, publication);
			return { ...existing, bytes: publication.bytes, publication };
		}
		const entry = this.#insert(key, mimeType, false);
		entry.bytesCount = publication.bytes;
		entry.publication = publication;
		this.#scheduleSave();
		return this.#describe(entry);
	}

	/** Attach durable publication metadata after the backend creates it. */
	setPublication(key: string, publication: BlobPublication): void {
		const token = this.#tokenByKey.get(key);
		const entry = token === undefined ? undefined : this.#entries.get(token);
		if (!entry) return;
		entry.publication = publication;
		if (publication.bytes > 0) entry.bytesCount = publication.bytes;
		this.#scheduleSave();
	}

	#describe(entry: StoredBlob): BlobRegistryEntry {
		return {
			path: `${entry.token}.${entry.ext}`,
			bytes: entry.bytesCount,
			...(entry.publication ? { publication: entry.publication } : {}),
		};
	}

	#insert(key: string, mimeType: string, lazy: boolean): StoredBlob {
		const entry: StoredBlob = {
			token: randomToken(),
			mimeType,
			ext: EXT_BY_MIME[mimeType] ?? "bin",
			sha: undefined,
			bytesCount: 0,
			lazy,
			touchedAt: this.#now(),
			bytes: undefined,
			fetcher: undefined,
			pending: undefined,
			lastServe: 0,
			successfulGets: 0,
			publication: undefined,
		};
		this.#adopt(key, entry);
		return entry;
	}

	#retain(entry: StoredBlob, bytes: Uint8Array): void {
		this.#evictFor(bytes.byteLength);
		entry.bytes = bytes;
		this.#residentBytes += bytes.byteLength;
	}

	#evictFor(incoming: number): void {
		while (this.#residentBytes + incoming > this.#maxBytes) {
			let oldest: StoredBlob | undefined;
			for (const entry of this.#entries.values()) {
				if (entry.bytes && (!oldest || entry.lastServe < oldest.lastServe)) oldest = entry;
			}
			if (!oldest?.bytes) return;
			this.#residentBytes -= oldest.bytes.byteLength;
			oldest.bytes = undefined;
			// Lazy blobs re-render on the next fetch; disk-backed blobs re-read.
			// Only memory-mode eager blobs are gone for good (their session
			// re-registers the bytes on the next decorated request).
			if (!oldest.fetcher && !oldest.sha) this.#drop(oldest);
		}
	}

	/** Return current store counters and the bounded fetch-attribution history. */
	status(): BlobStoreStatus {
		this.#sweep(true);
		let eagerBlobs = 0;
		let lazyBlobs = 0;
		let diskBytes = 0;
		const diskShas = new Set<string>();
		for (const entry of this.#entries.values()) {
			if (entry.lazy) lazyBlobs++;
			else eagerBlobs++;
			if (entry.sha) diskShas.add(entry.sha);
		}
		if (this.#persist) {
			for (const sha of diskShas) {
				try {
					diskBytes += fs.statSync(path.join(this.#persist.blobsDir, sha)).size;
				} catch {
					// A concurrently collected session blob contributes no disk bytes.
				}
			}
		}
		const metrics: BlobBrokerMetrics = {
			activeBlobs: this.#entries.size,
			eagerBlobs,
			lazyBlobs,
			residentBytes: this.#residentBytes,
			diskBytes,
			bytesServed: this.#bytesServed,
			hits: this.#hits,
			misses: this.#misses,
			duplicateTokenGets: this.#duplicateTokenGets,
		};
		return { metrics, recentFetches: [...this.#recentFetches] };
	}

	/**
	 * Select registrations for cleanup and, only when `apply` is true, remove
	 * candidates accepted by `canRemove`. An unscoped request defaults to
	 * expired registrations; callers must set `all` to select live entries.
	 */
	purge(
		request: BlobBrokerPurgeRequest = {},
		canRemove: (publication: BlobPublication | undefined) => boolean = () => true,
	): BlobBrokerPurgeResponse {
		const publications: BlobPublication[] = [];
		const apply = request.apply === true;
		const expiredOnly = request.expiredOnly === true || (!request.all && request.before === undefined);
		let purgedBlobs = 0;
		let reclaimedBytes = 0;
		for (const entry of Array.from(this.#entries.values())) {
			if (expiredOnly && !this.#expired(entry)) continue;
			if (request.before !== undefined && entry.touchedAt >= request.before) continue;
			if (entry.publication) publications.push(entry.publication);
			if (apply && !canRemove(entry.publication)) continue;
			purgedBlobs++;
			reclaimedBytes += entry.bytes?.byteLength ?? (entry.sha ? entry.bytesCount : 0);
			if (apply) this.#drop(entry);
		}
		if (apply && purgedBlobs > 0) this.#scheduleSave();
		return {
			applied: apply,
			purgedBlobs,
			reclaimedBytes,
			publications,
			remoteDeletes: publications.flatMap(publication => (publication.delete ? [publication.delete] : [])),
			attempted: 0,
			deleted: 0,
			errors: [],
		};
	}

	/** Resolve a lazy blob's bytes, invoking and caching the fetcher when needed. */
	async materialize(entry: StoredBlob): Promise<Uint8Array | null> {
		if (entry.bytes) return entry.bytes;
		if (!entry.fetcher) return null;
		entry.pending ??= entry
			.fetcher()
			.then(bytes => {
				if (bytes && bytes.byteLength > 0) this.#retain(entry, bytes);
				return bytes;
			})
			.catch(error => {
				logger.warn("blob-broker: lazy blob fetch failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			})
			.finally(() => {
				entry.pending = undefined;
			});
		return entry.pending;
	}

	#recordFetch(event: BlobFetchAttributionEvent): void {
		this.#recentFetches.push(event);
		if (this.#recentFetches.length > BLOB_FETCH_EVENT_LIMIT) this.#recentFetches.shift();
	}

	#recordMiss(): void {
		this.#misses++;
		this.#scheduleSave();
	}

	#recordHit(entry: StoredBlob, method: "GET" | "HEAD", bytes: number): void {
		this.#hits++;
		if (method === "GET") {
			if (entry.successfulGets > 0) this.#duplicateTokenGets++;
			entry.successfulGets++;
			this.#bytesServed += bytes;
		}
		this.#scheduleSave();
	}

	/**
	 * Serve one public request against the registry. Unknown tokens 404;
	 * expired or source-less entries 410; only GET/HEAD are read operations.
	 * Fetcher attribution is logged, never gated.
	 */
	async serve(request: Request): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		this.#sweep();
		const token = BLOB_PATH_PATTERN.exec(new URL(request.url).pathname)?.[1];
		const entry = token ? this.#entries.get(token) : undefined;
		const fetcher = identifyImageFetcher(request.headers);
		const method: "GET" | "HEAD" = request.method === "GET" ? "GET" : "HEAD";
		this.#recordFetch({
			fetcherId: fetcher?.id ?? null,
			corroborated: fetcher?.corroborated ?? false,
			timestamp: this.#now(),
			method,
			found: entry !== undefined,
			tokenSuffix: token?.slice(-6) ?? null,
		});
		logger.debug("blob-broker: inbound fetch", {
			fetcher: fetcher?.id ?? null,
			corroborated: fetcher?.corroborated ?? false,
			found: entry !== undefined,
			method,
		});
		if (!entry) {
			this.#recordMiss();
			return new Response(null, { status: 404 });
		}
		if (this.#expired(entry)) {
			this.#drop(entry);
			this.#recordMiss();
			return new Response(null, { status: 410 });
		}
		entry.lastServe = this.#now();
		const headers: Record<string, string> = {
			"content-type": entry.mimeType,
			// Serving-window semantics: content under a token never changes, but
			// the link itself expires, so provider caches get exactly the TTL.
			"cache-control": `public, max-age=${this.#servableSeconds(entry)}`,
		};
		// Disk-backed eager blobs stream from the content-addressed store —
		// nothing resident in RAM.
		if (entry.sha && this.#persist && this.#sessionStore) {
			const file = Bun.file(path.join(this.#persist.blobsDir, entry.sha));
			if (!(await file.exists())) {
				// Session blob GC'd (conversation deleted): the link is dead; the
				// owning session re-registers from history data on its next turn.
				this.#recordMiss();
				return new Response(null, { status: 410 });
			}
			headers["content-length"] = String(file.size);
			this.#recordHit(entry, method, file.size);
			return new Response(method === "HEAD" ? null : file, { status: 200, headers });
		}
		const bytes = await this.materialize(entry);
		// A lazy blob whose owning session died: 410 tells the provider the URL
		// is permanently gone; the session-side fallback re-sends inline anyway.
		if (!bytes) {
			this.#recordMiss();
			return new Response(null, { status: 410 });
		}
		if (entry.bytesCount === 0) {
			entry.bytesCount = bytes.byteLength;
			if (entry.publication?.bytes === 0) {
				entry.publication = { ...entry.publication, bytes: bytes.byteLength };
			}
		}
		headers["content-length"] = String(bytes.byteLength);
		this.#recordHit(entry, method, bytes.byteLength);
		return new Response(method === "HEAD" ? null : bytes, { status: 200, headers });
	}

	#servableSeconds(entry: StoredBlob): number {
		const ttl = this.#persist?.ttlMs ?? 0;
		if (ttl <= 0) return 86_400;
		return Math.max(60, Math.floor((entry.touchedAt + ttl - this.#now()) / 1000));
	}

	/** Flush any pending index write; call before shutdown. */
	flush(): void {
		if (!this.#saveTimer || !this.#persist) return;
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		this.#saveIndex(this.#persist);
	}
}
