/** Process-local rotating file sink: local-day and size rotation with bounded retention. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localDay } from "../dirs";

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
	/** Test seam: clock for day keys and rollover decisions. */
	readonly now?: () => Date;
	/**
	 * Called with the new active file path whenever the sink opens a different
	 * file — first write, local-day rotation, and size rotation alike.
	 *
	 * Consumers that hold their own descriptor on the active log (the macOS
	 * stderr guard dup2s it onto fd 2) use this to follow the sink instead of
	 * staying pinned to a file the sink later prunes.
	 * Throwing rejects the replacement: retain the working target and retry later.
	 */
	readonly onRotate?: (filePath: string) => void;
}

/**
 * Synchronous append sink with local-day and size rotation plus bounded retention.
 *
 * Construction performs no filesystem I/O. Files are opened when records are
 * flushed or an external writer explicitly acquires a target. Every file name
 * embeds the owning process's suffix (its PID); created and adopted files are
 * tracked in memory. Shared retention for earlier processes lives in
 * process-log.ts.
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
	readonly #now: () => Date;
	readonly #onRotate: ((filePath: string) => void) | undefined;
	/** Files this sink created or adopted, oldest first. */
	readonly #files: string[] = [];
	#activeDay: string | undefined;
	#activeIndex = 0;
	#activePath: string | undefined;
	/** Size of the active file including buffered records not yet written. */
	#activeBytes = 0;
	/** Last wall-clock external-size sample; see #selectFile. */
	#lastExternalCheckMs = 0;
	/** Cadence timer so external growth rotates even with no records. */
	#externalWatchTimer: NodeJS.Timeout | undefined;
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
		this.#now = options.now ?? (() => new Date());
	}

	#openFd(filePath: string): void {
		const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
		try {
			this.#onRotate?.(filePath);
		} catch (error) {
			fs.closeSync(fd);
			throw error;
		}
		this.#closeFd();
		this.#fd = fd;
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
	write(line: string, flushNow = false, day = localDay(this.#now())): void {
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
		this.stopWatchingExternalWrites();
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
		const hadPriorSelection = this.#activeDay !== undefined;
		if (!dayChanged && this.#activePath) {
			// fd 1/2 can be redirected onto the active log (terminal-output-guard);
			// those raw writes bypass write(), so the real file must be trusted over
			// the counter — but sampled at the batching cadence, not once per record:
			// high-volume logging must not pay a blocking stat per write.
			const now = Date.now();
			if (now - this.#lastExternalCheckMs >= (this.#batch?.intervalMs ?? 1_000)) {
				this.#lastExternalCheckMs = now;
				try {
					this.#activeBytes = Math.max(this.#activeBytes, fs.statSync(this.#activePath).size);
				} catch {
					// Active file missing or not yet chosen; keep the counter.
				}
			}
			if (this.#activeBytes <= this.#maxBytes) return;
		}
		// Flush to the old target, but retain its selection and fd until the
		// successor opens. A failed timer rotation must retry, not strand raw
		// writers on an untracked predecessor or prune their only working file.
		this.flush();
		let index = dayChanged ? 0 : this.#activeIndex;
		let filePath: string;
		let bytes: number;
		const adoptedFiles: string[] = [];
		for (;;) {
			const suffix = index === 0 ? "" : `.${index}`;
			filePath = path.join(this.#directory, `${this.#filenamePrefix}.${day}.${this.#filenameSuffix}.log${suffix}`);
			try {
				bytes = fs.statSync(filePath).size;
				adoptedFiles.push(filePath);
			} catch {
				bytes = 0;
			}
			if (bytes <= this.#maxBytes) break;
			index++;
		}
		if (index > 0 || (dayChanged && hadPriorSelection)) {
			try {
				this.#openFd(filePath);
			} catch (err) {
				// A blocked successor must not reject records while the previous
				// descriptor still works. Keep its selection so future ticks retry.
				if (this.#fd === undefined) throw err;
				return;
			}
		}
		this.#activeDay = day;
		this.#activeIndex = index;
		this.#activePath = filePath;
		this.#activeBytes = bytes;
		this.#lastExternalCheckMs = Date.now();
		// Opening closed the predecessor and notified external owners before
		// retention tries to unlink it (required on Windows).
		for (const adopted of adoptedFiles) this.#registerFile(adopted);
		if (this.#fd !== undefined) this.#registerFile(filePath);
	}

	/** Select/open the canonical file before an external writer receives its path. */
	openForExternalWrites(): string {
		if (this.#closed) throw new Error("Cannot acquire a closed log sink");
		this.#selectFile(localDay(this.#now()));
		const activePath = this.#activePath!;
		if (this.#fd === undefined) {
			this.#registerFile(activePath);
			this.#openFd(activePath);
		}
		this.#startExternalWatch();
		return activePath;
	}

	/** Stop idle sampling; diagnostic-only owners may also retire the held fd. */
	stopWatchingExternalWrites(closeFile = false): void {
		if (this.#externalWatchTimer !== undefined) {
			clearInterval(this.#externalWatchTimer);
			this.#externalWatchTimer = undefined;
		}
		if (closeFile) {
			try {
				this.flush();
			} catch {
				// A failed diagnostic flush must not prevent releasing its descriptor.
			} finally {
				this.#closeFd();
			}
		}
	}

	/**
	 * fd 1/2 redirected onto the active log keep appending even when no logger
	 * record arrives (an inherited child can be the only producer), so the
	 * size cap needs a cadence independent of `write()`. Each tick runs the
	 * same throttled sample `#selectFile` applies per record.
	 */
	#startExternalWatch(): void {
		if (this.#externalWatchTimer !== undefined || this.#closed) return;
		const intervalMs = this.#batch?.intervalMs ?? 1_000;
		this.#externalWatchTimer = setInterval(() => {
			try {
				this.checkExternalGrowth();
			} catch {
				// A background check has no caller to report to; logging never throws.
			}
		}, intervalMs);
		this.#externalWatchTimer.unref();
	}

	/** Run the external-size sample and rotate if the cap is exceeded. */
	checkExternalGrowth(): void {
		if (this.#closed) return;
		this.#selectFile(localDay(this.#now()));
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
