/**
 * Workspace checkpoint service: capture, query, retention, rollback.
 *
 * Disk discipline is a first-class concern. Snapshots are content-addressed git
 * objects (identical workspaces share every byte), an identical-tree capture
 * returns the existing checkpoint instead of minting a new one, oversize files
 * are excluded rather than duplicated into the object database, and retention
 * prunes automatic checkpoints plus any ref left behind by a crash.
 */
import * as fs from "node:fs/promises";
import { logger, toError } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import * as git from "../utils/git";
import { captureWorkspaceTree, resolveWorkspaceIdentity, writeCheckpointRef } from "./capture";
import { emitWorkspaceRolledBack } from "./notify";
import { runRollbackTransaction } from "./rollback";
import {
	defaultCheckpointsRoot,
	deleteMeta,
	identityMatches,
	journalPathFor,
	listMetaFileNames,
	metaPathFor,
	readJournal,
	readSessionMetas,
	refNameFor,
	refPrefixFor,
	removeSessionDir,
	writeJsonAtomic,
} from "./store";
import {
	CheckpointError,
	type CheckpointMeta,
	type CreateCheckpointOptions,
	type RollbackJournal,
	type RollbackOptions,
	type RollbackResult,
	type WorkspaceIdentity,
} from "./types";

/** Checkpoint ids are 5 random bytes rendered as 10 lowercase hex chars. */
const CHECKPOINT_ID_BYTES = 5;
/** Ids are random, not sequential; a collision means retry, never overwrite. */
const ID_MINT_ATTEMPTS = 8;

export interface WorkspaceCheckpointServiceOptions {
	/**
	 * Metadata root override. Defaults to the checkpoints directory inside the
	 * cwd's session directory. Tests and embedders pass a scratch directory.
	 */
	readonly metadataRoot?: string;
	/** Per-file size ceiling override; defaults to `checkpoints.maxFileBytes`. */
	readonly maxFileBytes?: number;
	/** Retention cap override; defaults to `checkpoints.retention.maxPerSession`. */
	readonly maxPerSession?: number;
}

function mintCheckpointId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(CHECKPOINT_ID_BYTES));
	let id = "";
	for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
	return id;
}

let globalService: WorkspaceCheckpointService | null = null;

export class WorkspaceCheckpointService {
	readonly #options: WorkspaceCheckpointServiceOptions;

	constructor(options: WorkspaceCheckpointServiceOptions = {}) {
		this.#options = options;
	}

	/** Process-wide instance used by commands and auto-checkpoint triggers. */
	static global(): WorkspaceCheckpointService {
		globalService ??= new WorkspaceCheckpointService();
		return globalService;
	}

	/** Drop the process-wide instance (test isolation). */
	static resetGlobal(): void {
		globalService = null;
	}

	/**
	 * Capture the current workspace.
	 *
	 * Dedup: when the newest checkpoint of the session already has the candidate
	 * tree, that checkpoint is returned unchanged — no new ref, no new metadata,
	 * no new bytes.
	 *
	 * @throws CheckpointError when `cwd` is not a git repository or too many
	 * files exceed the size limit.
	 */
	async create(options: CreateCheckpointOptions): Promise<CheckpointMeta> {
		const { cwd, sessionId, signal } = options;
		const identity = await resolveWorkspaceIdentity(cwd, signal);
		const root = this.#root(cwd);
		const capture = await captureWorkspaceTree(identity.worktreePath, {
			maxFileBytes: this.#maxFileBytes(),
			signal,
		});

		const latest = await this.latest(sessionId, cwd);
		if (latest?.treeSha === capture.treeSha) return latest;

		const id = await this.#mintUnusedId(root, sessionId);
		const refName = refNameFor(sessionId, id);
		const createdAt = new Date().toISOString();
		const message = `omp workspace checkpoint ${id} (${options.reason})\n\nsession: ${sessionId}\ncreated: ${createdAt}${options.label ? `\nlabel: ${options.label}` : ""}\n`;
		await writeCheckpointRef(identity.worktreePath, {
			refName,
			treeSha: capture.treeSha,
			parentSha: identity.headSha,
			message,
			signal,
		});

		const meta: CheckpointMeta = {
			id,
			sessionId,
			createdAt,
			...(options.label === undefined ? {} : { label: options.label }),
			reason: options.reason,
			identity,
			treeSha: capture.treeSha,
			headShaAtCapture: identity.headSha,
			refName,
			metaPath: metaPathFor(root, sessionId, id),
			bytesCaptured: capture.bytesCaptured,
			skippedFiles: capture.skippedFiles,
		};
		// Metadata is published only after the ref exists: a crash between the two
		// leaves an unreferenced ref (pruned by pruneSession), never metadata
		// pointing at a missing snapshot.
		await writeJsonAtomic(meta.metaPath, meta);
		await this.pruneSession(sessionId, cwd);
		return meta;
	}

