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
 * section counts as a change. The working tree may not add a released section
 * either, and its archive footer must stay the base's. A changelog git pairs as
 * renamed is compared at its new path; a changelog the base does not have may
 * hold no released section. A changelog must be a regular file, reached
 * without a symbolic link or a submodule, at the base and in the working tree;
 * the check cannot see into a submodule the base already has.
 *
 *   bun scripts/check-released-changelogs.ts --base <commit> [--release] [--github-annotations]
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
 * - The order of the sections, blank lines, `###` heading spacing, duplicate
 *   `###` headings and empty `###` headings: `bun run fix:changelogs` rewrites
 *   all of them inside released sections.
 * - A released section with no entries, gone: `bun run release` removes those.
 * - A package removed: its changelog gone with every other file of the
 *   package. None, tracked at the base or added since, may be left in its
 *   directory, and none may have moved (as git pairs renames) to a directory
 *   where the base has no package: that is a rename, and the changelog goes
 *   with it. A package merged into another one counts as removed. The report
 *   names each removed package. A package renamed with every file rewritten,
 *   so that git pairs none of them, reads as one removed and another added.
 * - With `--release` only, released sections the base does not have: that is
 *   how a release commit differs from the commit before it. A merge never adds
 *   one, so CI and scripts/merge-pr.ts do not pass `--release`.
 * - An oldest section gone behind a new archive footer, when three things
 *   hold. The working tree's released sections and footer are, byte for byte,
 *   what the fixer's own per-file pipeline (`fixChangelogFile`) leaves of the
 *   base's released sections, verbatim, with the working tree's `[Unreleased]`
 *   sections and the base's footer. The base's newest release is not among
 *   them. And the commit the new footer names holds every archived section
 *   and the base's footer; a shallow clone fetches that commit from `origin`.
 *   One input of a real run is not reproduced: items added to a released
 *   section since the release tag. None are assumed, as on a correct base.
 *
 * There is no override. A change that repairs a released section which is
 * already wrong at the base fails here too; it has to reach the base branch
 * another way, as a direct push.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { isEnoent, isEnotdir } from "../packages/utils/src/fs-error.ts";
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
const CHANGELOG_PATH = /^packages\/[^/]+\/CHANGELOG\.md$/;
const PACKAGE_DIR = /^packages\/[^/]+$/;
/** `packages/<name>` at the start of a path under it. */
const PACKAGE_PREFIX = /^packages\/[^/]+(?=\/)/;
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";
/** The repository command that moves lines added to a released section back under `[Unreleased]`. */
export const FIX_COMMAND = "bun run fix:changelogs";

export interface ChangedLine {
	/** The `###` subsection the line is under in the working tree; undefined above the first one. */
	subsection: string | undefined;
	text: string;
}

/** Why a change is reported, when its lines alone do not say. */
export type ChangeProblem =
	/** The changelog is absent while files of its package remain, or moved to a directory where the base has no package. */
	| "missing-changelog"
	/** The changelog is a symbolic link, another non-regular file, or under a linked directory or a submodule, at the base or here. */
	| "not-regular"
	/** A released section the base does not have. */
	| "not-at-base"
	/** Missing behind a new footer, and nothing else listed explains why this is not the fixer's output. */
	| "archive-mismatch"
	/** Missing behind a new footer whose commit cannot be read or does not hold the section. */
	| "archive-unverified"
	/** The archive footer differs from the base's, and no archive the check certifies explains it. */
	| "archive-footer";

export interface ReleasedSectionChange {
	/** The changelog here. */
	path: string;
	/** The changelog at the base, when git pairs `path` with it as renamed. */
	basePath?: string;
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
	problem?: ChangeProblem;
	/** Lines the report prints for the problem, such as the two footers. */
	detail?: string[];
}

export interface ReleasedChangelogCheck {
	baseCommit: string;
	changelogs: number;
	sections: number;
	/** Base sections moved behind a new archive footer by the size limit. */
	archived: number;
	/** Base changelogs gone with their whole package. */
	removed: string[];
	changes: ReleasedSectionChange[];
}

