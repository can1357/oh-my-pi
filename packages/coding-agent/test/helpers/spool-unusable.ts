/**
 * Ways to keep the local spool a full session rewrite streams through from
 * being used, to hold its writes or to cut its reads short, and the store's
 * warnings about it, for tests of what the rewrite does then.
 */
import { vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/** The warnings among `calls` (a `logger.warn` spy's) that are about the spool. */
export function spoolWarnings(calls: ReadonlyArray<readonly unknown[]>): ReadonlyArray<readonly unknown[]> {
	return calls.filter(([message]) => String(message).includes("spool"));
}

/**
 * The descriptors `openSync` (the synchronous spool) and `open` (the
 * asynchronous one) open on files under `dir` from now on, until
 * `vi.restoreAllMocks()`. A number leaves the set when `closeSync` closes it,
 * as the spool closes its file, since a later open may reuse it for a file
 * elsewhere; a holder may also delete a number once it is done with it.
 */
function descriptorsOpenedUnder(dir: string): Set<number> {
	const { closeSync, open, openSync } = fs;
	const prefix = `${dir}${path.sep}`;
	const fds = new Set<number>();
	vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]): number => {
		const fd: number = Reflect.apply(openSync, fs, [file, ...rest]);
		if (String(file).startsWith(prefix)) fds.add(fd);
		return fd;
	}) as typeof fs.openSync);
	vi.spyOn(fs, "closeSync").mockImplementation(((fd: number): void => {
		fds.delete(fd);
		Reflect.apply(closeSync, fs, [fd]);
	}) as typeof fs.closeSync);
	vi.spyOn(fs, "open").mockImplementation(((file: fs.PathLike, ...rest: unknown[]): void => {
		const callback = rest.pop() as (err: NodeJS.ErrnoException | null, fd: number) => void;
		Reflect.apply(open, fs, [
			file,
			...rest,
			(err: NodeJS.ErrnoException | null, fd: number) => {
				if (!err && String(file).startsWith(prefix)) fds.add(fd);
				callback(err, fd);
			},
		]);
	}) as typeof fs.open);
	return fds;
}

function enospc(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), {
		code: "ENOSPC",
		errno: -28,
		syscall: "write",
	});
}

/**
 * Fill the disk under `dir` for the spool: the first write to each descriptor
 * opened on a file under `dir` lands half its bytes and fails with ENOSPC, as
 * a write to a disk that fills does. Covers the synchronous spool
 * (`writeFileSync`) and the asynchronous one (`write`). The spool closes its
 * descriptor once a write fails, so that write is its last on it. Counts the
 * writes it failed. `vi.restoreAllMocks()` undoes it.
 */
export function fillDiskUnder(dir: string): { refused: () => number } {
	const { write, writeFileSync } = fs;
	const spoolFds = descriptorsOpenedUnder(dir);
	let refused = 0;
	/** Whether this write to `fd` is the first to a spool's descriptor, which fails. */
	const refuses = (fd: unknown): boolean => {
		if (typeof fd !== "number" || !spoolFds.delete(fd)) return false;
		refused++;
		return true;
	};
	vi.spyOn(fs, "writeFileSync").mockImplementation(((
		file: fs.PathOrFileDescriptor,
		data: string | NodeJS.ArrayBufferView,
		...rest: unknown[]
	): void => {
		if (!refuses(file)) {
			Reflect.apply(writeFileSync, fs, [file, data, ...rest]);
			return;
		}
		const bytes =
			typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		writeFileSync(file as number, bytes.subarray(0, bytes.byteLength >> 1));
		throw enospc();
	}) as typeof fs.writeFileSync);
	vi.spyOn(fs, "write").mockImplementation(((fd: number, buffer: Uint8Array, ...rest: unknown[]): void => {
		if (!refuses(fd)) {
			Reflect.apply(write, fs, [fd, buffer, ...rest]);
			return;
		}
		const callback = rest.pop() as (err: NodeJS.ErrnoException | null, written: number) => void;
		const position = rest[2] as number | null | undefined;
		write(fd, buffer.subarray(0, buffer.byteLength >> 1), 0, buffer.byteLength >> 1, position ?? null, () => {
			callback(enospc(), 0);
		});
	}) as typeof fs.write);
	return { refused: () => refused };
}

/**
 * Hold the first asynchronous write (`fs.write`) to a spool file under `dir`
 * until `release` runs; `reached` resolves once that write waits. A spool
 * written through synchronous calls never reaches it. `vi.restoreAllMocks()`
 * undoes the hold for later writes; a held write waits for `release`, so a
 * test releases it in its teardown too, or that write, its spool file and
 * the rewrite waiting on it never finish.
 */
export function holdFirstSpoolWrite(dir: string): { reached: Promise<void>; release: () => void } {
	const { write } = fs;
	const spoolFds = descriptorsOpenedUnder(dir);
	const reached = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let held = false;
	vi.spyOn(fs, "write").mockImplementation(((fd: number, ...rest: unknown[]): void => {
		if (held || !spoolFds.has(fd)) {
			Reflect.apply(write, fs, [fd, ...rest]);
			return;
		}
		held = true;
		reached.resolve();
		void gate.promise.then(() => Reflect.apply(write, fs, [fd, ...rest]));
	}) as typeof fs.write);
	return { reached: reached.promise, release: () => gate.resolve() };
}

/**
 * End each spool file opened under `dir` at byte `bytes` for its
 * asynchronous reads (`fs.read`), as a file cut short there reads: a read
 * that starts before it finds at most the bytes up to it, and one that
 * starts at or past it finds none. Counts the reads it cut.
 * `vi.restoreAllMocks()` undoes it.
 */
export function endSpoolReadsAt(dir: string, bytes: number): { cut: () => number } {
	const { read } = fs;
	const spoolFds = descriptorsOpenedUnder(dir);
	let cut = 0;
	vi.spyOn(fs, "read").mockImplementation(((fd: number, ...rest: unknown[]): void => {
		// `fs.read(fd, buffer, offset, length, position, callback)`, as the spool calls it.
		const [buffer, offset, length, position, callback] = rest as [
			NodeJS.ArrayBufferView,
			number,
			number,
			number | bigint | null,
			(err: NodeJS.ErrnoException | null, bytesRead: number, buffer: NodeJS.ArrayBufferView) => void,
		];
		if (rest.length !== 5 || !spoolFds.has(fd) || typeof position !== "number" || position + length <= bytes) {
			Reflect.apply(read, fs, [fd, ...rest]);
			return;
		}
		cut++;
		const before = bytes - position;
		if (before > 0) Reflect.apply(read, fs, [fd, buffer, offset, before, position, callback]);
		else process.nextTick(() => callback(null, 0, buffer));
	}) as typeof fs.read);
	return { cut: () => cut };
}
