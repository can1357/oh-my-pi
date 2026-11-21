/**
 * Append-only record of which agent changed which file, shared by a root session and its subagents.
 *
 * The journal lives beside the session artifacts (`<artifacts>/changes.jsonl`, large payloads under
 * `<artifacts>/blobs/`). Subagents adopt the root's artifact manager, so one journal covers the
 * whole agent tree. Edit tools append a {@link ChangeRecord} per write; the selective commit flow
 * appends a {@link CommitRecord} per commit it creates. Nothing else is recorded: what scripts,
 * formatters, and other processes change shows up only as the difference between recorded writes.
 *
 * The embedded shell reports what its own builtins and redirections wrote ({@link shellChangeSnapshots}),
 * so `sed -i`, `mv`, `rm` and `cat > file` are recorded like an edit tool's write.
 *
 * A file is stored whole once, as it was before its first recorded write. Every later record holds
 * line changes against the content the previous record left ({@link ChangeRecord.gap},
 * {@link ChangeRecord.edit}); {@link ChangeJournal.snapshots} replays that chain.
 *
 * `draft.ts` reads the journal to preselect an agent's own lines when committing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ShellFileChange } from "@oh-my-pi/pi-natives";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { changedRegionsWithin, fromLines, toLines } from "./attribution";

/** Journal file name inside the artifacts directory. */
const JOURNAL_FILE = "changes.jsonl";
/** Blob directory name inside the artifacts directory. */
const BLOB_DIR = "blobs";
/** Larger snapshots are not stored; their record leaves the path without replayable history. */
const MAX_SNAPSHOT_CHARS = 8 * 1024 * 1024;
/** Deltas whose JSON is longer go to the blob store instead of the journal line. */
const INLINE_DELTA_CHARS = 4096;
/** Added or removed lines up to which a write is diffed exactly; a larger rewrite is one replaced block. */
const MAX_DELTA_EDITS = 1024;
/** Characters of latest file contents kept in memory to diff the next write against. */
const TIP_CACHE_CHARS = 32 * 1024 * 1024;
/** Decodes snapshots byte for byte: a leading UTF-8 BOM stays part of the text, as it is on disk. */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** Identity of the agent a record belongs to. */
export interface JournalAgent {
	/** Registry id (`Main`, `AuthLoader`). */
	agent: string;
	/** Parent agent id; absent for the root agent. */
	parent?: string;
}

/**
 * Line changes turning one content into another: `[start, removed, inserted]` per changed region,
 * in order, `start` counting lines of the earlier content. Lines are `text.split("\n")`; an absent
 * file has none.
 */
export type LineDelta = Array<[start: number, removed: number, inserted: string[]]>;

/** A {@link LineDelta} kept in its record, or the key of the blob holding a larger one. */
type StoredDelta = LineDelta | string;

/**
 * One write of a file by an agent's edit tool. A path's records form a chain: each starts from the
 * content the previous one left, unless it carries a `base`.
 */
export interface ChangeRecord extends JournalAgent {
	type: "change";
	/** Epoch ms when the write landed. */
	at: number;
	/** Tool that wrote (`edit`, `write`, `ast_edit`, `task`, `bash`, `eval`). */
	tool: string;
	/** Absolute path. */
	path: string;
	/**
	 * Blob key of the whole content before the write (`null`: the file did not exist). Set when
	 * the writer no longer holds the content the previous record left: on a path's first record,
	 * and again after a restart, an unstored record, or a long time without a write.
	 */
	base?: string | null;
	/** Changes nobody recorded, between the previous record's result and the content this write replaced. */
	gap?: StoredDelta;
	/** Changes this write made. Absent when a snapshot was too large or binary; replay cannot pass such a record. */
	edit?: StoredDelta;
	/** Hash of the content after the write, checked on replay. */
	sum?: string;
}

/** A commit created by the selective commit flow. */
export interface CommitRecord extends JournalAgent {
	type: "commit";
	at: number;
	sha: string;
	/** Repo-relative paths the commit changed. */
	paths: string[];
}

export type JournalRecord = ChangeRecord | CommitRecord;

/** Content snapshot passed to {@link ChangeJournal.recordChange}; `null` = file absent. */
export interface ChangeInput extends JournalAgent {
	tool: string;
	path: string;
	before: string | null;
	after: string | null;
}

