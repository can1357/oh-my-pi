/**
 * Sessions replication domain — replicates only the session *index*
 * (per-file metadata), never bodies.
 *
 * S3 has no append, and a session JSONL grows by one line per message, so
 * read-modify-writing a whole object per line would be pathological. The live
 * append path therefore stays local and authoritative; bodies are archived to
 * object storage by {@link SessionReplicator}, and only this lightweight index
 * travels over the JSON broker. The payload carries just enough
 * (`rel`/`size`/`mtimeMs`/`title`) for the resume picker on machine B to list a
 * session whose body exists only on machine A — selecting it triggers a body
 * fetch via `SessionReplicator.ensureLocal`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { SESSION_TITLE_SLOT_BYTES } from "../../session/session-entries";
import { sessionDirNameForCwd } from "../../session/session-paths";
import { parseTitleSlotFromContent } from "../../session/session-title-slot";
import { decodeWireKey, encodeWireKey, projectById } from "../project-scope";
import type { ReplicatedDomain, StateSyncStore } from "../replica";
import {
	isValidWireRelCwd,
	isValidWireSessionFile,
	type OwnedSessionFile,
	scanOwnedSessions,
} from "../session-files";
import type { StateEntry } from "../wire";

/** Metadata a remote-only session needs to appear in the resume picker. */
export interface SessionIndexEntry {
	/**
	 * Session file path relative to the sessions dir, POSIX separators
	 * (`<localDirName>/<file>.jsonl`). Always this machine's local layout: an
	 * index row carries the path the resume picker can actually open here, not
	 * the origin machine's.
	 */
	rel: string;
	/** Registered project id this session belongs to (wire identity). */
	projectId: string;
	/**
	 * Project-relative POSIX cwd the session was started in, `""` at the project
	 * root. Carried through so the resume path can rewrite a downloaded body's
	 * header to THIS machine's matching subdirectory (not just the project root).
	 */
	relCwd: string;
	/** Body size in bytes at last observation. */
	size: number;
	/** File mtime in epoch millis — also the replication `rev`. */
	mtimeMs: number;
	/** Current session title, when the fixed-width title slot carried one. */
	title?: string;
}

/**
 * On-disk shape of the remote-only session index cache. Versioned so a future
 * layout change can be detected and discarded rather than misread.
 */
interface SessionIndexFile {
	version: 1;
	entries: Record<string, SessionIndexEntry>;
}

const INDEX_VERSION = 1 as const;
const INDEX_FILENAME = "remote-session-index.json";

const utf8Decoder = new TextDecoder("utf-8");

/**
 * Read the remote-only session index. Returns `[]` when the cache is absent —
 * and NEVER creates it — so a sync-disabled install reads nothing from disk.
 * Exposed for the resume picker integration owner.
 */
export function readRemoteSessionIndex(sessionsDir: string = getSessionsDir()): SessionIndexEntry[] {
	try {
		const raw = fs.readFileSync(path.join(path.dirname(sessionsDir), INDEX_FILENAME), "utf-8");
		const parsed = JSON.parse(raw) as SessionIndexFile;
		if (parsed?.version !== INDEX_VERSION || typeof parsed.entries !== "object" || parsed.entries === null) {
			return [];
		}
		return Object.values(parsed.entries);
	} catch {
		// Missing cache, unreadable file, or malformed JSON — all mean "no remote
		// sessions known", which is the correct sync-disabled/offline behaviour.
		return [];
	}
}

/**
 * Read the current session title cheaply from the fixed-width first-line slot
 * (exactly {@link SESSION_TITLE_SLOT_BYTES} bytes) without loading the body.
 */
function readTitleSlot(absPath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(absPath, "r");
		const buf = Buffer.allocUnsafe(SESSION_TITLE_SLOT_BYTES);
		const read = fs.readSync(fd, buf, 0, SESSION_TITLE_SLOT_BYTES, 0);
		const slot = parseTitleSlotFromContent(utf8Decoder.decode(buf.subarray(0, read)));
		const title = slot?.title?.trim();
		return title ? title : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// fd already gone; nothing to recover.
			}
		}
	}
}

/**
 * Index keys naming `file` within `projectId`, whatever local subdirectory the
 * row landed in.
 *
 * A key is `<localDirName>/<file>`, and the directory half is derived from THIS
 * machine's project path, so it is not knowable from a wire entry alone: a
 * subdirectory session, or a project since repointed, produces a different one.
 * Session filenames embed a UUID and are unique within a project, so every hit
 * is the same logical session.
 */
