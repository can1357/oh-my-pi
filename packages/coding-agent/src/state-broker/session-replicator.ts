/**
 * Session body mover — the archive half of sessions replication.
 *
 * Local JSONL is the authoritative live write path (S3 cannot append, and a
 * session grows one line per message). This class only mirrors finished bytes
 * to and from the object store, out of band from the append path:
 *
 * - {@link SessionReplicator.scheduleUpload} debounces per-path so a busy
 *   conversation is archived once per quiet period, not once per message;
 * - {@link SessionReplicator.uploadIfStale} pushes the local body when the
 *   remote copy is missing or behind;
 * - {@link SessionReplicator.ensureLocal} pulls a body that exists only on
 *   another machine, which is what makes cross-machine resume work;
 * - {@link SessionReplicator.drain} flushes pending uploads for graceful
 *   shutdown so the last turn is not stranded.
 *
 * All I/O is best-effort: a rejection is logged and swallowed, never surfaced
 * to the caller, so a dead object store degrades to local-only operation.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { sessionDirNameForCwd } from "../session/session-paths";
import { parseTitleSlotLine } from "../session/session-title-slot";
import { type ObjectStore, sessionKey } from "./object-store";
import { listSyncedProjects, projectObjectSlug, type ScopedProject } from "./project-scope";

/** Quiet period before a scheduled upload fires, coalescing a burst of appends. */
const UPLOAD_DEBOUNCE_MS = 3_000;

/** Ceiling on concurrent object-store transfers, shared by uploads and downloads. */
const MAX_CONCURRENT_TRANSFERS = 4;

export interface SessionReplicatorOptions {
	store: ObjectStore;
	sessionsDir: string;
}

export class SessionReplicator {
	readonly #store: ObjectStore;
	readonly #sessionsDir: string;

	/** Per-path debounce timers, coalescing repeated `scheduleUpload` calls. */
	readonly #timers = new Map<string, Timer>();
	/** In-flight transfer promises, awaited by {@link drain}. */
	readonly #inflight = new Set<Promise<void>>();

	/** Simple counting semaphore bounding concurrent transfers. */
	#active = 0;
	readonly #waiters: Array<() => void> = [];

	constructor(opts: SessionReplicatorOptions) {
		this.#store = opts.store;
		this.#sessionsDir = opts.sessionsDir;
	}

	/** Absolute local path for a wire `rel` (POSIX separators → native). */
	#localPath(rel: string): string {
		return path.join(this.#sessionsDir, ...rel.split("/"));
	}