/** One recorded write with the content around it, as replayed by {@link ChangeJournal.snapshots}. */
export interface RecordedWrite {
	agent: string;
	/** Content the write replaced; `null` when the file did not exist. */
	before: string | null;
	/** Content the write left; `null` when it deleted the file. */
	after: string | null;
}

/** File state read before a write, for {@link ChangeInput.before}. */
export interface FileSnapshot {
	/** Content; `null` when the file does not exist. */
	text: string | null;
}

/** Read `file` before writing it; `undefined` when it cannot be read (the write then goes unjournaled). */
export async function readSnapshot(file: string): Promise<FileSnapshot | undefined> {
	try {
		return { text: UTF8.decode(await Bun.file(file).bytes()) };
	} catch (error) {
		return isEnoent(error) ? { text: null } : undefined;
	}
}

/**
 * The snapshots of a change an embedded-shell run reported, decoded as {@link readSnapshot} decodes
 * a file. The shell spells paths as the command did (`dir/./file`); the journal keys them normalized.
 */
export function shellChangeSnapshots(change: ShellFileChange): Pick<ChangeInput, "path" | "before" | "after"> {
	return {
		path: path.normalize(change.path),
		before: change.before ? UTF8.decode(change.before) : null,
		after: change.after ? UTF8.decode(change.after) : null,
	};
}

/** A file's content as lines and as text (`null`: absent). */
interface Content {
	lines: readonly string[];
	text: string | null;
}

function contentSum(text: string | null): string {
	return text === null ? "-" : Bun.hash(text).toString(36);
}

/**
 * Line changes turning `from` into `to`. A rewrite of more than {@link MAX_DELTA_EDITS} lines
 * becomes one block replacing everything between the lines both ends share.
 */
