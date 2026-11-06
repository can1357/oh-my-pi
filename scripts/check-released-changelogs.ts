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
 * `[Unreleased]`, must appear in the head with the same lines in the same
 * order, as many times as at the base. Both sides are first normalized the way
 * `bun run fix:changelogs` normalizes a section, and blank lines are not
 * compared, so nothing the repository's own fixer does to a released section
 * counts as a change. The head may not add a released section either, and its
 * archive footer must stay the base's. A changelog git pairs as renamed is
 * compared at its new path; a changelog the base does not have may hold no
 * released section. A changelog must be a regular file, reached without a
 * symbolic link or a submodule, at the base and in the head; the check cannot
 * see into a submodule the base already has.
 *
 * Sections are found by the headings the fixer reads: `## [title]` and
 * `### Name` at the start of a line, below one `# Changelog` title, with
 * `## [Unreleased]` only alone on its line, as `bun run release` finds it.
 * A Markdown renderer shows other spellings
 * as headings too (indented, a tab or two spaces after the `#`s, underlined,
 * in a list or a quote, raw `<h2>`), and code or HTML can hide one the fixer
 * reads; a release written that way would escape the check. So the headings
 * Bun's CommonMark renderer shows must be exactly those the fixer reads, each
 * from the very line the fixer reads it on, and no line may start with
 * `[^label]:`, which GitHub reads as a footnote definition and renders as
 * Markdown at the end of the page: that line is refused wherever it stands,
 * a code block and an HTML comment included, so no block state can hide a
 * definition. A head that breaks this rule fails, naming the line, and a base
 * that breaks it is unreadable. The archive commit a new footer names is held
 * to the same.
 *
 *   bun scripts/check-released-changelogs.ts --base <commit> [--head <commit> | --index] [--release] [--github-annotations]
 *
 * `--base` is the tip of the branch the changes merge into: `origin/main`
 * after merging main into a branch, `HEAD` during an uncommitted merge
 * (scripts/merge-pr.ts), or a pull request merge commit's first parent (CI).
 * Releases happen on that branch, so its released sections are the reference.
 *
 * The head is the working tree; or, read from git objects alone, a commit (or
 * tree) with `--head`, or with `--index` the index, which is what `git commit`
 * records. Neither reads the working tree, so CI checks a pull request's merge
 * commit without checking it out, and scripts/merge-pr.ts checks the merge it
 * commits. Both sides are compared as git stores them. A working-tree
 * changelog is read through git's own filters, as `git add` would store it
 * (writing that blob to the object database), so an attribute such as
 * `working-tree-encoding` changes nothing; and a sparse checkout that keeps
 * part of `packages/` off disk is refused, since the working tree then does
 * not show what a commit records. A package directory, or `packages` itself,
 * that is a symbolic link or a submodule in the head fails whether or not a
 * changelog is behind it, and whether or not a submodule is checked out: git
 * objects do not show what is there, and the working tree is held to what a
 * commit of it would show.
 *
 * Exit 0: every released section of the base is unchanged.
 * Exit 1: a released section changed, or Markdown shows the head's headings
 *         other than as the fixer reads them; the report names the file, the
 *         section or line, and the fix, and ends with the command that checks
 *         again.
 * Exit 2: the base, the head or one of their changelogs could not be read, for
 *         example in a shallow clone without the base commit, a path under
 *         `packages/` is not UTF-8 (read lossily, it could name another path),
 *         sparse checkout hides part of the working tree, or Markdown shows the
 *         base's headings other than as the fixer reads them. Nothing was
 *         compared.
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
 *   hold. The head's released sections and footer are, byte for byte, what
 *   the fixer's own per-file pipeline (`fixChangelogFile`) leaves of the
 *   base's released sections, verbatim, with the head's `[Unreleased]`
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
	ChangelogHeadingError,
	describeHeadingMismatch,
	findHeadingMismatch,
	fixChangelogFile,
	HEADING_RULE,
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
const TREE_MODE = "040000";
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";
/** The repository command that moves lines added to a released section back under `[Unreleased]`. */
export const FIX_COMMAND = "bun run fix:changelogs";

