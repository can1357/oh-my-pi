import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { ObjectStore } from "../state-broker/object-store";
import { blobKey } from "../state-broker/object-store";

const BLOB_PREFIX = "blob:sha256:";
/** Attempts per background blob upload before giving up and warning. */
const BLOB_UPLOAD_ATTEMPTS = 3;
/** First retry delay; doubles per attempt. */
const BLOB_UPLOAD_RETRY_BASE_MS = 250;

/**
 * In-flight background blob uploads across every {@link BlobStore}.
 *
 * Module-level rather than per-instance because the concern is process-wide:
 * `BlobStore` is constructed at several independent sites and shutdown has no
 * handle on those instances, so a per-instance set could not be drained.
 * Entries remove themselves on settle, so this tracks concurrency rather than
 * growing with the number of blobs written.
 */
const pendingBlobUploads = new Set<Promise<void>>();

/**
 * Await every in-flight background blob upload.
 *
 * Called on graceful shutdown so a process exit does not abandon a blob whose
 * session body is already replicated, leaving a reference no other machine can
 * resolve. Uploads settle rather than reject, so this never throws; the caller
 * bounds it.
 */
export async function drainBlobUploads(): Promise<void> {
	while (pendingBlobUploads.size > 0) {
		// Re-read the set each pass: a retrying upload can outlive the snapshot,
		// and settling one does not stop another from still being in flight.
		await Promise.allSettled([...pendingBlobUploads]);
	}
}

/** Canonical blob hash shape: exactly 64 lowercase hex chars (a SHA-256 digest). */
export const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

export interface BlobPutOptions {
	/** Optional file extension for a sidecar hardlink/copy that OS openers can type-detect. */
	extension?: string;
}

export interface BlobPutResult {
	hash: string;
	/** Canonical content-addressed path, always `<dir>/<sha256-hex>`. */
	path: string;
	/** Path with the requested extension when supplied, otherwise the canonical path. */
	displayPath: string;
	get ref(): string;
}

/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * Files are stored canonically at `<dir>/<sha256-hex>`. Callers may also request
 * a typed sidecar path (`<dir>/<sha256-hex>.<ext>`) for `file://` links and OS
 * image viewers; blob refs and reads still address the extensionless hash path.
 * The SHA-256 hash is computed over the raw binary data (not base64).
 * Content-addressing makes writes idempotent and provides automatic deduplication
 * across sessions.
 */

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

function normalizeBlobExtension(extension: string | undefined): string | undefined {
	if (!extension) return undefined;
	const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
	if (normalized.length === 0 || normalized.length > 32) return undefined;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) return undefined;
	return normalized.toLowerCase();
}

