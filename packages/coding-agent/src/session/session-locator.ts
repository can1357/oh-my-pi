/**
 * Where each session file is: an id → path index kept beside every sessions
 * root, so finding a session by id never walks the tree.
 *
 * Each root (`~/.omp/agent/sessions`, its `gc` archive, a profile's root, a
 * configured extra root) holds up to two files of `<id>\t<path>` lines, the
 * path relative to that root (or absolute for a file outside every root, e.g.
 * under `--session-dir`), with `%`, tab, CR and LF percent-encoded:
 *
 * - `.session-index.tsv`, the log. omp appends a line whenever a session file
 *   appears at a new path: created, forked, moved, unpacked, archived. Each
 *   line is one `O_APPEND` write that starts with its own newline, so a crash
 *   loses at most the line being written and readers skip its torn remains.
 *   Nothing ever rewrites, renames or truncates the log, so no append is lost.
 * - `.session-index.base.tsv`, written only by `omp session reindex` from the
 *   files under the root (staged and renamed into place). It adds what the log
 *   lacks, such as sessions an older omp wrote; it removes nothing.
 *
 * The index is a cache derived from the session files: nothing about a
 * session's existence lives only in it. A line that could not be written is
 * logged and dropped, never queued, because `omp session reindex` rebuilds a
 * root from that root's own tree, skipping with a count whatever it cannot
 * read — so an unreadable artifact directory never costs the index a session
 * that is readable beside it.
 *
 * A lookup reads both files of every root and checks each candidate: the
 * relative path under its own root first, then under every other root (so a
 * tree moved wholesale, or bucket by bucket, to a root on the list is still
 * found: the index travels with the tree). A candidate counts only while it
 * exists and its header still carries the recorded id, so a stale line never
 * names another session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { hasFsCode, isEacces, isEnoent, isEnotdir } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { readGzipSessionHeaderId, readSessionHeaderId, sessionHeaderIdSync } from "./session-loader";

/** The append-only log inside each sessions root. A dotfile, so bucket and transcript globs skip it. */
export const SESSION_LOCATOR_FILE = ".session-index.tsv";
/** The snapshot `omp session reindex` writes beside the log. */
export const SESSION_LOCATOR_BASE_FILE = ".session-index.base.tsv";
/** First line of a rebuilt snapshot. */
const REBUILT_MARKER = "# omp session index v1, rebuilt from the tree at ";
/** Environment variable listing extra session roots, separated like `PATH`. */
export const SESSION_EXTRA_ROOTS_ENV = "PI_SESSION_EXTRA_ROOTS";
const SESSION_SUFFIX = ".jsonl";
/** Suffix `omp gc` gives a top-level transcript it moves into the archive. */
const ARCHIVED_SUFFIX = ".jsonl.gz";
const SESSION_ID_RE = /^[\w-]+$/;
const HEADER_READ_CONCURRENCY = 32;

/** `<agentDir>/archive/sessions`, where `omp gc` moves cold sessions out of `sessionsRoot`. */
export function archiveRootFor(sessionsRoot: string): string {
	return path.join(path.dirname(sessionsRoot), "archive", "sessions");
}

/** The sessions root an archive root archives, when it has {@link archiveRootFor}'s shape. */
function sessionsRootForArchive(archiveRoot: string): string | undefined {
	if (path.basename(archiveRoot) !== "sessions" || path.basename(path.dirname(archiveRoot)) !== "archive") {
		return undefined;
	}
	return path.join(path.dirname(path.dirname(archiveRoot)), "sessions");
}

let configuredExtraRoots: readonly string[] | undefined;

/** Set from the `session.extraRoots` setting; `undefined` falls back to {@link SESSION_EXTRA_ROOTS_ENV}. */
export function configureSessionExtraRoots(roots: readonly string[] | undefined): void {
	configuredExtraRoots = roots;
}

/** Whether {@link configureSessionExtraRoots} has applied the setting in this process. */
export function sessionExtraRootsConfigured(): boolean {
	return configuredExtraRoots !== undefined;
}

/** Roots listed in a {@link SESSION_EXTRA_ROOTS_ENV}-style value; `undefined` when unset or empty. */
export function parseSessionRootList(raw: string | undefined): string[] | undefined {
	const roots = raw?.split(path.delimiter).filter(root => root.trim() !== "");
	return roots && roots.length > 0 ? roots : undefined;
}

function extraRoots(): string[] {
	const roots = configuredExtraRoots ?? parseSessionRootList(Bun.env[SESSION_EXTRA_ROOTS_ENV]) ?? [];
	return roots
		.map(root => root.trim())
		.filter(root => root !== "")
		.map(root => path.resolve(root));
}

