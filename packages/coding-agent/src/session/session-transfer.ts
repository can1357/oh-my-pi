/**
 * Moving a session between machines (`omp session pack|unpack|moved`).
 *
 * A session archive is a plain tar:
 *
 * - `manifest.json` — {@link SessionArchiveManifest}
 * - `session.jsonl` — the journal, byte for byte
 * - `artifacts/<path>` — the session's artifacts directory (subagent transcripts included)
 * - `blobs/<sha256>` — every blob the journal or an artifact transcript references
 *
 * Moves are recorded in the transcript as `custom_message` entries of type
 * {@link SESSION_TRANSFER_MESSAGE_TYPE}: the model sees where the session came
 * from, and a copy whose latest marker says it moved away is stale — resuming
 * it forks instead of continuing it ({@link forkIfMovedAway}).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getBlobsDir,
	isEnoent,
	isEnotdir,
	isRecord,
	logger,
	prompt,
	Snowflake,
	TempDir,
	VERSION,
} from "@oh-my-pi/pi-utils";
import {
	type ArchiveMemberContent,
	ArchiveError,
	formatArchivePathForError,
	readArchiveEntries,
	writeArchive,
} from "@oh-my-pi/pi-utils/ar";
import transferArrivedTemplate from "../prompts/session/transfer-arrived.md" with { type: "text" };
import transferDepartedTemplate from "../prompts/session/transfer-departed.md" with { type: "text" };
import transferStaleForkTemplate from "../prompts/session/transfer-stale-fork.md" with { type: "text" };
import { replaceFileAtomically } from "../utils/atomic-file";
import { BLOB_HASH_RE, BlobStore } from "./blob-store";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-entries";
import { findSessionFiles } from "./session-listing";
import { loadEntriesFromFile, parseSessionContent, readSessionHeaderId } from "./session-loader";
import { SessionManager } from "./session-manager";
import { FileSessionStorage } from "./session-storage";

/** Archive format version written by {@link packSession} and the only one {@link unpackSession} reads. */
export const SESSION_ARCHIVE_VERSION = 1;

/** `customType` of the transcript entries that record a session moving between machines. */
export const SESSION_TRANSFER_MESSAGE_TYPE = "session-transfer";

/** `manifest.json` of a session archive. */
export interface SessionArchiveManifest {
	/** Archive format version ({@link SESSION_ARCHIVE_VERSION}). */
	version: number;
	/** Session id from the journal header. */
	id: string;
	/** Working directory recorded in the journal header on the packing machine. */
	cwd: string;
	/** omp version that wrote the archive. */
	omp: string;
}

/**
 * Structured details of a {@link SESSION_TRANSFER_MESSAGE_TYPE} entry:
 * - `arrived` — unpacked here from `fromCwd` on another machine into `cwd`;
 * - `departed` — this copy was handed to `to` and is stale from here on;
 * - `forked` — a stale copy (`source`) was resumed, so it continued as a fork.
 */
export type SessionTransferDetails =
	| { kind: "arrived"; fromCwd: string; cwd: string }
	| { kind: "departed"; to: string }
	| { kind: "forked"; source: string; to: string };

/** User-facing failure of a pack, unpack, or move marker: missing input, bad archive, live owner. */
export class SessionTransferError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionTransferError";
	}
}

/** Result of {@link packSession}. */
export interface PackSessionResult {
	/** Absolute path of the written archive. */
	archivePath: string;
	/** Packed session id. */
	id: string;
	/** Blobs the transcripts reference that the local blob store no longer holds; the archive lacks them. */
	missingBlobs: string[];
}

/** Options for {@link unpackSession}. */
export interface UnpackSessionOptions {
	/** Directory the session continues in on this machine; becomes the header `cwd`. */
	cwd: string;
	/** Session directory to land in; defaults to `cwd`'s session directory. */
	sessionDir?: string;
}

/**
 * How {@link unpackSession} placed the session:
 * - `created` — no local copy existed;
 * - `replaced` — local copies were prefixes of the incoming transcript and were replaced;
 * - `forked` — a local copy diverged, so the incoming transcript became a fork with a new id.
 */
export type UnpackMode = "created" | "replaced" | "forked";

