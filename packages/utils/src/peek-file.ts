/**
 * Read the first `maxBytes` of a file (offset 0) and pass that slice to `op`.
 *
 * Buffers are reused to avoid allocating on every peek: sync uses one growable
 * `Uint8Array`; async uses a small fixed pool of `Buffer`s with a bounded wait
 * queue, falling back to a fresh allocation when the pool and queue are saturated
 * or when `maxBytes` exceeds the pool slot size.
 */
import * as fs from "node:fs";

/** Async pool slot size; larger peeks allocate ad hoc. */
const POOLED_BUFFER_SIZE = 512;
const ASYNC_POOL_SIZE = 10;
/** Cap waiter queue so heavy concurrency does not queue unbounded; overflow uses alloc. */
const MAX_ASYNC_WAITERS = 4;
const INITIAL_SYNC_BUFFER_SIZE = 1024;
const EMPTY_BUFFER = Buffer.alloc(0);

const asyncPool = Array.from({ length: ASYNC_POOL_SIZE }, () => Buffer.allocUnsafe(POOLED_BUFFER_SIZE));
const availableAsyncPoolIndexes = Array.from({ length: ASYNC_POOL_SIZE }, (_, index) => index);
const asyncPoolWaiters: Array<(index: number) => void> = [];
let syncPool = new Uint8Array(INITIAL_SYNC_BUFFER_SIZE);

/** Returns a pool slot index, or `-1` when the caller should use a standalone buffer. */
function acquireAsyncPoolIndex(): Promise<number> | number {
	const index = availableAsyncPoolIndexes.pop();
	if (index !== undefined) {
		return index;
	}
	if (asyncPoolWaiters.length >= MAX_ASYNC_WAITERS) {
		return -1;
	}
	const { promise, resolve } = Promise.withResolvers<number>();
	asyncPoolWaiters.push(resolve);
	return promise;
}

function releaseAsyncPoolIndex(index: number): void {
	if (index < 0) {
		return;
	}
	const waiter = asyncPoolWaiters.shift();
	if (waiter) {
		waiter(index);
		return;
	}
	availableAsyncPoolIndexes.push(index);
}

async function withAsyncPoolBuffer<T>(maxBytes: number, op: (buffer: Buffer) => Promise<T>): Promise<T> {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}
	if (maxBytes > POOLED_BUFFER_SIZE) {
		return op(Buffer.allocUnsafe(maxBytes));
	}

	const poolIndex = await acquireAsyncPoolIndex();
	const buffer = poolIndex >= 0 ? asyncPool[poolIndex] : Buffer.allocUnsafe(maxBytes);
	try {
		return await op(buffer.subarray(0, maxBytes));
	} finally {
		releaseAsyncPoolIndex(poolIndex);
	}
}

function withSyncPoolBuffer<T>(maxBytes: number, op: (buffer: Uint8Array) => T): T {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}
	if (maxBytes > syncPool.byteLength) {
		syncPool = new Uint8Array(maxBytes + (maxBytes >> 1));
	}
	return op(syncPool.subarray(0, maxBytes));
}

/**
 * Synchronously reads up to `maxBytes` from the start of `filePath` and returns `op(header)`.
 * If the file is shorter, `header` is only the bytes actually read.
 */
export function peekFileSync<T>(filePath: string, maxBytes: number, op: (header: Uint8Array) => T): T {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}

	const fileHandle = fs.openSync(filePath, "r");
	try {
		return withSyncPoolBuffer(maxBytes, buffer => {
			const bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.byteLength, 0);
			return op(buffer.subarray(0, bytesRead));
		});
	} finally {
		fs.closeSync(fileHandle);
	}
}

/**
 * Like {@link peekFileSync} but uses async I/O.
 */
export async function peekFile<T>(filePath: string, maxBytes: number, op: (header: Uint8Array) => T): Promise<T> {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}

	const fileHandle = await fs.promises.open(filePath, "r");
	try {
		return await withAsyncPoolBuffer(maxBytes, async buffer => {
			const { bytesRead } = await fileHandle.read(buffer, 0, buffer.byteLength, 0);
			return op(buffer.subarray(0, bytesRead));
		});
	} finally {
		await fileHandle.close();
	}
}

/**
 * Read up to the last `maxBytes` of `filePath` and pass that slice to `op`.
 *
 * The tail mirror of {@link peekFile}: same pooled-buffer strategy (no per-call
 * allocation for small reads), but the read is positioned at `size - len` so the
 * window ends at EOF. When the file is shorter than `maxBytes`, the whole file is
 * returned. A multi-byte codepoint straddling the leading cut decodes to a
 * replacement char — callers that parse line-oriented tails drop the partial
 * leading line anyway.
 */
export async function peekFileTail<T>(filePath: string, maxBytes: number, op: (tail: Uint8Array) => T): Promise<T> {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}

	const fileHandle = await fs.promises.open(filePath, "r");
	try {
		const { size } = await fileHandle.stat();
		const len = Math.min(maxBytes, size);
		if (len <= 0) {
			return op(EMPTY_BUFFER);
		}
		return await withAsyncPoolBuffer(len, async buffer => {
			const { bytesRead } = await fileHandle.read(buffer, 0, buffer.byteLength, size - len);
			return op(buffer.subarray(0, bytesRead));
		});
	} finally {
		await fileHandle.close();
	}
}

/**
 * Read up to the first `prefixBytes` and last `suffixBytes` of `filePath`, then
 * pass both slices to `op`.
 *
 * Uses a single open/stat sequence. When the whole file fits in the head window,
 * the tail is sliced from the already-read head bytes instead of issuing a
 * second read.
 */
export async function peekFileEnds<T>(
	filePath: string,
	prefixBytes: number,
	suffixBytes: number,
	op: (head: Uint8Array, tail: Uint8Array) => T,
): Promise<T> {
	if (prefixBytes <= 0 && suffixBytes <= 0) {
		return op(EMPTY_BUFFER, EMPTY_BUFFER);
	}

	const fileHandle = await fs.promises.open(filePath, "r");
	try {
		const { size } = await fileHandle.stat();
		const headLen = prefixBytes > 0 ? Math.min(prefixBytes, size) : 0;
		const tailLen = suffixBytes > 0 ? Math.min(suffixBytes, size) : 0;

		const head = headLen > 0 ? Buffer.allocUnsafe(headLen) : EMPTY_BUFFER;
		const headBytesRead = headLen > 0 ? (await fileHandle.read(head, 0, head.byteLength, 0)).bytesRead : 0;
		const headSlice = head.subarray(0, headBytesRead);

		if (tailLen <= 0) {
			return op(headSlice, EMPTY_BUFFER);
		}
		if (size <= headLen) {
			return op(headSlice, headSlice.subarray(Math.max(0, headBytesRead - tailLen)));
		}

		const tail = Buffer.allocUnsafe(tailLen);
		const { bytesRead: tailBytesRead } = await fileHandle.read(tail, 0, tail.byteLength, size - tailLen);
		return op(headSlice, tail.subarray(0, tailBytesRead));
	} finally {
		await fileHandle.close();
	}
}
