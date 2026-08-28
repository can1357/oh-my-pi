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
import { type OwnedSessionFile, scanOwnedSessionFiles } from "./session-files";

/** Quiet period before a scheduled upload fires, coalescing a burst of appends. */
const UPLOAD_DEBOUNCE_MS = 3_000;

/** Ceiling on concurrent object-store transfers, shared by uploads and downloads. */
const MAX_CONCURRENT_TRANSFERS = 4;

/**
 * Minimum gap between full reconcile passes. Long enough that the per-project
 * `list()` is negligible next to the sync interval, short enough that a body
 * stranded by a transient failure is repaired within the same session.
 */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

export interface SessionReplicatorOptions {
	store: ObjectStore;
	sessionsDir: string;
}

export class SessionReplicator {
	readonly #store: ObjectStore;
	readonly #sessionsDir: string;

	/**
	 * Per-path debounce timers, coalescing repeated `scheduleUpload` calls. The
	 * confirmed project id rides along because {@link drain} fires the pending
	 * uploads itself, and ownership must never be re-derived from the path.
	 */
	readonly #timers = new Map<string, { timer: Timer; projectId: string }>();
	/** In-flight transfer promises, awaited by {@link drain}. */
	readonly #inflight = new Set<Promise<void>>();

	/** Simple counting semaphore bounding concurrent transfers. */
	#active = 0;
	readonly #waiters: Array<() => void> = [];
	/** Epoch millis of the last reconcile pass; 0 so the first call always runs. */
	#lastReconcileAt = 0;

	constructor(opts: SessionReplicatorOptions) {
		this.#store = opts.store;
		this.#sessionsDir = opts.sessionsDir;
	}

	/** Absolute local path for a wire `rel` (POSIX separators → native). */
	#localPath(rel: string): string {
		return path.join(this.#sessionsDir, ...rel.split("/"));
	}

