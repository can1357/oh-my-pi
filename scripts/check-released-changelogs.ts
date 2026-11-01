#!/usr/bin/env bun
/**
 * Fails when a merge changed a released changelog section.
 *
 * Released sections are immutable (AGENTS.md, "Changelog"), but a merge can
 * change one and report no conflict: when the base branch released a version
 * after a branch started, git puts the branch's `## [Unreleased]` entries under
 * the new `## [x.y.z]` heading. Merge PR #17499 put an entry into `[18.14.1]`
 * this way.
 *
 * Every section of each `packages/*\/CHANGELOG.md` at `--base`, other than
 * `[Unreleased]`, must appear in the working tree with the same non-blank
 * lines in the same order, as many times as at the base.
 *
 *   bun scripts/check-released-changelogs.ts --base <commit>
 *
 * `--base` is the tip of the branch the changes merge into: `origin/main`
 * after merging main into a branch, `HEAD` during an uncommitted merge
 * (scripts/merge-pr.ts), or a pull request merge commit's first parent (CI).
 * Releases happen on that branch, so its released sections are the reference.
 *
 * Exit 0: every released section of the base is unchanged.
 * Exit 1: a released section changed; the report names the file, the section,
 *         the lines and the fix.
 * Exit 2: the base or one of its changelogs could not be read, for example in
 *         a shallow clone without the base commit. Nothing was compared.
 *
 * Not checked, on purpose:
 * - `[Unreleased]`: placement inside it is normalized by `bun run release`.
 * - Sections the base does not have: only a release adds one.
 * - Blank lines, and the order of the sections: `bun scripts/fix-changelogs.ts`
 *   rewrites both inside released sections (it trims each subsection and drops
 *   blank separators between adjacent bullets), so a contributor who runs it
 *   would otherwise fail this check on whitespace alone.
 * - A changelog that exists on one side only: a package was added or removed.
 */
import * as path from "node:path";
import { $ } from "bun";
import {
	changelogPaths,
	isSubsectionHeading,
	parseSubsectionTitle,
	resolveRepoRoot,
	splitArchiveFooter,
	splitReleaseBlocks,
} from "./fix-changelogs";

const UNRELEASED_TITLE = "Unreleased";

export interface AddedLine {
	/** The `###` subsection the line is under in the working tree; undefined above the first one. */
	subsection: string | undefined;
	text: string;
}

export interface ReleasedSectionChange {
	path: string;
	/** The section's heading line at the base, such as `## [18.14.1] - 2026-10-31`. */
	heading: string;
	baseCopies: number;
	headCopies: number;
	baseLineCount: number;
	added: AddedLine[];
	removed: string[];
}

export interface ReleasedChangelogCheck {
	baseCommit: string;
	changelogs: number;
	sections: number;
	changes: ReleasedSectionChange[];
}

/** The base, or a changelog in it, could not be read; nothing was compared. */
export class UnreadableBaseError extends Error {}

interface ReleasedSection {
	heading: string;
	lines: string[];
}

/** Each released section's heading plus its non-blank lines, by section title. */
function releasedSections(content: string): Map<string, ReleasedSection[]> {
	const sections = new Map<string, ReleasedSection[]>();
	for (const block of splitReleaseBlocks(splitArchiveFooter(content).body).blocks) {
		if (block.title === UNRELEASED_TITLE) continue;
		const section = {
			heading: block.heading.text,
			lines: [block.heading.text, ...block.bodyLines.map(line => line.text).filter(line => line.trim() !== "")],
		};
		const copies = sections.get(block.title);
		if (copies) copies.push(section);
		else sections.set(block.title, [section]);
	}
	return sections;
}

function compareSection(
	changelogPath: string,
	base: readonly ReleasedSection[],
	head: readonly ReleasedSection[],
): ReleasedSectionChange | undefined {
	const baseLines = base.flatMap(section => section.lines);
	const headLines = head.flatMap(section => section.lines);
	if (
		base.length === head.length &&
		baseLines.length === headLines.length &&
		baseLines.every((line, index) => line === headLines[index])
	) {
		return undefined;
	}

	// Count each base line once; a working-tree line with no base count left is added.
	const remaining = new Map<string, number>();
	for (const line of baseLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
	const added: AddedLine[] = [];
	for (const section of head) {
		let subsection: string | undefined;
		for (const line of section.lines) {
			if (isSubsectionHeading(line)) subsection = parseSubsectionTitle(line);
			const count = remaining.get(line) ?? 0;
			if (count > 0) remaining.set(line, count - 1);
			else added.push({ subsection, text: line });
		}
	}
	const removed: string[] = [];
	for (const line of baseLines) {
		const count = remaining.get(line) ?? 0;
		if (count === 0) continue;
		removed.push(line);
		remaining.set(line, count - 1);
	}

	return {
		path: changelogPath,
		heading: base[0]?.heading ?? "",
		baseCopies: base.length,
		headCopies: head.length,
		baseLineCount: baseLines.length,
		added,
		removed,
	};
}

/** Compares one changelog's released sections at the base with the same file in the working tree. */
export function findReleasedSectionChanges(
	changelogPath: string,
	baseContent: string,
	headContent: string,
): { sections: number; changes: ReleasedSectionChange[] } {
	const baseSections = releasedSections(baseContent);
	const headSections = releasedSections(headContent);
	const changes: ReleasedSectionChange[] = [];
	for (const [title, copies] of baseSections) {
		const change = compareSection(changelogPath, copies, headSections.get(title) ?? []);
		if (change) changes.push(change);
	}
	return { sections: baseSections.size, changes };
}

async function git(args: readonly string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
	return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString().trim() };
}

