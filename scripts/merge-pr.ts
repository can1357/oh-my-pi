#!/usr/bin/env bun
/**
 * Merge a local PR branch with the repo's merge-commit schema:
 *
 *   Merge PR #<number>: <conventional PR subject> (@<author>)
 *
 * PR number and author are resolved via `gh`. The subject is taken from the
 * first (oldest) conventional-compliant commit in `HEAD..<branch>`; if none
 * exists the command fails rather than emit a noncompliant message.
 *
 * The merge is committed only after scripts/check-released-changelogs.ts finds
 * every released changelog section of HEAD unchanged in the index. A branch
 * that predates a release otherwise lands its `[Unreleased]` entries in the new
 * release section with no conflict; on failure the merge stays uncommitted for
 * the fix. Hooks that `git commit` runs can change what it records, so the
 * commit it makes is checked too, against the same base; a commit that fails is
 * undone (HEAD's branch moves back, as `git reset --soft` would), and the merge
 * is left uncommitted as before. It merges only into a work tree without local
 * changes to tracked files, which `merge.autostash` would put back after the
 * commit, mixed with the merge, and one run at a time per worktree: a second
 * run while one holds `$GIT_DIR/merge-pr.lock` stops before merging.
 *
 * Usage:
 *   bun scripts/merge-pr.ts <branch>              # resolve PR from branch head
 *   bun scripts/merge-pr.ts <branch> --pr 6386    # explicit PR number
 *   bun scripts/merge-pr.ts <branch> --dry-run    # print message, don't merge
 *
 * Handy alias:
 *   git config alias.mpr '!bun scripts/merge-pr.ts'
 *   git mpr feature-branch
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { isEexist } from "../packages/utils/src/fs-error.ts";
import {
	checkReleasedChangelogs,
	formatReleasedChangelogReport,
	UnreadableInputError,
} from "./check-released-changelogs";

interface PrMeta {
	number: number;
	title: string;
	author: { login: string };
}

function fail(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
}

/**
 * Holds this worktree's merge lock until the process exits, so two runs never
 * interleave: each undoes only the commit it made, and reads HEAD as it left it.
 * A lock left by a run that was killed stays; the error names it.
 */
async function holdMergeLock(): Promise<void> {
	const lock = path.resolve((await $`git rev-parse --git-path merge-pr.lock`.quiet().text()).trim());
	try {
		fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
	} catch (error) {
		if (!isEexist(error)) throw error;
		const holder = Number.parseInt(fs.readFileSync(lock, "utf8"), 10);
		let running = false;
		try {
			running = Number.isInteger(holder) && holder > 0 && process.kill(holder, 0);
		} catch {}
		fail(
			running
				? `another merge-pr.ts (pid ${holder}) is merging in this worktree; wait for it to finish`
				: `${lock} is left by a merge-pr.ts (pid ${holder || "unknown"}) that is no longer running; check \`git status\`, then remove it`,
		);
	}
	process.on("exit", () => fs.rmSync(lock, { force: true }));
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(1));
}

function parseArgs(argv: string[]) {
	let branch: string | undefined;
	let pr: number | undefined;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run" || arg === "-n") dryRun = true;
		else if (arg === "--pr") {
			const val = argv[++i];
			if (!val || !/^\d+$/.test(val)) fail("--pr requires a numeric PR number");
			pr = Number(val);
		} else if (arg === "--help" || arg === "-h") {
			console.log("usage: merge-pr.ts <branch> [--pr <number>] [--dry-run]");
			process.exit(0);
		} else if (arg.startsWith("-")) fail(`unknown flag: ${arg}`);
		else if (branch) fail(`unexpected argument: ${arg}`);
		else branch = arg;
	}
	if (!branch) fail("usage: merge-pr.ts <branch> [--pr <number>] [--dry-run]");
	return { branch, pr, dryRun };
}

/** Pull a PR number out of branch names like `pr/6386`, `pr-6386`, `6386-fix-foo`. */
function prNumberFromBranchName(branch: string): number | undefined {
	const m = branch.match(/(?:^|[/_-])pr[/_-]?(\d+)(?:$|[/_-])/i) ?? branch.match(/^(\d+)[/_-]/);
	return m ? Number(m[1]) : undefined;
}

async function ghPrView(selector: string): Promise<PrMeta | undefined> {
	const res = await $`gh pr view ${selector} --json number,title,author`.quiet().nothrow();
	if (res.exitCode !== 0) return undefined;
	try {
		return res.json() as PrMeta;
	} catch {
		return undefined;
	}
}

async function resolvePr(branch: string, explicit: number | undefined): Promise<PrMeta> {
	if (explicit !== undefined) {
		const meta = await ghPrView(String(explicit));
		if (!meta) fail(`gh could not find PR #${explicit}`);
		return meta;
	}
	// gh resolves a branch name when it is a PR head ref.
	const byBranch = await ghPrView(branch);
	if (byBranch) return byBranch;
	const inferred = prNumberFromBranchName(branch);
	if (inferred !== undefined) {
		const meta = await ghPrView(String(inferred));
		if (meta) return meta;
	}
	fail(`could not resolve a PR for branch '${branch}'; pass --pr <number>`);
}

const CONVENTIONAL_PREFIX = /^[a-z]+(\([^)]+\))?!?: (.+)$/;

/**
 * Full mechanically checkable AGENTS.md subject policy: conventional
 * `type(scope)!:` prefix, ≤72 chars total, description starting lowercase,
 * no trailing period. (Past tense is not machine-checkable.)
 */
export function isCompliantSubject(subject: string): boolean {
	const m = CONVENTIONAL_PREFIX.exec(subject);
	if (!m) return false;
	const desc = m[2];
	return subject.length <= 72 && !/^[A-Z]/.test(desc) && !desc.endsWith(".");
}