function lineDelta(from: readonly string[], to: readonly string[]): LineDelta {
	const shorter = Math.min(from.length, to.length);
	let head = 0;
	while (head < shorter && from[head] === to[head]) head++;
	let tail = 0;
	while (tail < shorter - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++;
	const a = from.slice(head, from.length - tail);
	const b = to.slice(head, to.length - tail);
	const regions = changedRegionsWithin(a, b, MAX_DELTA_EDITS) ?? [{ i1: 0, i2: a.length, j1: 0, j2: b.length }];
	return regions.map((region): LineDelta[number] => [
		head + region.i1,
		region.i2 - region.i1,
		b.slice(region.j1, region.j2),
	]);
}

/** `lines` with `delta` applied; `undefined` when the delta does not fit them. */
function applyDelta(lines: readonly string[], delta: LineDelta): readonly string[] | undefined {
	if (delta.length === 0) return lines;
	const parts: Array<readonly string[]> = [];
	let at = 0;
	for (const [start, removed, inserted] of delta) {
		if (start < at || start + removed > lines.length) return undefined;
		parts.push(lines.slice(at, start), inserted);
		at = start + removed;
	}
	parts.push(lines.slice(at));
	return parts.flat();
}

const journals = new Map<string, ChangeJournal>();

/** Journal for one artifacts directory, shared by every session writing to it. */
export class ChangeJournal {
	readonly dir: string;
	#queue: Promise<void> = Promise.resolve();
	#dirReady = false;
	#storedBlobs = new Set<string>();
	/**
	 * Content the latest record of each path left (`null`: absent), least recently written first.
	 * The next write of a path is stored as changes against it; a path without one stores a `base`.
	 */
	#tips = new Map<string, string | null>();
	#tipChars = 0;

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
			const record: ChangeRecord = {
				type: "change",
				at,
				agent: input.agent,
				parent: input.parent,
				tool: input.tool,
				path: input.path,
			};
			// The tip returns only once this record is in the file: after a failed or unstored
			// record the next one carries a base instead of changes against content nobody can replay.
			const tip = this.#takeTip(input.path);
			// Oversized and binary snapshots are not stored; drafts commit such files whole anyway.
			const stored = [input.before, input.after].every(
				text => text === null || (text.length <= MAX_SNAPSHOT_CHARS && !text.includes("\0")),
			);
			if (stored) {
				const before = toLines(input.before);
				if (tip === undefined) {
					record.base = input.before === null ? null : await this.#storeBlob(input.before);
				} else if (tip !== input.before) {
					record.gap = await this.#storeDelta(lineDelta(toLines(tip), before));
				}
				record.edit = await this.#storeDelta(lineDelta(before, toLines(input.after)));
				record.sum = contentSum(input.after);
			}
			await this.#append(record);
			if (stored) this.#setTip(input.path, input.after);
		});
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

	/**
	 * Replay `records` (one path's changes, oldest first) into the content around each write.
	 *
	 * A record that cannot be replayed (an unstored snapshot, a missing blob, a result that does
	 * not match its recorded hash) drops the history up to it: the writes that follow the next
	 * `base` are returned on their own. `undefined` when no write can be replayed.
	 */
	async snapshots(records: readonly ChangeRecord[]): Promise<RecordedWrite[] | undefined> {
		let writes: RecordedWrite[] = [];
		let tip: Content | undefined;
		for (const record of records) {
			const before = await this.#contentBefore(record, tip);
			const edit = record.edit === undefined ? undefined : await this.#loadDelta(record.edit);
			const lines = before && edit && applyDelta(before.lines, edit);
			tip = lines && { lines, text: fromLines(lines) };
			if (!before || !tip || contentSum(tip.text) !== record.sum) {
				writes = [];
				tip = undefined;
				continue;
			}
			writes.push({ agent: record.agent, before: before.text, after: tip.text });
		}
		return writes.length > 0 ? writes : undefined;
	}

	/** Content `record`'s write replaced: its `base`, else what the previous record left (`tip`) plus its `gap`. */
	async #contentBefore(record: ChangeRecord, tip: Content | undefined): Promise<Content | undefined> {
		if (record.base !== undefined) {
			const text = record.base === null ? null : await this.#loadBlob(record.base);
			return text === undefined ? undefined : { lines: toLines(text), text };
		}
		if (!tip || record.gap === undefined) return tip;
		const gap = await this.#loadDelta(record.gap);
		const lines = gap && applyDelta(tip.lines, gap);
		return lines && { lines, text: fromLines(lines) };
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

	/** Remove and return `file`'s tip; `undefined` when there is none. */
	#takeTip(file: string): string | null | undefined {
		const tip = this.#tips.get(file);
		if (tip === undefined) return undefined;
		this.#tips.delete(file);
		this.#tipChars -= tip?.length ?? 0;
		return tip;
	}

	/** Make `text` the tip of `file`, evicting the least recently written tips past {@link TIP_CACHE_CHARS}. */
	#setTip(file: string, text: string | null): void {
		this.#tips.set(file, text);
		this.#tipChars += text?.length ?? 0;
		for (const [oldest, tip] of this.#tips) {
			if (this.#tipChars <= TIP_CACHE_CHARS) break;
			this.#tips.delete(oldest);
			this.#tipChars -= tip?.length ?? 0;
		}
	}

	/** `delta` as its record holds it: itself, or the key of its blob past {@link INLINE_DELTA_CHARS}. */
	async #storeDelta(delta: LineDelta): Promise<StoredDelta> {
		const json = JSON.stringify(delta);
		return json.length > INLINE_DELTA_CHARS ? this.#storeBlob(json) : delta;
	}

	async #loadDelta(stored: StoredDelta): Promise<LineDelta | undefined> {
		if (typeof stored !== "string") return stored;
		const json = await this.#loadBlob(stored);
		if (json === undefined) return undefined;
		const delta: LineDelta = JSON.parse(json);
		return delta;
	}

	/** Store `content` gzipped under a key derived from it, and return the key. */
	async #storeBlob(content: string): Promise<string> {
		const bytes = Buffer.from(content, "utf8");
		const key = `${bytes.byteLength.toString(36)}-${Bun.hash(bytes).toString(36)}`;
		if (this.#storedBlobs.has(key)) return key;
		await this.#ensureDir();
		await Bun.write(path.join(this.dir, BLOB_DIR, key), Bun.gzipSync(bytes));
		this.#storedBlobs.add(key);
		return key;
	}

	/** Content of a blob; `undefined` when it is missing. */
	async #loadBlob(key: string): Promise<string | undefined> {
		try {
			const bytes = await fs.readFile(path.join(this.dir, BLOB_DIR, key));
			return UTF8.decode(Bun.gunzipSync(bytes));
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
	}
}
