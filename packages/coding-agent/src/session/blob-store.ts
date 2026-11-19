import { blobExtensionForImageMimeType, normalizeBlobExtension } from "@oh-my-pi/pi-tui/prompt/image-format";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEexist, isEnoent, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { LazyFrameData } from "@oh-my-pi/snapcompact";

const BLOB_PREFIX = "blob:sha256:";

/** Canonical blob hash shape: exactly 64 lowercase hex chars (a SHA-256 digest). */
export const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * A reused blob older than this gets its mtime refreshed (metadata only, never
 * its bytes) so `omp gc`'s write-grace window still covers a blob whose new
 * reference has not reached a session file yet. Younger blobs are left alone.
 */
const BLOB_REUSE_TOUCH_MS = 60_000;

/**
 * Staging file an atomic blob or sidecar write renames into place:
 * `.<hash>[.<ext>].<snowflake>.tmp`. Only a killed or crashed writer leaves one
 * behind, so `omp gc` removes the ones older than its write grace.
 */
export const BLOB_STAGING_RE = /^\.[a-f0-9]{64}(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,31})?\.[0-9a-f]{16}\.tmp$/;

/** Staging path beside `target` matching {@link BLOB_STAGING_RE}. */
export function blobStagingPath(target: string): string {
	return path.join(path.dirname(target), `.${path.basename(target)}.${Snowflake.next()}.tmp`);
}

export interface BlobPutOptions {
	/** Optional file extension for a sidecar hardlink/copy that OS openers can type-detect. */
	extension?: string;
	/**
	 * SHA-256 hex digest of `data` the caller already computed; skips re-hashing.
	 * Must be exactly that digest — a mismatch would file the bytes under the wrong
	 * address. Ignored (the data is hashed) unless it matches {@link BLOB_HASH_RE}.
	 */
	hash?: string;
}

function blobHash(data: Buffer, precomputed: string | undefined): string {
	if (precomputed !== undefined && BLOB_HASH_RE.test(precomputed)) return precomputed;
	return new Bun.SHA256().update(data).digest("hex");
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
 * across sessions. New blobs and copied sidecars are staged to a temp file and
 * renamed into place, so a hash-named file is never observed partially written.
 */

/** Whether `file` already holds `size` bytes; a shorter file is a torn write. */
async function hasCompleteFile(file: string, size: number): Promise<boolean> {
	try {
		return (await fsp.stat(file)).size === size;
	} catch {
		return false;
	}
}

/**
 * Refresh a long-lived reused blob's mtime for gc's write grace. Returns false
 * when the blob was collected before the touch, so the caller writes it again.
 */
function touchReusedBlobSync(blobPath: string, mtimeMs: number): boolean {
	const now = new Date();
	if (now.getTime() - mtimeMs < BLOB_REUSE_TOUCH_MS) return true;
	try {
		fs.utimesSync(blobPath, now, now);
	} catch (err) {
		if (isEnoent(err)) return false;
		logger.debug("Failed to refresh reused blob mtime", { blobPath, error: String(err) });
	}
	return true;
}

async function touchReusedBlob(blobPath: string, mtimeMs: number): Promise<boolean> {
	const now = new Date();
	if (now.getTime() - mtimeMs < BLOB_REUSE_TOUCH_MS) return true;
	try {
		await fsp.utimes(blobPath, now, now);
	} catch (err) {
		if (isEnoent(err)) return false;
		logger.debug("Failed to refresh reused blob mtime", { blobPath, error: String(err) });
	}
	return true;
}

/**
 * Publish `data` at `target` via temp file + rename. When the rename fails
 * because a racing writer already published the same content (Windows refuses
 * to replace a file a reader holds open), the existing complete file wins.
 */
function writeFileAtomicSync(target: string, data: Buffer): void {
	const tempPath = blobStagingPath(target);
	try {
		fs.writeFileSync(tempPath, data);
		fs.renameSync(tempPath, target);
	} catch (err) {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// Never staged, or already renamed away.
		}
		if (fs.statSync(target, { throwIfNoEntry: false })?.size === data.length) return;
		throw err;
	}
}

async function writeFileAtomic(target: string, data: Buffer): Promise<void> {
	const tempPath = blobStagingPath(target);
	try {
		await Bun.write(tempPath, data);
		await fsp.rename(tempPath, target);
	} catch (err) {
		try {
			await fsp.unlink(tempPath);
		} catch {
			// Never staged, or already renamed away.
		}
		if (await hasCompleteFile(target, data.length)) return;
		throw err;
	}
}

