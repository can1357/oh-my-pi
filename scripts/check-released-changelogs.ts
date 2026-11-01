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
 * `[Unreleased]`, must appear in the working tree with the same lines in the
 * same order, as many times as at the base. Both sides are first normalized
 * the way `bun run fix:changelogs` normalizes a section, and blank lines are
 * not compared, so nothing the repository's own fixer does to a released
 * section counts as a change.
 *
 *   bun scripts/check-released-changelogs.ts --base <commit> [--github-annotations]
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
 * - Sections the base does not have: only a release adds one. One does stop
 *   an archive from matching, below.
 * - The order of the sections, blank lines, `###` heading spacing, duplicate
 *   `###` headings and empty `###` headings: `bun run fix:changelogs` rewrites
 *   all of them inside released sections.
 * - An oldest section that is gone behind a new archive footer, when the
 *   working tree's released sections and footer are, byte for byte, what
 *   `bun run fix:changelogs` leaves. The check runs the fixer's own per-file
 *   pipeline (`fixChangelogFile`) on the base's released sections, verbatim,
 *   with the working tree's `[Unreleased]` sections and the base's footer,
 *   and compares. Two inputs of a real run come from the author's checkout
 *   and are not reproduced: items added to a released section since the
 *   release tag (none are assumed, as on a correct base), and the commit the
 *   footer names (read from the working tree's footer, not verified). A
 *   working tree that adds a released section the base lacks never matches.
 *   Whatever the fixer leaves, the base's newest release, first in the
 *   fixer's own version order, never counts as archived.
 * - A released section with no entries, gone: `bun run release` removes those.
 * - A package whose manifest and changelog are both gone. Deleting a changelog
 *   while its package manifest remains is a failure.
 *
 * There is no override. A change that repairs a released section which is
 * already wrong at the base fails here too; it has to reach the base branch
 * another way, as a direct push.
 */
import * as path from "node:path";
import { $ } from "bun";
import {
	fixChangelogFile,
	isSubsectionHeading,
	MAX_CHANGELOG_BYTES,
	normalizeSection,
	parseChangelog,
	parseReleaseSection,
	parseSubsectionTitle,
	type ReleaseBlock,
	renderChangelog,
	resolveRepoRoot,
	sortReleaseSections,
	splitArchiveFooter,
	splitReleaseBlocks,
} from "./fix-changelogs";

const UNRELEASED_TITLE = "Unreleased";
/** The repository command that moves lines added to a released section back under `[Unreleased]`. */
export const FIX_COMMAND = "bun run fix:changelogs";

export interface ChangedLine {
	/** The `###` subsection the line is under in the working tree; undefined above the first one. */
	subsection: string | undefined;
	text: string;
}

export interface ReleasedSectionChange {
	path: string;
	/** The section's heading line at the base, such as `## [18.14.1] - 2026-10-31`. */
	heading: string;
	/** 1-based line of the section's heading in the working tree; undefined when the section is missing. */
	headLine: number | undefined;
	baseCopies: number;
	headCopies: number;
	/** Lines the base section does not have at all: they belong under `[Unreleased]`. */
	added: ChangedLine[];
	/** Lines the base section has, here more times than at the base. */
	repeated: ChangedLine[];
	removed: string[];
	/** The changelog itself is absent while its package manifest remains. */
	missingChangelog?: boolean;
	/**
	 * Missing behind a new archive footer, and nothing else listed explains why
	 * the released sections are not what `bun run fix:changelogs` leaves.
	 */
	archiveMismatch?: boolean;
}

export interface ReleasedChangelogCheck {
	baseCommit: string;
	changelogs: number;
	sections: number;
	/** Base sections moved behind a new archive footer by the size limit. */
	archived: number;
	changes: ReleasedSectionChange[];
}

/** The base, or a changelog in it, could not be read; nothing was compared. */
export class UnreadableBaseError extends Error {}

interface ReleasedSection {
	heading: string;
	headLine: number;
	/** The heading, then the non-blank lines the fixer's normalization leaves. */
	lines: string[];
}

interface ReleasedChangelog {
	sections: Map<string, ReleasedSection[]>;
	archiveLink: string | undefined;
}

function parseReleased(content: string): ReleasedChangelog {
	const { body, archiveLink } = splitArchiveFooter(content);
	const sections = new Map<string, ReleasedSection[]>();
	for (const block of splitReleaseBlocks(body).blocks) {
		if (block.title === UNRELEASED_TITLE) continue;
		const parsed = parseReleaseSection(block.heading.text, block.bodyLines);
		normalizeSection(parsed);
		const lines = renderChangelog({ prefixLines: [], sections: [parsed] })
			.split("\n")
			.filter(line => line.trim() !== "");
		const section = { heading: block.heading.text, headLine: block.heading.lineNumber, lines };
		const copies = sections.get(block.title);
		if (copies) copies.push(section);
		else sections.set(block.title, [section]);
	}
	return { sections, archiveLink };
}

function blockText(block: ReleaseBlock): string[] {
	return [block.heading.text, ...block.bodyLines.map(line => line.text)];
}

/** The released blocks, in file order, and the archive footer. */
function releasedBlocks(content: string): { blocks: ReleaseBlock[]; archiveLink: string | undefined } {
	const { body, archiveLink } = splitArchiveFooter(content);
	return { blocks: splitReleaseBlocks(body).blocks.filter(block => block.title !== UNRELEASED_TITLE), archiveLink };
}

/** Each released section's text without trailing blank lines, then the footer. */
function releasedHistory(content: string): string[] {
	const { blocks, archiveLink } = releasedBlocks(content);
	const history = blocks.map(block => {
		const lines = blockText(block);
		while (lines.length > 1 && lines.at(-1)?.trim() === "") lines.pop();
		return lines.join("\n");
	});
	history.push(archiveLink ?? "");
	return history;
}

/**
 * The changelog as `bun run fix:changelogs` would find it before archiving:
 * the working tree's text above its first section and its `[Unreleased]`
 * sections, then every released section of the base, verbatim, then the base's
 * footer.
 */
function withBaseReleases(baseContent: string, headContent: string): string {
	const head = splitReleaseBlocks(splitArchiveFooter(headContent).body);
	const base = releasedBlocks(baseContent);
	const lines = head.prefixLines.map(line => line.text);
	for (const block of head.blocks) if (block.title === UNRELEASED_TITLE) lines.push(...blockText(block));
	for (const block of base.blocks) lines.push(...blockText(block));
	const body = `${lines.join("\n")}\n`;
	return base.archiveLink === undefined ? body : `${body}\n${base.archiveLink}\n`;
}

/**
 * Runs the fixer's per-file pipeline on `withBaseReleases`, archiving behind
 * `archiveCommit`. `matches` holds when the working tree's released sections
 * and footer equal the fixer's, byte for byte.
 */
async function fixerArchive(
	changelogPath: string,
	baseContent: string,
	headContent: string,
	archiveCommit: string,
): Promise<{ matches: boolean; collapsedReleases: number; archivedTitles: Set<string> }> {
	const fixed = await fixChangelogFile(changelogPath, withBaseReleases(baseContent, headContent), {
		promotableAddedItemStartLines: new Set<number>(),
		maxBytes: MAX_CHANGELOG_BYTES,
		archiveCommit: async () => archiveCommit,
	});
	const expected = releasedHistory(fixed.content);
	const actual = releasedHistory(headContent);
	const kept = new Set(releasedBlocks(fixed.content).blocks.map(block => block.title));
	return {
		matches: expected.length === actual.length && expected.every((text, index) => text === actual[index]),
		collapsedReleases: fixed.collapsedReleases,
		archivedTitles: new Set(
			releasedBlocks(baseContent)
				.blocks.map(block => block.title)
				.filter(title => !kept.has(title)),
		),
	};
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

	// Count each base line once; a working-tree line with no base count left is
	// either new to the section or a repeat of one it already has.
	const remaining = new Map<string, number>();
	for (const line of baseLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
	const added: ChangedLine[] = [];
	const repeated: ChangedLine[] = [];
	for (const section of head) {
		let subsection: string | undefined;
		for (const line of section.lines) {
			if (isSubsectionHeading(line)) subsection = parseSubsectionTitle(line);
			const count = remaining.get(line);
			if (count === undefined) added.push({ subsection, text: line });
			else if (count > 0) remaining.set(line, count - 1);
			else repeated.push({ subsection, text: line });
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
		headLine: head[0]?.headLine,
		baseCopies: base.length,
		headCopies: head.length,
		added,
		repeated,
		removed,
	};
}

/** Compares one changelog's released sections at the base with the same file in the working tree. */
export async function findReleasedSectionChanges(
	changelogPath: string,
	baseContent: string,
	headContent: string,
): Promise<{ sections: number; archived: number; changes: ReleasedSectionChange[] }> {
	const base = parseReleased(baseContent);
	const head = parseReleased(headContent);
	const titles = [...base.sections.keys()];
	// Gone with entries. A release removes versions with no entries; losing one loses nothing.
	const missing = new Set(
		titles.filter(
			title =>
				!head.sections.has(title) && (base.sections.get(title) ?? []).some(section => section.lines.length > 1),
		),
	);

	// A released section with entries may go only behind a new archive footer
	// that the fixer itself writes: run the fixer and compare what it leaves.
	// The fixer promises to keep the newest release; hold it to that here, so a
	// fault in its collapse cannot certify losing that release.
	const sorted = parseChangelog(splitArchiveFooter(baseContent).body);
	sortReleaseSections(sorted);
	const newest = sorted.sections.find(section => section.title !== UNRELEASED_TITLE)?.title;
	let archivedByFixer = new Set<string>();
	const archiveCommit =
		head.archiveLink === base.archiveLink ? undefined : head.archiveLink?.match(/\/blob\/([0-9a-f]{40})\//)?.[1];
	if (missing.size > 0 && archiveCommit !== undefined && (newest === undefined || !missing.has(newest))) {
		const archive = await fixerArchive(changelogPath, baseContent, headContent, archiveCommit);
		if (archive.matches) return { sections: titles.length, archived: archive.collapsedReleases, changes: [] };
		archivedByFixer = archive.archivedTitles;
	}

	const changes: ReleasedSectionChange[] = [];
	for (const title of titles) {
		if (!head.sections.has(title) && (!missing.has(title) || archivedByFixer.has(title))) continue;
		const change = compareSection(changelogPath, base.sections.get(title) ?? [], head.sections.get(title) ?? []);
		if (change) changes.push(change);
	}
	// Nothing listed explains why this is not the fixer's output, so the
	// sections it would archive are the difference.
	if (changes.length === 0) {
		for (const title of missing) {
			const change = compareSection(changelogPath, base.sections.get(title) ?? [], []);
			if (change) changes.push({ ...change, archiveMismatch: true });
		}
	}
	return { sections: titles.length, archived: 0, changes };
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

	const listed = await git(["ls-tree", "-r", "-z", "--name-only", baseCommit, "--", "packages"], repoRoot);
	if (!listed.ok) throw new UnreadableBaseError(`cannot list the changelogs at ${baseCommit}: ${listed.stderr}`);
	const basePaths = listed.stdout.split("\0").filter(pathName => /^packages\/[^/]+\/CHANGELOG\.md$/.test(pathName));
	if (basePaths.length === 0) {
		throw new UnreadableBaseError(`no packages/*/CHANGELOG.md exists at ${baseCommit}; nothing to compare.`);
	}

	let changelogs = 0;
	let sections = 0;
	let archived = 0;
	const changes: ReleasedSectionChange[] = [];
	for (const changelogPath of basePaths) {
		const absolutePath = path.join(repoRoot, changelogPath);
		if (!(await Bun.file(absolutePath).exists())) {
			const packageManifest = path.join(path.dirname(absolutePath), "package.json");
			if (await Bun.file(packageManifest).exists()) {
				changes.push({
					path: changelogPath,
					heading: "CHANGELOG.md is missing",
					headLine: undefined,
					baseCopies: 1,
					headCopies: 0,
					added: [],
					repeated: [],
					removed: [],
					missingChangelog: true,
				});
			}
			continue;
		}

		const base = await git(["cat-file", "blob", `${baseCommit}:${changelogPath}`], repoRoot);
		if (!base.ok) throw new UnreadableBaseError(`cannot read ${changelogPath} at ${baseCommit}: ${base.stderr}`);
		const head = await Bun.file(absolutePath).text();
		const result = await findReleasedSectionChanges(changelogPath, base.stdout, head);
		changelogs++;
		sections += result.sections;
		archived += result.archived;
		changes.push(...result.changes);
	}
	return { baseCommit, changelogs, sections, archived, changes };
}

/**
 * Renders a check result. `recheckBase` is the `--base` argument a reader
 * should pass to run the check again in their own checkout.
 */
export function formatReleasedChangelogReport(check: ReleasedChangelogCheck, recheckBase: string): string {
	const base = check.baseCommit.slice(0, 12);
	if (check.changes.length === 0) {
		const archived = check.archived > 0 ? `; ${check.archived} oldest archived behind a new size-limit footer` : "";
		return `Released changelog sections match ${base}: ${check.sections} sections in ${check.changelogs} changelogs${archived}.`;
	}

	const out = [`A released changelog section differs from the base (${base}).`, ""];
	for (const change of check.changes) {
		out.push(`${change.path}: ${change.heading}`);
		if (change.missingChangelog) {
			out.push("  The package manifest remains, so this is not a package removal. Restore the changelog.", "");
			continue;
		}
		if (change.archiveMismatch) {
			out.push(
				"  Missing here, and the new archive footer does not account for it: the released sections here are not",
				`  exactly what \`${FIX_COMMAND}\` leaves of the base's. Put the base's released sections back from`,
				`  \`git show ${base}:${change.path}\`, then run \`${FIX_COMMAND}\`.`,
				"",
			);
			continue;
		}
		if (change.headCopies === 0) {
			out.push(`  Missing here. Restore it from \`git show ${base}:${change.path}\`.`, "");
			continue;
		}
		if (change.headCopies !== change.baseCopies) {
			out.push(`  This heading appears ${change.headCopies} times here and ${change.baseCopies} at the base.`);
		}
		// One group per destination subsection, then repeats, then removals.
		const groups = new Map<string, string[]>();
		const addTo = (label: string, text: string) => {
			const lines = groups.get(label);
			if (lines) lines.push(text);
			else groups.set(label, [text]);
		};
		for (const line of change.added) {
			addTo(
				line.subsection === undefined
					? "  Added; it belongs under `## [Unreleased]`:"
					: `  Added under \`### ${line.subsection}\`; it belongs under \`## [Unreleased]\`, \`### ${line.subsection}\`:`,
				line.text,
			);
		}
		for (const line of change.repeated)
			addTo("  Repeated; the base has these fewer times, delete the extra:", line.text);
		for (const text of change.removed) addTo("  Removed; put back:", text);
		for (const [label, lines] of groups) out.push(label, ...lines.map(text => `    ${text}`));
		if (groups.size === 0) out.push("  Same lines in a different order; restore the base's order.");
		out.push("");
	}

	const moved = check.changes.some(change => change.added.length > 0);
	const handFixed = check.changes.some(
		change => change.added.length === 0 || change.repeated.length > 0 || change.removed.length > 0,
	);
	if (moved) {
		out.push(
			`Run \`${FIX_COMMAND}\`: it moves each line added to a released section since the last release tag`,
			"back under `## [Unreleased]`. This usually happens when the base branch released a version after",
			"this branch started: git merges the branch's `## [Unreleased]` entries into the new release section",
			"and reports no conflict.",
			"",
		);
	}
	if (handFixed) {
		out.push(
			moved
				? `Released sections never change. Fix what \`${FIX_COMMAND}\` leaves by hand: put back removed lines,`
				: "Released sections never change. Make each section above match the base by hand: put back removed lines,",
			"undo edits, delete repeats, restore the order.",
			"",
		);
	}
	out.push(`Check again: bun scripts/check-released-changelogs.ts --base ${recheckBase}`);
	return out.join("\n");
}

/** Escapes a GitHub workflow-command message. */
function escapeAnnotationData(text: string): string {
	return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** Escapes a GitHub workflow-command property value. */
function escapeAnnotationProperty(text: string): string {
	return escapeAnnotationData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/** One `::error` workflow command per changed section, so GitHub marks the file in the pull request. */
export function formatGithubAnnotations(check: ReleasedChangelogCheck): string[] {
	return check.changes.map(change => {
		const properties = [`file=${escapeAnnotationProperty(change.path)}`];
		if (change.headLine !== undefined) properties.push(`line=${change.headLine}`);
		properties.push(`title=${escapeAnnotationProperty("Released changelog section changed")}`);
		const counts = [
			change.missingChangelog ? "changelog missing while package remains" : undefined,
			!change.missingChangelog && change.headCopies === 0 ? "missing" : undefined,
			change.added.length > 0 ? `${change.added.length} line(s) added` : undefined,
			change.repeated.length > 0 ? `${change.repeated.length} repeated` : undefined,
			change.removed.length > 0 ? `${change.removed.length} removed` : undefined,
		].filter(Boolean);
		const remedy = change.missingChangelog
			? "Restore the changelog; its package manifest is still present."
			: change.archiveMismatch
				? `Put the base's released sections back, then run \`${FIX_COMMAND}\`.`
				: change.added.length > 0
					? `Run \`${FIX_COMMAND}\` to move added lines back under ## [Unreleased].`
					: "Make it match the base; the job log lists the lines.";
		const what = counts.length > 0 ? counts.join(", ") : "lines reordered";
		return `::error ${properties.join(",")}::${escapeAnnotationData(`${change.heading}: ${what}. ${remedy}`)}`;
	});
}

function usage(): string {
	return [
		"Usage: bun scripts/check-released-changelogs.ts --base <commit> [--repo-root <dir>] [--github-annotations]",
		"",
		"Fails when a released section of a packages/*/CHANGELOG.md in the working tree differs",
		"from the same section at <commit>, the tip of the branch the changes merge into.",
		"--github-annotations also prints GitHub workflow commands that mark each failing file.",
		"",
		"Exit 0: unchanged. Exit 1: a released section changed. Exit 2: the base could not be read.",
	].join("\n");
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	let base: string | undefined;
	let repoRoot: string | undefined;
	let annotate = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "-h" || arg === "--help") {
			console.log(usage());
			return 0;
		}
		if (arg === "--github-annotations") {
			annotate = true;
			continue;
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
		if (check.changes.length === 0) {
			console.log(report);
			return 0;
		}
		if (annotate) for (const line of formatGithubAnnotations(check)) console.log(line);
		console.error(report);
		return 1;
	} catch (error) {
		if (!(error instanceof UnreadableBaseError)) throw error;
		if (annotate) {
			console.log(`::error title=Released changelog check could not run::${escapeAnnotationData(error.message)}`);
		}
		console.error(`error: ${error.message}`);
		return 2;
	}
}

if (import.meta.main) {
	process.exit(await main());
}
