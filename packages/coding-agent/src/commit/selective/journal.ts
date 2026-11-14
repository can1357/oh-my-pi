/**
 * Append-only record of which agent changed which file, shared by a root session and its subagents.
 *
 * The journal lives beside the session artifacts (`<artifacts>/changes.jsonl`, content blobs under
 * `<artifacts>/blobs/`). Subagents adopt the root's artifact manager, so one journal covers the
 * whole agent tree. Edit tools append a {@link ChangeRecord} per write; shell-like tools append a
 * {@link CallRecord} per call so changes made by scripts can be traced to a call window; the
 * selective commit flow appends a {@link CommitRecord} per commit it creates.
 *
 * `draft.ts` reads the journal to preselect an agent's own lines when committing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";

/** Journal file name inside the artifacts directory. */
const JOURNAL_FILE = "changes.jsonl";
/** Blob directory name inside the artifacts directory. */
const BLOB_DIR = "blobs";
/** Larger snapshots are not stored; their file is treated as unrecorded. */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** Identity of the agent a record belongs to. */
export interface JournalAgent {
	/** Registry id (`Main`, `AuthLoader`). */
	agent: string;
	/** Parent agent id; absent for the root agent. */
	parent?: string;
}

/** One write of a file by an agent's edit tool. Blobs are keys into the journal's blob store. */
export interface ChangeRecord extends JournalAgent {
	type: "change";
	/** Epoch ms when the write landed. */
	at: number;
	/** Tool that wrote (`edit`, `write`, `ast_edit`, `task`). */
	tool: string;
	/** Absolute path. */
	path: string;
	/** Content before the write; `null` when the file did not exist; `undefined` when not stored (too large). */
	before: string | null | undefined;
	/** Content after the write; `null` when the write deleted the file; `undefined` when not stored. */
	after: string | null | undefined;
	/** The file's mtime just before the write; locates whoever changed it since the agent's previous write. */
	beforeMtimeMs?: number;
}

/** One shell-like tool call (`bash`, `eval`); files modified inside its window may be the agent's. */
export interface CallRecord extends JournalAgent {
	type: "call";
	tool: string;
	/** Epoch ms when the call started. */
	start: number;
	/** Epoch ms when the call returned. */
	end: number;
	/** One-line description (command head, cell title). */
	label: string;
}

/** Display cap for a call label. */
const CALL_LABEL_CHARS = 80;

/** One-line {@link CallRecord.label} from `bash`/`eval` arguments: the command's or cell's first line. */
export function callLabel(args: unknown): string {
	if (!isRecord(args)) return "";
	const source = [args.title, args.command, args.code].find(value => typeof value === "string" && value.trim());
	const line = typeof source === "string" ? (source.trim().split("\n", 1)[0] ?? "") : "";
	return line.length > CALL_LABEL_CHARS ? `${line.slice(0, CALL_LABEL_CHARS)}…` : line;
}

/** A commit created by the selective commit flow. */
export interface CommitRecord extends JournalAgent {
	type: "commit";
	at: number;
	sha: string;
	/** Repo-relative paths the commit changed. */
	paths: string[];
}

export type JournalRecord = ChangeRecord | CallRecord | CommitRecord;

/** Content snapshot passed to {@link ChangeJournal.recordChange}; `null` = file absent. */
export interface ChangeInput extends JournalAgent {
	tool: string;
	path: string;
	before: string | null;
	after: string | null;
	beforeMtimeMs?: number;
}

/** File state read before a write, for {@link ChangeInput.before}. */
export interface FileSnapshot {
	/** Content; `null` when the file does not exist. */
	text: string | null;
	mtimeMs?: number;
}

/** Read `file` before writing it; `undefined` when it cannot be read (the write then goes unjournaled). */
export async function readSnapshot(file: string): Promise<FileSnapshot | undefined> {
	try {
		const handle = Bun.file(file);
		const [text, stat] = await Promise.all([handle.text(), handle.stat()]);
		return { text, mtimeMs: stat.mtimeMs };
	} catch (error) {
		return isEnoent(error) ? { text: null } : undefined;
	}
}

