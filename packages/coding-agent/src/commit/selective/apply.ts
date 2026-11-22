/**
 * Commit a {@link Draft}'s selection in a workspace other agents keep editing.
 *
 * The commit is built in a private index file: HEAD's tree plus one patch per selected path
 * rendering the exact content the draft chose. `commitCreate` commits that index with an
 * expected-HEAD guard (hooks see it as `GIT_INDEX_FILE`, like `git commit --only`), so a
 * concurrent commit by someone else can never be overwritten. Afterwards the same patches, plus
 * whatever a `pre-commit` hook restaged into the private index (formatters do), are applied to the
 * shared index so the committed paths do not show up as staged reversals; every other index entry
 * and the worktree stay untouched.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Draft, SelectedChange } from "./draft";
import type { ChangeJournal, JournalAgent } from "./journal";
import { formatTextPatch } from "./patch";

/** Attempts at a shared-index write while another git process holds `index.lock`. */
const INDEX_WRITE_ATTEMPTS = 5;
/** Pause before the first retry of a shared-index write, doubled per attempt. */
const INDEX_WRITE_BACKOFF_MS = 40;

/**
 * Apply `patch` to the shared index, retrying while it cannot be written; the last failure's
 * message, or `undefined` once applied. A patch whose preimage the index no longer holds fails
 * every attempt, which the caller tells apart with `canApplyPatch`.
 */
async function applyToSharedIndex(repo: VcsGitRepo, patch: string, signal?: AbortSignal): Promise<string | undefined> {
	let failure = "";
	for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			if (!(await repo.canApplyPatch(patch, { cached: true }).catch(() => true))) return failure;
			await Bun.sleep(INDEX_WRITE_BACKOFF_MS << (attempt - 1));
		}
		try {
			await repo.applyPatch(patch, { cached: true }, signal);
			return undefined;
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
	}
	return failure;
}

/** One path's patch; joined with others, or applied alone when the joined write fails. */
interface PathPatch {
	path: string;
	patch: string;
}

/**
 * Apply `patches` to the shared index; a note per path whose entry was left as is. Entries that
 * already hold the patched content count as applied.
 */
async function syncSharedIndex(
	repo: VcsGitRepo,
	patches: readonly PathPatch[],
	signal?: AbortSignal,
): Promise<Array<{ path: string; note: string }>> {
	// One write for every path: each write takes `index.lock`, which a concurrent git (a prompt's
	// or an editor's `git status`) may hold. Per-path writes only when a path's entry differs.
	const joined = vcs.joinPatches(patches.map(entry => entry.patch));
	if ((await applyToSharedIndex(repo, joined, signal)) === undefined) return [];
	const notes: Array<{ path: string; note: string }> = [];
	for (const entry of patches) {
		const failure = await applyToSharedIndex(repo, entry.patch, signal);
		if (failure === undefined) continue;
		if (await repo.canApplyPatch(entry.patch, { cached: true, reverse: true }).catch(() => false)) continue;
		const staged = await repo.canApplyPatch(entry.patch, { cached: true }).catch(() => undefined);
		notes.push({
			path: entry.path,
			note:
				staged === false
					? `${entry.path}: its shared-index entry holds someone else's staged changes and was left as is; ` +
						"`git diff --cached` there shows this commit reverted until they restage."
					: `${entry.path}: the shared index could not be written (${failure}); ` +
						`\`git diff --cached\` there shows this commit reverted until \`git reset -q -- ${entry.path}\`.`,
		});
	}
	return notes;
}

/** Attempts when HEAD moves between building the private index and committing it. */
const HEAD_RACE_ATTEMPTS = 3;

/** Message and mode of a selective commit. */
export interface CommitRequest {
	/** One-line subject. */
	subject: string;
	/** Body paragraphs or lines; joined with newlines after a blank line. */
	body?: string | readonly string[];
	/** Issue references appended as `Fixes #N` lines (`123`, `"#123"`, `"owner/repo#123"`). */
	fixes?: number | string | ReadonlyArray<number | string>;
	/** Replace HEAD instead of adding a commit; only allowed when this session's selective commit made HEAD. */
	amend?: boolean;
	/** Skip the `pre-commit` and `commit-msg` hooks, like `git commit --no-verify`. */
	noVerify?: boolean;
}