	/**
	 * Resolve a local session `rel` (`<encodedDir>/<file>.jsonl`) to the synced
	 * project that owns it, plus the bare file name. Returns undefined when the
	 * rel's directory maps to no sync-enabled project — the enforcement point
	 * for the per-project toggle on session BODIES: a rel outside a synced
	 * project is never uploaded, downloaded, or keyed into the object store.
	 *
	 * A session may live in a SUBDIRECTORY of a project, whose encoded dir name
	 * extends the project root's (`~/projects/foo/pkg/a` -> `-projects-foo-pkg-a`
	 * vs `-projects-foo`), so we match the project root name OR a `<base>-...`
	 * extension. The trailing `-` is essential: a bare `startsWith(base)` would
	 * also claim a sibling project like `~/projects/foobar` (`-projects-foobar`)
	 * for `~/projects/foo`. When a nested project is also registered, the DEEPEST
	 * (longest) base wins — the body belongs to the innermost project. The object
	 * key is project+file only (filenames are UUID-unique), so identifying the
	 * project is sufficient; the in-project subdir does not affect the key.
	 */
	#projectForRel(rel: string): { project: ScopedProject; file: string } | undefined {
		const slash = rel.indexOf("/");
		if (slash <= 0) return undefined;
		const dirName = rel.slice(0, slash);
		const file = rel.slice(slash + 1);
		// Session files live directly under the per-cwd dir; reject nesting.
		if (!file || file.includes("/")) return undefined;
		let best: { project: ScopedProject; baseLen: number } | undefined;
		for (const project of listSyncedProjects()) {
			const base = sessionDirNameForCwd(project.localPath);
			if (dirName !== base && !dirName.startsWith(`${base}-`)) continue;
			if (!best || base.length > best.baseLen) best = { project, baseLen: base.length };
		}
		return best ? { project: best.project, file } : undefined;
	}

	/**
	 * Object-store key for a session body, namespaced by PROJECT rather than by
	 * the machine-specific local dir name, so a body uploaded from one machine
	 * is addressable by every machine that maps the same project.
	 */
	#objectKey(project: ScopedProject, file: string): string {
		return sessionKey(`${projectObjectSlug(project.id)}/${file}`);
	}

	async #withSlot<T>(fn: () => Promise<T>): Promise<T> {
		while (this.#active >= MAX_CONCURRENT_TRANSFERS) {
			// Park behind the concurrency cap until a running transfer releases a
			// slot; the resolver is stored FIFO so waiters wake in arrival order.
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			await promise;
		}
		this.#active++;
		try {
			return await fn();
		} finally {
			this.#active--;
			this.#waiters.shift()?.();
		}
	}

	#track(op: Promise<void>): void {
		this.#inflight.add(op);
		void op.finally(() => this.#inflight.delete(op));
	}

	/**
	 * Upload the local body when the remote copy is absent or is not newer than
	 * this machine's.
	 *
	 * Staleness is decided by mtime, NOT byte length. `ensureLocal` REWRITES the
	 * downloaded header's `cwd` to this machine's checkout path, so identical
	 * logical content occupies a DIFFERENT number of bytes on machines whose
	 * project paths differ in length — a shorter local path makes the file
	 * smaller for the same (or more) turns. A "bigger is newer" size test would
	 * therefore let a genuinely new turn on a short-path machine satisfy
	 * `remote.size >= local.size` and silently drop the upload. File mtime is
	 * invariant to the header rewrite and advances on every append, so it orders
	 * versions correctly; it is the SAME last-writer-wins clock the sessions
	 * index domain publishes as `rev` (domains/sessions.ts), keeping the body
	 * archive and the index in agreement.
	 *
	 * FAILURE MODE: mtime is a wall clock, so this inherits LWW's clock-skew
	 * caveat — a machine whose clock lags the last uploader's could under-upload
	 * a real edit until its own clock passes the remote's recorded time. That is
	 * the tradeoff the sessions domain already accepts, and it is strictly safer
	 * than the size test it replaces, which lost writes with no skew at all.
	 *
	 * `mtimeMs` is FRACTIONAL from `fs.stat` while a `rev` is contractually an
	 * integer, so both sides are floored before comparison — a raw float against
	 * a floored remote value (100.9 vs 100) would re-upload forever. Only the
	 * `list()` metadata is read to compare, never the remote body itself.
	 */
	async uploadIfStale(rel: string): Promise<void> {
		const scoped = this.#projectForRel(rel);
		if (!scoped) {
			// Per-project toggle / unregistered project: bodies stay local-only.
			logger.debug(`[session-replicator] upload skipped, not a synced project: ${rel}`);
			return;
		}
		const abs = this.#localPath(rel);
		let local: fs.Stats;
		try {
			local = await fsp.stat(abs);
		} catch {
			// No local body to upload (never created, or already pruned).
			return;
		}
		if (!local.isFile()) return;

		const key = this.#objectKey(scoped.project, scoped.file);
		await this.#withSlot(async () => {
			try {
				const remote = await this.#store.list(key);
				const match = remote.find(item => item.key === key);
				// Skip only when a remote exists AND is at least as new as the local
				// body. Floor both sides: mtimeMs is fractional and a raw
				// `100.9 > 100` would re-upload every cycle (see doc).
				if (match && Math.floor(local.mtimeMs) <= Math.floor(match.mtimeMs)) return;
				const bytes = await fsp.readFile(abs);
				await this.#store.put(key, bytes, "application/x-ndjson");
			} catch (err) {
				logger.warn(`[session-replicator] upload failed for ${rel}: ${String(err)}`);
			}
		});
	}

	/**
	 * Ensure the session body exists locally, downloading it from the object
	 * store when missing. The download lands via temp+rename so a partial
	 * transfer is never observable at the session path. Returns whether the
	 * body is present locally afterwards.
	 *
	 * `opts.relCwd` is the session's project-relative POSIX cwd (`""` at the
	 * root). The header is rewritten to `<project.localPath>/<relCwd>` — the
	 * session's local SUBDIRECTORY, not the project root — so a session started
	 * deep in a monorepo resumes in the right directory here. The resume path
	 * passes it from the index; when absent (older caller) we fall back to the
	 * project root, since the encoded dir name is not losslessly reversible.
	 */
	async ensureLocal(rel: string, opts?: { relCwd?: string }): Promise<boolean> {
		const abs = this.#localPath(rel);
		if (fs.existsSync(abs)) return true;

		const scoped = this.#projectForRel(rel);
		if (!scoped) {
			// Not a synced project here — there is no project-keyed object to pull.
			logger.debug(`[session-replicator] download skipped, not a synced project: ${rel}`);
			return false;
		}

		// The session's local root is the project path plus its in-project subdir.
		let relCwd = opts?.relCwd;
		if (relCwd === undefined) {
			// Fall back to the rel's own dir name: only the project-root dir maps
			// back unambiguously (relCwd ""); a deeper encoded name is not
			// losslessly reversible, so we degrade to the project root and note it.
			const dirName = rel.slice(0, rel.indexOf("/"));
			relCwd = "";
			if (dirName !== sessionDirNameForCwd(scoped.project.localPath)) {
				logger.debug(`[session-replicator] relCwd unknown for subdir session, using project root: ${rel}`);
			}
		}
		const localRoot = relCwd ? path.join(scoped.project.localPath, ...relCwd.split("/")) : scoped.project.localPath;

		return this.#withSlot(async () => {
			try {
				const bytes = await this.#store.get(this.#objectKey(scoped.project, scoped.file));
				if (!bytes) return false;
				// Translate the origin machine's absolute cwd in the session header
				// to THIS machine's session directory before landing the file, so
				// resume adopts the directory instead of degrading to runtime-only.
				const rewritten = rewriteSessionHeaderCwd(bytes, localRoot);
				await fsp.mkdir(path.dirname(abs), { recursive: true });
				const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
				try {
					await fsp.writeFile(tmp, rewritten);
					await fsp.rename(tmp, abs);
				} catch (err) {
					await fsp.rm(tmp, { force: true }).catch(() => {});
					throw err;
				}
				return true;
			} catch (err) {
				logger.warn(`[session-replicator] download failed for ${rel}: ${String(err)}`);
				return false;
			}
		});
	}

	/**
	 * Debounce and coalesce an upload for `rel`. Fire-and-forget: the timer is
	 * `unref`'d so it never keeps the process alive, and its eventual work is
	 * tracked so {@link drain} can await it.
	 */
	scheduleUpload(rel: string): void {
		if (!this.#projectForRel(rel)) {
			// Enforce the per-project body toggle at the debounce entry point too,
			// so a non-synced session never even schedules a transfer.
			logger.debug(`[session-replicator] schedule skipped, not a synced project: ${rel}`);
			return;
		}
		clearTimeout(this.#timers.get(rel));
		const timer = setTimeout(() => {
			this.#timers.delete(rel);
			this.#track(this.uploadIfStale(rel));
		}, UPLOAD_DEBOUNCE_MS);
		timer.unref?.();
		this.#timers.set(rel, timer);
	}

	/**
	 * Flush every pending debounced upload and wait for all transfers to
	 * settle. A graceful shutdown calls this so the final turn of a
	 * conversation is archived rather than lost with the debounce timer.
	 */
	async drain(): Promise<void> {
		while (this.#timers.size > 0 || this.#inflight.size > 0) {
			for (const [rel, timer] of this.#timers) {
				clearTimeout(timer);
				this.#timers.delete(rel);
				this.#track(this.uploadIfStale(rel));
			}
			await Promise.allSettled([...this.#inflight]);
		}
	}
}

/**
 * Rewrite the origin machine's absolute `cwd` — and any `additionalDirectories`
 * that lay inside the origin project root — in a downloaded session body's
 * header to THIS machine's project path, returning the re-encoded bytes.
 *
 * WHY: resume (session-manager.ts:1435-1445) adopts `header.cwd` only when the
 * directory is enterable; an origin-only path forces `#fallbackRuntimeOnly` and
 * a degraded session. Cross-machine resume therefore requires translating the
 * header to the local project path.
 *
 * FORMAT: line 0 is a fixed-width title slot, line 1 the variable-width session
 * header; legacy sessions omit the slot and start with the header. Only the
 * header line is re-serialized — the title slot and every subsequent byte are
 * sliced through verbatim, so the slot's fixed-width invariant is never touched
 * (no re-padding is needed because the slot bytes are preserved exactly). A body
 * whose header line is unparseable or not a session header is returned as-is.
 */
function rewriteSessionHeaderCwd(bytes: Uint8Array, localRoot: string): Uint8Array {
	const text = Buffer.from(bytes).toString("utf-8");
	const firstNl = text.indexOf("\n");
	if (firstNl < 0) {
		logger.debug("[session-replicator] header rewrite skipped: no newline in body");
		return bytes;
	}

	// Locate the header line: it follows the title slot when one is present,
	// otherwise the body starts with the header (legacy sessions).
	let headerStart = 0;
	let headerEnd = firstNl;
	if (parseTitleSlotLine(text.slice(0, firstNl))) {
		const secondNl = text.indexOf("\n", firstNl + 1);
		if (secondNl < 0) {
			logger.debug("[session-replicator] header rewrite skipped: title slot without header line");
			return bytes;
		}
		headerStart = firstNl + 1;
		headerEnd = secondNl;
	}

	let header: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(text.slice(headerStart, headerEnd));
		if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "session") {
			logger.debug("[session-replicator] header rewrite skipped: first record is not a session header");
			return bytes;
		}
		// A JSON object is a string-keyed record; we only read/replace `cwd` and
		// `additionalDirectories`, both re-validated by `typeof` below.
		header = parsed as Record<string, unknown>;
	} catch {
		logger.debug("[session-replicator] header rewrite skipped: header line is not valid JSON");
		return bytes;
	}

	const originRoot = typeof header.cwd === "string" ? path.resolve(header.cwd) : undefined;
	header.cwd = localRoot;
	if (originRoot && Array.isArray(header.additionalDirectories)) {
		header.additionalDirectories = (header.additionalDirectories as unknown[]).map(dir => {
			if (typeof dir !== "string") return dir;
			// Best-effort, native-separator remap (the supported scenario is
			// same-OS machines); only paths INSIDE the origin project root are
			// translated, unrelated absolute dirs are left untouched.
			const rel = path.relative(originRoot, path.resolve(dir));
			if (rel === "") return localRoot;
			if (!rel.startsWith("..") && !path.isAbsolute(rel)) return path.join(localRoot, rel);
			return dir;
		});
	}

	// Preserve the title slot (bytes before headerStart) and every byte from
	// headerEnd onward exactly; only the header JSON changes.
	const rewritten = text.slice(0, headerStart) + JSON.stringify(header) + text.slice(headerEnd);
	return Buffer.from(rewritten, "utf-8");
}