/** Result of {@link unpackSession}. */
export interface UnpackSessionResult {
	/** Absolute path of the unpacked session file. */
	sessionFile: string;
	/** Id of the unpacked session (a fresh id when `mode` is `forked`). */
	id: string;
	/** How the session was placed. */
	mode: UnpackMode;
}

const MANIFEST_MEMBER = "manifest.json";
const SESSION_MEMBER = "session.jsonl";
const ARTIFACTS_PREFIX = "artifacts/";
const BLOBS_PREFIX = "blobs/";
const BLOB_REF_RE = /\bblob:sha256:([a-f0-9]{64})\b/g;
/** Ids name files and leases; anything else in an archive header is refused. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ARCHIVE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024;
const TEXT_DECODER = new TextDecoder();

function isBodyEntry(entry: FileEntry): entry is SessionEntry {
	return entry.type !== "session";
}

/** Transfer details of `entry`, or `undefined` when it is not a session-transfer marker. */
export function sessionTransferDetails(entry: FileEntry): SessionTransferDetails | undefined {
	if (entry.type !== "custom_message" || entry.customType !== SESSION_TRANSFER_MESSAGE_TYPE) return undefined;
	const details = entry.details;
	if (!isRecord(details)) return undefined;
	switch (details.kind) {
		case "arrived":
			return typeof details.fromCwd === "string" && typeof details.cwd === "string"
				? { kind: "arrived", fromCwd: details.fromCwd, cwd: details.cwd }
				: undefined;
		case "departed":
			return typeof details.to === "string" ? { kind: "departed", to: details.to } : undefined;
		case "forked":
			return typeof details.source === "string" && typeof details.to === "string"
				? { kind: "forked", source: details.source, to: details.to }
				: undefined;
		default:
			return undefined;
	}
}

/** The latest session-transfer marker in append order, if any. */
export function lastSessionTransfer(entries: readonly FileEntry[]): SessionTransferDetails | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const details = sessionTransferDetails(entries[index]);
		if (details) return details;
	}
	return undefined;
}

function renderTransferNotice(details: SessionTransferDetails): string {
	switch (details.kind) {
		case "arrived":
			return prompt.render(transferArrivedTemplate, { fromCwd: details.fromCwd, cwd: details.cwd }).trim();
		case "departed":
			return prompt.render(transferDepartedTemplate, { to: details.to }).trim();
		case "forked":
			return prompt.render(transferStaleForkTemplate, { to: details.to, source: details.source }).trim();
	}
}

/** Append a visible, model-facing transfer marker and make it durable. */
async function appendTransferNotice(manager: SessionManager, details: SessionTransferDetails): Promise<void> {
	manager.appendCustomMessageEntry(SESSION_TRANSFER_MESSAGE_TYPE, renderTransferNotice(details), true, details);
	await manager.flush();
}

async function requireFile(file: string, what: string): Promise<void> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(file);
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) throw new SessionTransferError(`${what} not found: ${file}`);
		throw error;
	}
	if (!stat.isFile()) throw new SessionTransferError(`${what} is not a file: ${file}`);
}

async function requireDirectory(dir: string): Promise<void> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(dir);
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) throw new SessionTransferError(`Directory not found: ${dir}`);
		throw error;
	}
	if (!stat.isDirectory()) throw new SessionTransferError(`Not a directory: ${dir}`);
}

/** The session id in `file`'s header; refuses anything that is not a session journal. */
async function requireSessionId(file: string): Promise<string> {
	await requireFile(file, "Session file");
	const id = await readSessionHeaderId(file);
	if (id === undefined) throw new SessionTransferError(`Not an omp session file (no session header): ${file}`);
	return id;
}

/**
 * Take this process's ownership lease on session `id` at `file` — the check
 * {@link SessionManager.moveTo} uses — or refuse while another live omp process
 * writes it.
 */
function claimSessionOrRefuse(id: string, file: string, action: string): () => void {
	const release = new FileSessionStorage().claimSession(id, file);
	if (!release) {
		throw new SessionTransferError(
			`Cannot ${action} ${file}: another live omp process writes this session. Exit it first. Nothing was changed.`,
		);
	}
	return release;
}

function collectBlobHashes(text: string, into: Set<string>): void {
	for (const match of text.matchAll(BLOB_REF_RE)) into.add(match[1]);
}