/** Result of {@link commitSelection}. */
export interface CommitOutcome {
	sha: string;
	subject: string;
	/** Repo-relative paths the commit changed against `parent` (on amend: everything the amended commit changes). */
	paths: string[];
	/**
	 * First parent of the commit, `null` for a root commit. Without amend this is the HEAD the commit was
	 * placed on, which differs from the draft's HEAD when someone committed meanwhile.
	 */
	parent: string | null;
	/** On amend, the commit that was replaced. */
	amended?: string;
	/** Committed paths whose shared-index entry kept someone else's staged content instead of the commit's. */
	indexNotes: string[];
}

/**
 * Commit message with a single-line subject, a blank line, the body, and `Fixes` trailers.
 * @throws when the subject is empty or spans lines.
 */
export function composeMessage(request: CommitRequest): string {
	const subject = request.subject.trim();
	if (!subject) throw new Error("Commit subject is empty.");
	if (subject.includes("\n")) throw new Error("Commit subject must be one line; put details in `body`.");
	const body = (typeof request.body === "string" ? request.body : (request.body ?? []).join("\n")).trim();
	const references = request.fixes === undefined ? [] : Array.isArray(request.fixes) ? request.fixes : [request.fixes];
	const fixes = references.map(reference => `Fixes ${/^\d+$/.test(String(reference)) ? `#${reference}` : reference}`);
	return `${[subject, body, fixes.join("\n")].filter(Boolean).join("\n\n")}\n`;
}

/** Abbreviated commit id, or a stand-in for the unborn HEAD. */
function shortSha(sha: string | null): string {
	return sha?.slice(0, 10) ?? "(no commits yet)";
}

async function patchFor(repo: VcsGitRepo, change: SelectedChange, signal?: AbortSignal): Promise<string> {
	if (change.kind === "text") {
		if (change.after?.mode === "160000") {
			const absolute = path.join(repo.info().repoRoot, change.path);
			const module = vcs.git(absolute);
			const sameRoot = module && (await fs.realpath(module.info().repoRoot)) === (await fs.realpath(absolute));
			if (!sameRoot || `Subproject commit ${await module.headSha()}\n` !== change.after.text) {
				throw new Error(`${change.path}: submodule HEAD changed since the draft; build a new draft.`);
			}
		}
		return formatTextPatch(change.path, change.before, change.after);
	}
	return repo.diffBlobs(
		{
			path: change.path,
			oldId: change.before?.id,
			newId: change.after?.id,
			oldMode: change.before?.mode,
			newMode: change.after?.mode,
		},
		true,
		signal,
	);
}

/**
 * Commit the draft's selection on top of the current HEAD.
 * @throws when a merge, cherry-pick, revert, rebase, or git am is in progress, or the index has
 * unresolved conflicts; when nothing is selected;
 * on `amend` when HEAD is not a selective commit of this session; when HEAD moved onto changes
 * that conflict with the selection; or when a hook fails.
 */
export async function commitSelection(
	draft: Draft,
	request: CommitRequest,
	context: { journal: ChangeJournal | null; agent: JournalAgent; signal?: AbortSignal },
): Promise<CommitOutcome> {
	const changes = draft.selection();
	if (changes.length === 0) {
		if (draft.paths.length > 0) throw new Error("Nothing selected; use take() first.");
		throw new Error(
			draft.skipped.length > 0
				? `Nothing to commit: only ${draft.skipped.join(", ")} changed (submodule or nested repository), which selective commits skip.`
				: `Nothing to commit: ${shortenPath(draft.root)} has no changes against HEAD.`,
		);
	}
	const repo = vcs.requireGit(draft.root);
	const operation = await repo.operationKind(context.signal);
	if (operation === "unmerged-index") {
		throw new Error("The index has unresolved conflicts; resolve them before using commit().");
	}
	if (operation) {
		throw new Error(
			`A ${operation === "am" ? "git am" : operation} is in progress; finish or abort it before using commit(). Use plain \`git commit\` for commits within that operation.`,
		);
	}
	const gitDir = repo.info().gitDir;
	const message = composeMessage(request);
	const patches: PathPatch[] = [];
	for (const change of changes) {
		const patch = await patchFor(repo, change, context.signal);
		if (patch) patches.push({ path: change.path, patch });
	}
	if (patches.length === 0) throw new Error("The selection matches HEAD; nothing to commit.");
	const ownCommits = request.amend
		? new Set(
				(context.journal ? await context.journal.read() : []).flatMap(record =>
					record.type === "commit" ? [record.sha] : [],
				),
			)
		: undefined;
	const joined = vcs.joinPatches(patches.map(entry => entry.patch));
	const indexPath = path.join(
		gitDir,
		`omp-commit-${draft.id}-${Math.floor(Math.random() * 46656).toString(36)}.index`,
	);
	let sha: string | undefined;
	/** HEAD the commit was built on; on amend, the commit it replaced. */
	let base = draft.head;
	/** Tree of the private index before hooks ran: what the selection alone commits. */
	let selectedTree = "";
	try {
		for (let attempt = 1; sha === undefined; attempt++) {
			context.signal?.throwIfAborted();
			const head = (await repo.headSha(context.signal)) ?? null;
			if (ownCommits && (head === null || !ownCommits.has(head))) {
				throw new Error(`HEAD ${shortSha(head)} was not made by this session's commit flow; refusing to amend it.`);
			}
			// Hooks see this index; preserve HEAD's sparse exclusions from the shared index.
			if (head === null) await fs.rm(indexPath, { force: true });
			else await repo.readTreeKeepingSparse(head, indexPath, context.signal);
			try {
				await repo.applyPatch(joined, { cached: true, indexPath }, context.signal);
			} catch (error) {
				if (head === draft.head) throw error;
				const blocked: string[] = [];
				for (const entry of patches) {
					if (!(await repo.canApplyPatch(entry.patch, { cached: true, indexPath }))) blocked.push(entry.path);
				}
				throw new Error(
					`HEAD moved from ${shortSha(draft.head)} to ${shortSha(head)}, which changed ${blocked.join(", ") || "selected paths"}; build a new draft.`,
				);
			}
			selectedTree = await repo.writeTree(indexPath, context.signal);
			try {
				sha = await repo.commitCreate(
					message,
					{
						indexPath,
						expectedHead: head ?? undefined,
						amend: request.amend ?? false,
						noVerify: request.noVerify ?? false,
					},
					context.signal,
				);
				base = head;
			} catch (error) {
				if (!(vcs.isVcsError(error) && error.code === "HeadMoved") || attempt >= HEAD_RACE_ATTEMPTS) throw error;
			}
		}
	} finally {
		await fs.rm(indexPath, { force: true });
	}

	const indexNotes: string[] = [];
	// A new repository may have no index file yet. Git reads that as an empty index, but patch
	// application reads HEAD in its place, so seed it with the root commit's tree instead.
	if (base === null && !(await Bun.file(path.join(gitDir, "index")).exists())) {
		await repo.readTree(sha, undefined, context.signal);
	} else {
		const left = await syncSharedIndex(repo, patches, context.signal);
		// Then what a hook changed on top of the selection, for paths that now hold the selection.
		const kept = new Set(left.map(entry => entry.path));
		const rewrites: PathPatch[] = [];
		for (const file of await repo.changedFiles({ base: selectedTree, head: sha })) {
			if (kept.has(file)) continue;
			const patch = await repo.diffText({ base: selectedTree, head: sha, files: [file], binary: true });
			rewrites.push({ path: file, patch });
		}
		if (rewrites.length > 0) left.push(...(await syncSharedIndex(repo, rewrites, context.signal)));
		indexNotes.push(...left.map(entry => entry.note));
	}
	const selected = patches.map(entry => entry.path);
	await context.journal?.recordCommit({
		agent: context.agent.agent,
		parent: context.agent.parent,
		sha,
		paths: selected,
	});
	// The commit exists and is recorded: the reads below describe it and are not cancelled.
	const details = await repo.commitDetails(sha);
	const subject = details.message.split("\n", 1)[0];
	if (!request.amend) return { sha, subject, paths: selected, parent: base, indexNotes };
	// An amended commit keeps the replaced commit's parents and carries its changes along with this selection.
	const parent = details.parents[0] ?? null;
	const paths =
		parent === null
			? (await repo.lsTree(sha, [])).map(entry => entry.path)
			: await repo.changedFiles({ base: parent, head: sha });
	return { sha, subject, paths, parent, amended: base ?? undefined, indexNotes };
}
