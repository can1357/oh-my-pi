/**
 * Commit a {@link Draft}'s selection in a workspace other agents keep editing.
 *
 * The commit is built in a private index file: HEAD's tree plus one patch per selected path
 * rendering the exact content the draft chose. `commitReconciled` prepares the shared index
 * under its lock before moving HEAD, then installs it only if the guarded HEAD update succeeds.
 * Hooks see the private index; its staged rewrites are included in the reconciliation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsCommitOptions, VcsGitRepo, VcsReconciledCommit } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { shortenPath } from "../../utils/render-utils";
import type { Draft, SelectedChange } from "./draft";
import type { ChangeJournal, JournalAgent } from "./journal";
import { formatTextPatch } from "./patch";

/** One selected path's patch, also used to diagnose a conflicting HEAD move. */
interface PathPatch {
	path: string;
	patch: string;
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
	/** Staged content kept in the shared index, or warnings publishing the index. */
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
 * that conflict with the selection; when a hook fails; or when the shared index cannot be prepared.
 */
export async function commitSelection(
	draft: Draft,
	request: CommitRequest,
	context: {
		journal: ChangeJournal | null;
		agent: JournalAgent;
		signal?: AbortSignal;
		/** Starts the commit hooks in place of the native spawn (the OS sandbox's contained spawn). */
		hookRunner?: VcsCommitOptions["hookRunner"];
	},
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
	let committed: VcsReconciledCommit | undefined;
	/** HEAD the commit was built on; on amend, the commit it replaced. */
	let base = draft.head;
	try {
		for (let attempt = 1; committed === undefined; attempt++) {
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
			try {
				committed = await repo.commitReconciled(
					message,
					{
						indexPath,
						expectedHead: head ?? undefined,
						amend: request.amend ?? false,
						noVerify: request.noVerify ?? false,
						hookRunner: context.hookRunner,
					},
					joined,
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
	const { sha, indexNotes } = committed;

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