export interface FindReleasedSectionChangesOptions {
	/** Accept released sections the base does not have: the base is the commit before a release. */
	release: boolean;
	/** This changelog's text at `commit`, or undefined when it cannot be read. */
	readArchive: (commit: string) => Promise<string | undefined>;
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
	options: FindReleasedSectionChangesOptions,
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
	const footerChanged = head.archiveLink !== base.archiveLink;

	// A released section with entries may go only behind a new archive footer
	// that the fixer itself writes, naming a commit that still holds it: run the
	// fixer, compare what it leaves, then read that commit. The fixer promises to
	// keep the newest release; hold it to that here, so a fault in its collapse
	// cannot certify losing that release.
	const sorted = parseChangelog(splitArchiveFooter(baseContent).body);
	sortReleaseSections(sorted);
	const newest = sorted.sections.find(section => section.title !== UNRELEASED_TITLE)?.title;
	const archiveCommit = footerChanged ? head.archiveLink?.match(/\/blob\/([0-9a-f]{40})\//)?.[1] : undefined;
	let explained = new Set<string>();
	let unverified = false;
	if (missing.size > 0 && archiveCommit !== undefined && (newest === undefined || !missing.has(newest))) {
		const archive = await fixerArchive(changelogPath, baseContent, headContent, archiveCommit);
		explained = archive.archivedTitles;
		if (archive.matches) {
			const linked = await options.readArchive(archiveCommit);
			const held = linked === undefined ? undefined : parseReleased(linked);
			const holds =
				held !== undefined &&
				held.archiveLink === base.archiveLink &&
				[...archive.archivedTitles].every(
					title =>
						compareSection(changelogPath, base.sections.get(title) ?? [], held.sections.get(title) ?? []) ===
						undefined,
				);
			if (holds) return { sections: titles.length, archived: archive.collapsedReleases, changes: [] };
			unverified = true;
		}
	}

	const changes: ReleasedSectionChange[] = [];
	for (const title of titles) {
		if (!head.sections.has(title) && (!missing.has(title) || explained.has(title))) continue;
		const change = compareSection(changelogPath, base.sections.get(title) ?? [], head.sections.get(title) ?? []);
		if (change) changes.push(change);
	}
	if (!options.release) {
		for (const [title, copies] of head.sections) {
			if (base.sections.has(title)) continue;
			changes.push({
				path: changelogPath,
				heading: copies[0]?.heading ?? title,
				headLine: copies[0]?.headLine,
				baseCopies: 0,
				headCopies: copies.length,
				added: [],
				repeated: [],
				removed: [],
				problem: "not-at-base",
			});
		}
	}
	// The fixer would archive these, but the archive is not certified: either
	// its commit does not hold them, or nothing above explains why the released
	// sections are not the fixer's output.
	if (unverified || changes.length === 0) {
		for (const title of missing) {
			if (!explained.has(title)) continue;
			const change = compareSection(changelogPath, base.sections.get(title) ?? [], []);
			if (change) changes.push({ ...change, problem: unverified ? "archive-unverified" : "archive-mismatch" });
		}
	}
	if (footerChanged && changes.length === 0) {
		changes.push({
			path: changelogPath,
			heading: "Archive footer",
			headLine: undefined,
			baseCopies: 1,
			headCopies: 1,
			added: [],
			repeated: [],
			removed: [],
			problem: "archive-footer",
			detail: [`Base: ${base.archiveLink ?? "(none)"}`, `Here: ${head.archiveLink ?? "(none)"}`],
		});
	}
	return { sections: titles.length, archived: 0, changes };
}

async function git(
	args: readonly string[],
	cwd: string,
	stdin?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const command = stdin === undefined ? $`git ${args}` : $`git ${args} < ${new Response(stdin)}`;
	const result = await command
		.cwd(cwd)
		.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
		.quiet()
		.nothrow();
	return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString().trim() };
}

/** The file's type in the working tree, or undefined when it does not exist. */
async function lstatOrUndefined(filePath: string): Promise<fs.Stats | undefined> {
	try {
		return await fs.promises.lstat(filePath);
	} catch (error) {
		// ENOTDIR: a directory on the path is now a file, so nothing is under it.
		if (isEnoent(error) || isEnotdir(error)) return undefined;
		throw error;
	}
}

