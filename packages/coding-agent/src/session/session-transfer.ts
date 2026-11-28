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
import type * as Archive from "@oh-my-pi/pi-utils/ar";
import transferArrivedTemplate from "../prompts/session/transfer-arrived.md" with { type: "text" };
import transferDepartedTemplate from "../prompts/session/transfer-departed.md" with { type: "text" };
import transferStaleForkTemplate from "../prompts/session/transfer-stale-fork.md" with { type: "text" };
import { replaceFileAtomically } from "../utils/atomic-file";
import { BLOB_HASH_RE, BlobStore } from "./blob-store";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-entries";
import { isValidSessionHeader } from "./session-header-id";
import { findSessionFiles } from "./session-listing";
import { readSessionHeaderId, visitEntriesFromFile, visitEntriesFromFileStream } from "./session-loader";
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
/**
 * Characters one {@link BLOB_REF_RE} match spans (its prefix and 64 hex
 * digits), plus the one before it that its leading `\b` reads.
 */
const BLOB_REF_SPAN = "blob:sha256:".length + 64 + 1;
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

/** The first record of the journal at `file` (title slot folded in), read from its first lines only. */
async function firstJournalRecord(file: string): Promise<FileEntry | undefined> {
	const first: { entry?: FileEntry } = {};
	await visitEntriesFromFileStream(file, entry => {
		first.entry = entry;
		return false;
	});
	return first.entry;
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

/**
 * `chunks`, passed on as they are, after adding the blob hashes their text
 * references to `into`: the ones {@link BLOB_REF_RE} finds in the whole text,
 * scanned one chunk at a time. Each scan also covers the last
 * {@link BLOB_REF_SPAN} characters of the one before, so a reference a chunk
 * edge splits is still found.
 */
async function* collectingBlobHashes<C extends Uint8Array>(
	chunks: AsyncIterable<C>,
	into: Set<string>,
): AsyncGenerator<C> {
	const decoder = new TextDecoder();
	let carried = "";
	let atTextStart = true;
	const scan = (text: string, final: boolean): void => {
		for (const match of text.matchAll(BLOB_REF_RE)) {
			// At a cut edge `\b` reads the edge, not the characters beyond it. The
			// next scan carries the characters around such a match and decides it.
			if (match.index === 0 && !atTextStart) continue;
			if (!final && match.index + match[0].length === text.length) continue;
			into.add(match[1]);
		}
	};
	for await (const chunk of chunks) {
		const text = carried + decoder.decode(chunk, { stream: true });
		scan(text, false);
		if (text.length > BLOB_REF_SPAN) {
			carried = text.slice(-BLOB_REF_SPAN);
			atTextStart = false;
		} else {
			carried = text;
		}
		yield chunk;
	}
	scan(carried + decoder.decode(), true);
}

/**
 * A transcript file as an archive member that adds the blob hashes its bytes
 * reference to `hashes` as the archive writer streams them, so the blobs
 * packed after it are the ones the packed bytes name, whatever another writer
 * does to the file meanwhile. Only a streaming writer (`writeTarArchive`) can
 * take it: the member is read through `stream()` and `size`, which the writer
 * reads for the member's header, again for its padding, on each chunk and
 * once the stream ends, and fails on a stream that does not yield that size.
 * `size` is the wrapped `Bun.file`'s, which stats the file once, at its first
 * read, so every read gives the size the header holds. Every other read
 * (`arrayBuffer()`, `bytes()`, `text()`, `slice()`) throws: this class holds no
 * bytes of its own, so it would give 0 bytes and collect no hashes.
 */
class BlobScannedFile extends Blob {
	readonly #file: Blob;
	readonly #hashes: Set<string>;

	constructor(file: Blob, hashes: Set<string>) {
		super();
		this.#file = file;
		this.#hashes = hashes;
	}

	override get size(): number {
		return this.#file.size;
	}

	override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
		const chunks = collectingBlobHashes(this.#file.stream(), this.#hashes);
		return new ReadableStream<Uint8Array<ArrayBuffer>>({
			async pull(controller) {
				const next = await chunks.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			async cancel() {
				await chunks.return(undefined);
			},
		});
	}

	override async arrayBuffer(): Promise<ArrayBuffer> {
		throw unstreamedRead("arrayBuffer");
	}

	override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
		throw unstreamedRead("bytes");
	}

	override async text(): Promise<string> {
		throw unstreamedRead("text");
	}

	override slice(): Blob {
		throw unstreamedRead("slice");
	}
}

function unstreamedRead(method: string): Error {
	return new Error(`A scanned transcript archive member is only streamed; ${method}() cannot read it`);
}

/** `chunks`, each fed to `digest` as it passes. */
async function* digestedChunks(chunks: AsyncIterable<Uint8Array>, digest: Bun.SHA256): AsyncGenerator<Uint8Array> {
	for await (const chunk of chunks) {
		digest.update(chunk);
		yield chunk;
	}
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

/**
 * Write a tar to a sibling staging file and rename it over `target`, so a failure leaves no partial archive.
 * File members stream into it, so the archive is never held in memory.
 */
async function writeArchiveAtomically(
	target: string,
	members: AsyncIterable<readonly [string, Archive.ArchiveMemberContent]>,
): Promise<void> {
	const { writeTarArchive }: typeof Archive = require("@oh-my-pi/pi-utils/ar");
	const staging = `${target}.${Snowflake.next()}.tmp`;
	try {
		await writeTarArchive(staging, members);
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
		const header = await firstJournalRecord(source);
		if (header?.type !== "session") {
			throw new SessionTransferError(`Not an omp session file (no session header): ${source}`);
		}
		const manifest: SessionArchiveManifest = {
			version: SESSION_ARCHIVE_VERSION,
			id,
			cwd: header.cwd,
			omp: VERSION,
		};
		// Artifacts sit beside the journal's real name (see copySessionArtifacts).
		let realSource = source;
		try {
			realSource = await fs.promises.realpath(source);
		} catch {}
		const artifactsDir = realSource.slice(0, -".jsonl".length);
		const artifacts = realSource.endsWith(".jsonl") ? await listFilesRecursive(artifactsDir) : [];
		const hashes = new Set<string>();
		const blobs = new BlobStore(getBlobsDir());
		const missingBlobs: string[] = [];
		// File members are read only while the archive is written, and the transcripts are scanned for
		// blob references as they stream in. The blobs come last: the archive writer takes each member
		// only once the one before it is written, so they are the blobs the packed transcripts name.
		async function* members(): AsyncGenerator<readonly [string, Archive.ArchiveMemberContent]> {
			yield [MANIFEST_MEMBER, `${JSON.stringify(manifest, null, 2)}\n`];
			yield [SESSION_MEMBER, new BlobScannedFile(Bun.file(source), hashes)];
			for (const relative of artifacts) {
				const artifact = Bun.file(path.join(artifactsDir, ...relative.split("/")));
				yield [
					`${ARTIFACTS_PREFIX}${relative}`,
					relative.endsWith(".jsonl") ? new BlobScannedFile(artifact, hashes) : artifact,
				];
			}
			for (const hash of [...hashes].sort()) {
				// Only an absent blob is left out; one the store holds but cannot read fails the pack.
				if ((await blobs.size(hash)) === null) {
					missingBlobs.push(hash);
					continue;
				}
				yield [`${BLOBS_PREFIX}${hash}`, blobs.file(hash)];
			}
		}

		await writeArchiveAtomically(archivePath, members());
		if (missingBlobs.length > 0) {
			logger.warn("Packing session without blobs missing from the local store", { id, missingBlobs });
		}
		return { archivePath, id, missingBlobs };
	} finally {
		release();
	}
}

/** A validated session archive, its members streamed to files in the unpack's staging directory. */
interface SessionArchiveContents {
	manifest: SessionArchiveManifest;
	/** The staged journal. */
	journal: string;
	header: SessionHeader;
	artifacts: [relative: string, file: string][];
	blobs: [hash: string, file: string][];
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

/** The hash a `blobs/<sha256>` member is named for; `undefined` for any other member. */
function blobMemberHash(name: string): string | undefined {
	if (!name.startsWith(BLOBS_PREFIX)) return undefined;
	const hash = name.slice(BLOBS_PREFIX.length);
	return BLOB_HASH_RE.test(hash) ? hash : undefined;
}

/**
 * Read and validate the whole archive before anything is written outside
 * `staging`: member layout, manifest version, journal header, and every
 * blob's sha256. The members are read one after another, each streamed to its
 * own file in `staging`, so no member is held in memory; a blob is hashed as
 * it streams and refused there when its bytes do not match its name. Every
 * member is read through one handle, so all of them come from the archive the
 * unpack opened, even when another file is renamed over its path meanwhile.
 */
async function readSessionArchive(archive: string, staging: TempDir): Promise<SessionArchiveContents> {
	await requireFile(archive, "Archive");
	const {
		ArchiveError,
		assertInMemorySize,
		formatArchivePathForError,
		heldFileSource,
		openArchive,
		writeChunksToFile,
	}: typeof Archive = require("@oh-my-pi/pi-utils/ar");
	const members: [name: string, file: string][] = [];
	const handle = await fs.promises.open(archive, "r");
	try {
		const reader = await openArchive(
			{ source: await heldFileSource(handle), format: "tar", path: archive },
			{ limits: { maxInMemorySize: ARCHIVE_SIZE_LIMIT, maxMemberSize: ARCHIVE_SIZE_LIMIT } },
		);
		// Invariant: the bytes staged below total at most ARCHIVE_SIZE_LIMIT
		// (2 GiB), checked here before any member is staged. Each member counts
		// the bytes `readFileChunks` reads for it: those of the entry its path
		// resolves to through directory symlinks, which can be another, larger
		// member. A path that resolves to no entry counts its own size; staging
		// refuses it. `assertInMemorySize` words the refusal as users already see it.
		let total = 0;
		for (const entry of reader.indexEntries()) {
			if (entry.isDirectory) continue;
			total += reader.getNode(entry.path)?.size ?? entry.size;
			assertInMemorySize(total, reader.limits);
		}
		for (const entry of reader.indexEntries()) {
			if (entry.isDirectory) continue;
			const file = staging.join(`member-${members.length}`);
			const hash = blobMemberHash(entry.path);
			const digest = hash === undefined ? undefined : new Bun.SHA256();
			const chunks = reader.readFileChunks(entry.path);
			await writeChunksToFile(file, digest ? digestedChunks(chunks, digest) : chunks);
			const actual = digest?.digest("hex");
			if (actual !== hash) {
				throw new SessionTransferError(
					`Bad session archive ${archive}: blob ${hash} fails its sha256 check (content hashes to ${actual}). Nothing was unpacked.`,
				);
			}
			members.push([entry.path, file]);
		}
	} catch (error) {
		if (error instanceof ArchiveError) {
			throw new SessionTransferError(`Bad session archive ${archive}: ${error.message}`);
		}
		throw error;
	} finally {
		await handle.close();
	}

	let manifestFile: string | undefined;
	let journal: string | undefined;
	const artifacts: [string, string][] = [];
	const blobs: [string, string][] = [];
	for (const [name, file] of members) {
		const blobHash = blobMemberHash(name);
		if (name === MANIFEST_MEMBER) {
			manifestFile = file;
		} else if (name === SESSION_MEMBER) {
			journal = file;
		} else if (name.startsWith(ARTIFACTS_PREFIX) && isSafeRelativePath(name.slice(ARTIFACTS_PREFIX.length))) {
			artifacts.push([name.slice(ARTIFACTS_PREFIX.length), file]);
		} else if (blobHash !== undefined) {
			blobs.push([blobHash, file]);
		} else {
			throw new SessionTransferError(
				`Bad session archive ${archive}: unexpected member "${formatArchivePathForError(name)}".`,
			);
		}
	}
	if (!manifestFile) throw new SessionTransferError(`Bad session archive ${archive}: no manifest.json.`);
	const manifest = parseManifest(await Bun.file(manifestFile).bytes(), archive);
	if (!journal) throw new SessionTransferError(`Bad session archive ${archive}: no session.jsonl.`);

	const header = await firstJournalRecord(journal);
	if (!isValidSessionHeader(header)) {
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
	return { manifest, journal, header, artifacts, blobs };
}

/** Ids of the body entries of the journal at `file`, in file order, visited one entry at a time. */
async function bodyEntryIds(file: string): Promise<string[]> {
	const ids: string[] = [];
	await visitEntriesFromFile(file, entry => {
		if (isBodyEntry(entry)) ids.push(entry.id);
	});
	return ids;
}

/**
 * Whether the session at `local` is a prefix of `incoming` (body entry ids)
 * by entry id, visiting `local` one entry at a time. `departed` markers only
 * `local` has are skipped: they are appended to the copy left behind after it
 * was packed, so they never reach the copy that moved on. A copy removed since
 * it was found holds no entries, so it is a prefix; any other read error throws.
 */
async function isTranscriptPrefix(local: string, incoming: readonly string[]): Promise<boolean> {
	let next = 0;
	let prefix = true;
	try {
		await visitEntriesFromFile(local, entry => {
			if (!isBodyEntry(entry)) return;
			if (next < incoming.length && incoming[next] === entry.id) {
				next++;
				return;
			}
			if (sessionTransferDetails(entry)?.kind === "departed") return;
			prefix = false;
			return false;
		});
	} catch (error) {
		if (isEnoent(error)) return true;
		throw error;
	}
	return prefix;
}

/** Top-level session files holding session `id`: every project bucket, plus `sessionDir` when it lies elsewhere. */
async function findLocalCopies(id: string, sessionDir: string): Promise<string[]> {
	const candidates = new Set((await findSessionFiles(id)).map(file => path.resolve(file)));
	try {
		for await (const name of new Bun.Glob(`*_${id}.jsonl`).scan({ cwd: sessionDir, followSymlinks: true })) {
			candidates.add(path.resolve(sessionDir, name));
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	// One transcript reached by two names — a bucket symlinked to another
	// lists it under both (#5385) — is one copy, or `setAside` would try to
	// move the same file aside twice. `path.resolve` leaves the symlink in
	// place, so the identity has to come from `realpath`.
	const seen = new Set<string>();
	const copies: string[] = [];
	for (const file of candidates) {
		if (!path.basename(file).endsWith(`_${id}.jsonl`)) continue;
		let key: string;
		try {
			key = await fs.promises.realpath(file);
		} catch {
			key = file;
		}
		if (seen.has(key)) continue;
		seen.add(key);
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
 * `options.cwd`. The archive's members stream one by one into a temp
 * directory and are validated in full there (manifest version, member layout,
 * every blob's sha256) before anything else is written. Blobs go into the
 * local blob store; the journal and artifacts are moved with
 * {@link SessionManager.openRelocated}, which rewrites the header `cwd`. An
 * `arrived` marker is appended.
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
	const staging = await TempDir.create("@omp-session-unpack-");
	try {
		const contents = await readSessionArchive(archive, staging);
		const { header } = contents;
		const id = header.id;
		const recordedCwd = header.cwd || contents.manifest.cwd;
		const sessionDir = options.sessionDir
			? path.resolve(options.sessionDir)
			: SessionManager.getDefaultSessionDir(cwd);
		const arrival: SessionTransferDetails = { kind: "arrived", fromCwd: recordedCwd, cwd };

		// Blobs first: the loader hydrates image refs while the journal is opened.
		// Content-addressed and verified, so an aborted unpack leaves nothing wrong.
		// One stored image at a time is read into memory to file it.
		const blobStore = new BlobStore(getBlobsDir());
		for (const [hash, file] of contents.blobs) {
			await blobStore.put(await fs.promises.readFile(file), { hash });
		}

		const stagedFile = staging.join(`${header.timestamp.replace(/[^\w-]/g, "-")}_${id}.jsonl`);
		await fs.promises.rename(contents.journal, stagedFile);
		const stagedArtifacts = stagedFile.slice(0, -".jsonl".length);
		for (const [relative, file] of contents.artifacts) {
			const target = path.join(stagedArtifacts, ...relative.split("/"));
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await fs.promises.rename(file, target);
		}

		const localCopies = await findLocalCopies(id, sessionDir);
		let diverged = false;
		if (localCopies.length > 0) {
			const incoming = await bodyEntryIds(stagedFile);
			for (const file of localCopies) {
				if (!(await isTranscriptPrefix(file, incoming))) diverged = true;
			}
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
