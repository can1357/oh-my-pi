import { LRUCache } from "../lru";
import { ArchiveError } from "./error";

/**
 * A byte window into an archive — file-backed (lazy, ranged reads) or
 * in-memory. Format readers index through this so ZIP/ASAR/RAR payloads are
 * only read when a member is actually extracted.
 */
export interface ByteSource {
	readonly size: number;
	read(start: number, end: number): Promise<Uint8Array>;
}

/** Reject a nonsensical `[start, end)` range before any read. */
export function assertValidRange(start: number, end: number): void {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new ArchiveError("Invalid archive range");
	}
}

/** Read an exact in-memory range, throwing (not clamping) when it runs past the buffer. */
export function readMemoryRange(buffer: Uint8Array, start: number, end: number): Uint8Array {
	assertValidRange(start, end);
	if (end > buffer.byteLength) {
		throw new ArchiveError("Invalid archive: truncated data");
	}
	return buffer.subarray(start, end);
}

/** Wrap borrowed bytes as a {@link ByteSource}. */
export function memoryByteSource(buffer: Uint8Array): ByteSource {
	return {
		size: buffer.byteLength,
		async read(start, end) {
			return readMemoryRange(buffer, start, end);
		},
	};
}

/** Lazily read ranges of a file on disk as a {@link ByteSource}. */
export function fileByteSource(filePath: string): ByteSource {
	const file = Bun.file(filePath);
	const size = file.size;
	if (!Number.isSafeInteger(size)) {
		throw new ArchiveError("Archive is too large to read safely");
	}
	return {
		size,
		async read(start, end) {
			assertValidRange(start, end);
			const bytes = await file.slice(start, end).bytes();
			if (bytes.byteLength !== end - start) {
				throw new ArchiveError("Invalid archive: truncated data");
			}
			return bytes;
		},
	};
}

/** Materialize an entire {@link ByteSource}; use only under a limits check. */
export async function readAllBytes(source: ByteSource): Promise<Uint8Array> {
	return source.read(0, source.size);
}

/** Options for {@link httpByteSource}. */
export interface HttpByteSourceOptions {
	/** Extra request headers (e.g. authorization). */
	headers?: Record<string, string>;
	/** Fetch implementation seam for tests; defaults to global `fetch`. */
	fetch?: typeof fetch;
	/**
	 * When the server ignores `Range` (responds 200), the body is buffered in
	 * memory instead, capped to this many bytes. Default 256 MiB.
	 */
	maxFallbackBytes?: number;
}

const HTTP_FALLBACK_CAP = 256 * 1024 * 1024;

/**
 * A {@link ByteSource} over HTTP(S) range requests, so remote archives can be
 * indexed and read member-by-member without downloading the whole file.
 * Probes with `Range: bytes=0-0`; servers without range support fall back to
 * one bounded full download. Wrap with {@link cachingByteSource} to coalesce
 * the many small header reads format parsers issue.
 */
export async function httpByteSource(url: string | URL, options: HttpByteSourceOptions = {}): Promise<ByteSource> {
	const doFetch = options.fetch ?? fetch;
	const headers = { ...options.headers, range: "bytes=0-0" };
	const probe = await doFetch(url, { headers });
	if (probe.status === 200) {
		// No range support: buffer the whole body once, bounded.
		const cap = options.maxFallbackBytes ?? HTTP_FALLBACK_CAP;
		const declared = Number(probe.headers.get("content-length") ?? 0);
		if (declared > cap) {
			throw new ArchiveError(
				`Remote archive is too large to buffer without range support (${declared} > ${cap} bytes)`,
			);
		}
		const bytes = new Uint8Array(await probe.arrayBuffer());
		if (bytes.byteLength > cap) {
			throw new ArchiveError(`Remote archive is too large to buffer without range support (> ${cap} bytes)`);
		}
		return memoryByteSource(bytes);
	}
	if (probe.status !== 206) {
		await probe.body?.cancel();
		throw new ArchiveError(`Remote archive request failed (HTTP ${probe.status})`);
	}
	await probe.body?.cancel();
	// `Content-Range: bytes 0-0/12345` carries the total size.
	const contentRange = probe.headers.get("content-range");
	const total = contentRange ? Number(/\/(\d+)$/.exec(contentRange)?.[1]) : Number.NaN;
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new ArchiveError("Remote archive did not report a valid size in Content-Range");
	}
	return {
		size: total,
		async read(start, end) {
			assertValidRange(start, end);
			if (start === end) return new Uint8Array(0);
			const response = await doFetch(url, {
				headers: { ...options.headers, range: `bytes=${start}-${end - 1}` },
			});
			if (response.status !== 206) {
				await response.body?.cancel();
				throw new ArchiveError(`Remote archive range request failed (HTTP ${response.status})`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength !== end - start) {
				throw new ArchiveError("Invalid archive: truncated data");
			}
			return bytes;
		},
	};
}

/** Options for {@link cachingByteSource}. */
export interface CachingByteSourceOptions {
	/** Cache block size in bytes. Default 256 KiB. */
	blockSize?: number;
	/** Max cached blocks. Default 64 (16 MiB at the default block size). */
	maxBlocks?: number;
}

/**
 * Wrap a high-latency {@link ByteSource} (HTTP, network filesystems) with an
 * aligned-block LRU cache. Small header reads coalesce into shared block
 * fetches (concurrent readers of one block share a single in-flight request);
 * reads spanning more than two blocks bypass the cache to avoid copying large
 * member payloads through it.
 */
export function cachingByteSource(source: ByteSource, options: CachingByteSourceOptions = {}): ByteSource {
	const blockSize = options.blockSize ?? 256 * 1024;
	const blocks = new LRUCache<number, Promise<Uint8Array>>({ max: options.maxBlocks ?? 64 });
	const readBlock = (index: number): Promise<Uint8Array> => {
		const cached = blocks.get(index);
		if (cached) return cached;
		const start = index * blockSize;
		const pending = source.read(start, Math.min(start + blockSize, source.size));
		blocks.set(index, pending);
		pending.catch(() => blocks.delete(index));
		return pending;
	};
	return {
		size: source.size,
		async read(start, end) {
			assertValidRange(start, end);
			if (end > source.size) {
				throw new ArchiveError("Invalid archive: truncated data");
			}
			if (start === end) return new Uint8Array(0);
			const firstBlock = Math.floor(start / blockSize);
			const lastBlock = Math.floor((end - 1) / blockSize);
			if (lastBlock - firstBlock > 1) return source.read(start, end);
			const out = new Uint8Array(end - start);
			for (let index = firstBlock; index <= lastBlock; index++) {
				const block = await readBlock(index);
				const blockStart = index * blockSize;
				const from = Math.max(start, blockStart);
				const to = Math.min(end, blockStart + block.byteLength);
				if (to < Math.min(end, blockStart + blockSize)) {
					throw new ArchiveError("Invalid archive: truncated data");
				}
				out.set(block.subarray(from - blockStart, to - blockStart), from - start);
			}
			return out;
		},
	};
}
