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
 * Usage:
 *   bun scripts/merge-pr.ts <branch>              # resolve PR from branch head
 *   bun scripts/merge-pr.ts <branch> --pr 6386    # explicit PR number
 *   bun scripts/merge-pr.ts <branch> --dry-run    # print message, don't merge
 *
 * Handy alias:
 *   git config alias.mpr '!bun scripts/merge-pr.ts'
 *   git mpr feature-branch
 */
import { $ } from "bun";

interface PrMeta {
	number: number;
	title: string;
	author: { login: string };
}

function fail(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
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

	const merge = await $`git merge --no-ff -m ${message} ${mergeRef}`.nothrow();
	process.exit(merge.exitCode);
}
