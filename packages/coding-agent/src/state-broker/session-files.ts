/**
 * Locating the session bodies that belong to a sync-enabled project.
 *
 * Shared by the `sessions` domain (which replicates the index) and the `titles`
 * domain (which replicates display names), because getting this wrong in only
 * one of them is a silent, asymmetric data leak or data loss. Titles originally
 * scanned just the project root's encoded directory and so never replicated the
 * title of any session started in a subdirectory — which in a monorepo is most
 * of them.
 *
 * Two facts about the on-disk layout drive everything here:
 *
 * 1. A session's directory name is derived from its cwd, so a session started
 *    in a SUBDIRECTORY lands in a sibling encoded directory rather than under
 *    the project root's (`~/projects/foo/pkg/a` -> `-projects-foo-pkg-a`).
 *    Enumerating a project therefore means the root dir plus every directory
 *    whose encoded name extends it. The trailing `-` in that prefix test is
 *    essential: a bare `startsWith(base)` also swallows the unrelated sibling
 *    project `~/projects/foobar`.
 * 2. The encoding is NOT losslessly reversible — `-projects-foo-pkg-a` is
 *    ambiguous between `foo/pkg/a`, `foo-pkg/a` and `foo/pkg-a` — so a matching
 *    directory name is a candidate, never proof. Every candidate is CONFIRMED
 *    by reading the body's header `cwd` and resolving it back to a project.
 *
 * FAIL CLOSED: an unregistered or sync-disabled project is never enumerated,
 * and a candidate whose header resolves to a different project is rejected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { SESSION_TITLE_SLOT_BYTES } from "../session/session-entries";
import { sessionDirNameForCwd } from "../session/session-paths";
import { parseTitleSlotLine } from "../session/session-title-slot";
import { listSyncedProjects, resolveProject } from "./project-scope";

/** A session body confirmed to belong to a sync-enabled project. */
export interface OwnedSessionFile {
	/** Registered project id that owns it. */
	projectId: string;
	/** Project-relative POSIX cwd it was started in; `""` at the project root. */
	relCwd: string;
	/** Bare filename, `<file-safe-timestamp>_<sessionId>.jsonl`. */
	file: string;
	/** Absolute path on this machine. */
	abs: string;
	size: number;
	/** Floored epoch-millis mtime, usable directly as a replication `rev`. */
	mtimeMs: number;
}

/**
 * Cap on remembered ownership confirmations. Each entry is keyed by
 * `(path, mtime, size)`, so an edited body is re-confirmed rather than trusted.
 */
const CONFIRM_CACHE_MAX = 4096;

/**
 * Process-wide confirmation cache. `null` records a confirmed NON-owner so an
 * unregistered session's header is not re-read every cycle. Shared across
 * domains deliberately: both ask the same question about the same files, and
 * the header read is the expensive part.
 */
const confirmCache = new Map<string, { projectId: string; relCwd: string } | null>();

/**
 * Bytes read from the head of a session body when confirming ownership: the
 * fixed-width title slot plus a generous window for the variable-width session
 * header line. A header longer than this cannot be confirmed (and is rejected),
 * but real headers are a few hundred bytes, so 64 KiB is comfortably safe.
 */
const HEADER_PROBE_BYTES = SESSION_TITLE_SLOT_BYTES + 64 * 1024;

const utf8Decoder = new TextDecoder("utf-8");

/**
 * The `cwd` recorded in a session's `{"type":"session",...}` header, or
 * `undefined` when the file is unreadable or not a session body.
 *
 * Line 0 may be the fixed-width title slot, in which case the header is the
 * NEXT record; both layouts are handled. Reads a bounded prefix rather than the
 * whole file, which for a long session is many megabytes.
 */
