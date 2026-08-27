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
import { parseTitleSlotFromContent, parseTitleSlotLine } from "../../session/session-title-slot";
import { decodeWireKey, encodeWireKey, listSyncedProjects, projectById, resolveProject } from "../project-scope";
import type { ReplicatedDomain } from "../replica";
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
 * Bytes read from the head of a session body when confirming ownership: the
 * fixed-width title slot plus a generous window for the variable-width session
 * header line. A header longer than this cannot be confirmed (and is rejected),
 * but real headers are a few hundred bytes, so 64 KiB is comfortably safe.
 */
const HEADER_SCAN_BYTES = SESSION_TITLE_SLOT_BYTES + 64 * 1024;

/**
 * Ceiling on the per-process ownership-confirmation cache. Sessions accumulate
 * over a long-lived TUI, so the cache is bounded and evicts oldest-first rather
 * than growing without limit.
 */
const CONFIRM_CACHE_MAX = 4_096;

/**
 * Read the origin `cwd` from a session body's header (the first JSON record
 * after the title slot) without loading the whole file. Legacy bodies omit the
 * slot and start with the header. Returns undefined when the header is missing,
 * unparseable, not a session record, or lacks a `cwd`.
 */
function readHeaderCwd(absPath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(absPath, "r");
		const buf = Buffer.allocUnsafe(HEADER_SCAN_BYTES);
		const read = fs.readSync(fd, buf, 0, HEADER_SCAN_BYTES, 0);
		const text = utf8Decoder.decode(buf.subarray(0, read));
		const firstNl = text.indexOf("\n");
		if (firstNl < 0) return undefined;
		// The header follows the title slot when present, else starts at byte 0.
		let headerStart = 0;
		let headerEnd = firstNl;
		if (parseTitleSlotLine(text.slice(0, firstNl))) {
			const secondNl = text.indexOf("\n", firstNl + 1);
			if (secondNl < 0) return undefined;
			headerStart = firstNl + 1;
			headerEnd = secondNl;
		}
		const parsed: unknown = JSON.parse(text.slice(headerStart, headerEnd));
		if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "session") {
			return undefined;
		}
		const cwd = "cwd" in parsed ? parsed.cwd : undefined;
		return typeof cwd === "string" && cwd ? cwd : undefined;
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
	 * Per-process cache of session-ownership confirmations, keyed by
	 * `<abs>\0<mtimeMs>\0<size>` so a body that changes on disk is re-confirmed.
	 * A value of `null` records a confirmed non-owner (unregistered cwd) so we
	 * do not re-read its header every sync cycle. Bounded by
	 * {@link CONFIRM_CACHE_MAX}; oldest insertions are evicted first.
	 */
	readonly #confirmCache = new Map<string, { projectId: string; relCwd: string } | null>();

	constructor(sessionsDir: string) {
		this.#sessionsDir = sessionsDir;
	}

	/**
	 * Session bodies of SYNC-ENABLED projects only, whose mtime is strictly
	 * newer than `afterRev`, ascending by mtime, capped at `limit`.
	 *
	 * A session may start in any SUBDIRECTORY of a project, which lands it in a
	 * distinct encoded dir (`~/projects/foo/pkg/a` -> `-projects-foo-pkg-a`),
	 * not the project root's dir. In a monorepo that is most sessions. We must
	 * therefore scan the project root dir AND every child dir whose encoded name
	 * extends it. The trailing `-` in the prefix test is essential: a bare
	 * `startsWith(base)` would also swallow a sibling project such as
	 * `~/projects/foobar` (`-projects-foobar`) when base is `-projects-foo`.
	 *
	 * The encoding is NOT losslessly reversible (`-projects-foo-pkg-a` is
	 * ambiguous between `foo/pkg/a`, `foo-pkg/a`, and `foo/pkg-a`), so each
	 * candidate is CONFIRMED against the project by reading its header `cwd` and
	 * checking `resolveProject(cwd)?.project.id`. Confirmation is cached per
	 * `(path, mtime, size)` so a sync cycle does not re-read every header.
	 *
	 * FAIL CLOSED: an unregistered / sync-disabled project is never enumerated,
	 * and a candidate whose header resolves to a different project is rejected.
	 *
	 * Ascending order is mandatory: the engine advances its watermark to the
	 * last returned entry's `rev`. Filtering (mtime AND ownership) happens
	 * DURING the scan, before the limit, so a capped page is never post-filtered
	 * down to empty while newer eligible rows wait beyond it.
	 */
	changedSince(afterRev: number, limit: number): StateEntry[] {
		const changed: Array<{
			projectId: string;
			relCwd: string;
			file: string;
			abs: string;
			size: number;
			mtimeMs: number;
		}> = [];
		const rootDirs = this.#readRootDirs();
		for (const project of listSyncedProjects()) {
			const base = sessionDirNameForCwd(project.localPath);
			for (const dirName of rootDirs) {
				// Root dir OR a subdirectory session dir (`<base>-<...>`).
				if (dirName !== base && !dirName.startsWith(`${base}-`)) continue;
				const dir = path.join(this.#sessionsDir, dirName);
				let files: string[];
				try {
					files = Array.from(new Bun.Glob("*.jsonl").scanSync(dir));
				} catch {
					// This dir vanished between readdir and scan — skip it.
					continue;
				}
				for (const file of files) {
					const abs = path.join(dir, file);
					let stat: fs.Stats;
					try {
						stat = fs.statSync(abs);
					} catch {
						continue;
					}
					// `mtimeMs` is a float with sub-millisecond precision, but a
					// `rev` is contractually an integer (`stateEntrySchema` rejects
					// non-integers). Floor before the watermark test as well as
					// before publication: comparing the raw float against a floored
					// watermark would re-emit every session forever, since
					// 100.9 > floor(100.9).
					const mtimeMs = Math.floor(stat.mtimeMs);
					if (!stat.isFile() || mtimeMs <= afterRev) continue;
					// Confirm this file actually belongs to `project` (see method
					// doc): the encoded dir name alone cannot be trusted.
					const owner = this.#confirmOwner(abs, mtimeMs, stat.size);
					if (!owner || owner.projectId !== project.id) continue;
					changed.push({ projectId: project.id, relCwd: owner.relCwd, file, abs, size: stat.size, mtimeMs });
				}
			}
		}

		changed.sort((a, b) => a.mtimeMs - b.mtimeMs);
		const page = changed.slice(0, Math.max(0, limit));
		return page.map(entry => ({
			// The wire key is `<projectId>\0<file>`: the filename carries a UUID so
			// it is unique across a project's subdirectories, and the key therefore
			// need NOT encode location. `relCwd` in the value carries location.
			key: encodeWireKey(entry.projectId, entry.file),
			rev: entry.mtimeMs,
			value: {
				projectId: entry.projectId,
				// Where the session lives inside the project; the receiver needs it
				// to place the body in the right local subdirectory.
				relCwd: entry.relCwd,
				file: entry.file,
				size: entry.size,
				mtimeMs: entry.mtimeMs,
				// Read the title only for the capped page, not every scanned file.
				title: readTitleSlot(entry.abs),
			},
		}));
	}

	/** Immediate child dir names of the sessions root; `[]` when it is absent. */
	#readRootDirs(): string[] {
		try {
			return fs
				.readdirSync(this.#sessionsDir, { withFileTypes: true })
				.filter(e => e.isDirectory())
				.map(e => e.name);
		} catch {
			return [];
		}
	}

	/**
	 * Confirm which synced project (if any) owns the session body at `abs`, plus
	 * its project-relative cwd, by reading the header `cwd` and resolving it.
	 * Cached by `(path, mtime, size)`; `null` records a confirmed non-owner so a
	 * later cycle does not re-read the header. The cache is bounded.
	 */
	#confirmOwner(abs: string, mtimeMs: number, size: number): { projectId: string; relCwd: string } | null {
		const cacheKey = `${abs}\u0000${mtimeMs}\u0000${size}`;
		const cached = this.#confirmCache.get(cacheKey);
		if (cached !== undefined) return cached;

		let result: { projectId: string; relCwd: string } | null = null;
		const cwd = readHeaderCwd(abs);
		if (!cwd) {
			logger.debug(`[state:sessions] ownership unconfirmed, no header cwd: ${abs}`);
		} else {
			const resolved = resolveProject(cwd);
			if (resolved) result = { projectId: resolved.project.id, relCwd: resolved.rel };
			else logger.debug(`[state:sessions] ownership unconfirmed, cwd not in any project: ${cwd}`);
		}

		// Bound the cache: evict oldest insertion (Map preserves order) first.
		if (this.#confirmCache.size >= CONFIRM_CACHE_MAX) {
			const oldest = this.#confirmCache.keys().next().value;
			if (oldest !== undefined) this.#confirmCache.delete(oldest);
		}
		this.#confirmCache.set(cacheKey, result);
		return result;
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
			const file = decoded.rel;

			if (entry.value === null) {
				// Tombstone: relCwd is unknown here, so remove any local row for
				// this project's file wherever its subdir landed (filenames are
				// UUID-unique, so at most one matches).
				for (const [key, row] of Object.entries(index)) {
					if (row.projectId === project.id && key.endsWith(`/${file}`) && row.mtimeMs < entry.rev) {
						delete index[key];
						dirty = true;
					}
				}
				continue;
			}

			const value = entry.value as Partial<SessionIndexEntry> | null;
			if (typeof value !== "object" || value === null) {
				logger.warn(`[state:sessions] dropping entry with non-object value: ${file}`);
				continue;
			}
			// Tolerate a missing `relCwd` from an older peer by treating the
			// session as project-root ("").
			const relCwd = typeof value.relCwd === "string" ? value.relCwd : "";
			const localDir = sessionDirNameForCwd(
				relCwd ? path.join(project.localPath, ...relCwd.split("/")) : project.localPath,
			);
			const localRel = `${localDir}/${file}`;

			const existing = index[localRel];
			// LWW: ignore anything not strictly newer than what we already hold.
			if (existing && existing.mtimeMs >= entry.rev) continue;

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
export function createSessionsDomain(sessionsDir: string = getSessionsDir()): ReplicatedDomain {
	return new SessionsDomain(sessionsDir);
}

/**
 * Map a wire index entry from {@link SessionsDomain.changedSince} to this
 * machine's local session rel (`<localDirName>/<file>`), or undefined when the
 * entry's project is not registered/synced here. The registry's body uploader
 * uses it to schedule the matching body: the local dir name is derived from the
 * project mapping PLUS the session's project-relative cwd (from the value), so a
 * subdirectory session resolves to its own local subdir — never read from a
 * machine-specific path on the wire.
 */
export function localSessionRelForEntry(entry: StateEntry): string | undefined {
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
	return `${localDir}/${decoded.rel}`;
}