const journals = new Map<string, ChangeJournal>();

/** Journal for one artifacts directory, shared by every session writing to it. */
export class ChangeJournal {
	readonly dir: string;
	#queue: Promise<void> = Promise.resolve();
	#dirReady = false;
	#storedBlobs = new Set<string>();

	constructor(dir: string) {
		this.dir = dir;
	}

	/** The process-wide journal for `artifactsDir`. */
	static at(artifactsDir: string): ChangeJournal {
		let journal = journals.get(artifactsDir);
		if (!journal) {
			journal = new ChangeJournal(artifactsDir);
			journals.set(artifactsDir, journal);
		}
		return journal;
	}

	/**
	 * Record a file write. Appends in call order; failures are logged, never thrown, so a full
	 * disk cannot fail the edit that triggered the record.
	 */
	recordChange(input: ChangeInput): void {
		if (input.before === input.after) return;
		const at = Date.now();
		this.#enqueue(async () => {
			const [before, after] = await Promise.all([this.#storeBlob(input.before), this.#storeBlob(input.after)]);
			const record: ChangeRecord = {
				type: "change",
				at,
				agent: input.agent,
				parent: input.parent,
				tool: input.tool,
				path: input.path,
				before,
				after,
				beforeMtimeMs: input.beforeMtimeMs,
			};
			await this.#append(record);
		});
	}

	/** Record a finished shell-like tool call window. */
	recordCall(record: Omit<CallRecord, "type">): void {
		this.#enqueue(() => this.#append({ type: "call", ...record }));
	}

	/** Record a commit created by the selective commit flow; resolves once it is on disk. */
	recordCommit(record: Omit<CommitRecord, "type" | "at">): Promise<void> {
		this.#enqueue(() => this.#append({ type: "commit", at: Date.now(), ...record }));
		return this.flush();
	}

	/** Resolve once every queued record is on disk. */
	flush(): Promise<void> {
		return this.#queue;
	}

	/** Every record, oldest first. Waits for queued appends. */
	async read(): Promise<JournalRecord[]> {
		await this.flush();
		let text: string;
		try {
			text = await Bun.file(path.join(this.dir, JOURNAL_FILE)).text();
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		const records: JournalRecord[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				records.push(JSON.parse(line) as JournalRecord);
			} catch {
				// A torn final line from a crash mid-append; earlier records stay valid.
			}
		}
		return records;
	}

	/** Content for a blob key; `undefined` when the blob is missing. */
	async blob(key: string): Promise<string | undefined> {
		try {
			const bytes = await fs.readFile(path.join(this.dir, BLOB_DIR, key));
			return new TextDecoder().decode(Bun.gunzipSync(bytes));
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
	}

	#enqueue(task: () => Promise<void>): void {
		this.#queue = this.#queue.then(task).catch(error => {
			logger.warn("Change journal append failed", { dir: this.dir, error: String(error) });
		});
	}

	async #append(record: JournalRecord): Promise<void> {
		await this.#ensureDir();
		await fs.appendFile(path.join(this.dir, JOURNAL_FILE), `${JSON.stringify(record)}\n`);
	}

	async #ensureDir(): Promise<void> {
		if (this.#dirReady) return;
		await fs.mkdir(path.join(this.dir, BLOB_DIR), { recursive: true });
		this.#dirReady = true;
	}

	/** Store `content` content-addressed; `null` passes through, oversized content yields `undefined`. */
	async #storeBlob(content: string | null): Promise<string | null | undefined> {
		if (content === null) return null;
		const bytes = Buffer.from(content, "utf8");
		if (bytes.byteLength > MAX_BLOB_BYTES) return undefined;
		const key = `${bytes.byteLength.toString(36)}-${Bun.hash(bytes).toString(36)}`;
		if (this.#storedBlobs.has(key)) return key;
		await this.#ensureDir();
		await Bun.write(path.join(this.dir, BLOB_DIR, key), Bun.gzipSync(bytes));
		this.#storedBlobs.add(key);
		return key;
	}
}
