/** Behavior-compatible reimplementation of winston-daily-rotate-file's used surface. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface AuditEntry {
	readonly date: number;
	readonly name: string;
	readonly hash: string;
}

interface AuditState {
	readonly keep: { readonly days: false; readonly amount: number };
	readonly auditLog: string;
	readonly files: AuditEntry[];
	readonly hashType: "sha256";
}

/** Configuration for a process-local rotating file sink. */
export interface RotatingFileOptions {
	readonly directory: string;
	readonly filenamePrefix: string;
	readonly filenameSuffix: string;
	readonly auditFile: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
}

function isAuditEntry(value: unknown): value is AuditEntry {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.date === "number" && typeof entry.name === "string" && typeof entry.hash === "string";
}

/** Synchronous append sink with local-day and size rotation plus bounded retention. */
export class RotatingFileSink {
	readonly #directory: string;
	readonly #filenamePrefix: string;
	readonly #filenameSuffix: string;
	readonly #auditFile: string;
	readonly #maxBytes: number;
	readonly #maxFiles: number;
	#files: AuditEntry[];
	#activeDay: string | undefined;
	#activeIndex = 0;
	#activePath: string | undefined;
	#activeBytes = 0;
	#closed = false;

	constructor(options: RotatingFileOptions) {
		this.#directory = options.directory;
		this.#filenamePrefix = options.filenamePrefix;
		this.#filenameSuffix = options.filenameSuffix;
		this.#auditFile = options.auditFile;
		this.#maxBytes = options.maxBytes;
		this.#maxFiles = options.maxFiles;
		this.#files = this.#readAudit();
		const now = new Date();
		this.#selectFile(this.#localDay(now));
		const activePath = this.#activePath;
		if (activePath) {
			this.#registerFile(activePath, now.getTime());
			fs.closeSync(fs.openSync(activePath, "a"));
		}
	}

	/** Append one already-formatted log record. */
	write(line: string): void {
		if (this.#closed) return;
		const now = new Date();
		this.#selectFile(this.#localDay(now));
		const activePath = this.#activePath;
		if (!activePath) return;
		this.#registerFile(activePath, now.getTime());
		const record = `${line}${os.EOL}`;
		fs.appendFileSync(activePath, record, "utf8");
		this.#activeBytes += Buffer.byteLength(record);
	}

	/** Stop accepting records. Synchronous writes require no drain phase. */
	close(): void {
		this.#closed = true;
	}

	#localDay(date: Date): string {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	}

	#selectFile(day: string): void {
		if (day !== this.#activeDay) {
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

	#registerFile(filePath: string, date: number): void {
		if (this.#files.some(file => file.name === filePath)) return;
		const hash = crypto.createHash("sha256").update(`${filePath}LOG_FILE${date}`).digest("hex");
		this.#files.push({ date, name: filePath, hash });
		while (this.#files.length > this.#maxFiles) {
			const removed = this.#files.shift();
			if (!removed) break;
			try {
				fs.rmSync(removed.name, { force: true });
			} catch {
				// Retention is best-effort; the current record must still be written.
			}
		}
		this.#writeAudit();
	}

	#readAudit(): AuditEntry[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.#auditFile, "utf8")) as { files?: unknown };
			return Array.isArray(parsed.files) ? parsed.files.filter(isAuditEntry) : [];
		} catch {
			return [];
		}
	}

	#writeAudit(): void {
		const state: AuditState = {
			keep: { days: false, amount: this.#maxFiles },
			auditLog: this.#auditFile,
			files: this.#files,
			hashType: "sha256",
		};
		fs.writeFileSync(this.#auditFile, JSON.stringify(state, undefined, 4), "utf8");
	}
}