/** Files git pairs as renamed between the base and the working tree, anywhere in the repository, old path to new. */
async function renamesSince(baseCommit: string, repoRoot: string): Promise<Map<string, string>> {
	const diff = await git(["diff", "--no-color", "-M", "--name-status", "-z", "--diff-filter=R", baseCommit], repoRoot);
	if (!diff.ok) throw new UnreadableBaseError(`cannot list the files renamed since ${baseCommit}: ${diff.stderr}`);
	// `R<score>\0<old path>\0<new path>\0` per rename.
	const fields = diff.stdout.split("\0");
	const renames = new Map<string, string>();
	for (let index = 0; index + 2 < fields.length; index += 3) renames.set(fields[index + 1], fields[index + 2]);
	return renames;
}

interface TreeEntry {
	mode: string;
	path: string;
}

/** The entries `git ls-tree -r -z` or `git ls-files --stage -z` prints: `<mode> <...>\t<path>`. */
function parseEntries(stdout: string): TreeEntry[] {
	return stdout
		.split("\0")
		.filter(entry => entry.length > 0)
		.map(entry => ({ mode: entry.slice(0, entry.indexOf(" ")), path: entry.slice(entry.indexOf("\t") + 1) }));
}

/**
 * A file showing that the package of a changelog gone from the working tree
 * was not removed, or undefined when it was: a file of the package, tracked at
 * the base or added since, still in its directory, or one git pairs as moved
 * to a directory where the base has no package. Moving into another package
 * of the base merges the two; that removes this one.
 */
async function remainingPackageFile(
	packageDir: string,
	context: {
		repoRoot: string;
		tracked: readonly TreeEntry[];
		index: readonly TreeEntry[];
		renames: ReadonlyMap<string, string>;
		baseDirs: ReadonlySet<string>;
	},
): Promise<string | undefined> {
	const prefix = `${packageDir}/`;
	const seen = new Set<string>();
	for (const entry of [...context.tracked, ...context.index]) {
		if (!entry.path.startsWith(prefix) || seen.has(entry.path)) continue;
		seen.add(entry.path);
		if ((await lstatOrUndefined(path.join(context.repoRoot, entry.path))) !== undefined) {
			return `Still here: ${entry.path}`;
		}
	}
	for (const entry of context.tracked) {
		const moved = entry.path.startsWith(prefix) ? context.renames.get(entry.path) : undefined;
		if (moved === undefined) continue;
		const movedTo = PACKAGE_PREFIX.exec(moved)?.[0];
		if (movedTo === undefined || !context.baseDirs.has(movedTo)) return `Moved: ${entry.path} -> ${moved}`;
	}
	return undefined;
}

/** `packages/<name>/CHANGELOG.md` for every directory entry under `packages/` in the working tree. */
async function workingTreeChangelogPaths(repoRoot: string): Promise<string[]> {
	try {
		const names = await fs.promises.readdir(path.join(repoRoot, "packages"));
		return names.map(name => `packages/${name}/CHANGELOG.md`);
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return [];
		throw error;
	}
}

/** A whole-changelog failure with no section lines, such as a missing or linked changelog. */
function fileChange(changelogPath: string, heading: string, problem: ChangeProblem): ReleasedSectionChange {
	return {
		path: changelogPath,
		heading,
		headLine: undefined,
		baseCopies: 1,
		headCopies: 0,
		added: [],
		repeated: [],
		removed: [],
		problem,
	};
}