function keysForSessionFile(
	index: Record<string, SessionIndexEntry>,
	projectId: string,
	file: string,
): string[] {
	const suffix = `/${file}`;
	const hits: string[] = [];
	for (const [key, row] of Object.entries(index)) {
		if (row.projectId === projectId && key.endsWith(suffix)) hits.push(key);
	}
	return hits;
}

class SessionsDomain implements ReplicatedDomain {
	readonly id = "sessions" as const;

	readonly #sessionsDir: string;
	/**
	 * Lazily loaded remote-only index. Loading is deferred until the first
	 * merge so constructing the domain (which happens only when sync is
	 * enabled) still touches no disk until there is something to record.
	 */
	#index: Record<string, SessionIndexEntry> | undefined;

	/**
	 * The replica's own cursor database, used to remember published keys so a
	 * local deletion becomes a tombstone. Undefined runs the domain without
	 * deletion propagation.
	 */
	readonly #store: StateSyncStore | undefined;

	constructor(sessionsDir: string, store?: StateSyncStore) {
		this.#sessionsDir = sessionsDir;
		this.#store = store;
	}

	/**
	 * Session bodies of SYNC-ENABLED projects only, whose mtime is strictly
	 * newer than `afterRev`, ascending by mtime, capped at `limit`, plus
	 * tombstones for sessions this replica published and no longer has.
	 *
	 * Directory enumeration and project-ownership confirmation live in
	 * {@link scanOwnedSessions}, shared with the `titles` domain so the two
	 * cannot disagree about which sessions belong to a synced project.
	 *
	 * Ascending order is mandatory: the engine advances its watermark to the
	 * last returned entry's `rev`. Filtering (mtime AND ownership) happens
	 * DURING the scan, before the limit, so a capped page is never post-filtered
	 * down to empty while newer eligible rows wait beyond it.
	 *
	 * A live enumeration alone cannot see a session that is gone, so deleting
	 * one through the picker used to leave its row on the broker forever. Worse,
	 * this replica then pulled its OWN published row back and the deleted
	 * session reappeared as a remote-only stub whose body was still in the
	 * archive, so selecting it downloaded the session the user had just deleted.
	 * The published-key ledger is what makes the deletion expressible.
	 *
	 * A tombstone is only ever inferred for a project the scan can SPEAK FOR
	 * (`completeProjects`). Absence is ambiguous otherwise: a project switched to
	 * `sync: false`, unregistered, or whose directories momentarily failed to
	 * read also has no files here, and tombstoning those would delete sessions
	 * that still exist from every other machine. Worse, they could not be
	 * restored by re-enabling the project, because the surviving bodies carry
	 * their original mtimes and would lose LWW against the newer tombstone until
	 * each session was written again.
	 */
	changedSince(afterRev: number, limit: number): StateEntry[] {
		const scan = scanOwnedSessions(this.#sessionsDir, { afterRev: 0 });
		const owned = scan.files;
		const pending: Array<{ key: string; rev: number; file?: OwnedSessionFile }> = [];
		for (const file of owned) {
			if (file.mtimeMs > afterRev) {
				// The wire key is `<projectId>\0<file>`: the filename carries a UUID
				// so it is unique across a project's subdirectories, and the key
				// therefore need NOT encode location. `relCwd` carries location.
				pending.push({ key: encodeWireKey(file.projectId, file.file), rev: file.mtimeMs, file });
			}
		}
		if (this.#store) {
			const liveKeys = new Set(owned.map(f => encodeWireKey(f.projectId, f.file)));
			const now = Date.now();
			for (const prior of this.#store.published("sessions")) {
				if (liveKeys.has(prior.key)) continue;
				// Absence only means deletion for a project this scan enumerated.
				// A disabled/unregistered project, or one whose directory failed to
				// read, is silently skipped: its rows stay published untouched and
				// are neither tombstoned nor forgotten.
				const decodedPrior = decodeWireKey(prior.key);
				if (!decodedPrior || !scan.completeProjects.has(decodedPrior.id)) continue;
				// Absent locally. Latch a tombstone rev on first sight, then keep
				// re-offering the same rev until the watermark passes it, so a
				// failed push retries instead of dropping the deletion.
				//
				// The rev must be strictly ABOVE the row it retracts, and
				// `Date.now()` alone is not: a body's published rev is its floored
				// mtime, so deleting a session in the same millisecond it was
				// published yields `now === prior.rev`, the `rev > afterRev` test
				// below fails, and the tombstone is dropped AND forgotten. LWW on
				// the receiving side would ignore an equal rev anyway.
				const rev = prior.deleted ? prior.rev : Math.max(now, prior.rev + 1);
				if (!prior.deleted) this.#store.recordDeleted("sessions", prior.key, rev);
				if (rev > afterRev) pending.push({ key: prior.key, rev });
				else this.#store.forgetPublished("sessions", prior.key);
			}
		}

		// Sort and cap AFTER assembling both kinds; the filtering above already
		// happened, so a capped page is never post-filtered to empty.
		pending.sort((a, b) => a.rev - b.rev);
		return pending.slice(0, Math.max(0, limit)).map(item => {
			if (!item.file) return { key: item.key, rev: item.rev, value: null };
			this.#store?.recordPublished("sessions", item.key, item.rev);
			return {
				key: item.key,
				rev: item.rev,
				value: {
					projectId: item.file.projectId,
					// Where the session lives inside the project; the receiver needs
					// it to place the body in the right local subdirectory.
					relCwd: item.file.relCwd,
					file: item.file.file,
					size: item.file.size,
					mtimeMs: item.file.mtimeMs,
					// Read the title only for the capped page, not every scanned file.
					title: readTitleSlot(item.file.abs),
				},
			};
		});
	}

	/**
	 * Merge remote index rows into the local cache under last-writer-wins on
	 * `rev` (= mtime), so replays are idempotent. A `null` value is a tombstone
	 * that removes the row. One malformed entry is dropped with a log line
	 * rather than aborting the batch, then the cache is persisted once.
	 *
	 * FAIL CLOSED: a row whose project is unknown here or has sync disabled is
	 * skipped, never recorded — a machine that has not registered a project
	 * must not accumulate index rows pointing at a directory it cannot open.
	 * Rows are keyed under this machine's LOCAL rel so the resume picker sees a
	 * local-looking path.
	 */
	applyRemote(entries: readonly StateEntry[]): void {
		if (entries.length === 0) return;
		const index = this.#loadIndex();
		let dirty = false;

		for (const entry of entries) {
			const decoded = typeof entry.key === "string" ? decodeWireKey(entry.key) : undefined;
			if (!decoded) {
				logger.warn(`[state:sessions] dropping entry with invalid key: ${String(entry.key)}`);
				continue;
			}
			const project = projectById(decoded.id);
			if (!project?.sync) {
				// Unregistered or sync-disabled here — fail closed and do not record.
				logger.debug(`[state:sessions] skipping row for unmapped project: ${decoded.id}`);
				continue;
			}
			// The wire rel is the bare filename; the local dir is derived from the
			// project mapping on THIS machine PLUS the session's project-relative
			// cwd, so a subdirectory session lands in the matching local subdir.
			//
			// Checked before BOTH branches so `file` means the same thing in each.
			// Unlike the config domain's inbound gate, the tombstone path here is
			// not separately exploitable — its `endsWith("/" + file)` match only
			// gets harder to satisfy with extra path segments, and the project id
			// is already confirmed above — but that match is only meaningful while
			// `file` is guaranteed to be a bare name, which is what this enforces.
			const file = decoded.rel;
			if (!isValidWireSessionFile(file)) {
				logger.warn(`[state:sessions] dropping entry with unsafe file name: ${JSON.stringify(file)}`);
				continue;
			}

			if (entry.value === null) {
				// Tombstone: relCwd is unknown here, so remove any local row for
				// this project's file wherever its subdir landed (filenames are
				// UUID-unique, so at most one matches).
				for (const key of keysForSessionFile(index, project.id, file)) {
					if (index[key].mtimeMs >= entry.rev) continue;
					delete index[key];
					dirty = true;
				}
				continue;
			}

			const value = entry.value as Partial<SessionIndexEntry> | null;
			if (typeof value !== "object" || value === null) {
				logger.warn(`[state:sessions] dropping entry with non-object value: ${file}`);
				continue;
			}
			// Tolerate a missing `relCwd` from an older peer by treating the
			// session as project-root (""), but never accept one that would place
			// the row outside the project.
			if (value.relCwd !== undefined && !isValidWireRelCwd(value.relCwd)) {
				logger.warn(`[state:sessions] dropping entry with unsafe relCwd: ${JSON.stringify(value.relCwd)}`);
				continue;
			}
			const relCwd = typeof value.relCwd === "string" ? value.relCwd : "";
			const localDir = sessionDirNameForCwd(
				relCwd ? path.join(project.localPath, ...relCwd.split("/")) : project.localPath,
			);
			const localRel = `${localDir}/${file}`;

			const existing = index[localRel];
			// LWW: ignore anything not strictly newer than what we already hold.
			if (existing && existing.mtimeMs >= entry.rev) continue;
			// A row's key encodes THIS machine's directory name, which changes when
			// `omp project path` repoints the project. The repoint resets the
			// inbound cursor, so every row replays and computes a new key while the
			// old path-derived one stays behind: the picker would then show two
			// stubs for one session, and selecting the stale one would download the
			// body into the directory the project no longer lives in. Filenames are
			// UUID-unique within a project, so any other key naming this file is by
			// definition the same session at a stale path.
			for (const key of keysForSessionFile(index, project.id, file)) {
				if (key === localRel) continue;
				delete index[key];
				dirty = true;
			}

			index[localRel] = {
				rel: localRel,
				projectId: project.id,
				relCwd,
				size: typeof value.size === "number" ? value.size : 0,
				mtimeMs: entry.rev,
				...(typeof value.title === "string" && value.title ? { title: value.title } : {}),
			};
			dirty = true;
		}

		if (dirty) this.#persistIndex(index);
	}

	#loadIndex(): Record<string, SessionIndexEntry> {
		if (this.#index) return this.#index;
		const loaded: Record<string, SessionIndexEntry> = {};
		for (const entry of readRemoteSessionIndex(this.#sessionsDir)) {
			if (entry && typeof entry.rel === "string") loaded[entry.rel] = entry;
		}
		this.#index = loaded;
		return loaded;
	}

	/** Persist the index via temp+rename so a reader never sees a half file. */
	#persistIndex(index: Record<string, SessionIndexEntry>): void {
		const target = path.join(path.dirname(this.#sessionsDir), INDEX_FILENAME);
		const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
		const payload: SessionIndexFile = { version: INDEX_VERSION, entries: index };
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(tmp, JSON.stringify(payload));
			fs.renameSync(tmp, target);
		} catch (err) {
			logger.warn(`[state:sessions] failed to persist session index: ${String(err)}`);
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// Best-effort cleanup of the abandoned temp file.
			}
		}
	}
}

/**
 * Build the sessions replication domain. Constructing it touches no disk; the
 * index cache is created only when a remote row is actually merged.
 */
export function createSessionsDomain(
	sessionsDir: string = getSessionsDir(),
	store?: StateSyncStore,
): ReplicatedDomain {
	return new SessionsDomain(sessionsDir, store);
}

/**
 * Map a wire index entry from {@link SessionsDomain.changedSince} to this
 * machine's local session rel (`<localDirName>/<file>`) plus the project id
 * that owns it, or undefined when the entry's project is not registered/synced
 * here. The registry's body uploader uses it to schedule the matching body: the
 * local dir name is derived from the project mapping PLUS the session's
 * project-relative cwd (from the value), so a subdirectory session resolves to
 * its own local subdir — never read from a machine-specific path on the wire.
 *
 * The id is returned rather than left for the caller to re-derive, because the
 * encoded dir name is ambiguous between a subdirectory session and a sibling
 * project's root; deriving ownership from it can key a body under the wrong
 * project.
 */
export function localSessionRelForEntry(entry: StateEntry): { rel: string; projectId: string } | undefined {
	const decoded = typeof entry.key === "string" ? decodeWireKey(entry.key) : undefined;
	if (!decoded) return undefined;
	const project = projectById(decoded.id);
	if (!project?.sync) return undefined;
	const value = entry.value as Partial<SessionIndexEntry> | null;
	// Tolerate a missing `relCwd` (older peer / tombstone) as project-root ("").
	const relCwd = value && typeof value.relCwd === "string" ? value.relCwd : "";
	const localDir = sessionDirNameForCwd(
		relCwd ? path.join(project.localPath, ...relCwd.split("/")) : project.localPath,
	);
	return { rel: `${localDir}/${decoded.rel}`, projectId: project.id };
}