if (import.meta.main) {
	const { branch, pr, dryRun } = parseArgs(process.argv.slice(2));

	// Prefer the local ref; fall back to the remote-tracking ref when the branch
	// was never checked out locally.
	let mergeRef = branch;
	const refCheck = await $`git rev-parse --verify --quiet ${branch}`.quiet().nothrow();
	if (refCheck.exitCode !== 0) {
		const remoteCheck = await $`git rev-parse --verify --quiet origin/${branch}`.quiet().nothrow();
		if (remoteCheck.exitCode !== 0) fail(`'${branch}' is neither a local nor an origin/ ref`);
		mergeRef = `origin/${branch}`;
		console.warn(`note: '${branch}' is not local; merging '${mergeRef}'`);
	}

	const meta = await resolvePr(branch, pr);

	// Subject comes from the first (oldest) fully compliant commit being
	// merged; if none complies, refuse to merge.
	const log = await $`git log --reverse --format=%s HEAD..${mergeRef}`.quiet().nothrow();
	if (log.exitCode !== 0) fail(`git log HEAD..${mergeRef} failed`);
	const subjects = log
		.text()
		.split("\n")
		.map(s => s.trim())
		.filter(Boolean);
	if (subjects.length === 0) fail(`'${branch}' has no commits ahead of HEAD`);
	const subject = subjects.find(isCompliantSubject);
	if (!subject)
		fail(`no compliant commit subject in HEAD..${mergeRef}; the merge message cannot comply with the schema`);
	const message = `Merge PR #${meta.number}: ${subject} (@${meta.author.login})`;

	if (dryRun) {
		console.log(message);
		process.exit(0);
	}

	await holdMergeLock();
	// The commit is checked after `git commit` and undone if it fails; with local changes to tracked files,
	// `merge.autostash` would put them back after the commit, and the undo could not tell them from the merge.
	const local = await $`git status --porcelain --untracked-files=no`.quiet().nothrow();
	if (local.exitCode !== 0 || local.text().trim() !== "") {
		fail(
			"tracked files have local changes; commit or stash them first, so the merge this checks is the merge it commits",
		);
	}

	const merge = await $`git merge --no-ff --no-commit -m ${message} ${mergeRef}`.nothrow();
	if (merge.exitCode !== 0) {
		console.error(
			"note: after resolving, `git add` the files and run `bun scripts/check-released-changelogs.ts --base HEAD --index` before `git commit`.",
		);
		process.exit(merge.exitCode);
	}

	// HEAD is still the target branch tip, which owns every released section; the index is what the commit records.
	const target = (await $`git rev-parse HEAD`.quiet().text()).trim();
	const merged = (await $`git rev-parse MERGE_HEAD`.quiet().text()).trim();
	const check = async (head: { index: true } | { head: string }): Promise<string | undefined> => {
		try {
			const result = await checkReleasedChangelogs({ base: target, ...head });
			if (result.changes.length === 0) return undefined;
			const recheck = "index" in head ? ["--base", target, "--index"] : ["--base", target, "--head", head.head];
			return formatReleasedChangelogReport(result, recheck);
		} catch (error) {
			if (!(error instanceof UnreadableInputError)) throw error;
			return `error: ${error.message}`;
		}
	};
	let report = await check({ index: true });
	if (report === undefined) {
		const commit = await $`git commit --no-edit`.nothrow();
		if (commit.exitCode !== 0) {
			console.error(
				"\nThe merge is not committed. A hook may have staged changes: run `bun scripts/check-released-changelogs.ts --base HEAD --index` before `git commit --no-edit`.",
			);
			process.exit(commit.exitCode);
		}
		// Hooks may have staged more, or amended the commit: check what HEAD now records, if it is this merge.
		const committed = (await $`git rev-parse HEAD`.quiet().text()).trim();
		const parents = (await $`git rev-list --parents -n 1 ${committed}`.quiet().text()).trim().split(" ").slice(1);
		if (parents.length !== 2 || parents[0] !== target || parents[1] !== merged) {
			fail(
				`HEAD is now ${committed.slice(0, 12)}, not a merge of ${target.slice(0, 12)} and ${merged.slice(0, 12)}: something other than this merge moved it, so nothing is checked or undone. Check it with \`bun scripts/check-released-changelogs.ts --base ${target} --head HEAD\`.`,
			);
		}
		report = await check({ head: committed });
		if (report === undefined) process.exit(0);
		// Move only HEAD's branch back, as `git reset --soft` does, but whatever the index holds.
		const undo =
			await $`git update-ref -m ${"merge-pr: undo a merge that fails the released changelog check"} HEAD ${target} ${committed}`
				.quiet()
				.nothrow();
		if (undo.exitCode !== 0) {
			console.error(report);
			console.error(
				`\nThe commit ${committed} fails the check and could not be undone: ${undo.stderr.toString().trim()}\nUndo it with \`git reset --soft ${target}\`, then fix the changelogs as listed above.`,
			);
			process.exit(1);
		}
		await $`git update-ref MERGE_HEAD ${merged}`;
		await Bun.write((await $`git rev-parse --git-path MERGE_MSG`.quiet().text()).trim(), `${message}\n`);
		await Bun.write((await $`git rev-parse --git-path MERGE_MODE`.quiet().text()).trim(), "no-ff");
		report = `A hook that \`git commit\` ran changed what it recorded, and the commit ${committed.slice(0, 12)} fails the check; it is undone.\n\n${report}`;
	}
	console.error(report);
	console.error(
		"\nThe merge is not committed. Fix the changelogs as listed above, `git add` them, then `git commit --no-edit` keeps the merge message.",
	);
	process.exit(1);
}