function readHeaderCwd(absPath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(absPath, "r");
		const buf = Buffer.allocUnsafe(HEADER_PROBE_BYTES);
		const read = fs.readSync(fd, buf, 0, HEADER_PROBE_BYTES, 0);
		if (read <= 0) return undefined;
		const text = utf8Decoder.decode(buf.subarray(0, read));
		const firstNl = text.indexOf("\n");
		if (firstNl < 0) return undefined;
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

/**
 * Which synced project (if any) owns the body at `abs`, plus its
 * project-relative cwd. Cached by `(path, mtime, size)`.
 */
function confirmOwner(abs: string, mtimeMs: number, size: number): { projectId: string; relCwd: string } | null {
	const cacheKey = `${abs}\u0000${mtimeMs}\u0000${size}`;
	const cached = confirmCache.get(cacheKey);
	if (cached !== undefined) return cached;

	let result: { projectId: string; relCwd: string } | null = null;
	const cwd = readHeaderCwd(abs);
	if (!cwd) {
		logger.debug(`[state:session-files] ownership unconfirmed, no header cwd: ${abs}`);
	} else {
		const resolved = resolveProject(cwd);
		if (resolved) result = { projectId: resolved.project.id, relCwd: resolved.rel };
		else logger.debug(`[state:session-files] ownership unconfirmed, cwd not in any project: ${cwd}`);
	}

	// Bound the cache: evict oldest insertion (Map preserves order) first.
	if (confirmCache.size >= CONFIRM_CACHE_MAX) {
		const oldest = confirmCache.keys().next().value;
		if (oldest !== undefined) confirmCache.delete(oldest);
	}
	confirmCache.set(cacheKey, result);
	return result;
}

/** Immediate child directory names of the sessions root; `[]` when absent. */
function readRootDirs(sessionsDir: string): string[] {
	try {
		return fs
			.readdirSync(sessionsDir, { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name);
	} catch {
		return [];
	}
}

/**
 * Every session body owned by a sync-enabled project, unordered.
 *
 * `afterRev` filters by floored mtime DURING the scan. That timing is
 * load-bearing for the sessions domain: the sync engine advances its watermark
 * to the last returned entry, so a page filtered down after being capped would
 * stall the cursor while newer eligible rows waited just beyond the limit.
 *
 * `mtimeMs` is floored here, once, because `fs.Stats.mtimeMs` is a float with
 * sub-millisecond precision while a `rev` is contractually an integer. Flooring
 * on only one side of the comparison re-emits every session forever, since
 * `100.9 > floor(100.9)`.
 */
export function scanOwnedSessionFiles(
	sessionsDir: string = getSessionsDir(),
	opts?: { afterRev?: number },
): OwnedSessionFile[] {
	const afterRev = opts?.afterRev;
	const out: OwnedSessionFile[] = [];
	const rootDirs = readRootDirs(sessionsDir);
	for (const project of listSyncedProjects()) {
		// sessionDirNameForCwd canonicalizes internally, so localPath is fine.
		const base = sessionDirNameForCwd(project.localPath);
		for (const dirName of rootDirs) {
			// Root dir OR a subdirectory session dir (`<base>-<...>`).
			if (dirName !== base && !dirName.startsWith(`${base}-`)) continue;
			const dir = path.join(sessionsDir, dirName);
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
				if (!stat.isFile()) continue;
				const mtimeMs = Math.floor(stat.mtimeMs);
				if (afterRev !== undefined && mtimeMs <= afterRev) continue;
				const owner = confirmOwner(abs, mtimeMs, stat.size);
				if (!owner || owner.projectId !== project.id) continue;
				out.push({ projectId: project.id, relCwd: owner.relCwd, file, abs, size: stat.size, mtimeMs });
			}
		}
	}
	return out;
}

/**
 * Drop cached ownership confirmations. Call when the project registry changes,
 * since a project switching to `sync: false` must stop being enumerated even
 * for bodies whose mtime and size are unchanged.
 */
export function invalidateSessionOwnerCache(): void {
	confirmCache.clear();
}

/**
 * Whether a peer-supplied value is usable as a session body's bare filename.
 *
 * The `sessions` domain's wire key carries a filename, and the receiver joins
 * it to a locally derived directory. Nothing about the transport constrains its
 * shape: an authenticated peer can put `../` segments, an absolute path, or a
 * NUL in there, and the resulting index row would name a file outside the
 * sessions dir. Opening such a row materializes a session at that path, so this
 * is the gate that keeps a compromised peer inside its own lane.
 *
 * Accepts exactly what {@link scanOwnedSessionFiles} emits: a single path
 * segment ending in `.jsonl`. Rejecting `.` and `..` explicitly matters because
 * both are otherwise separator-free segments.
 */
export function isValidWireSessionFile(file: unknown): file is string {
	if (typeof file !== "string" || file.length === 0 || file.length > 255) return false;
	if (!file.endsWith(".jsonl") || file === ".jsonl") return false;
	if (file === "." || file === "..") return false;
	// Any separator (either platform's), drive prefix, or control character
	// means this is not a bare filename.
	if (/[/\\]/.test(file) || /^[A-Za-z]:/.test(file)) return false;
	if (/[\u0000-\u001f]/.test(file)) return false;
	return path.basename(file) === file;
}

/**
 * Whether a peer-supplied value is usable as a project-relative cwd.
 *
 * Joined to this machine's project root to decide which encoded directory a
 * replicated session belongs in, so a `..` segment would place the row outside
 * the project. `""` is the project root and always valid.
 */
export function isValidWireRelCwd(rel: unknown): rel is string {
	if (typeof rel !== "string") return false;
	if (rel === "") return true;
	if (rel.length > 1024) return false;
	if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
	if (rel.includes("\\")) return false;
	if (/[\u0000-\u001f]/.test(rel)) return false;
	// POSIX-separated on the wire; every segment must be an ordinary name.
	return rel.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}