	/**
	 * Resolve a CONFIRMED project id to the synced project that owns it, plus
	 * the bare file name from `rel`.
	 *
	 * The id must come from the scan that read the body's header `cwd`
	 * (`scanOwnedSessionFiles`) or from an index row keyed by it. This class
	 * used to re-derive the project from the encoded directory name by longest
	 * prefix, which is unsound: the encoding is not reversible, so a session in
	 * `~/u/foo/bar` and one at the root of a sibling project `~/u/foo-bar` share
	 * the encoded name `-u-foo-bar`. Longest-prefix then picked `foo-bar` for
	 * both, and the body was uploaded under one project's key while the index
	 * row it belongs to was published under the other's, so peers resolved the
	 * advertised body to a key that does not exist.
	 *
	 * Returns undefined when the project is unregistered here or has sync off,
	 * which is the enforcement point for the per-project toggle on BODIES.
	 */
	#scopeFor(rel: string, projectId: string): { project: ScopedProject; file: string } | undefined {
		const slash = rel.indexOf("/");
		if (slash <= 0) return undefined;
		const file = rel.slice(slash + 1);
		// Session files live directly under the per-cwd dir; reject nesting.
		if (!file || file.includes("/")) return undefined;
		const project = listSyncedProjects().find(p => p.id === projectId);
		return project ? { project, file } : undefined;
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
	async uploadIfStale(rel: string, projectId: string): Promise<void> {
		const scoped = this.#scopeFor(rel, projectId);
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
	 * passes it from the index; when absent we fall back to the project root,
	 * since the encoded dir name is not losslessly reversible.
	 */
	async ensureLocal(rel: string, opts: { projectId: string; relCwd?: string }): Promise<boolean> {
		const abs = this.#localPath(rel);
		if (fs.existsSync(abs)) return true;

		const scoped = this.#scopeFor(rel, opts.projectId);
		if (!scoped) {
			// Not a synced project here — there is no project-keyed object to pull.
			logger.debug(`[session-replicator] download skipped, not a synced project: ${rel}`);
			return false;
		}

		// The session's local root is the project path plus its in-project subdir.
		let relCwd = opts.relCwd;
		if (relCwd === undefined) {
			// Only the project-root dir maps back unambiguously (relCwd ""); a
			// deeper encoded name is not losslessly reversible, so we degrade to
			// the project root and note it.
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
	 * Debounce and coalesce an upload for `rel`, whose owning project id must
	 * already be confirmed. Fire-and-forget: the timer is `unref`'d so it never
	 * keeps the process alive, and its eventual work is tracked so
	 * {@link drain} can await it.
	 */
	scheduleUpload(rel: string, projectId: string): void {
		if (!this.#scopeFor(rel, projectId)) {
			// Enforce the per-project body toggle at the debounce entry point too,
			// so a non-synced session never even schedules a transfer.
			logger.debug(`[session-replicator] schedule skipped, not a synced project: ${rel}`);
			return;
		}
		clearTimeout(this.#timers.get(rel)?.timer);
		const timer = setTimeout(() => {
			this.#timers.delete(rel);
			this.#track(this.uploadIfStale(rel, projectId));
		}, UPLOAD_DEBOUNCE_MS);
		timer.unref?.();
		this.#timers.set(rel, { timer, projectId });
	}

	/**
	 * Upload every owned body the object store is missing or holds an older copy
	 * of, independently of the index watermark. Throttled to
	 * {@link RECONCILE_INTERVAL_MS}; the first call always runs.
	 *
	 * Scheduled uploads alone are not enough to keep bodies and index rows in
	 * agreement, because they are driven by `changedSince` rows and the outbound
	 * cursor advances once the METADATA push succeeds. So a transfer that failed
	 * transiently was never retried: peers held an index row whose body did not
	 * exist, until that session happened to be written again. The same gap
	 * appeared when body replication was switched on after the cursor had
	 * already passed the existing sessions — none of them were ever offered.
	 *
	 * Costs one `list()` per project rather than one per session: the remote
	 * mtimes come back in a single call and the comparison is local.
	 *
	 * Tracked in {@link drain} rather than left detached, so a shutdown that
	 * lands mid-pass still waits for the transfers it started.
	 */
	maybeReconcile(): void {
		const now = Date.now();
		if (now - this.#lastReconcileAt < RECONCILE_INTERVAL_MS) return;
		this.#lastReconcileAt = now;
		this.#track(this.#reconcile());
	}

	async #reconcile(): Promise<void> {
		// afterRev 0: every owned body, with ownership confirmed by header cwd.
		const owned = scanOwnedSessionFiles(this.#sessionsDir, { afterRev: 0 });
		if (owned.length === 0) return;
		const byProject = new Map<string, OwnedSessionFile[]>();
		for (const file of owned) {
			const bucket = byProject.get(file.projectId);
			if (bucket) bucket.push(file);
			else byProject.set(file.projectId, [file]);
		}

		for (const [projectId, files] of byProject) {
			const slug = projectObjectSlug(projectId);
			let remote: Map<string, number>;
			try {
				const listed = await this.#store.list(sessionKey(`${slug}/`));
				remote = new Map(listed.map(item => [item.key, Math.floor(item.mtimeMs)]));
			} catch (err) {
				// A dead store degrades to local-only; the next pass retries.
				logger.warn(`[session-replicator] reconcile list failed for ${projectId}: ${String(err)}`);
				continue;
			}
			for (const file of files) {
				const at = remote.get(sessionKey(`${slug}/${file.file}`));
				if (at !== undefined && Math.floor(file.mtimeMs) <= at) continue;
				// Reuse the scheduled path so the concurrency cap, the staleness
				// re-check and drain tracking all apply unchanged.
				this.#track(this.uploadIfStale(`${path.basename(path.dirname(file.abs))}/${file.file}`, projectId));
			}
		}
	}

	/**
	 * Flush every pending debounced upload and wait for all transfers to
	 * settle. A graceful shutdown calls this so the final turn of a
	 * conversation is archived rather than lost with the debounce timer.
	 */
	async drain(): Promise<void> {
		while (this.#timers.size > 0 || this.#inflight.size > 0) {
			for (const [rel, pending] of this.#timers) {
				clearTimeout(pending.timer);
				this.#timers.delete(rel);
				this.#track(this.uploadIfStale(rel, pending.projectId));
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