export async function checkReleasedChangelogs(options: {
	base: string;
	repoRoot?: string;
	/** Accept released sections the base does not have: the base is the commit before a release. */
	release?: boolean;
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

	const listed = await git(["ls-tree", "-r", "-z", baseCommit, "--", "packages"], repoRoot);
	if (!listed.ok) throw new UnreadableBaseError(`cannot list the changelogs at ${baseCommit}: ${listed.stderr}`);
	const tracked = parseEntries(listed.stdout);
	const baseChangelogs = tracked.filter(entry => CHANGELOG_PATH.test(entry.path));
	if (baseChangelogs.length === 0) {
		throw new UnreadableBaseError(`no packages/*/CHANGELOG.md exists at ${baseCommit}; nothing to compare.`);
	}
	const basePaths = new Set(baseChangelogs.map(entry => entry.path));
	const renames = await renamesSince(baseCommit, repoRoot);
	const realRoot = await fs.promises.realpath(repoRoot);
	const shallow = (await git(["rev-parse", "--is-shallow-repository"], repoRoot)).stdout.trim() === "true";
	const indexed = await git(["ls-files", "-z", "--stage", "--", "packages"], repoRoot);
	if (!indexed.ok)
		throw new UnreadableBaseError(`cannot list the files git tracks under packages/: ${indexed.stderr}`);
	const index = parseEntries(indexed.stdout);
	// A submodule at `packages` or at a package directory holds files this repository does not track.
	const submodules = new Set(index.filter(entry => entry.mode === SUBMODULE_MODE).map(entry => entry.path));
	const inSubmodule = (changelogPath: string) =>
		submodules.has("packages") || submodules.has(path.posix.dirname(changelogPath));
	const baseDirs = new Set(tracked.flatMap(entry => PACKAGE_PREFIX.exec(entry.path)?.[0] ?? []));
	const changes: ReleasedSectionChange[] = [];
	const removed: string[] = [];

	// A package directory that is a link at the base keeps its changelog out of the listing above.
	// git follows the link, and a chain of links, to whatever changelog is behind it in the base.
	for (const entry of tracked) {
		if (entry.mode !== SYMLINK_MODE || !PACKAGE_DIR.test(entry.path)) continue;
		const behind = await git(
			["cat-file", "--batch-check", "--follow-symlinks"],
			repoRoot,
			`${baseCommit}:${entry.path}/CHANGELOG.md\n`,
		);
		if (!/^[0-9a-f]+ blob /.test(behind.stdout)) continue;
		changes.push(
			fileChange(
				`${entry.path}/CHANGELOG.md`,
				"The package directory is a symbolic link at the base",
				"not-regular",
			),
		);
	}

	// Each base changelog's path here: its own, or the changelog git pairs it with as renamed.
	// `basePath` is undefined for a changelog the base does not have.
	const compared: { basePath: string | undefined; headPath: string }[] = [];
	for (const { mode, path: basePath } of baseChangelogs) {
		if (mode === SYMLINK_MODE) {
			changes.push(fileChange(basePath, "CHANGELOG.md is a symbolic link at the base", "not-regular"));
			continue;
		}
		// A changelog in a submodule fails below, checked out or not.
		if (inSubmodule(basePath) || (await lstatOrUndefined(path.join(repoRoot, basePath))) !== undefined) {
			compared.push({ basePath, headPath: basePath });
			continue;
		}
		const renamed = renames.get(basePath);
		if (
			renamed !== undefined &&
			CHANGELOG_PATH.test(renamed) &&
			!basePaths.has(renamed) &&
			(await lstatOrUndefined(path.join(repoRoot, renamed))) !== undefined
		) {
			compared.push({ basePath, headPath: renamed });
			continue;
		}
		const remaining = await remainingPackageFile(path.posix.dirname(basePath), {
			repoRoot,
			tracked,
			index,
			renames,
			baseDirs,
		});
		if (remaining === undefined) removed.push(basePath);
		else
			changes.push({ ...fileChange(basePath, "CHANGELOG.md is missing", "missing-changelog"), detail: [remaining] });
	}
	const pairedHeads = new Set(compared.map(entry => entry.headPath));
	for (const headPath of await workingTreeChangelogPaths(repoRoot)) {
		if (basePaths.has(headPath) || pairedHeads.has(headPath)) continue;
		if ((await lstatOrUndefined(path.join(repoRoot, headPath))) === undefined) continue;
		compared.push({ basePath: undefined, headPath });
	}

	let changelogs = 0;
	let sections = 0;
	let archived = 0;
	for (const { basePath, headPath } of compared) {
		const absolutePath = path.join(repoRoot, headPath);
		if (inSubmodule(headPath)) {
			changes.push(fileChange(headPath, "The package directory is a submodule here", "not-regular"));
			continue;
		}
		const stat = await lstatOrUndefined(absolutePath);
		if (stat?.isSymbolicLink()) {
			changes.push(fileChange(headPath, "CHANGELOG.md is a symbolic link here", "not-regular"));
			continue;
		}
		if (!stat?.isFile()) {
			changes.push(fileChange(headPath, "CHANGELOG.md is not a regular file here", "not-regular"));
			continue;
		}
		// A linked directory on the path makes the next change read a link at the base, not this file.
		if ((await fs.promises.realpath(absolutePath)) !== path.join(realRoot, headPath)) {
			changes.push(fileChange(headPath, "CHANGELOG.md is reached through a symbolic link here", "not-regular"));
			continue;
		}

		let baseContent = "";
		if (basePath !== undefined) {
			const base = await git(["cat-file", "blob", `${baseCommit}:${basePath}`], repoRoot);
			if (!base.ok) throw new UnreadableBaseError(`cannot read ${basePath} at ${baseCommit}: ${base.stderr}`);
			baseContent = base.stdout;
		}
		const head = await Bun.file(absolutePath).text();
		// A changelog the base does not have is compared with an empty one: it may hold no released section.
		const result = await findReleasedSectionChanges(headPath, baseContent, head, {
			release: options.release ?? false,
			readArchive: async commit => {
				const spec = `${commit}:${headPath}`;
				const local = await git(["cat-file", "blob", spec], repoRoot);
				if (local.ok) return local.stdout;
				// A CI checkout is shallow, and the footer's commit is usually below its depth.
				const fetch = ["fetch", "--quiet", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", commit];
				if (!(await git(fetch, repoRoot)).ok) return undefined;
				const fetched = await git(["cat-file", "blob", spec], repoRoot);
				return fetched.ok ? fetched.stdout : undefined;
			},
		});
		if (basePath !== undefined) {
			changelogs++;
			sections += result.sections;
			archived += result.archived;
		}
		const renamedFrom = basePath !== undefined && basePath !== headPath ? basePath : undefined;
		changes.push(...result.changes.map(change => (renamedFrom ? { ...change, basePath: renamedFrom } : change)));
	}
	return { baseCommit, changelogs, sections, archived, removed, changes };
}

/** The report's explanation of a problem, then the short remedy its GitHub annotation gives. */
function describeProblem(
	problem: ChangeProblem,
	base: string,
	changelogPath: string,
): { report: string[]; annotation: string; remedy: string } {
	switch (problem) {
		case "missing-changelog":
			return {
				report: [
					"This is not a package removal: a file of the package is still here, or moved to a directory where the",
					"base has no package. Restore the changelog, in the package's new directory if it moved:",
				],
				annotation: "changelog missing while package remains",
				remedy: "Restore the changelog; files of its package remain or moved.",
			};
		case "not-regular":
			return {
				report: [
					"Released sections are compared only in a regular file. Replace the link, submodule or other entry with",
					`the changelog file itself, from \`git show ${base}:${changelogPath}\` where the base has the file.`,
				],
				annotation: "not a regular file",
				remedy: "Make the changelog a regular file.",
			};
		case "not-at-base":
			return {
				report: [
					"This released section is not at the base. Only a release adds one, and a merge is not a release:",
					"move its entries under `## [Unreleased]` and delete the heading.",
				],
				annotation: "released section not at the base",
				remedy: "Move its entries under ## [Unreleased] and delete the heading.",
			};
		case "archive-mismatch":
			return {
				report: [
					"Missing here, and the new archive footer does not account for it: the released sections here are not",
					`exactly what \`${FIX_COMMAND}\` leaves of the base's. Put the base's released sections back from`,
					`\`git show ${base}:${changelogPath}\`, then run \`${FIX_COMMAND}\`.`,
				],
				annotation: "missing behind an archive the fixer does not write",
				remedy: `Put the base's released sections back, then run \`${FIX_COMMAND}\`.`,
			};
		case "archive-unverified":
			return {
				report: [
					"Missing here, and the commit the new archive footer names does not hold it, or cannot be read.",
					`Put the base's released sections back from \`git show ${base}:${changelogPath}\`, commit them, then run`,
					`\`${FIX_COMMAND}\`: its footer names that commit.`,
				],
				annotation: "missing behind an archive footer whose commit does not hold it",
				remedy: `Put the base's released sections back, commit them, then run \`${FIX_COMMAND}\`.`,
			};
		case "archive-footer":
			return {
				report: [
					`Archive footer differs from the base. Only \`${FIX_COMMAND}\` changes it, when it archives sections.`,
					"Restore the base's footer:",
				],
				annotation: "archive footer changed",
				remedy: "Restore the base's archive footer.",
			};
	}
}

/**
 * Renders a check result. `recheckBase` is the `--base` argument a reader
 * should pass to run the check again in their own checkout.
 */
export function formatReleasedChangelogReport(check: ReleasedChangelogCheck, recheckBase: string): string {
	const base = check.baseCommit.slice(0, 12);
	if (check.changes.length === 0) {
		const archived = check.archived > 0 ? `; ${check.archived} oldest archived behind a new size-limit footer` : "";
		const removed =
			check.removed.length > 0
				? `; removed with ${check.removed.length === 1 ? "its package" : "their packages"}: ${check.removed.join(", ")}`
				: "";
		return `Released changelog sections match ${base}: ${check.sections} sections in ${check.changelogs} changelogs${archived}${removed}.`;
	}

	const out = [`A released changelog section differs from the base (${base}).`, ""];
	for (const change of check.changes) {
		const basePath = change.basePath ?? change.path;
		out.push(
			change.basePath
				? `${change.path} (${change.basePath} at the base): ${change.heading}`
				: `${change.path}: ${change.heading}`,
		);
		if (change.problem) {
			const { report } = describeProblem(change.problem, base, basePath);
			out.push(...report.map(line => `  ${line}`), ...(change.detail ?? []).map(line => `    ${line}`), "");
			continue;
		}
		if (change.headCopies === 0) {
			out.push(`  Missing here. Restore it from \`git show ${base}:${basePath}\`.`, "");
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
	const base = check.baseCommit.slice(0, 12);
	return check.changes.map(change => {
		const properties = [`file=${escapeAnnotationProperty(change.path)}`];
		if (change.headLine !== undefined) properties.push(`line=${change.headLine}`);
		properties.push(`title=${escapeAnnotationProperty("Released changelog section changed")}`);
		const described = change.problem ? describeProblem(change.problem, base, change.path) : undefined;
		const counts = [
			described?.annotation,
			!described && change.headCopies === 0 ? "missing" : undefined,
			change.added.length > 0 ? `${change.added.length} line(s) added` : undefined,
			change.repeated.length > 0 ? `${change.repeated.length} repeated` : undefined,
			change.removed.length > 0 ? `${change.removed.length} removed` : undefined,
		].filter(Boolean);
		const remedy =
			described?.remedy ??
			(change.added.length > 0
				? `Run \`${FIX_COMMAND}\` to move added lines back under ## [Unreleased].`
				: "Make it match the base; the job log lists the lines.");
		const what = counts.length > 0 ? counts.join(", ") : "lines reordered";
		return `::error ${properties.join(",")}::${escapeAnnotationData(`${change.heading}: ${what}. ${remedy}`)}`;
	});
}

function usage(): string {
	return [
		"Usage: bun scripts/check-released-changelogs.ts --base <commit> [--repo-root <dir>] [--release] [--github-annotations]",
		"",
		"Fails when a released section of a packages/*/CHANGELOG.md in the working tree differs",
		"from the same section at <commit>, the tip of the branch the changes merge into, or when",
		"the working tree adds a released section. --release accepts added released sections, for",
		"checking a release commit against the commit before it.",
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
	let release = false;
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
		if (arg === "--release") {
			release = true;
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
		const check = await checkReleasedChangelogs({ base, repoRoot, release });
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