export interface ChangedLine {
	/** The `###` subsection the line is under in the head; undefined above the first one. */
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
	| "archive-footer"
	/** Markdown shows the head's headings other than as the check reads them, from the line named. */
	| "heading";

export interface ReleasedSectionChange {
	/** The changelog here. */
	path: string;
	/** The changelog at the base, when git pairs `path` with it as renamed. */
	basePath?: string;
	/** The section's heading line at the base, such as `## [18.14.1] - 2026-10-31`. */
	heading: string;
	/** 1-based line of the section's heading in the head; undefined when the section is missing. */
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

/** The base, the head, or a changelog in either could not be read; nothing was compared. */
export class UnreadableInputError extends Error {}

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
 * the head's text above its first section and its `[Unreleased]`
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
 * `archiveCommit`. `matches` holds when the head's released sections
 * and footer equal the fixer's, byte for byte; never when the fixer refuses
 * the text for its headings, since then it writes no archive.
 * `archivedTitles` names each base title the fixer left fewer copies of; the
 * archive commit must hold every copy of each.
 */
async function fixerArchive(
	changelogPath: string,
	baseContent: string,
	headContent: string,
	archiveCommit: string,
): Promise<{ matches: boolean; collapsedReleases: number; archivedTitles: Set<string> }> {
	let fixed: { content: string; collapsedReleases: number };
	try {
		fixed = await fixChangelogFile(changelogPath, withBaseReleases(baseContent, headContent), {
			promotableAddedItemStartLines: new Set<number>(),
			maxBytes: MAX_CHANGELOG_BYTES,
			archiveCommit: async () => archiveCommit,
		});
	} catch (error) {
		if (!(error instanceof ChangelogHeadingError)) throw error;
		return { matches: false, collapsedReleases: 0, archivedTitles: new Set() };
	}
	const expected = releasedHistory(fixed.content);
	const actual = releasedHistory(headContent);
	// A title the base has twice can lose one copy and keep the other: count copies, not titles.
	const kept = new Map<string, number>();
	for (const block of releasedBlocks(fixed.content).blocks) kept.set(block.title, (kept.get(block.title) ?? 0) + 1);
	const archivedTitles = new Set<string>();
	for (const block of releasedBlocks(baseContent).blocks) {
		const left = kept.get(block.title) ?? 0;
		if (left > 0) kept.set(block.title, left - 1);
		else archivedTitles.add(block.title);
	}
	return {
		matches: expected.length === actual.length && expected.every((text, index) => text === actual[index]),
		collapsedReleases: fixed.collapsedReleases,
		archivedTitles,
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

/**
 * Compares one changelog's released sections at the base with the same file in
 * the head. Released sections are found only where Markdown shows the same
 * headings the fixer reads; a head where it shows others is a change, and a
 * base where it does is unreadable.
 */
export async function findReleasedSectionChanges(
	changelogPath: string,
	baseContent: string,
	headContent: string,
	options: FindReleasedSectionChangesOptions,
): Promise<{ sections: number; archived: number; changes: ReleasedSectionChange[] }> {
	const baseMismatch = findHeadingMismatch(baseContent);
	if (baseMismatch) {
		throw new UnreadableInputError(
			`${changelogPath} at the base, ${describeHeadingMismatch(baseMismatch)}. The check cannot tell which ` +
				`sections the base has released, so it compares nothing. ${HEADING_RULE}`,
		);
	}
	const base = parseReleased(baseContent);
	const headMismatch = findHeadingMismatch(headContent);
	if (headMismatch) {
		const change: ReleasedSectionChange = {
			path: changelogPath,
			heading: describeHeadingMismatch(headMismatch),
			headLine: headMismatch.lineNumber,
			baseCopies: 0,
			headCopies: 0,
			added: [],
			repeated: [],
			removed: [],
			problem: "heading",
		};
		return { sections: base.sections.size, archived: 0, changes: [change] };
	}
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
	// Fewer copies here than at the base, entries or not: what a new archive footer has to account for.
	const fewer = titles.filter(
		title => (head.sections.get(title)?.length ?? 0) < (base.sections.get(title)?.length ?? 0),
	);

	// A released section may go behind a new archive footer only when the
	// fixer itself writes that footer, naming a commit that still holds it: run
	// the fixer, compare what it leaves, then read that commit. This holds for
	// sections without entries too, so the fixer's own archive of them passes.
	// The fixer promises to keep the newest release; hold it to that here, so a
	// fault in its collapse cannot certify losing that release.
	const sorted = parseChangelog(splitArchiveFooter(baseContent).body);
	sortReleaseSections(sorted);
	const newest = sorted.sections.find(section => section.title !== UNRELEASED_TITLE)?.title;
	const archiveCommit = footerChanged ? head.archiveLink?.match(/\/blob\/([0-9a-f]{40})\//)?.[1] : undefined;
	let explained = new Set<string>();
	let unverified = false;
	if (fewer.length > 0 && archiveCommit !== undefined && (newest === undefined || !missing.has(newest))) {
		const archive = await fixerArchive(changelogPath, baseContent, headContent, archiveCommit);
		explained = archive.archivedTitles;
		if (archive.matches) {
			const linked = await options.readArchive(archiveCommit);
			// The archive link shows that commit's file as Markdown: it holds a section only where Markdown shows one.
			const held =
				linked === undefined || findHeadingMismatch(linked) !== undefined ? undefined : parseReleased(linked);
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
): Promise<{ ok: boolean; stdout: string; bytes: Uint8Array; stderr: string }> {
	const command = stdin === undefined ? $`git ${args}` : $`git ${args} < ${new Response(stdin)}`;
	const result = await command
		.cwd(cwd)
		.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
		.quiet()
		.nothrow();
	return {
		ok: result.exitCode === 0,
		stdout: result.stdout.toString(),
		bytes: result.stdout,
		stderr: result.stderr.toString().trim(),
	};
}

// `ignoreBOM` keeps a leading U+FEFF: dropped, `\uFEFFpackages/x` would read as `packages/x`.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A path, from git's bytes or a directory listing's, as text. A path that is
 * not UTF-8 stops the check: decoded lossily, byte 0x80 reads as U+FFFD, the
 * name of another path that can sit beside it, and one would hide the other.
 */
function pathText(bytes: Uint8Array, source: string): string {
	try {
		return strictUtf8.decode(bytes);
	} catch {
		throw new UnreadableInputError(
			`${source} holds a path that is not UTF-8, ${JSON.stringify(new TextDecoder().decode(bytes))}: ` +
				"the check cannot tell it from the path that text names, so it compares nothing.",
		);
	}
}

/** A changelog's bytes as text. Bytes that are not UTF-8 stop the check: decoded lossily, other bytes read the same. */
function blobText(bytes: Uint8Array, spec: string): string {
	try {
		return strictUtf8.decode(bytes);
	} catch {
		throw new UnreadableInputError(
			`${spec} is not UTF-8: decoded lossily, it reads the same as other bytes, so the check compares nothing.`,
		);
	}
}

/** The NUL-terminated fields of git's `-z` output, as bytes. */
function nulFields(bytes: Uint8Array): Uint8Array[] {
	const fields: Uint8Array[] = [];
	for (let start = 0, end = bytes.indexOf(0); end !== -1; start = end + 1, end = bytes.indexOf(0, start)) {
		fields.push(bytes.subarray(start, end));
	}
	return fields;
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

/** Files git pairs as renamed since `revisions[0]`, old path to new: every pair with a side under packages/. */
async function renamesSince(revisions: readonly string[], repoRoot: string): Promise<Map<string, string>> {
	const diff = await git(
		["diff", "--no-color", "-M", "--name-status", "-z", "--diff-filter=R", ...revisions],
		repoRoot,
	);
	if (!diff.ok) throw new UnreadableInputError(`cannot list the files renamed since ${revisions[0]}: ${diff.stderr}`);
	// `R<score>\0<old path>\0<new path>\0` per rename. A pair with no side under packages/ moves no
	// package file, so a path there that is not UTF-8 does not concern the check.
	const fields = nulFields(diff.bytes);
	const renames = new Map<string, string>();
	const packages = new TextEncoder().encode("packages/");
	const underPackages = (field: Uint8Array) => packages.every((byte, index) => field[index] === byte);
	for (let index = 0; index + 2 < fields.length; index += 3) {
		const [from, to] = [fields[index + 1], fields[index + 2]];
		if (!underPackages(from) && !underPackages(to)) continue;
		renames.set(pathText(from, "git diff"), pathText(to, "git diff"));
	}
	return renames;
}

interface TreeEntry {
	mode: string;
	path: string;
}

/** The entries `git ls-tree -z` or `git ls-files --stage -z` prints: `<mode> <...>\t<path>`. */
function parseEntries(bytes: Uint8Array, source: string): TreeEntry[] {
	return nulFields(bytes)
		.filter(field => field.length > 0)
		.map(field => {
			const entry = pathText(field, source);
			return { mode: entry.slice(0, entry.indexOf(" ")), path: entry.slice(entry.indexOf("\t") + 1) };
		});
}

async function readBlob(spec: string, repoRoot: string): Promise<string> {
	const blob = await git(["cat-file", "blob", spec], repoRoot);
	if (!blob.ok) throw new UnreadableInputError(`cannot read ${spec}: ${blob.stderr}`);
	return blobText(blob.bytes, spec);
}

/**
 * For each `<commit>:<path>`, whether it names a blob once git follows the
 * symbolic links on the path inside the commit. Requests and replies are
 * NUL-delimited (`-Z`), so a path may hold any byte but NUL, a newline too.
 */
async function namesBlob(specs: readonly string[], repoRoot: string): Promise<boolean[]> {
	if (specs.length === 0) return [];
	const batch = await git(
		["cat-file", "--batch-check", "--follow-symlinks", "-Z"],
		repoRoot,
		specs.map(spec => `${spec}\0`).join(""),
	);
	if (!batch.ok) throw new UnreadableInputError(`cannot follow the links at the base: ${batch.stderr}`);
	const fields = batch.stdout.split("\0");
	const blobs: boolean[] = [];
	for (let index = 0; blobs.length < specs.length; index++) {
		const field = fields[index];
		if (field === undefined) throw new UnreadableInputError("git answered fewer link lookups than asked");
		const found = /^[0-9a-f]+ (\w+) \d+$/.exec(field);
		if (found) blobs.push(found[1] === "blob");
		else if (field.endsWith(" missing")) blobs.push(false);
		// A link out of the commit, dangling, in a loop, or through a file: one more field names it.
		else if (/^(?:symlink|dangling|loop|notdir) \d+$/.test(field)) {
			blobs.push(false);
			index++;
		} else throw new UnreadableInputError(`unexpected link lookup reply from git: ${field}`);
	}
	return blobs;
}

/** What the base is compared with: the working tree, or a commit's tree read only from git objects. */
interface Head {
	/** Files git pairs as renamed since the base, anywhere in the repository, old path to new. */
	renames: ReadonlyMap<string, string>;
	/** What git tracks under packages/ here, without directories: the index, or the commit's tree. */
	entries: readonly TreeEntry[];
	/** Whether a file is at `filePath` here. */
	has(filePath: string): Promise<boolean>;
	/** Whether something is at the changelog path here, or behind a link or submodule on its way. */
	hasChangelog(changelogPath: string): Promise<boolean>;
	/** Why the changelog at `changelogPath` is not compared as a regular file here; undefined when it is one. */
	irregular(changelogPath: string): Promise<string | undefined>;
	/** The changelog as git stores it. */
	read(changelogPath: string): Promise<string>;
	/** `packages/<name>/CHANGELOG.md` for every entry directly under packages/ here. */
	changelogPaths(): Promise<string[]>;
}

async function workingTreeHead(repoRoot: string, baseCommit: string): Promise<Head> {
	const indexed = await git(["ls-files", "-z", "-v", "--stage", "--", "packages"], repoRoot);
	if (!indexed.ok) {
		throw new UnreadableInputError(`cannot list the files git tracks under packages/: ${indexed.stderr}`);
	}
	const entries: TreeEntry[] = [];
	for (const field of nulFields(indexed.bytes)) {
		// `<status tag> <mode> <object> <stage>\t<path>`; `-v` writes the tag in lower case for an
		// entry git is told to assume unchanged.
		const entry = pathText(field, "git ls-files");
		const [tag, mode] = entry.split(" ", 2);
		const entryPath = entry.slice(entry.indexOf("\t") + 1);
		// Sparse checkout leaves a skip-worktree entry off disk, yet a commit records it.
		if (tag.toUpperCase() === "S") {
			throw new UnreadableInputError(
				`sparse checkout keeps ${entryPath} out of the working tree, so the working tree does not show what ` +
					"a commit records. Check the index with --index, or a commit with --head.",
			);
		}
		if (tag !== tag.toUpperCase()) {
			throw new UnreadableInputError(
				`git is told to assume ${entryPath} unchanged, so the working tree and what a commit records can ` +
					"differ. Check the index with --index, or a commit with --head.",
			);
		}
		entries.push({ mode, path: entryPath });
	}
	// A submodule at `packages` or at a package directory holds files this repository does not track.
	const submodules = new Set(entries.filter(entry => entry.mode === SUBMODULE_MODE).map(entry => entry.path));
	const inSubmodule = (changelogPath: string) =>
		submodules.has("packages") || submodules.has(path.posix.dirname(changelogPath));
	// So does a link at either: what it holds is not this repository's to compare.
	const linkedDir = async (changelogPath: string) => {
		for (const dir of ["packages", path.posix.dirname(changelogPath)]) {
			if ((await lstatOrUndefined(path.join(repoRoot, dir)))?.isSymbolicLink()) return true;
		}
		return false;
	};
	const has = async (filePath: string) => (await lstatOrUndefined(path.join(repoRoot, filePath))) !== undefined;
	return {
		renames: await renamesSince([baseCommit], repoRoot),
		entries,
		has,
		// A changelog in a submodule or behind a linked package directory fails as irregular, checked out,
		// with a changelog behind it, or not, as in a committed head.
		hasChangelog: async changelogPath =>
			inSubmodule(changelogPath) || (await linkedDir(changelogPath)) || (await has(changelogPath)),
		async irregular(changelogPath) {
			if (inSubmodule(changelogPath)) return "The package directory is a submodule here";
			if (await linkedDir(changelogPath)) return "CHANGELOG.md is reached through a symbolic link here";
			const absolutePath = path.join(repoRoot, changelogPath);
			const stat = await lstatOrUndefined(absolutePath);
			if (stat?.isSymbolicLink()) return "CHANGELOG.md is a symbolic link here";
			if (!stat?.isFile()) return "CHANGELOG.md is not a regular file here";
			return undefined;
		},
		async read(changelogPath) {
			// The blob `git add` would store: git's filters applied, such as a working-tree-encoding back to UTF-8.
			const stored = await git(["hash-object", "-w", "--", changelogPath], repoRoot);
			if (!stored.ok)
				throw new UnreadableInputError(`cannot read ${changelogPath} as git stores it: ${stored.stderr}`);
			return readBlob(stored.stdout.trim(), repoRoot);
		},
		async changelogPaths() {
			try {
				const names = await fs.promises.readdir(path.join(repoRoot, "packages"), { encoding: "buffer" });
				return names.map(name => `packages/${pathText(name, "packages/")}/CHANGELOG.md`);
			} catch (error) {
				if (isEnoent(error) || isEnotdir(error)) return [];
				throw error;
			}
		},
	};
}

/** The index as a tree: what `git commit` records. */
async function indexTree(repoRoot: string): Promise<string> {
	const written = await git(["write-tree"], repoRoot);
	if (!written.ok) {
		throw new UnreadableInputError(
			`cannot record the index as a tree (${written.stderr}). Resolve every conflict and \`git add\` it first.`,
		);
	}
	return written.stdout.trim();
}

async function committedHead(repoRoot: string, baseCommit: string, head: string): Promise<Head> {
	const resolved = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${head}^{tree}`], repoRoot);
	if (!resolved.ok) {
		throw new UnreadableInputError(`cannot resolve --head ${head} to a commit or tree. Fetch it first.`);
	}
	const tree = resolved.stdout.trim();
	const listed = await git(["ls-tree", "-r", "-t", "-z", tree, "--", "packages"], repoRoot);
	if (!listed.ok) throw new UnreadableInputError(`cannot list packages/ in ${head}: ${listed.stderr}`);
	const modes = new Map(parseEntries(listed.bytes, "git ls-tree").map(entry => [entry.path, entry.mode]));
	// git objects do not show what a link or a submodule on the way to a changelog holds.
	const blockedBy = (changelogPath: string) =>
		[modes.get("packages"), modes.get(PACKAGE_PREFIX.exec(changelogPath)?.[0] ?? "")].find(
			mode => mode === SYMLINK_MODE || mode === SUBMODULE_MODE,
		);
	return {
		renames: await renamesSince([baseCommit, tree], repoRoot),
		entries: [...modes]
			.filter(([, mode]) => mode !== TREE_MODE)
			.map(([entryPath, mode]) => ({ mode, path: entryPath })),
		has: async filePath => modes.has(filePath),
		hasChangelog: async changelogPath => modes.has(changelogPath) || blockedBy(changelogPath) !== undefined,
		async irregular(changelogPath) {
			const blocked = blockedBy(changelogPath);
			if (blocked === SUBMODULE_MODE) return "The package directory is a submodule here";
			if (blocked === SYMLINK_MODE) return "CHANGELOG.md is reached through a symbolic link here";
			const mode = modes.get(changelogPath);
			if (mode === SYMLINK_MODE) return "CHANGELOG.md is a symbolic link here";
			if (mode !== "100644" && mode !== "100755") return "CHANGELOG.md is not a regular file here";
			return undefined;
		},
		read: changelogPath => readBlob(`${tree}:${changelogPath}`, repoRoot),
		changelogPaths: async () =>
			[...modes.keys()].filter(entryPath => PACKAGE_DIR.test(entryPath)).map(dir => `${dir}/CHANGELOG.md`),
	};
}

/**
 * A file showing that the package of a changelog gone from the head was not
 * removed, or undefined when it was: a file of the package, tracked at the
 * base or added since, still in its directory, or one git pairs as moved to a
 * directory where the base has no package. Moving into another package of the
 * base merges the two; that removes this one.
 */
async function remainingPackageFile(
	packageDir: string,
	head: Head,
	context: { tracked: readonly TreeEntry[]; baseDirs: ReadonlySet<string> },
): Promise<string | undefined> {
	const prefix = `${packageDir}/`;
	const seen = new Set<string>();
	for (const entry of [...context.tracked, ...head.entries]) {
		if (!entry.path.startsWith(prefix) || seen.has(entry.path)) continue;
		seen.add(entry.path);
		if (await head.has(entry.path)) return `Still here: ${entry.path}`;
	}
	for (const entry of context.tracked) {
		const moved = entry.path.startsWith(prefix) ? head.renames.get(entry.path) : undefined;
		if (moved === undefined) continue;
		const movedTo = PACKAGE_PREFIX.exec(moved)?.[0];
		if (movedTo === undefined || !context.baseDirs.has(movedTo)) return `Moved: ${entry.path} -> ${moved}`;
	}
	return undefined;
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
	/** A commit or tree to check instead of the working tree, read only from git objects. */
	head?: string;
	/** Check the index, what `git commit` records, read only from git objects. */
	index?: boolean;
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
		throw new UnreadableInputError(
			`cannot resolve --base ${options.base} to a commit. A shallow clone may not have it: fetch it first.`,
		);
	}
	const baseCommit = resolved.stdout.trim();

	const listed = await git(["ls-tree", "-r", "-z", baseCommit, "--", "packages"], repoRoot);
	if (!listed.ok) throw new UnreadableInputError(`cannot list the changelogs at ${baseCommit}: ${listed.stderr}`);
	const tracked = parseEntries(listed.bytes, "git ls-tree");
	const baseChangelogs = tracked.filter(entry => CHANGELOG_PATH.test(entry.path));
	if (baseChangelogs.length === 0) {
		throw new UnreadableInputError(`no packages/*/CHANGELOG.md exists at ${baseCommit}; nothing to compare.`);
	}
	const basePaths = new Set(baseChangelogs.map(entry => entry.path));
	const head = options.index
		? await committedHead(repoRoot, baseCommit, await indexTree(repoRoot))
		: options.head === undefined
			? await workingTreeHead(repoRoot, baseCommit)
			: await committedHead(repoRoot, baseCommit, options.head);
	const shallow = (await git(["rev-parse", "--is-shallow-repository"], repoRoot)).stdout.trim() === "true";
	const baseDirs = new Set(tracked.flatMap(entry => PACKAGE_PREFIX.exec(entry.path)?.[0] ?? []));
	const changes: ReleasedSectionChange[] = [];
	const removed: string[] = [];

	// A package directory that is a link at the base keeps its changelog out of the listing above.
	// git follows the link, and a chain of links, to whatever changelog is behind it in the base.
	const linkedDirs = tracked.filter(entry => entry.mode === SYMLINK_MODE && PACKAGE_DIR.test(entry.path));
	const behind = await namesBlob(
		linkedDirs.map(entry => `${baseCommit}:${entry.path}/CHANGELOG.md`),
		repoRoot,
	);
	for (const [index, entry] of linkedDirs.entries()) {
		if (!behind[index]) continue;
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
		if (await head.hasChangelog(basePath)) {
			compared.push({ basePath, headPath: basePath });
			continue;
		}
		const renamed = head.renames.get(basePath);
		if (
			renamed !== undefined &&
			CHANGELOG_PATH.test(renamed) &&
			!basePaths.has(renamed) &&
			(await head.hasChangelog(renamed))
		) {
			compared.push({ basePath, headPath: renamed });
			continue;
		}
		const remaining = await remainingPackageFile(path.posix.dirname(basePath), head, { tracked, baseDirs });
		if (remaining === undefined) removed.push(basePath);
		else
			changes.push({ ...fileChange(basePath, "CHANGELOG.md is missing", "missing-changelog"), detail: [remaining] });
	}
	const pairedHeads = new Set(compared.map(entry => entry.headPath));
	for (const headPath of await head.changelogPaths()) {
		if (basePaths.has(headPath) || pairedHeads.has(headPath)) continue;
		if (!(await head.hasChangelog(headPath))) continue;
		compared.push({ basePath: undefined, headPath });
	}

	let changelogs = 0;
	let sections = 0;
	let archived = 0;
	for (const { basePath, headPath } of compared) {
		const irregular = await head.irregular(headPath);
		if (irregular !== undefined) {
			changes.push(fileChange(headPath, irregular, "not-regular"));
			continue;
		}
		// A changelog the base does not have is compared with one that holds only the title: it may hold no released section.
		const baseContent =
			basePath === undefined ? "# Changelog\n" : await readBlob(`${baseCommit}:${basePath}`, repoRoot);
		const result = await findReleasedSectionChanges(headPath, baseContent, await head.read(headPath), {
			release: options.release ?? false,
			readArchive: async commit => {
				const spec = `${commit}:${headPath}`;
				const local = await git(["cat-file", "blob", spec], repoRoot);
				if (local.ok) return blobText(local.bytes, spec);
				// A CI checkout is shallow, and the footer's commit is usually below its depth.
				const fetch = ["fetch", "--quiet", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", commit];
				if (!(await git(fetch, repoRoot)).ok) return undefined;
				const fetched = await git(["cat-file", "blob", spec], repoRoot);
				return fetched.ok ? blobText(fetched.bytes, spec) : undefined;
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

/** `text` as one shell word, quoted unless it holds only characters no common shell expands. */
function shellWord(text: string): string {
	return /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The report's explanation of a problem, then the short remedy its GitHub annotation gives. */
function describeProblem(
	problem: ChangeProblem,
	base: string,
	changelogPath: string,
): { report: string[]; annotation: string; remedy: string } {
	const show = `git show ${shellWord(`${base}:${changelogPath}`)}`;
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
					`the changelog file itself, from \`${show}\` where the base has the file.`,
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
					`\`${show}\`, then run \`${FIX_COMMAND}\`.`,
				],
				annotation: "missing behind an archive the fixer does not write",
				remedy: `Put the base's released sections back, then run \`${FIX_COMMAND}\`.`,
			};
		case "archive-unverified":
			return {
				report: [
					"Missing here, and the commit the new archive footer names does not hold it, or cannot be read.",
					`Put the base's released sections back from \`${show}\`, commit them, then run`,
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
		case "heading":
			return {
				report: [
					"The check finds released sections only by headings it reads, so it compares nothing in a changelog",
					"where Markdown shows other headings: a release written that way would escape it.",
					HEADING_RULE,
				],
				annotation: "a heading the check does not read as Markdown shows it",
				remedy: HEADING_RULE,
			};
	}
}

/**
 * Renders a check result. `recheckArgs` are the arguments that run the same
 * check again; the report ends with that command, quoted for a shell.
 */
export function formatReleasedChangelogReport(check: ReleasedChangelogCheck, recheckArgs: readonly string[]): string {
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
			out.push(`  Missing here. Restore it from \`git show ${shellWord(`${base}:${basePath}`)}\`.`, "");
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
	// A heading problem's own text says what to do; no section was compared there.
	const handFixed = check.changes.some(
		change =>
			change.problem !== "heading" &&
			(change.added.length === 0 || change.repeated.length > 0 || change.removed.length > 0),
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
	out.push(`Check again: bun scripts/check-released-changelogs.ts ${recheckArgs.map(shellWord).join(" ")}`);
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
		"Usage: bun scripts/check-released-changelogs.ts --base <commit> [--head <commit> | --index] [--repo-root <dir>] [--release] [--github-annotations]",
		"",
		"Fails when a released section of a packages/*/CHANGELOG.md in the head differs from the",
		"same section at <commit>, the tip of the branch the changes merge into, or when the head",
		"adds a released section. The head is the working tree; or, read from git objects alone, the",
		"--head commit, or with --index the index, which is what `git commit` records. --release",
		"accepts added released sections, for checking a release commit against the commit before it.",
		"--github-annotations also prints GitHub workflow commands that mark each failing file.",
		"",
		"Exit 0: unchanged. Exit 1: a released section changed. Exit 2: the base or head could not be read.",
	].join("\n");
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const values = new Map<string, string>();
	let annotate = false;
	let release = false;
	let index = false;
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
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
		if (arg === "--index") {
			index = true;
			continue;
		}
		const value = args[at + 1];
		if ((arg === "--base" || arg === "--head" || arg === "--repo-root") && value) {
			values.set(arg, value);
			at++;
			continue;
		}
		console.error(`error: unexpected argument ${arg}\n\n${usage()}`);
		return 2;
	}
	const base = values.get("--base");
	if (!base) {
		console.error(`error: --base is required\n\n${usage()}`);
		return 2;
	}
	if (index && values.has("--head")) {
		console.error(`error: --head and --index name two different heads\n\n${usage()}`);
		return 2;
	}

	try {
		const check = await checkReleasedChangelogs({
			base,
			head: values.get("--head"),
			index,
			repoRoot: values.get("--repo-root"),
			release,
		});
		const report = formatReleasedChangelogReport(check, [
			...[...values].flat(),
			...(release ? ["--release"] : []),
			...(index ? ["--index"] : []),
		]);
		if (check.changes.length === 0) {
			console.log(report);
			return 0;
		}
		if (annotate) for (const line of formatGithubAnnotations(check)) console.log(line);
		console.error(report);
		return 1;
	} catch (error) {
		if (!(error instanceof UnreadableInputError)) throw error;
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