/** Files under `dir` as `/`-separated relative paths, sorted; empty when `dir` does not exist. Symlinks are skipped. */
async function listFilesRecursive(dir: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (relative: string): Promise<void> => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(relative ? path.join(dir, relative) : dir, { withFileTypes: true });
		} catch (error) {
			if (relative === "" && (isEnoent(error) || isEnotdir(error))) return;
			throw error;
		}
		entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(child);
			else if (entry.isFile()) files.push(child);
		}
	};
	await walk("");
	return files;
}

/** Write a tar to a sibling staging file and rename it over `target`, so a failure leaves no partial archive. */
async function writeArchiveAtomically(
	target: string,
	members: readonly (readonly [string, ArchiveMemberContent])[],
): Promise<void> {
	const staging = `${target}.${Snowflake.next()}.tmp`;
	try {
		await writeArchive(staging, "tar", members);
		await replaceFileAtomically(staging, target);
	} catch (error) {
		await fs.promises.rm(staging, { force: true });
		throw error;
	}
}

/**
 * Pack `sessionFile` with its artifacts and referenced blobs into the tar
 * `outPath` (written atomically). Refuses a session another live omp process
 * is writing; the ownership lease is held while the files are read.
 */
export async function packSession(sessionFile: string, outPath: string): Promise<PackSessionResult> {
	const source = path.resolve(sessionFile);
	const archivePath = path.resolve(outPath);
	const id = await requireSessionId(source);
	try {
		if ((await fs.promises.stat(archivePath)).isDirectory()) {
			throw new SessionTransferError(`Output path is a directory: ${archivePath}`);
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const release = claimSessionOrRefuse(id, source, "pack");
	try {
		const journal = await fs.promises.readFile(source);
		const journalText = journal.toString("utf8");
		const header = parseSessionContent(journalText).entries[0];
		if (header?.type !== "session") {
			throw new SessionTransferError(`Not an omp session file (no session header): ${source}`);
		}
		const manifest: SessionArchiveManifest = {
			version: SESSION_ARCHIVE_VERSION,
			id,
			cwd: header.cwd,
			omp: VERSION,
		};
		const members: (readonly [string, ArchiveMemberContent])[] = [
			[MANIFEST_MEMBER, `${JSON.stringify(manifest, null, 2)}\n`],
			[SESSION_MEMBER, journal],
		];
		const hashes = new Set<string>();
		collectBlobHashes(journalText, hashes);

		// Artifacts sit beside the journal's real name (see copySessionArtifacts).
		let realSource = source;
		try {
			realSource = await fs.promises.realpath(source);
		} catch {}
		const artifactsDir = realSource.slice(0, -".jsonl".length);
		if (realSource.endsWith(".jsonl")) {
			for (const relative of await listFilesRecursive(artifactsDir)) {
				const bytes = await fs.promises.readFile(path.join(artifactsDir, ...relative.split("/")));
				members.push([`${ARTIFACTS_PREFIX}${relative}`, bytes]);
				if (relative.endsWith(".jsonl")) collectBlobHashes(bytes.toString("utf8"), hashes);
			}
		}

		const blobs = new BlobStore(getBlobsDir());
		const missingBlobs: string[] = [];
		for (const hash of [...hashes].sort()) {
			const data = await blobs.get(hash);
			if (data) members.push([`${BLOBS_PREFIX}${hash}`, data]);
			else missingBlobs.push(hash);
		}
		if (missingBlobs.length > 0) {
			logger.warn("Packing session without blobs missing from the local store", { id, missingBlobs });
		}

		await writeArchiveAtomically(archivePath, members);
		return { archivePath, id, missingBlobs };
	} finally {
		release();
	}
}

/** A validated session archive, read fully into memory. */
interface SessionArchiveContents {
	manifest: SessionArchiveManifest;
	journal: Uint8Array;
	header: SessionHeader;
	entries: SessionEntry[];
	artifacts: [relative: string, bytes: Uint8Array][];
	blobs: [hash: string, bytes: Uint8Array][];
}

function isSafeRelativePath(relative: string): boolean {
	if (relative.length === 0 || relative.includes("\\")) return false;
	return relative.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function parseManifest(bytes: Uint8Array, archive: string): SessionArchiveManifest {
	let value: unknown;
	try {
		value = JSON.parse(TEXT_DECODER.decode(bytes));
	} catch {
		throw new SessionTransferError(`Bad session archive ${archive}: manifest.json is not valid JSON.`);
	}
	if (!isRecord(value)) {
		throw new SessionTransferError(`Bad session archive ${archive}: manifest.json is not an object.`);
	}
	const { version, id, cwd, omp } = value;
	if (typeof version !== "number") {
		throw new SessionTransferError(`Bad session archive ${archive}: manifest.json has no version.`);
	}
	if (version !== SESSION_ARCHIVE_VERSION) {
		const hint = version > SESSION_ARCHIVE_VERSION ? " Update omp on this machine." : "";
		throw new SessionTransferError(
			`Unsupported session archive version ${version} in ${archive}: omp ${VERSION} reads version ${SESSION_ARCHIVE_VERSION}.${hint}`,
		);
	}
	if (typeof id !== "string" || typeof cwd !== "string" || typeof omp !== "string") {
		throw new SessionTransferError(`Bad session archive ${archive}: manifest.json needs string id, cwd, and omp.`);
	}
	return { version, id, cwd, omp };
}

/**
 * Read and validate the whole archive before anything is written: member
 * layout, manifest version, journal header, and every blob's sha256.
 */
async function readSessionArchive(archive: string): Promise<SessionArchiveContents> {
	await requireFile(archive, "Archive");
	let members: Map<string, Uint8Array>;
	try {
		members = await readArchiveEntries(
			{ path: archive, format: "tar" },
			{ limits: { maxInMemorySize: ARCHIVE_SIZE_LIMIT, maxMemberSize: ARCHIVE_SIZE_LIMIT } },
		);
	} catch (error) {
		if (error instanceof ArchiveError) {
			throw new SessionTransferError(`Bad session archive ${archive}: ${error.message}`);
		}
		throw error;
	}

	let manifestBytes: Uint8Array | undefined;
	let journal: Uint8Array | undefined;
	const artifacts: [string, Uint8Array][] = [];
	const blobs: [string, Uint8Array][] = [];
	for (const [name, bytes] of members) {
		if (name === MANIFEST_MEMBER) {
			manifestBytes = bytes;
		} else if (name === SESSION_MEMBER) {
			journal = bytes;
		} else if (name.startsWith(ARTIFACTS_PREFIX) && isSafeRelativePath(name.slice(ARTIFACTS_PREFIX.length))) {
			artifacts.push([name.slice(ARTIFACTS_PREFIX.length), bytes]);
		} else if (name.startsWith(BLOBS_PREFIX) && BLOB_HASH_RE.test(name.slice(BLOBS_PREFIX.length))) {
			blobs.push([name.slice(BLOBS_PREFIX.length), bytes]);
		} else {
			throw new SessionTransferError(
				`Bad session archive ${archive}: unexpected member "${formatArchivePathForError(name)}".`,
			);
		}
	}
	if (!manifestBytes) throw new SessionTransferError(`Bad session archive ${archive}: no manifest.json.`);
	const manifest = parseManifest(manifestBytes, archive);
	if (!journal) throw new SessionTransferError(`Bad session archive ${archive}: no session.jsonl.`);

	const parsed = parseSessionContent(TEXT_DECODER.decode(journal));
	const header = parsed.entries[0];
	if (parsed.invalidHeader || header?.type !== "session") {
		throw new SessionTransferError(`Bad session archive ${archive}: session.jsonl has no session header.`);
	}
	if (header.id !== manifest.id) {
		throw new SessionTransferError(
			`Bad session archive ${archive}: manifest id ${manifest.id} does not match session id ${header.id}.`,
		);
	}
	if (!SESSION_ID_RE.test(header.id)) {
		throw new SessionTransferError(`Bad session archive ${archive}: invalid session id.`);
	}
	for (const [hash, bytes] of blobs) {
		const actual = new Bun.SHA256().update(bytes).digest("hex");
		if (actual !== hash) {
			throw new SessionTransferError(
				`Bad session archive ${archive}: blob ${hash} fails its sha256 check (content hashes to ${actual}). Nothing was unpacked.`,
			);
		}
	}
	return { manifest, journal, header, entries: parsed.entries.filter(isBodyEntry), artifacts, blobs };
}

/**
 * Whether `local` is a prefix of `incoming` by entry id. `departed` markers
 * only `local` has are skipped: they are appended to the copy left behind
 * after it was packed, so they never reach the copy that moved on.
 */
function isTranscriptPrefix(local: readonly SessionEntry[], incoming: readonly SessionEntry[]): boolean {
	let next = 0;
	for (const entry of local) {
		if (next < incoming.length && incoming[next].id === entry.id) {
			next++;
			continue;
		}
		if (sessionTransferDetails(entry)?.kind === "departed") continue;
		return false;
	}
	return true;
}

/** Top-level session files holding session `id`: every project bucket, plus `sessionDir` when it lies elsewhere. */
async function findLocalCopies(id: string, sessionDir: string): Promise<string[]> {
	const candidates = new Set((await findSessionFiles(id)).map(file => path.resolve(file)));
	try {
		for await (const name of new Bun.Glob(`*_${id}.jsonl`).scan(sessionDir)) {
			candidates.add(path.resolve(sessionDir, name));
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const copies: string[] = [];
	for (const file of candidates) {
		if (!path.basename(file).endsWith(`_${id}.jsonl`)) continue;
		if ((await readSessionHeaderId(file)) === id) copies.push(file);
	}
	return copies.sort();
}

/** One path renamed aside by {@link setAside}. */
interface AsidePath {
	original: string;
	backup: string;
}

async function restoreAside(aside: readonly AsidePath[]): Promise<void> {
	for (const { original, backup } of [...aside].reverse()) {
		try {
			await fs.promises.rename(backup, original);
		} catch (error) {
			logger.error("Failed to restore a session set aside for unpack", { original, backup, error: String(error) });
		}
	}
}

/** Rename session files and their artifacts directories to sibling backups, all or nothing. */
async function setAside(files: readonly string[]): Promise<AsidePath[]> {
	const aside: AsidePath[] = [];
	try {
		for (const file of files) {
			const suffix = `.unpack-${Snowflake.next()}.bak`;
			await fs.promises.rename(file, `${file}${suffix}`);
			aside.push({ original: file, backup: `${file}${suffix}` });
			const artifacts = file.slice(0, -".jsonl".length);
			try {
				await fs.promises.rename(artifacts, `${artifacts}${suffix}`);
				aside.push({ original: artifacts, backup: `${artifacts}${suffix}` });
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		await restoreAside(aside);
		throw error;
	}
	return aside;
}

async function removeSessionFiles(sessionFile: string): Promise<void> {
	await fs.promises.rm(sessionFile, { force: true });
	await fs.promises.rm(sessionFile.slice(0, -".jsonl".length), { recursive: true, force: true });
}

/**
 * Open a session through `open`, record its arrival, and close it. A failure
 * after the session landed removes it again, so the caller can roll back.
 */
async function placeSession(
	open: () => Promise<SessionManager>,
	arrival: SessionTransferDetails,
): Promise<{ sessionFile: string; id: string }> {
	let placed: string | undefined;
	try {
		const manager = await open();
		placed = manager.getSessionFile();
		const id = manager.getSessionId();
		try {
			await appendTransferNotice(manager, arrival);
		} finally {
			await manager.close();
		}
		if (!placed) throw new SessionTransferError("Unpacked session has no session file.");
		return { sessionFile: placed, id };
	} catch (error) {
		if (placed) await removeSessionFiles(placed);
		throw error;
	}
}

/**
 * Unpack a {@link packSession} archive so the session continues in
 * `options.cwd`. The archive is validated in full (manifest version, member
 * layout, every blob's sha256) before anything is written. Blobs go into the
 * local blob store; the journal and artifacts are staged in a temp directory
 * and moved with {@link SessionManager.openRelocated}, which rewrites the
 * header `cwd`. An `arrived` marker is appended.
 *
 * One live copy: local copies of the same session whose entries are a prefix
 * of the incoming ones are replaced (restored if placing fails); if any local
 * copy diverged, the incoming transcript lands as a fork with a new id whose
 * `parentSession` is the original id, and local copies stay untouched.
 */
export async function unpackSession(archivePath: string, options: UnpackSessionOptions): Promise<UnpackSessionResult> {
	const archive = path.resolve(archivePath);
	const cwd = path.resolve(options.cwd);
	await requireDirectory(cwd);
	const contents = await readSessionArchive(archive);
	const { header } = contents;
	const id = header.id;
	const recordedCwd = header.cwd || contents.manifest.cwd;
	const sessionDir = options.sessionDir ? path.resolve(options.sessionDir) : SessionManager.getDefaultSessionDir(cwd);
	const arrival: SessionTransferDetails = { kind: "arrived", fromCwd: recordedCwd, cwd };

	// Blobs first: the loader hydrates image refs while the journal is opened.
	// Content-addressed and verified, so an aborted unpack leaves nothing wrong.
	const blobStore = new BlobStore(getBlobsDir());
	for (const [hash, bytes] of contents.blobs) {
		await blobStore.put(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { hash });
	}

	const staging = await TempDir.create("@omp-session-unpack-");
	try {
		const stagedFile = staging.join(`${header.timestamp.replace(/[^\w-]/g, "-")}_${id}.jsonl`);
		await Bun.write(stagedFile, contents.journal);
		const stagedArtifacts = stagedFile.slice(0, -".jsonl".length);
		for (const [relative, bytes] of contents.artifacts) {
			await Bun.write(path.join(stagedArtifacts, ...relative.split("/")), bytes);
		}

		const localCopies = await findLocalCopies(id, sessionDir);
		let diverged = false;
		for (const file of localCopies) {
			const entries = (await loadEntriesFromFile(file)).filter(isBodyEntry);
			if (!isTranscriptPrefix(entries, contents.entries)) diverged = true;
		}

		if (diverged) {
			const placed = await placeSession(() => SessionManager.forkFrom(stagedFile, cwd, sessionDir), arrival);
			logger.info("Unpacked session as a fork of a diverged local copy", { parent: id, ...placed });
			return { ...placed, mode: "forked" };
		}

		const releases: (() => void)[] = [];
		try {
			for (const file of localCopies) releases.push(claimSessionOrRefuse(id, file, "replace"));
			const aside = await setAside(localCopies);
			let placed: { sessionFile: string; id: string };
			try {
				placed = await placeSession(
					() => SessionManager.openRelocated(stagedFile, recordedCwd, cwd, sessionDir),
					arrival,
				);
			} catch (error) {
				await restoreAside(aside);
				throw error;
			}
			for (const { backup } of aside) await fs.promises.rm(backup, { recursive: true, force: true });
			const mode: UnpackMode = localCopies.length > 0 ? "replaced" : "created";
			logger.info("Unpacked session", { mode, replaced: localCopies, ...placed });
			return { ...placed, mode };
		} finally {
			for (const release of releases) release();
		}
	} finally {
		await staging.remove().catch(error => {
			logger.warn("Failed to remove session unpack staging directory", {
				dir: staging.path(),
				error: String(error),
			});
		});
	}
}

/**
 * Append a `departed` marker to `sessionFile`: the session moved to `label`
 * and this copy is stale. Refuses a session another live omp process writes.
 */
export async function markSessionMoved(sessionFile: string, label: string): Promise<void> {
	const target = path.resolve(sessionFile);
	const to = label.trim();
	if (!to) throw new SessionTransferError("The move label must not be empty.");
	const id = await requireSessionId(target);
	const release = claimSessionOrRefuse(id, target, "mark moved");
	try {
		const manager = await SessionManager.open(target, path.dirname(target), undefined, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
		});
		try {
			await appendTransferNotice(manager, { kind: "departed", to });
		} finally {
			await manager.close();
		}
	} finally {
		release();
	}
}

/**
 * Resume guard: when `manager`'s latest transfer marker says the session moved
 * away, close it untouched and return a fork of it (in `sessionDir`, default:
 * the cwd's session directory) carrying a visible `forked` notice. Otherwise
 * return `manager` itself.
 */
export async function forkIfMovedAway(manager: SessionManager, sessionDir?: string): Promise<SessionManager> {
	const marker = lastSessionTransfer(manager.getEntries());
	if (marker?.kind !== "departed") return manager;
	const source = manager.getSessionFile();
	if (!source) return manager;
	const cwd = manager.getCwd();
	await manager.close();
	const fork = await SessionManager.forkFrom(source, cwd, sessionDir, undefined, { repairInterruptedTail: true });
	await appendTransferNotice(fork, { kind: "forked", source, to: marker.to });
	logger.info("Resumed a session that moved away; continuing in a fork", {
		source,
		movedTo: marker.to,
		fork: fork.getSessionFile(),
	});
	return fork;
}