async function ensureDisplayPath(blobPath: string, displayPath: string, data: Buffer): Promise<void> {
	if (displayPath === blobPath) return;
	try {
		await fsp.link(blobPath, displayPath);
		return;
	} catch (err) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") return;
		logger.debug("Blob display hardlink failed; falling back to copy", {
			blobPath,
			displayPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	await Bun.write(displayPath, data);
}

function ensureDisplayPathSync(blobPath: string, displayPath: string, data: Buffer): void {
	if (displayPath === blobPath) return;
	try {
		fs.linkSync(blobPath, displayPath);
		return;
	} catch (err) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") return;
		logger.debug("Blob display hardlink failed; falling back to copy", {
			blobPath,
			displayPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	fs.writeFileSync(displayPath, data);
}

export function blobExtensionForImageMimeType(mimeType: string | undefined): string | undefined {
	if (!mimeType) return undefined;
	const lower = mimeType.toLowerCase();
	const known = IMAGE_EXTENSION_BY_MIME[lower];
	if (known) return known;
	if (!lower.startsWith("image/")) return undefined;
	const subtype = lower.slice("image/".length).split(";")[0]?.split("+")[0];
	return normalizeBlobExtension(subtype);
}

/**
 * Process-wide remote backing applied to every {@link BlobStore} constructed
 * after it is set.
 *
 * `BlobStore` is instantiated independently at three sites (`SessionManager`,
 * `session-loader`, the ACP agent), each with `new BlobStore(getBlobsDir())`.
 * A module-level default lets replication be enabled once at startup without
 * threading an object store through all three constructors — and keeps the
 * default `undefined`, so a run with object storage off is byte-identical.
 */
let defaultObjectStore: ObjectStore | undefined;

/**
 * Whether the process-wide default store may receive UPLOADS. Blob bytes are
 * session attachments (pasted screenshots etc.); a project with sync disabled
 * must never push them. Downloads are always allowed regardless — see
 * {@link BlobStore.attachObjectStore} — so this gates only the write direction.
 */
let defaultUploadEnabled = true;

/**
 * Back every subsequently-constructed {@link BlobStore} with `store`. `upload`
 * (default `true`) sets whether those stores may push blobs; downloads stay
 * unconditional. Passing `undefined` for `store` disables remote backing.
 */
export function setDefaultBlobObjectStore(store: ObjectStore | undefined, options?: { upload?: boolean }): void {
	defaultObjectStore = store;
	defaultUploadEnabled = options?.upload ?? true;
}

/**
 * Whether any remote backing is configured at all.
 *
 * Lets owners skip work that is only meaningful when a store exists — notably
 * resolving the owning project to decide the upload gate, which would otherwise
 * read `projects.yml` on every session construction even with replication
 * switched off.
 */
export function hasDefaultBlobObjectStore(): boolean {
	return defaultObjectStore !== undefined;
}

export class BlobStore {
	/**
	 * Optional remote backing for cross-machine replication. Blobs are immutable
	 * by SHA-256 hash, so remote sync is pure upload-if-absent / download-on-miss
	 * and can never conflict. Defaults to the process-wide
	 * {@link setDefaultBlobObjectStore} value, which is `undefined` unless
	 * replication was enabled at startup — so the store is entirely local and
	 * byte-identical when object storage is off.
	 */
	#objectStore: ObjectStore | undefined = defaultObjectStore;

	/**
	 * Whether this store may UPLOAD blobs to {@link #objectStore}. Blob bytes are
	 * session attachments; when the owning session belongs to a sync-disabled
	 * project the owner attaches with `{ upload: false }` so nothing leaves this
	 * machine. Downloads ignore this flag: viewing an image from a session you
	 * already legitimately hold is always fine, and the hash is only learnable
	 * from a session you already have — so fetch-on-miss stays unconditional.
	 */
	#uploadEnabled = defaultUploadEnabled;

	constructor(readonly dir: string) {}

	/**
	 * Wire in a remote object store to back this local blob dir. `upload`
	 * (default `true`) gates the write direction only; downloads remain
	 * unconditional.
	 */
	attachObjectStore(store: ObjectStore, options?: { upload?: boolean }): void {
		this.#objectStore = store;
		this.#uploadEnabled = options?.upload ?? true;
	}

	/**
	 * Flip the upload gate on a store that already inherited the process-wide
	 * object store. Lets a session owner opt its own blobs into replication once
	 * it knows its project's sync state, without the blob store ever needing to
	 * resolve a project itself.
	 */
	setUploadEnabled(enabled: boolean): void {
		this.#uploadEnabled = enabled;
	}

	/**
	 * Write binary data to the blob store.
	 * @returns SHA-256 hex hash of the data
	 */
	async put(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};

		await Bun.write(blobPath, data);
		await ensureDisplayPath(blobPath, displayPath, data);
		this.#scheduleUpload(hash, data);
		return result;
	}

	/**
	 * Synchronous variant of {@link put}. Use on persistence hot paths where the caller
	 * cannot afford the microtask hops of the async version (e.g. OOM-safe session writes).
	 * Returns once the bytes are in the kernel page cache.
	 */
	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(blobPath, data);
		ensureDisplayPathSync(blobPath, displayPath, data);
		this.#scheduleUpload(hash, data);
		return result;
	}

	/**
	 * Read blob by hash, returns Buffer or null if not found. On a local miss with
	 * a remote store attached, the blob is fetched, materialized into the local dir
	 * (so subsequent {@link getSync} hits), and returned; a remote miss reads as null.
	 */
	async get(hash: string): Promise<Buffer | null> {
		const blobPath = path.join(this.dir, hash);
		try {
			const file = Bun.file(blobPath);
			const ab = await file.arrayBuffer();
			return Buffer.from(ab);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return await this.#downloadRemote(hash, blobPath);
	}

	/** Synchronous variant of {@link get}. */
	getSync(hash: string): Buffer | null {
		const blobPath = path.join(this.dir, hash);
		try {
			return fs.readFileSync(blobPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/**
	 * Check if a blob exists. On a local miss with a remote store attached, the blob
	 * is downloaded into the local dir when present remotely (so subsequent
	 * {@link getSync} hits) and reported as existing; otherwise false.
	 */
	async has(hash: string): Promise<boolean> {
		try {
			await fsp.access(path.join(this.dir, hash));
			return true;
		} catch {
			// Fall through to the remote store below.
		}
		const blobPath = path.join(this.dir, hash);
		return (await this.#downloadRemote(hash, blobPath)) !== null;
	}

	/**
	 * Background upload of a freshly written blob, retried and drainable.
	 *
	 * Fire-and-forget so neither {@link put} nor the synchronous {@link putSync}
	 * hot path blocks on the network, and a `has` guard avoids re-uploading blobs
	 * already replicated. Skipped entirely when uploads are gated off
	 * (sync-disabled project), so the blob never leaves this machine while local
	 * writes and downloads still work.
	 *
	 * A single detached attempt was not enough. Blobs are content-addressed, so
	 * nothing ever revisits one that is already local: a transient failure, or an
	 * exit while the request was in flight, left the session body replicated with
	 * a reference no other machine can resolve, permanently. So attempts are
	 * retried with backoff, and tracked in {@link pendingBlobUploads} so
	 * {@link drainBlobUploads} can await them on shutdown.
	 */
	#scheduleUpload(hash: string, data: Buffer): void {
		if (!this.#uploadEnabled) return;
		const store = this.#objectStore;
		if (!store) return;
		const key = blobKey(hash);
		const task = (async () => {
			for (let attempt = 1; attempt <= BLOB_UPLOAD_ATTEMPTS; attempt++) {
				try {
					if (await store.has(key)) return;
					await store.put(key, data);
					return;
				} catch (err) {
					if (attempt === BLOB_UPLOAD_ATTEMPTS) {
						// Warn, not debug: the blob is now local-only while the session
						// body referencing it may already be replicated.
						logger.warn(`blob upload failed for ${hash} after ${attempt} attempts: ${err}`);
						return;
					}
					logger.debug(`blob upload attempt ${attempt} failed for ${hash}: ${err}`);
					await Bun.sleep(BLOB_UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1));
				}
			}
		})();
		pendingBlobUploads.add(task);
		// Self-removal keeps the set bounded without a sweep; `finally` rather than
		// `then` so a rejection (which the loop above should make impossible)
		// cannot leak an entry that a drain would then wait on forever.
		void task.finally(() => {
			pendingBlobUploads.delete(task);
		});
	}

	/**
	 * Best-effort download of a blob missing locally, writing it into the local dir
	 * so later synchronous reads hit. Returns null when no store is attached, the
	 * blob is absent remotely, or the fetch fails — a dead store only adds latency.
	 */
	async #downloadRemote(hash: string, blobPath: string): Promise<Buffer | null> {
		const store = this.#objectStore;
		if (!store) return null;
		try {
			const bytes = await store.get(blobKey(hash));
			if (!bytes) return null;
			const buffer = Buffer.from(bytes);
			await Bun.write(blobPath, buffer);
			return buffer;
		} catch (err) {
			logger.warn(`blob download failed for ${hash}: ${err}`);
			return null;
		}
	}
}

/** Check if a data string is a blob reference. */
export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

/**
 * Extract the SHA-256 hash from a blob reference string.
 *
 * Returns null when the string is not a blob ref, or when the suffix is not a
 * canonical 64-char lowercase hex hash. Rejecting non-hash suffixes here is the
 * single choke point that keeps every resolution path confined to the blob dir:
 * `get`/`getSync` feed this value into `path.join(this.dir, hash)`, so an
 * unvalidated `../` suffix would otherwise escape the store and read arbitrary files.
 */
export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	const hash = data.slice(BLOB_PREFIX.length);
	if (!BLOB_HASH_RE.test(hash)) {
		logger.warn("Rejected malformed blob reference", { suffix: hash });
		return null;
	}
	return hash;
}

/** Identify provider transport image data URLs so persistence can externalize and restore them losslessly. */
export function isImageDataUrl(data: string): boolean {
	return data.startsWith("data:image/") && data.includes(";base64,");
}

/**
 * Externalize a provider image data URL to the blob store, returning a blob reference.
 * The full data URL string is preserved so transport-native history can be reconstructed on resume.
 */
export async function externalizeImageDataUrl(blobStore: BlobStore, dataUrl: string): Promise<string> {
	if (isBlobRef(dataUrl)) return dataUrl;
	const { ref } = await blobStore.put(Buffer.from(dataUrl, "utf8"));
	return ref;
}

/** Synchronous variant of {@link externalizeImageDataUrl}. */
export function externalizeImageDataUrlSync(blobStore: BlobStore, dataUrl: string): string {
	if (isBlobRef(dataUrl)) return dataUrl;
	return blobStore.putSync(Buffer.from(dataUrl, "utf8")).ref;
}

/**
 * Externalize an image's base64 data to the blob store, returning a blob reference.
 * If the data is already a blob reference, returns it unchanged.
 */
export async function externalizeImageData(
	blobStore: BlobStore,
	base64Data: string,
	mimeType?: string,
): Promise<string> {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = await blobStore.put(buffer, {
		extension: blobExtensionForImageMimeType(mimeType),
	});
	return ref;
}

/** Synchronous variant of {@link externalizeImageData}. */
export function externalizeImageDataSync(blobStore: BlobStore, base64Data: string, mimeType?: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	return blobStore.putSync(Buffer.from(base64Data, "base64"), {
		extension: blobExtensionForImageMimeType(mimeType),
	}).ref;
}

/**
 * Resolve an externalized provider image data URL back to its original string.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns the reference as-is.
 */
export async function resolveImageDataUrl(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/**
 * Resolve a blob reference back to base64 data.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns a placeholder.
 */
export async function resolveImageData(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data; // Return the ref as-is; downstream will see invalid base64 but won't crash
	}
	return buffer.toString("base64");
}

/** Synchronous variant of {@link resolveImageData}. */
export function resolveImageDataSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}
