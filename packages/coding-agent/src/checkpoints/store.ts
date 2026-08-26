/**
 * On-disk storage for checkpoint metadata and the rollback journal.
 *
 * Layout mirrors the session artifacts convention (`<sessionDir>/<sessionFile
 * basename>/` for artifacts): checkpoints live in
 * `<sessionDir>/checkpoints/<sessionId>/`, one `<id>.json` per checkpoint plus
 * `rollback-journal.json` while a rollback transaction is in flight. Every write
 * is tmp+rename, so a crash leaves either the previous file or the complete new
 * one — never a truncated JSON body.
 *
 * A checkpoint is *valid* only when its ref resolves, its JSON parses into the
 * expected shape, and its recorded workspace identity matches the workspace
 * being queried. Anything else is a crash remnant and is filtered out.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, Snowflake } from "@oh-my-pi/pi-utils";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import type { CheckpointMeta, CheckpointReason, RollbackJournal, WorkspaceIdentity } from "./types";

const CHECKPOINTS_DIR_NAME = "checkpoints";
const JOURNAL_FILE_NAME = "rollback-journal.json";
/** Metadata filenames are exactly `<10 hex>.json`; anything else is not ours. */
const META_FILE_PATTERN = /^[0-9a-f]{10}\.json$/;
const CHECKPOINT_REASONS: readonly CheckpointReason[] = ["manual", "auto", "pre-rollback"];
const REF_SEGMENT_UNSAFE = /[^A-Za-z0-9._-]+/g;

const sessionDirStorage = new FileSessionStorage();

/**
 * Default metadata root for a workspace: the checkpoints directory inside the
 * cwd's session directory, so checkpoints sit beside the sessions and artifacts
 * they belong to and are removed with the project's session data.
 *
 * `sessionsRoot` mirrors `computeDefaultSessionDir`'s parameter so callers (and
 * tests) can point the whole layout at a scratch directory.
 */
export function defaultCheckpointsRoot(cwd: string, sessionsRoot?: string): string {
	return path.join(computeDefaultSessionDir(cwd, sessionDirStorage, sessionsRoot), CHECKPOINTS_DIR_NAME);
}

/**
 * Ref-safe form of a session id or checkpoint id. Ids are generated (uuid /
 * hex), but a caller-supplied session id must never be able to inject ref path
 * components or git's forbidden byte sequences.
 */
export function refSegment(value: string): string {
	const sanitized = value.replace(REF_SEGMENT_UNSAFE, "-").replace(/^[.-]+|[.-]+$/g, "");
	return sanitized.length > 0 ? sanitized : "unnamed";
}

export function refNameFor(sessionId: string, id: string): string {
	return `refs/omp/checkpoints/${refSegment(sessionId)}/${refSegment(id)}`;
}

/** Ref namespace covering every checkpoint of one session. */
export function refPrefixFor(sessionId: string): string {
	return `refs/omp/checkpoints/${refSegment(sessionId)}`;
}

export function sessionDirFor(root: string, sessionId: string): string {
	return path.join(root, refSegment(sessionId));
}

export function metaPathFor(root: string, sessionId: string, id: string): string {
	return path.join(sessionDirFor(root, sessionId), `${id}.json`);
}

export function journalPathFor(root: string, sessionId: string): string {
	return path.join(sessionDirFor(root, sessionId), JOURNAL_FILE_NAME);
}