/**
 * Every root a lookup consults, in order: this process's sessions root and its
 * archive, then the configured extra roots.
 *
 * Other profiles' roots are **not** consulted. A profile is a boundary a user
 * chose, and reaching across it would let a session under one profile open
 * another's transcripts — a change of default behaviour with a privacy
 * character, which does not belong in a fix for finding a session by id. A
 * user who wants one profile's sessions visible from another names that root
 * in `session.extraRoots` (or `PI_SESSION_EXTRA_ROOTS`), which is also how a
 * sessions tree on another disk is reached.
 */
export function sessionLocatorRoots(): string[] {
	const roots: string[] = [];
	const add = (root: string): void => {
		const resolved = path.resolve(root);
		if (!roots.includes(resolved)) roots.push(resolved);
	};
	const own = getSessionsDir();
	add(own);
	add(archiveRootFor(own));
	for (const root of extraRoots()) {
		add(root);
		add(archiveRootFor(root));
	}
	return roots;
}

/** `file` relative to `root` with `/` separators, or undefined when `file` is not inside `root`. */
function relativeInside(root: string, file: string): string | undefined {
	const relative = path.relative(root, file);
	if (relative === "" || path.isAbsolute(relative)) return undefined;
	if (relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
	return relative.split(path.sep).join("/");
}

/** The root among `roots` that most closely contains `file`, with the path relative to it. */
function owningRoot(file: string, roots: readonly string[]): { root: string; relative: string } | undefined {
	let best: { root: string; relative: string } | undefined;
	for (const root of roots) {
		const relative = relativeInside(root, file);
		if (relative !== undefined && (!best || root.length > best.root.length)) best = { root, relative };
	}
	return best;
}

/** A stored path with the characters that would break a line or a field percent-encoded. */
function encodeStoredPath(stored: string): string {
	return stored.replace(/[%\t\n\r]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function decodeStoredPath(stored: string): string {
	return stored.replace(/%(25|09|0A|0D)/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Append one record to a root's log. The root directory is created only for a
 * file recorded by absolute path: a file inside a root implies the root
 * exists, and recreating a root someone just removed would resurrect it.
 */
function appendIndexLine(indexFile: string, line: string, createRoot: boolean): void {
	try {
		fs.appendFileSync(indexFile, line, { mode: 0o600 });
	} catch (error) {
		if (!createRoot || !isEnoent(error)) throw error;
		fs.mkdirSync(path.dirname(indexFile), { recursive: true });
		fs.appendFileSync(indexFile, line, { mode: 0o600 });
	}
}

/**
 * Read `file` as a regular file, through a single descriptor, without ever
 * blocking: opened `O_NONBLOCK` (which does nothing to a regular file, and
 * returns rather than waiting for a writer on a fifo), checked with `fstat`
 * on the descriptor that was opened, and read from that same descriptor.
 *
 * Checking a path and then reopening it by name inspects two different
 * objects if anything renames it in between, which is why the check lives on
 * the descriptor. Throws `ENOENT` when there is nothing there, the file
 * system's own error when it cannot be read, and `EISDIR`-like errors for a
 * path that is not a regular file; a caller on a failure path treats
 * every one of those as "cannot demonstrate recovery".
 */
function readableRegularFile(file: string): void {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
		fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Whether a reindex of `root` would demonstrably find session `id` at
 * `relative` again.
 *
 * This decides whether a failed append is reported quietly or loudly, so it
 * answers positively or not at all: true only when every read the recovery
 * depends on succeeds here and now, and false — be loud — in every other
 * case, including ones nobody thought to list. Shape is not evidence. A path
 * of the right shape under a bucket the walk cannot list, or beside a
 * snapshot the publish step will refuse to replace, is not recovered by any
 * reindex, and promising one is worse than saying nothing.
 *
 * Each check performs the operation the reindex itself performs, so a mode,
 * an ACL or a read-only mount answers for itself rather than being
 * enumerated here:
 * - the root's own top level and every ancestor directory list
 *   ({@link scanRootTranscripts}, {@link scanTranscripts});
 * - every ancestor is a real directory, because the walk sees a symlinked
 *   one and never enters it;
 * - the transcript yields *this* id, by the generated `<timestamp>_<id>` name
 *   recording it or by reading the header the rebuild reads. Permission to
 *   open a file is not evidence that an id comes out of it: a header past the
 *   reader's ceiling is perfectly readable and yields nothing;
 * - `root`'s snapshot reads, if it exists, because
 *   {@link rebuildSessionLocator} refuses to publish over one it cannot read
 *   and so recovers nothing. It is read rather than probed for the same
 *   reason: a directory at that path passes a permission check.
 *
 * Never throws; anything unexpected is `false`, which is the loud direction.
 * Two places are deliberately loud about something a rebuild might recover,
 * because the cheap error costs a log line and the other mistake costs a
 * session: an `omp gc` `.jsonl.gz` whose id is in its header rather than its
 * name (the header there is compressed, and this runs without awaiting), and
 * the snapshot *write*, which cannot be tested without side effects — though
 * a write that fails makes `omp session reindex` exit non-zero in front of
 * the person who ran it, so that case is loud without this predicate.
 */
function reindexDemonstrablyRecovers(root: string, relative: string, id: string): boolean {
	try {
		const parts = relative.split("/");
		if (parts.length < 2 || parts.some(part => part.startsWith("."))) return false;
		const name = parts[parts.length - 1];
		if (!name.endsWith(SESSION_SUFFIX) && !(parts.length === 2 && name.endsWith(ARCHIVED_SUFFIX))) return false;
		let dir = root;
		fs.readdirSync(dir);
		for (const part of parts.slice(0, -1)) {
			dir = path.join(dir, part);
			if (!fs.lstatSync(dir).isDirectory()) return false;
			fs.readdirSync(dir);
		}
		const file = path.join(root, relative);
		// The walk collects a file, following a symlinked transcript as it does.
		if (!fs.statSync(file).isFile()) return false;
		// Derive the id, rather than checking we are allowed to try.
		if (generatedNameId(file) !== id && sessionHeaderIdSync(file) !== id) return false;
		// One descriptor, opened without blocking, checked and read: a path
		// checked by `stat` and then reopened by name is two different objects
		// if anything renames it in between, and the rename need not be
		// adversarial to park this handler for ever.
		try {
			readableRegularFile(path.join(root, SESSION_LOCATOR_BASE_FILE));
		} catch (error) {
			if (!isEnoent(error)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Record that session `id` is now stored at `file`. The line goes to the log
 * of the root among `roots` (default: {@link sessionLocatorRoots}) that holds
 * `file`, relative to it; a file outside every root is recorded by absolute
 * path in this process's sessions root. Never throws: a log that misses a
 * line costs a lookup, not a session. Returns whether the line was written,
 * so a caller can try again on its next write. A failed append is reported
 * at error level unless a reindex is demonstrably able to derive the line
 * again ({@link reindexDemonstrablyRecovers}), because the session is then
 * findable by id nowhere and nothing else will say so.
 */
export function recordSessionLocation(
	id: string,
	file: string,
	roots: readonly string[] = sessionLocatorRoots(),
): boolean {
	if (!SESSION_ID_RE.test(id)) return false;
	const absolute = path.resolve(file);
	const owner = owningRoot(absolute, roots);
	const indexFile = path.join(owner?.root ?? getSessionsDir(), SESSION_LOCATOR_FILE);
	try {
		appendIndexLine(indexFile, `\n${id}\t${encodeStoredPath(owner?.relative ?? absolute)}\n`, owner === undefined);
		return true;
	} catch (error) {
		if (owner !== undefined && reindexDemonstrablyRecovers(owner.root, owner.relative, id)) {
			logger.warn("Session index append failed; `omp session reindex` rebuilds it", {
				indexFile,
				id,
				file: absolute,
				error: String(error),
			});
		} else {
			logger.error(
				"Session index append failed and no reindex will recover this session: a reindex derives a root only from transcripts it can read, in buckets it can list, and it refuses to publish over a snapshot it cannot read",
				{ indexFile, id, file: absolute, error: String(error) },
			);
		}
		return false;
	}
}

/**
 * Record `file` (a session transcript) and every transcript nested in its
 * artifact directory (subagent sessions), by the id in each file's header (a
 * `.jsonl.gz` by the header inside it). An unreadable directory in the tree
 * is skipped without losing the rest. When the tree was just moved or copied
 * from `previousFile`, a transcript whose header cannot be read keeps every
 * id the index recorded for it at its old path, and so does every transcript
 * under a directory it cannot enter. `artifactsOnly` leaves `file` itself out
 * (a fork's journal holds its own id). Reads only that one session's tree.
 *
 * Returns whether everything was recorded. The index is a cache derived from
 * the session files, so a record that could not be written is logged and
 * dropped, never queued: `SessionManager` records the session's own file
 * again on its next durable write, and `omp session reindex` rebuilds a root
 * from that root's own tree.
 */
export async function recordSessionTree(
	file: string,
	roots?: readonly string[],
	previousFile?: string,
	options: { artifactsOnly?: boolean } = {},
): Promise<boolean> {
	const complete = await recordSessionTreeOnce(file, roots ?? sessionLocatorRoots(), previousFile, options);
	if (!complete) {
		logger.warn("Session index did not record a whole session tree; `omp session reindex` rebuilds it", {
			file,
			previousFile,
		});
	}
	return complete;
}

async function recordSessionTreeOnce(
	file: string,
	roots: readonly string[],
	previousFile: string | undefined,
	options: { artifactsOnly?: boolean },
): Promise<boolean> {
	const artifacts = artifactsOf(file);
	if (artifacts === undefined) return true;
	// Gone from here (moved again, removed): whatever is left to record belongs to its new place.
	try {
		await fs.promises.lstat(options.artifactsOnly ? artifacts : file);
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return true;
	}
	let complete = true;
	const record = (id: string, transcript: string): void => {
		if (!recordSessionLocation(id, transcript, roots)) complete = false;
	};
	const files = options.artifactsOnly ? [] : [file];
	const unreadable: SessionLocatorRebuild["unreadable"] = [];
	try {
		await scanTranscripts(artifacts, false, files, unreadable);
	} catch (error) {
		logger.debug("Session tree scan failed", { artifacts, error: String(error) });
		complete = false;
	}
	// The artifact directory not existing is not a failure: a session may have none.
	const unreadableHere = unreadable.filter(entry => !(entry.bucket === artifacts && entry.code === "ENOENT"));
	if (unreadableHere.length > 0) complete = false;
	const previousArtifacts = previousFile === undefined ? undefined : artifactsOf(previousFile);
	// Where `moved` (a path in the new tree) was before the move.
	const before = (moved: string): string | undefined =>
		moved === file
			? previousFile
			: previousArtifacts && path.join(previousArtifacts, path.relative(artifacts, moved));
	for (const transcript of files) {
		const ids = new Set<string>();
		let headerId: string | undefined;
		try {
			headerId = await sessionIdOfFile(transcript);
		} catch {
			complete = false;
		}
		if (headerId) ids.add(headerId);
		// As reindex does: a generated name's id beside the header's, for continuations.
		const nameId = generatedNameId(transcript);
		if (nameId) ids.add(nameId);
		// Unreadable now: keep every id the index had for it at its old path, not one of them.
		const old = headerId ? undefined : before(transcript);
		if (old) {
			const carried = await recordedRowsAt(old, roots, false);
			if (!carried.complete) complete = false;
			for (const row of carried.rows) ids.add(row.id);
		}
		for (const id of ids) record(id, transcript);
	}
	// A directory, or a symlinked transcript, the move carried but this walk
	// cannot read keeps every line the index had at or under its old path.
	if (previousArtifacts === undefined) return complete;
	for (const { bucket: unreadablePath } of unreadableHere) {
		const old = before(unreadablePath);
		if (!old) continue;
		const exact = await recordedRowsAt(old, roots, false);
		const under = await recordedRowsAt(old, roots, true);
		if (!exact.complete || !under.complete) complete = false;
		for (const row of [...exact.rows, ...under.rows]) {
			record(row.id, path.join(unreadablePath, path.relative(old, row.file)));
		}
	}
	return complete;
}

function artifactsOf(file: string): string | undefined {
	if (file.endsWith(ARCHIVED_SUFFIX)) return file.slice(0, -ARCHIVED_SUFFIX.length);
	if (file.endsWith(SESSION_SUFFIX)) return file.slice(0, -SESSION_SUFFIX.length);
	return undefined;
}

/**
 * Lines that name exactly `target`, or with `under`, every path inside the
 * directory `target`, in the index of every root: a relative line names its
 * path under each root, as {@link locateSessions} reads it, so a line another
 * root keeps for the same relative path counts. Each row's `file` is where
 * that line puts it beside `target`. In root order, then file order.
 * `complete` is false when an index file exists but could not be read: its
 * lines may be missing from `rows`.
 */
async function recordedRowsAt(
	target: string,
	roots: readonly string[],
	under: boolean,
): Promise<{ rows: { id: string; file: string }[]; complete: boolean }> {
	const absolute = path.resolve(target);
	const owner = owningRoot(absolute, roots);
	const indexRoots = roots.includes(getSessionsDir()) ? roots : [...roots, getSessionsDir()];
	const rows: { id: string; file: string }[] = [];
	let complete = true;
	for (const indexRoot of indexRoots) {
		for (const name of [SESSION_LOCATOR_BASE_FILE, SESSION_LOCATOR_FILE]) {
			let text: string;
			try {
				text = await Bun.file(path.join(indexRoot, name)).text();
			} catch (error) {
				if (!isEnoent(error) && !isEnotdir(error)) complete = false;
				continue;
			}
			for (const line of text.split("\n")) {
				const tab = line.indexOf("\t");
				if (tab <= 0) continue;
				const id = line.slice(0, tab);
				if (!SESSION_ID_RE.test(id)) continue;
				const recorded = decodeStoredPath(line.slice(tab + 1));
				// Absolute lines match by path; relative ones by their path under `target`'s own root.
				const base = path.isAbsolute(recorded) ? absolute : owner?.relative;
				if (base === undefined) continue;
				const hit = under ? recorded.startsWith(`${base}/`) : recorded === base;
				if (!hit) continue;
				const ownerRoot = owner?.root ?? indexRoot;
				rows.push({
					id,
					file: path.isAbsolute(recorded) ? recorded : path.join(ownerRoot, ...recorded.split("/")),
				});
			}
		}
	}
	return { rows, complete };
}

const GENERATED_STEM_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(.+)$/;

function fileStem(file: string): string | undefined {
	const base = path.basename(file);
	if (base.endsWith(ARCHIVED_SUFFIX)) return base.slice(0, -ARCHIVED_SUFFIX.length);
	if (base.endsWith(SESSION_SUFFIX)) return base.slice(0, -SESSION_SUFFIX.length);
	return undefined;
}

/** The id a generated `<timestamp>_<id>` name records (whole, underscores included), if it is one. */
function generatedNameId(file: string): string | undefined {
	const id = GENERATED_STEM_RE.exec(fileStem(file) ?? "")?.[1];
	return id && SESSION_ID_RE.test(id) ? id : undefined;
}

/** The id a file name records: a generated name's, else whatever follows its last `_`. */
function idFromFileName(file: string): string | undefined {
	const stem = fileStem(file);
	if (stem === undefined) return undefined;
	const generated = generatedNameId(file);
	if (generated) return generated;
	const separator = stem.lastIndexOf("_");
	const id = separator >= 0 ? stem.slice(separator + 1) : "";
	return id && SESSION_ID_RE.test(id) ? id : undefined;
}

/**
 * The session id `file` holds: its header's. For a `.jsonl.gz` archive that is
 * the header inside the compressed data; only when that cannot be parsed (not
 * gzip, no header) does the id its name carries stand in. Throws when the file
 * cannot be read.
 */
async function sessionIdOfFile(file: string): Promise<string | undefined> {
	const id = file.endsWith(ARCHIVED_SUFFIX)
		? ((await readGzipSessionHeaderId(file)) ?? idFromFileName(file))
		: await readSessionHeaderId(file);
	return id && SESSION_ID_RE.test(id) ? id : undefined;
}

/** One session file a lookup found. */
export interface LocatedSession {
	/** Session id the index recorded for the file, and that the file still holds. */
	id: string;
	/** The file as it exists now. */
	path: string;
	/** True for a `.jsonl.gz` transcript `omp gc` moved into an archive; omp does not open one in place. */
	archived: boolean;
	/** For an archived transcript: the path it had before `omp gc` moved it, when known. */
	livePath?: string;
	mtimeMs: number;
}

/** What {@link locateSessions} matches besides an id prefix. */
export interface LocateSessionsOptions {
	/** Roots to consult; default {@link sessionLocatorRoots}. */
	roots?: readonly string[];
	/**
	 * Also match a top-level transcript (`<bucket>/<name>.jsonl`) whose file name,
	 * or the id after its last `_`, starts with the key: what the session
	 * picker's resume key accepts.
	 */
	matchFileName?: boolean;
	/**
	 * Default true: a candidate counts only while its header still carries the
	 * recorded id. `false` returns the file at a recorded path whatever it holds
	 * now: for following a session whose file was replaced to the copies that
	 * continue it, where the file is wanted by its name.
	 */
	verifyHeader?: boolean;
}

interface IndexRow {
	id: string;
	stored: string;
	root: string;
}

function fileNameMatches(stored: string, needle: string): boolean {
	// The id a generated `<timestamp>_<id>` name records names that session
	// wherever the file lies, nested in an artifact tree or under `--session-dir`.
	if (generatedNameId(stored)?.toLowerCase().startsWith(needle)) return true;
	// Free-form name keys (a timestamp, a custom name) reach top-level
	// transcripts only, as the project listing they stand in for does.
	if (path.isAbsolute(stored)) return false;
	const slash = stored.indexOf("/");
	if (slash < 0 || stored.indexOf("/", slash + 1) >= 0) return false;
	const stem = (fileStem(stored) ?? path.basename(stored)).toLowerCase();
	if (stem.startsWith(needle)) return true;
	const separator = stem.lastIndexOf("_");
	return separator >= 0 && stem.slice(separator + 1).startsWith(needle);
}

async function readIndexFileRows(
	root: string,
	file: string,
	needle: string,
	matchFileName: boolean,
): Promise<IndexRow[]> {
	let text: string;
	try {
		text = await Bun.file(path.join(root, file)).text();
	} catch (error) {
		if (!isEnoent(error) && !isEnotdir(error)) {
			logger.debug("Session index unreadable", { root, file, error: String(error) });
		}
		return [];
	}
	const rows: IndexRow[] = [];
	let start = 0;
	while (start < text.length) {
		const end = text.indexOf("\n", start);
		// A line without its newline is a torn append: skip it.
		if (end < 0) break;
		const line = text.slice(start, end);
		start = end + 1;
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		const id = line.slice(0, tab);
		const encoded = line.slice(tab + 1);
		if (!encoded || !SESSION_ID_RE.test(id)) continue;
		const stored = decodeStoredPath(encoded);
		if (id.toLowerCase().startsWith(needle) || (matchFileName && fileNameMatches(stored, needle))) {
			rows.push({ id, stored, root });
		}
	}
	return rows;
}

async function statFile(file: string): Promise<fs.Stats | undefined> {
	try {
		const stat = await fs.promises.stat(file);
		return stat.isFile() ? stat : undefined;
	} catch {
		return undefined;
	}
}

/** Where a row's file may be now: its own root first, then the same relative path under every other root. */
function candidatePaths(row: IndexRow, roots: readonly string[]): string[] {
	if (path.isAbsolute(row.stored)) return [row.stored];
	const relative = row.stored.split("/").join(path.sep);
	const ordered = [row.root, ...roots.filter(root => root !== row.root)];
	const candidates: string[] = [];
	for (const root of ordered) {
		const file = path.join(root, relative);
		candidates.push(file);
		if (file.endsWith(SESSION_SUFFIX)) candidates.push(`${file}.gz`);
	}
	return candidates;
}

function livePathOfArchived(file: string, roots: readonly string[]): string | undefined {
	const owner = owningRoot(file, roots);
	const sessionsRoot = owner ? sessionsRootForArchive(owner.root) : undefined;
	if (!owner || !sessionsRoot) return undefined;
	return path.join(sessionsRoot, owner.relative.slice(0, -".gz".length).split("/").join(path.sep));
}

/**
 * Session files whose recorded id starts with `idPrefix` (case-insensitive),
 * newest first, each existing on disk and still holding the recorded id. Reads
 * the index files of every root, stats candidate paths and reads the header of
 * each that exists; never lists a directory. A key outside `[A-Za-z0-9_-]`
 * matches nothing.
 */
export async function locateSessions(idPrefix: string, options: LocateSessionsOptions = {}): Promise<LocatedSession[]> {
	const needle = idPrefix.toLowerCase();
	if (!SESSION_ID_RE.test(needle)) return [];
	const roots = options.roots ?? sessionLocatorRoots();
	const matchFileName = options.matchFileName === true;
	const rowsByRoot = await Promise.all(
		roots.flatMap(root => [
			readIndexFileRows(root, SESSION_LOCATOR_FILE, needle, matchFileName),
			readIndexFileRows(root, SESSION_LOCATOR_BASE_FILE, needle, matchFileName),
		]),
	);
	const seenRows = new Set<string>();
	const seenPaths = new Set<string>();
	const found: LocatedSession[] = [];
	for (const row of rowsByRoot.flat()) {
		const key = `${row.root}\0${row.id}\0${row.stored}`;
		if (seenRows.has(key)) continue;
		seenRows.add(key);
		for (const candidate of candidatePaths(row, roots)) {
			if (seenPaths.has(candidate)) break;
			const stat = await statFile(candidate);
			// The path may now hold another session (a reused name, a replaced
			// file): the index names a place, the header decides what is there.
			// An unreadable copy (permissions, a vanished file) is not this
			// session as far as this lookup can tell: try the next candidate.
			if (
				!stat ||
				(options.verifyHeader !== false && (await sessionIdOfFile(candidate).catch(() => undefined)) !== row.id)
			) {
				continue;
			}
			seenPaths.add(candidate);
			const archived = candidate.endsWith(ARCHIVED_SUFFIX);
			found.push({
				id: row.id,
				path: candidate,
				archived,
				livePath: archived ? livePathOfArchived(candidate, roots) : undefined,
				mtimeMs: stat.mtimeMs,
			});
			break;
		}
	}
	return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Whether `root` was never rebuilt with `omp session reindex`, so sessions an
 * older omp created there may be in no index.
 *
 * Only an **absent** snapshot, or one present without the rebuilt marker,
 * counts. A snapshot that exists and cannot be read says nothing about
 * whether a rebuild happened — it says this process cannot tell — and
 * answering "never rebuilt" there would send a lookup back to listing a root
 * that is in fact indexed, which is the stall this change exists to remove,
 * reappearing exactly when the index is damaged.
 */
export async function sessionLocatorMayBeIncomplete(root: string = getSessionsDir()): Promise<boolean> {
	const snapshot = path.join(root, SESSION_LOCATOR_BASE_FILE);
	try {
		const head = await Bun.file(snapshot).slice(0, REBUILT_MARKER.length).text();
		return head !== REBUILT_MARKER;
	} catch (error) {
		// Absent: never rebuilt. Anything else: a snapshot is there and this
		// process cannot read it, which is not evidence of no rebuild.
		return isEnoent(error);
	}
}

/**
 * The roots a lookup consults that were never rebuilt with `omp session
 * reindex`, so a session an older omp wrote there is in no index and only a
 * directory listing of that root can find it. Empty once every root has been
 * rebuilt, which is what lets the listing fall away.
 */
export async function unindexedSessionRoots(roots: readonly string[] = sessionLocatorRoots()): Promise<string[]> {
	const incomplete = await Promise.all(
		roots.map(async root => ((await sessionLocatorMayBeIncomplete(root)) ? root : undefined)),
	);
	return incomplete.filter((root): root is string => root !== undefined);
}

/** What {@link rebuildSessionLocator} did to one root. */
export interface SessionLocatorRebuild {
	root: string;
	/** Session files recorded in the snapshot. */
	indexed: number;
	/**
	 * Buckets, directories inside them, and transcripts that could not be read,
	 * with why (`bucket` holds the path, `code` the errno code when there is
	 * one). The new snapshot keeps what the previous one recorded under each.
	 */
	unreadable: UnreadableEntry[];
}

/** One path a walk could not read. */
export interface UnreadableEntry {
	bucket: string;
	error: string;
	code?: string;
}

function unreadableEntry(file: string, error: unknown): UnreadableEntry {
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	return { bucket: file, error: String(error), code };
}

function isUnavailable(error: unknown): boolean {
	return isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM") || isEnotdir(error);
}

/**
 * Session files in `dir` and below it, one directory at a time. In a bucket
 * (`topLevel`) that is `*.jsonl` and `*.jsonl.gz`; below it, `*.jsonl`. A
 * symlinked transcript is followed to its target, as the session listing
 * does; one whose target cannot be reached (dangling, looping, unreadable
 * path) is reported in `unreadable`. A symlinked directory is not entered, so
 * a scan never leaves the tree, and neither are dot-entries (gc scratch). A
 * directory that cannot be read is reported and skipped, and everything
 * readable beside it is kept.
 */
async function scanTranscripts(
	dir: string,
	topLevel: boolean,
	files: string[],
	unreadable: SessionLocatorRebuild["unreadable"],
): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (!isUnavailable(error)) throw error;
		unreadable.push(unreadableEntry(dir, error));
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const child = path.join(dir, entry.name);
		const isTranscriptName =
			entry.name.endsWith(SESSION_SUFFIX) || (topLevel && entry.name.endsWith(ARCHIVED_SUFFIX));
		if (entry.isSymbolicLink()) {
			if (!isTranscriptName) continue;
			try {
				if ((await fs.promises.stat(child)).isFile()) files.push(child);
			} catch (error) {
				unreadable.push(unreadableEntry(child, error));
			}
		} else if (entry.isDirectory()) {
			await scanTranscripts(child, false, files, unreadable);
		} else if (entry.isFile() && isTranscriptName) {
			files.push(child);
		}
	}
}

/**
 * Session files under `root`: each bucket's top-level `*.jsonl` and
 * `*.jsonl.gz`, and every `*.jsonl` nested in their artifact directories (see
 * {@link scanTranscripts}). A symlinked bucket is skipped, so a scan never
 * leaves the root through it. `undefined` when `root` is missing or not a
 * directory; throws when `root` itself cannot be read.
 */
async function scanRootTranscripts(
	root: string,
	unreadable: SessionLocatorRebuild["unreadable"],
): Promise<string[] | undefined> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return undefined;
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith(".")) continue;
		await scanTranscripts(path.join(root, entry.name), true, files, unreadable);
	}
	return files;
}

/**
 * Rewrite `root`'s snapshot: every line the snapshot holds when this reindex
 * publishes, plus one for each session file the walk found, by its header id.
 * A reindex adds and never removes: a file it cannot read now (permissions, a
 * directory it cannot enter, a header it cannot parse, a dangling or looping
 * symlink) keeps every line the index knew for it, and is reported in
 * `unreadable`. Lines for files that are gone cost nothing, as lookups check
 * each candidate's header.
 *
 * The walk runs unlocked; the read-merge-rename of the snapshot runs under
 * an exclusive per-root lock, so a reindex that finished meanwhile is merged
 * rather than overwritten. A snapshot that exists but cannot be read is never
 * replaced: the reindex throws instead. The walk deliberately skips a
 * symlinked bucket, a dot-entry and a file at the root's top level, so a
 * snapshot can hold rows this walk cannot derive, and publishing over it would
 * destroy them. The log is never touched, so lines other processes append stay.
 * This is the one operation that walks the tree.
 */
export async function rebuildSessionLocator(root: string): Promise<SessionLocatorRebuild> {
	const resolvedRoot = path.resolve(root);
	const result: SessionLocatorRebuild = { root: resolvedRoot, indexed: 0, unreadable: [] };
	const files = await scanRootTranscripts(resolvedRoot, result.unreadable);
	if (files === undefined) return result;
	const walked: string[] = [];
	for (let i = 0; i < files.length; i += HEADER_READ_CONCURRENCY) {
		const batch = files.slice(i, i + HEADER_READ_CONCURRENCY);
		// Keep each failure, rather than deciding afterwards whether one happened:
		// a read can fail for reasons a permission check passes (descriptor
		// exhaustion, EIO, a header past the loader's ceiling), and a rebuild that
		// silently drops those publishes an incomplete snapshot reporting success.
		const headers = await Promise.all(
			batch.map((file): Promise<{ id: string | undefined; error?: unknown }> =>
				sessionIdOfFile(file).then(
					id => ({ id }),
					(error: unknown) => ({ id: undefined, error }),
				),
			),
		);
		const headerIds = headers.map(header => header.id);
		for (let j = 0; j < batch.length; j++) {
			const relative = relativeInside(resolvedRoot, batch[j]);
			if (relative === undefined) continue;
			const failure = headers[j].error;
			if (failure !== undefined) result.unreadable.push(unreadableEntry(batch[j], failure));
			else if (!headerIds[j] && generatedNameId(batch[j]) === undefined) {
				// Read cleanly, yielded no id, and the name records none either: the
				// row cannot be derived, and nothing else would say so.
				result.unreadable.push(unreadableEntry(batch[j], new Error("no session id in its header or its name")));
			}
			// A generated `<timestamp>_<id>.jsonl` that no longer reads as that
			// session (replaced, or unreadable now) is also recorded under the id
			// its name records: resume follows such a file to the copies that
			// continue that session. Lookups that verify headers never take it
			// for that id.
			const nameId = generatedNameId(batch[j]);
			for (const id of new Set([headerIds[j], nameId !== headerIds[j] ? nameId : undefined])) {
				if (!id) continue;
				walked.push(`${id}\t${encodeStoredPath(relative)}`);
				if (id === headerIds[j]) result.indexed++;
			}
		}
	}
	const snapshot = path.join(resolvedRoot, SESSION_LOCATOR_BASE_FILE);
	// One lock per physical root: a root reached through a symlink (a moved
	// tree left a link behind) and through its real path is the same snapshot.
	const lockKey = path.join(await fs.promises.realpath(resolvedRoot), SESSION_LOCATOR_BASE_FILE);
	await withFileLock(
		lockKey,
		async () => {
			// No other reindex of this root is publishing: a staged snapshot left here is a dead one's.
			for (const name of await fs.promises.readdir(resolvedRoot)) {
				if (name.startsWith(`${SESSION_LOCATOR_BASE_FILE}.`) && name.endsWith(".tmp")) {
					await fs.promises.rm(path.join(resolvedRoot, name), { force: true });
				}
			}
			let previous = "";
			try {
				previous = await Bun.file(snapshot).text();
			} catch (error) {
				if (!isEnoent(error)) {
					throw new Error(`${snapshot} cannot be read, so it was not replaced: ${String(error)}`, {
						cause: error,
					});
				}
			}
			const kept = new Set<string>();
			const lines: string[] = [`${REBUILT_MARKER}${new Date().toISOString()}\n`];
			const keep = (line: string): void => {
				if (kept.has(line)) return;
				kept.add(line);
				lines.push(`${line}\n`);
			};
			// Every row the snapshot held is carried. A reindex ADDS AND NEVER
			// REMOVES: a row names a place, and this process cannot tell the
			// difference between a file that is gone and one it merely cannot
			// reach right now — a bucket whose symlink target is temporarily
			// away, a tree being moved, a mount not up yet. Seven reproduced
			// defects came from trying: each fix found the next place a lookup
			// looks that the check did not. A stale row costs a `stat` on a
			// lookup, which verifies every candidate's header anyway; a dropped
			// row costs the session. Growth is bounded by `omp gc`, which
			// already walks these trees, and not here.
			for (const line of previous.split("\n")) {
				const tab = line.indexOf("\t");
				if (tab > 0 && SESSION_ID_RE.test(line.slice(0, tab)) && line.length > tab + 1) keep(line);
			}
			for (const line of walked) keep(line);
			// Unique per call: two reindexes of one root in one process may start in the same millisecond.
			const staged = `${snapshot}.${process.pid}.${crypto.randomUUID()}.tmp`;
			try {
				await fs.promises.writeFile(staged, lines.join(""), { mode: 0o600 });
				await fs.promises.rename(staged, snapshot);
			} catch (error) {
				await fs.promises.rm(staged, { force: true });
				throw error;
			}
		},
		// The locked step is one read and one write; wait out a peer's for up to a minute.
		{ retries: 600, retryDelayMs: 100 },
	);
	return result;
}