	/**
	 * Valid checkpoints of a session in this workspace, newest first. Entries
	 * whose ref is gone, whose JSON is unparsable, or that belong to another
	 * workspace are filtered out. Returns `[]` outside a git repository.
	 */
	async list(sessionId: string, cwd: string): Promise<CheckpointMeta[]> {
		const identity = await this.#identityOrNull(cwd);
		if (!identity) return [];
		const root = this.#root(cwd);
		const metas = (await readSessionMetas(root, sessionId)).filter(
			meta => meta.sessionId === sessionId && identityMatches(meta.identity, identity),
		);
		const resolved = await Promise.all(
			metas.map(async meta => ((await git.ref.resolve(identity.worktreePath, meta.refName)) ? meta : undefined)),
		);
		return resolved
			.filter((meta): meta is CheckpointMeta => meta !== undefined)
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
	}

	/** Resolve a checkpoint by id prefix (as typed by the user). */
	async get(sessionId: string, cwd: string, idPrefix: string): Promise<CheckpointMeta | undefined> {
		const normalized = idPrefix.trim().toLowerCase();
		if (!normalized) return undefined;
		const metas = await this.list(sessionId, cwd);
		return metas.find(meta => meta.id === normalized) ?? metas.find(meta => meta.id.startsWith(normalized));
	}

	async latest(sessionId: string, cwd: string): Promise<CheckpointMeta | undefined> {
		return (await this.list(sessionId, cwd))[0];
	}