export async function checkReleasedChangelogs(options: {
	base: string;
	repoRoot?: string;
}): Promise<ReleasedChangelogCheck> {
	const repoRoot = await resolveRepoRoot(options.repoRoot);
	const resolved = await git(
		["rev-parse", "--verify", "--quiet", "--end-of-options", `${options.base}^{commit}`],
		repoRoot,
	);
	if (!resolved.ok) {
		throw new UnreadableBaseError(
			`cannot resolve --base ${options.base} to a commit. A shallow clone may not have it: fetch it first ` +
				"(in GitHub Actions, `actions/checkout` with `fetch-depth: 2` gives a pull request's merge commit its first parent).",
		);
	}
	const baseCommit = resolved.stdout.trim();

	const workingTreePaths = await changelogPaths(repoRoot);
	const listed =
		workingTreePaths.length === 0
			? { ok: true, stdout: "", stderr: "" }
			: await git(["ls-tree", "-z", "--name-only", baseCommit, "--", ...workingTreePaths], repoRoot);
	if (!listed.ok) throw new UnreadableBaseError(`cannot list the changelogs at ${baseCommit}: ${listed.stderr}`);
	const sharedPaths = listed.stdout.split("\0").filter(Boolean);
	if (sharedPaths.length === 0) {
		throw new UnreadableBaseError(
			`no packages/*/CHANGELOG.md exists both at ${baseCommit} and in ${repoRoot}; nothing to compare.`,
		);
	}

	let sections = 0;
	const changes: ReleasedSectionChange[] = [];
	for (const changelogPath of sharedPaths) {
		const base = await git(["cat-file", "blob", `${baseCommit}:${changelogPath}`], repoRoot);
		if (!base.ok) throw new UnreadableBaseError(`cannot read ${changelogPath} at ${baseCommit}: ${base.stderr}`);
		const head = await Bun.file(path.join(repoRoot, changelogPath)).text();
		const result = findReleasedSectionChanges(changelogPath, base.stdout, head);
		sections += result.sections;
		changes.push(...result.changes);
	}
	return { baseCommit, changelogs: sharedPaths.length, sections, changes };
}

/**
 * Renders a check result. `recheckBase` is the `--base` argument a reader
 * should pass to run the check again in their own checkout.
 */
export function formatReleasedChangelogReport(check: ReleasedChangelogCheck, recheckBase: string): string {
	const base = check.baseCommit.slice(0, 12);
	if (check.changes.length === 0) {
		return `Released changelog sections match ${base}: ${check.sections} sections in ${check.changelogs} changelogs.`;
	}

	const out = [`A released changelog section differs from the base (${base}).`, ""];
	for (const change of check.changes) {
		out.push(`${change.path}: ${change.heading}`);
		if (change.headCopies === 0) {
			out.push(
				`  Missing here. The base has this section (${change.baseLineCount} lines); restore it from \`git show ${base}:${change.path}\`.`,
			);
			out.push("");
			continue;
		}
		if (change.headCopies !== change.baseCopies) {
			out.push(
				`  This heading appears ${change.headCopies} times here and ${change.baseCopies} at the base; keep only the base's copy.`,
			);
		}
		// One group per destination subsection, then the removed lines.
		const groups = new Map<string, string[]>();
		for (const line of change.added) {
			const label =
				line.subsection === undefined
					? "  Added; move under `## [Unreleased]`:"
					: `  Added under \`### ${line.subsection}\`; move under \`## [Unreleased]\`, \`### ${line.subsection}\`:`;
			const lines = groups.get(label);
			if (lines) lines.push(line.text);
			else groups.set(label, [line.text]);
		}
		if (change.removed.length > 0) groups.set("  Removed; put back:", change.removed);
		for (const [label, lines] of groups) {
			out.push(label, ...lines.map(text => `    ${text}`));
		}
		if (groups.size === 0 && change.headCopies === change.baseCopies) {
			out.push("  Same lines in a different order; restore the base's order.");
		}
		out.push("");
	}
	out.push(
		"Released sections never change. Make each section above match the base exactly: move each added",
		"line under `## [Unreleased]`, in the subsection named above, and put back each removed line.",
		"",
		"This usually means the base branch released a version after this branch started. Git then merges",
		"the branch's `## [Unreleased]` entries into the new release section and reports no conflict.",
		"",
		`Check again: bun scripts/check-released-changelogs.ts --base ${recheckBase}`,
	);
	return out.join("\n");
}

function usage(): string {
	return [
		"Usage: bun scripts/check-released-changelogs.ts --base <commit> [--repo-root <dir>]",
		"",
		"Fails when a released section of a packages/*/CHANGELOG.md in the working tree differs",
		"from the same section at <commit>, the tip of the branch the changes merge into.",
		"",
		"Exit 0: unchanged. Exit 1: a released section changed. Exit 2: the base could not be read.",
	].join("\n");
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	let base: string | undefined;
	let repoRoot: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "-h" || arg === "--help") {
			console.log(usage());
			return 0;
		}
		const value = args[index + 1];
		if ((arg === "--base" || arg === "--repo-root") && value) {
			if (arg === "--base") base = value;
			else repoRoot = value;
			index++;
			continue;
		}
		console.error(`error: unexpected argument ${arg}\n\n${usage()}`);
		return 2;
	}
	if (!base) {
		console.error(`error: --base is required\n\n${usage()}`);
		return 2;
	}

	try {
		const check = await checkReleasedChangelogs({ base, repoRoot });
		const report = formatReleasedChangelogReport(check, "<base branch, such as origin/main>");
		if (check.changes.length > 0) {
			console.error(report);
			return 1;
		}
		console.log(report);
		return 0;
	} catch (error) {
		if (!(error instanceof UnreadableBaseError)) throw error;
		console.error(`error: ${error.message}`);
		return 2;
	}
}

if (import.meta.main) {
	process.exit(await main());
}
