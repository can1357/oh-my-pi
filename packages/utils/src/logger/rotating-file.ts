/** Process-local rotating file sink: local-day and size rotation with bounded retention. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localDay } from "../dirs";
import { openCloexecSync } from "../fs-open";

/** Write batching for {@link RotatingFileSink}. */
export interface RotatingFileBatchOptions {
	/** Longest a buffered record waits before an unref'd timer writes it. */
	readonly intervalMs: number;
	/** Buffered UTF-8 bytes at which the batch is written immediately. */
	readonly maxBytes: number;
}

/** Configuration for a process-local rotating file sink. */
export interface RotatingFileOptions {
	readonly directory: string;
	readonly filenamePrefix: string;
	readonly filenameSuffix: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
	/**
	 * Buffer records and write them together instead of one write per record.
	 * Without it every record is written as it arrives.
	 */
	readonly batch?: RotatingFileBatchOptions;
	/**
	 * Called with the new active file path whenever the sink opens a different
	 * file — first write, local-day rotation, and size rotation alike.
	 *
	 * Consumers that hold their own descriptor on the active log (the macOS
	 * stderr guard dup2s it onto fd 2) use this to follow the sink instead of
	 * staying pinned to a file the sink later prunes.
	 */
	readonly onRotate?: (filePath: string) => void;
}

/**
 * Synchronous append sink with local-day and size rotation plus bounded retention.
 *
 * Construction performs no filesystem I/O: the first file is created when the
 * first record is written out, so a process that never logs leaves nothing on
 * disk. Every file name embeds the owning process's suffix (its PID), so the
 * set of files this sink created is tracked in memory; files left by earlier
 * processes are pruned by name pattern in the logger, not by this sink.
 *
 * With {@link RotatingFileOptions.batch}, records are buffered and written in
 * one `write` per batch. Buffered bytes already count toward the active file's
 * size, and the buffer is written to its file before any rotation, so file
 * selection matches an unbatched sink record for record.
 */
export class RotatingFileSink {
	readonly #directory: string;
	readonly #filenamePrefix: string;
	readonly #filenameSuffix: string;
	readonly #maxBytes: number;
	readonly #maxFiles: number;
	readonly #batch: RotatingFileBatchOptions | undefined;
	readonly #onRotate: ((filePath: string) => void) | undefined;
	/** Files this sink created, oldest first. */
	readonly #files: string[] = [];
	#activeDay: string | undefined;
	#activeIndex = 0;
	#activePath: string | undefined;
	/** Size of the active file including buffered records not yet written. */
	#activeBytes = 0;
	#closed = false;
	// Held append fd: one descriptor per active file instead of
	// open+write+close per line. It is reopened on rotation and closed on
	// close()/rotation (required for Windows delete-on-prune semantics).
	#fd: number | undefined;
	/** Records for the active file not yet written, each ending in EOL. */
	#pending = "";
	#pendingBytes = 0;
	#flushTimer: NodeJS.Timeout | undefined;

	constructor(options: RotatingFileOptions) {
		this.#directory = options.directory;
		this.#filenamePrefix = options.filenamePrefix;
		this.#filenameSuffix = options.filenameSuffix;
		this.#maxBytes = options.maxBytes;
		this.#maxFiles = options.maxFiles;
		this.#batch = options.batch;
		this.#onRotate = options.onRotate;
	}

	#openFd(filePath: string): void {
		this.#closeFd();
		this.#fd = openCloexecSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
		try {
			this.#onRotate?.(filePath);
		} catch {
			// A rotation observer must never break logging.
		}
	}

	#closeFd(): void {
		if (this.#fd !== undefined) {
			try {
				fs.closeSync(this.#fd);
			} catch {
				// Best-effort: the fd may already be invalid after rotation.
			}
			this.#fd = undefined;
		}
	}

	/**
	 * Append one already-formatted log record. A batching sink buffers it unless
	 * `flushNow` is set or the buffer reached its size threshold; either way the
	 * whole buffer, this record included, is then written in order. `day` is the
	 * record's `localDay` key, so callers that already took the record's `Date`
	 * reuse it.
	 */
	write(line: string, flushNow = false, day = localDay(new Date())): void {
		if (this.#closed) return;
		this.#selectFile(day);
		const record = `${line}${os.EOL}`;
		const bytes = Buffer.byteLength(record, "utf8");
		this.#pending += record;
		this.#pendingBytes += bytes;
		this.#activeBytes += bytes;
		const batch = this.#batch;
		if (flushNow || !batch || this.#pendingBytes >= batch.maxBytes) {
			this.flush();
		} else if (this.#flushTimer === undefined) {
			this.#flushTimer = setTimeout(this.#flushFromTimer, batch.intervalMs);
			this.#flushTimer.unref();
		}
	}

	/** Write every buffered record to the active file now. */
	flush(): void {
		if (this.#flushTimer !== undefined) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		const activePath = this.#activePath;
		if (this.#pendingBytes === 0 || !activePath) return;
		const buf = Buffer.from(this.#pending, "utf8");
		// Drop the batch even if the write below fails, so a broken file cannot
		// make the buffer grow without bound.
		this.#pending = "";
		this.#pendingBytes = 0;
		if (this.#fd === undefined) {
			this.#registerFile(activePath);
			this.#openFd(activePath);
		}
		let off = 0;
		while (off < buf.length) {
			const written = fs.writeSync(this.#fd!, buf, off);
			if (written <= 0) break;
			off += written;
		}
	}

	#flushFromTimer = (): void => {
		this.#flushTimer = undefined;
		try {
			this.flush();
		} catch {
			// A background flush has no caller to report to; logging never throws.
		}
	};

	/** Write buffered records, then stop accepting records. */
	close(): void {
		if (this.#closed) return;
		try {
			this.flush();
		} catch {
			// Best-effort: a failed final write must not keep the descriptor open.
		}
		this.#closed = true;
		this.#closeFd();
	}

	#selectFile(day: string): void {
		const dayChanged = day !== this.#activeDay;
		if (!dayChanged && this.#activeBytes <= this.#maxBytes) return;
		// The buffered records belong to the current file: write them there, then
		// close its descriptor BEFORE the next file is registered, because
		// registration prunes beyond maxFiles — on Windows the pruned
		// predecessor cannot be deleted while still open, which would leak it.
		this.flush();
		this.#closeFd();
		if (dayChanged) {
			this.#activeDay = day;
			this.#activeIndex = 0;
			this.#setActivePath(day, 0);
		}
		while (this.#activeBytes > this.#maxBytes) {
			this.#activeIndex++;
			this.#setActivePath(day, this.#activeIndex);
		}
	}

	#setActivePath(day: string, index: number): void {
		const suffix = index === 0 ? "" : `.${index}`;
		this.#activePath = path.join(
			this.#directory,
			`${this.#filenamePrefix}.${day}.${this.#filenameSuffix}.log${suffix}`,
		);
		try {
			this.#activeBytes = fs.statSync(this.#activePath).size;
		} catch {
			this.#activeBytes = 0;
		}
	}

	#registerFile(filePath: string): void {
		if (this.#files.includes(filePath)) return;
		this.#files.push(filePath);
		while (this.#files.length > this.#maxFiles) {
			const removed = this.#files.shift();
			if (!removed) break;
			try {
				fs.rmSync(removed, { force: true });
			} catch {
				// Retention is best-effort; the current record must still be written.
			}
		}
	}
}
