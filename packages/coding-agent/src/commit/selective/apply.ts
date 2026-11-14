/**
 * Commit a {@link Draft}'s selection in a workspace other agents keep editing.
 *
 * The commit is built in a private index file: HEAD's tree plus one patch per selected path
 * rendering the exact content the draft chose. `commitCreate` commits that index with an
 * expected-HEAD guard (hooks see it as `GIT_INDEX_FILE`, like `git commit --only`), so a
 * concurrent commit by someone else can never be overwritten. Afterwards the same patches are
 * applied to the shared index so the committed paths do not show up as staged reversals; every
 * other index entry and the worktree stay untouched.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { Draft, SelectedChange } from "./draft";
import type { ChangeJournal, JournalAgent } from "./journal";
import { formatTextPatch } from "./patch";

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
	/** Repo-relative paths the commit changed. */
	paths: string[];
	/** HEAD the commit was placed on (differs from the draft's HEAD when someone committed meanwhile); `null` for a root commit. */
	parent: string | null;
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

async function patchFor(repo: VcsGitRepo, head: string | null, change: SelectedChange): Promise<string> {
	if (change.kind === "text") return formatTextPatch(change.path, change.before, change.after);
	return change.added || head === null
		? repo.diffNoIndex("/dev/null", change.path, true)
		: repo.diffText({ base: head, files: [change.path], binary: true });
}

/**
 * Commit the draft's selection on top of the current HEAD.
 * @throws when nothing is selected; on `amend` when HEAD is not a selective commit of this
 * session; when HEAD moved onto changes that conflict with the selection; or when a hook fails.
 */
export async function commitSelection(
	draft: Draft,
	request: CommitRequest,
	context: { journal: ChangeJournal | null; agent: JournalAgent; signal?: AbortSignal },
): Promise<CommitOutcome> {
	const message = composeMessage(request);
	const changes = draft.selection();
	if (changes.length === 0) throw new Error("Nothing selected; use take() first.");
	const repo = vcs.requireGit(draft.root);
	const patches: Array<{ path: string; patch: string }> = [];
	for (const change of changes) {
		const patch = await patchFor(repo, draft.head, change);
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
		repo.info().gitDir,
		`omp-commit-${draft.id}-${Math.floor(Math.random() * 46656).toString(36)}.index`,
	);
	let sha: string | undefined;
	let parent = draft.head;
	try {
		for (let attempt = 1; sha === undefined; attempt++) {
			context.signal?.throwIfAborted();
			const head = (await repo.headSha(context.signal)) ?? null;
			if (ownCommits && (head === null || !ownCommits.has(head))) {
				throw new Error(`HEAD ${shortSha(head)} was not made by this session's commit flow; refusing to amend it.`);
			}
			// An unborn HEAD starts from an empty index: patches create the missing index file.
			if (head === null) await fs.rm(indexPath, { force: true });
			else await repo.readTree(head, indexPath, context.signal);
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
				parent = head;
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
	const seedIndex = parent === null && !(await Bun.file(path.join(repo.info().gitDir, "index")).exists());
	if (seedIndex) await repo.readTree(sha, undefined, context.signal);
	for (const entry of seedIndex ? [] : patches) {
		try {
			await repo.applyPatch(entry.patch, { cached: true }, context.signal);
		} catch {
			if (await repo.canApplyPatch(entry.patch, { cached: true, reverse: true }).catch(() => false)) continue;
			indexNotes.push(
				`${entry.path}: its shared-index entry holds someone else's staged changes and was left as is; ` +
					"`git diff --cached` there shows this commit reverted until they restage.",
			);
		}
	}
	const paths = patches.map(entry => entry.path);
	await context.journal?.recordCommit({ agent: context.agent.agent, parent: context.agent.parent, sha, paths });
	return { sha, subject: message.split("\n", 1)[0], paths, parent, indexNotes };
}