/**
 * Publish `value` at `filePath` atomically. `Bun.write` creates the parent
 * directory, and the rename is the single visible transition.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const tempPath = `${filePath}.${Snowflake.next()}.tmp`;
	await Bun.write(tempPath, `${JSON.stringify(value, null, 2)}\n`);
	try {
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function readJsonFile(filePath: string): Promise<unknown> {
	try {
		return await Bun.file(filePath).json();
	} catch {
		// Missing (never written / already pruned) and unparsable (crash before
		// the metadata rename) are the same answer to the caller: no usable
		// record here. Callers treat `undefined` as "not a valid checkpoint".
		return undefined;
	}
}

function isWorkspaceIdentity(value: unknown): value is WorkspaceIdentity {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.repoRoot === "string" &&
		typeof candidate.worktreePath === "string" &&
		(candidate.headSha === null || typeof candidate.headSha === "string") &&
		(candidate.branch === null || typeof candidate.branch === "string")
	);
}

/** Structural validation of a parsed metadata file. */
export function isCheckpointMeta(value: unknown): value is CheckpointMeta {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.createdAt === "string" &&
		(candidate.label === undefined || typeof candidate.label === "string") &&
		typeof candidate.reason === "string" &&
		CHECKPOINT_REASONS.includes(candidate.reason as CheckpointReason) &&
		isWorkspaceIdentity(candidate.identity) &&
		typeof candidate.treeSha === "string" &&
		candidate.treeSha.length > 0 &&
		(candidate.headShaAtCapture === null || typeof candidate.headShaAtCapture === "string") &&
		typeof candidate.refName === "string" &&
		typeof candidate.metaPath === "string" &&
		typeof candidate.bytesCaptured === "number" &&
		Array.isArray(candidate.skippedFiles) &&
		candidate.skippedFiles.every(entry => typeof entry === "string")
	);
}

function isRollbackJournal(value: unknown): value is RollbackJournal {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.sessionId === "string" &&
		typeof candidate.phase === "string" &&
		typeof candidate.targetId === "string" &&
		typeof candidate.targetTreeSha === "string" &&
		typeof candidate.baseTreeSha === "string" &&
		isWorkspaceIdentity(candidate.identity)
	);
}

/**
 * Whether two identities describe the same checkout. HEAD and branch are
 * deliberately excluded: a checkpoint stays valid after the user commits or
 * switches branches, it just no longer matches HEAD.
 */
export function identityMatches(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
	return (
		path.resolve(left.repoRoot) === path.resolve(right.repoRoot) &&
		path.resolve(left.worktreePath) === path.resolve(right.worktreePath)
	);
}

/** Checkpoint metadata filenames present for a session (unvalidated, cheap). */
export async function listMetaFileNames(root: string, sessionId: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(sessionDirFor(root, sessionId));
		return entries.filter(entry => META_FILE_PATTERN.test(entry));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

/** Parse and structurally validate every metadata file of a session. Order is unspecified. */
export async function readSessionMetas(root: string, sessionId: string): Promise<CheckpointMeta[]> {
	const fileNames = await listMetaFileNames(root, sessionId);
	const dir = sessionDirFor(root, sessionId);
	const parsed = await Promise.all(fileNames.map(name => readJsonFile(path.join(dir, name))));
	return parsed.filter(isCheckpointMeta);
}

export async function readMeta(root: string, sessionId: string, id: string): Promise<CheckpointMeta | undefined> {
	const value = await readJsonFile(metaPathFor(root, sessionId, id));
	return isCheckpointMeta(value) ? value : undefined;
}

export async function deleteMeta(root: string, sessionId: string, id: string): Promise<void> {
	await fs.rm(metaPathFor(root, sessionId, id), { force: true });
}

export async function readJournal(root: string, sessionId: string): Promise<RollbackJournal | undefined> {
	const value = await readJsonFile(journalPathFor(root, sessionId));
	return isRollbackJournal(value) ? value : undefined;
}

export async function writeJournal(root: string, sessionId: string, journal: RollbackJournal): Promise<void> {
	await writeJsonAtomic(journalPathFor(root, sessionId), journal);
}

/** Close a completed transaction. The journal's absence is the "no transaction in flight" signal. */
export async function clearJournal(root: string, sessionId: string): Promise<void> {
	await fs.rm(journalPathFor(root, sessionId), { force: true });
}

/** Remove a session's whole checkpoint metadata directory (session delete flow). */
export async function removeSessionDir(root: string, sessionId: string): Promise<void> {
	await fs.rm(sessionDirFor(root, sessionId), { recursive: true, force: true });
}