async function ensureDisplayPath(blobPath: string, displayPath: string, data: Buffer): Promise<void> {
	if (displayPath === blobPath) return;
	if (await hasCompleteFile(displayPath, data.length)) return;
	try {
		await fsp.link(blobPath, displayPath);
		return;
	} catch (err) {
		// EEXIST here is a torn sidecar or a racing writer: replace it.
		if (!isEexist(err)) {
			logger.debug("Blob display hardlink failed; falling back to copy", {
				blobPath,
				displayPath,
				error: String(err),
			});
		}
	}
	await writeFileAtomic(displayPath, data);
}

function ensureDisplayPathSync(blobPath: string, displayPath: string, data: Buffer): void {
	if (displayPath === blobPath) return;
	if (fs.statSync(displayPath, { throwIfNoEntry: false })?.size === data.length) return;
	try {
		fs.linkSync(blobPath, displayPath);
		return;
	} catch (err) {
		if (!isEexist(err)) {
			logger.debug("Blob display hardlink failed; falling back to copy", {
				blobPath,
				displayPath,
				error: String(err),
			});
		}
	}
	writeFileAtomicSync(displayPath, data);
}

export class BlobStore {
	constructor(readonly dir: string) {}

	/**
	 * Write binary data to the blob store.
	 * @returns SHA-256 hex hash of the data
	 */
	async put(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		const hash = blobHash(data, options?.hash);
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

		// Content-addressed: a same-length file already holds these bytes. A
		// shorter one is a torn write and is rewritten.
		let stored: fs.Stats | undefined;
		try {
			stored = await fsp.stat(blobPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (!stored || stored.size !== data.length || !(await touchReusedBlob(blobPath, stored.mtimeMs))) {
			await writeFileAtomic(blobPath, data);
		}
		await ensureDisplayPath(blobPath, displayPath, data);
		return result;
	}

	/**
	 * Synchronous variant of {@link put}. Use on persistence hot paths where the caller
	 * cannot afford the microtask hops of the async version (e.g. OOM-safe session writes).
	 * Returns once the bytes are in the kernel page cache.
	 */
	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const hash = blobHash(data, options?.hash);
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
		const stored = fs.statSync(blobPath, { throwIfNoEntry: false });
		if (!stored || stored.size !== data.length || !touchReusedBlobSync(blobPath, stored.mtimeMs)) {
			try {
				writeFileAtomicSync(blobPath, data);
			} catch (err) {
				if (!isEnoent(err)) throw err;
				fs.mkdirSync(this.dir, { recursive: true });
				writeFileAtomicSync(blobPath, data);
			}
		}
		ensureDisplayPathSync(blobPath, displayPath, data);
		return result;
	}

	/** Read blob by hash, returns Buffer or null if not found. */
	async get(hash: string): Promise<Buffer | null> {
		const blobPath = path.join(this.dir, hash);
		try {
			const file = Bun.file(blobPath);
			const ab = await file.arrayBuffer();
			return Buffer.from(ab);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
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

	/** Stored byte length without reading the blob; null when it is absent. */
	sizeSync(hash: string): number | null {
		try {
			return fs.statSync(path.join(this.dir, hash)).size;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Check if a blob exists. */
	async has(hash: string): Promise<boolean> {
		try {
			await fsp.access(path.join(this.dir, hash));
			return true;
		} catch {
			return false;
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

/** Synchronous variant of {@link resolveImageDataUrl}. */
export function resolveImageDataUrlSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.getSync(hash);
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

/**
 * Price a persisted frame payload without reading it, then read it only if the
 * snapcompact frame budget keeps it. Missing blobs are dropped instead of sent
 * to a provider as storage references.
 */
export function lazyImageDataSync(blobStore: BlobStore, data: string): LazyFrameData | undefined {
	const hash = parseBlobRef(data);
	if (!hash) return isBlobRef(data) ? undefined : { bytes: data.length, read: () => data };
	const size = blobStore.sizeSync(hash);
	if (size === null) {
		logger.warn("Blob not found for image reference", { hash });
		return undefined;
	}
	return { bytes: Math.ceil(size / 3) * 4, read: () => resolveImageDataSync(blobStore, data) };
}