	/**
	 * Checkpoint count for a session without git or JSON work: metadata filenames
	 * only. Used by session listings, where a per-row git call per session would
	 * be the dominant cost.
	 */
	async countForSession(sessionId: string, cwd: string): Promise<number> {
		return (await listMetaFileNames(this.#root(cwd), sessionId)).length;
	}

	/** Journal of an unfinished rollback, for startup recovery messaging. */
	async pendingRollback(sessionId: string, cwd: string): Promise<RollbackJournal | undefined> {
		return readJournal(this.#root(cwd), sessionId);
	}

	/**
	 * Restore the workspace to `meta`. See `rollback.ts` for the transaction
	 * guarantees. Validation failures (foreign session, foreign workspace, missing
	 * snapshot) come back as `ok: false` without touching the workspace.
	 *
	 * @throws CheckpointError when `opts.cwd` is not a git repository.
	 */
	async rollback(meta: CheckpointMeta, opts: RollbackOptions): Promise<RollbackResult> {
		const identity = await resolveWorkspaceIdentity(opts.cwd, opts.signal);
		if (meta.sessionId !== opts.sessionId) {
			return {
				ok: false,
				restoredFiles: 0,
				removedFiles: 0,
				error: `checkpoint ${meta.id} belongs to session ${meta.sessionId}, not ${opts.sessionId}`,
			};
		}
		if (!identityMatches(meta.identity, identity)) {
			return {
				ok: false,
				restoredFiles: 0,
				removedFiles: 0,
				error: `checkpoint ${meta.id} was captured in ${meta.identity.worktreePath}, not ${identity.worktreePath}`,
			};
		}
		if (!(await git.ref.resolve(identity.worktreePath, meta.refName))) {
			return {
				ok: false,
				restoredFiles: 0,
				removedFiles: 0,
				error: `checkpoint ${meta.id} is no longer present in the repository (${meta.refName})`,
			};
		}

		const result = await runRollbackTransaction({
			root: this.#root(opts.cwd),
			sessionId: opts.sessionId,
			identity,
			target: meta,
			maxFileBytes: this.#maxFileBytes(),
			captureSafety: () =>
				this.create({
					sessionId: opts.sessionId,
					cwd: opts.cwd,
					reason: "pre-rollback",
					label: `before rollback to ${meta.id}`,
					signal: opts.signal,
				}),
			signal: opts.signal,
		});
		if (result.ok) emitWorkspaceRolledBack(opts.notify, meta);
		return result;
	}

	/**
	 * Enforce retention for a session: delete oldest automatic checkpoints beyond
	 * the cap (manual and pre-rollback are protected) and drop refs no valid
	 * metadata points at. Returns the number of checkpoints removed.
	 */
	async pruneSession(sessionId: string, cwd: string): Promise<number> {
		const identity = await this.#identityOrNull(cwd);
		if (!identity) return 0;
		const metas = await this.list(sessionId, cwd);
		const cap = this.#maxPerSession();
		// Newest-first list ⇒ reversed autos are oldest-first: the oldest automatic
		// checkpoints go while manual and pre-rollback ones are always kept.
		const prunable = metas.filter(meta => meta.reason === "auto").reverse();
		const removals: CheckpointMeta[] = [];
		let total = metas.length;
		for (const meta of prunable) {
			if (total <= cap) break;
			removals.push(meta);
			total -= 1;
		}

		const removedIds = new Set(removals.map(meta => meta.id));
		const keptRefs = new Set(metas.filter(meta => !removedIds.has(meta.id)).map(meta => meta.refName));
		const orphanRefs = (await git.ref.list(identity.worktreePath, refPrefixFor(sessionId)))
			.map(entry => entry.refName)
			.filter(refName => !keptRefs.has(refName));

		if (orphanRefs.length > 0) {
			await git.withRepoLock(identity.worktreePath, async () => {
				for (const refName of orphanRefs) {
					try {
						await git.ref.delete(identity.worktreePath, refName);
					} catch (error) {
						logger.warn("Failed to delete checkpoint ref during prune", {
							refName,
							error: toError(error).message,
						});
					}
				}
			});
		}
		for (const meta of removals) await deleteMeta(this.#root(cwd), sessionId, meta.id);
		return removals.length;
	}

	/**
	 * Remove every checkpoint of a session: all refs under the session's ref
	 * namespace plus the metadata directory. Safe outside a git repository (the
	 * metadata still goes). Returns the number of metadata files removed.
	 */
	async deleteForSession(sessionId: string, cwd: string): Promise<number> {
		const root = this.#root(cwd);
		const removed = (await listMetaFileNames(root, sessionId)).length;
		const identity = await this.#identityOrNull(cwd);
		if (identity) {
			const refs = await git.ref.list(identity.worktreePath, refPrefixFor(sessionId));
			if (refs.length > 0) {
				await git.withRepoLock(identity.worktreePath, async () => {
					for (const entry of refs) {
						try {
							await git.ref.delete(identity.worktreePath, entry.refName);
						} catch (error) {
							logger.warn("Failed to delete checkpoint ref during session delete", {
								refName: entry.refName,
								error: toError(error).message,
							});
						}
					}
				});
			}
		}
		await removeSessionDir(root, sessionId);
		return removed;
	}

	/** Absolute path of a session's rollback journal (present only mid-transaction). */
	journalPath(sessionId: string, cwd: string): string {
		return journalPathFor(this.#root(cwd), sessionId);
	}

	#root(cwd: string): string {
		return this.#options.metadataRoot ?? defaultCheckpointsRoot(cwd);
	}

	#maxFileBytes(): number {
		if (this.#options.maxFileBytes !== undefined) return this.#options.maxFileBytes;
		const configured = isSettingsInitialized()
			? settings.get("checkpoints.maxFileBytes")
			: getDefault("checkpoints.maxFileBytes");
		return Number.isFinite(configured) && configured > 0 ? configured : getDefault("checkpoints.maxFileBytes");
	}

	#maxPerSession(): number {
		if (this.#options.maxPerSession !== undefined) return this.#options.maxPerSession;
		const configured = isSettingsInitialized()
			? settings.get("checkpoints.retention.maxPerSession")
			: getDefault("checkpoints.retention.maxPerSession");
		return Number.isFinite(configured) && configured > 0
			? configured
			: getDefault("checkpoints.retention.maxPerSession");
	}

	async #identityOrNull(cwd: string): Promise<WorkspaceIdentity | null> {
		try {
			return await resolveWorkspaceIdentity(cwd);
		} catch (error) {
			if (error instanceof CheckpointError) return null;
			throw error;
		}
	}

	async #mintUnusedId(root: string, sessionId: string): Promise<string> {
		for (let attempt = 0; attempt < ID_MINT_ATTEMPTS; attempt += 1) {
			const id = mintCheckpointId();
			try {
				await fs.access(metaPathFor(root, sessionId, id));
			} catch {
				return id;
			}
		}
		throw new CheckpointError("could not allocate a unique checkpoint id");
	}
}
