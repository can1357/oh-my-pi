#!/usr/bin/env bun

import * as path from "node:path";
import { $, Glob } from "bun";

const CHANGELOG_GLOB = "packages/*/CHANGELOG.md";
const ORDERED_SECTION_TITLES = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;
const CHANGELOG_BASELINE_REF = "refs/clog";
const CHANGELOG_BASELINE_NAME = "clog";

export interface NumberedLine {
	text: string;
	lineNumber: number;
}

export interface Subsection {
	title: string;
	lines: NumberedLine[];
}

export interface ReleaseSection {
	heading: string;
	title: string;
	leadingLines: NumberedLine[];
	subsections: Subsection[];
}

export interface ChangelogDocument {
	prefixLines: NumberedLine[];
	sections: ReleaseSection[];
}

export interface ParsedItem {
	startLine: number;
	endLine: number;
	lines: string[];
}

interface FixCounters {
	promotedItems: number;
	mergedDuplicateHeadings: number;
	removedEmptyHeadings: number;
	droppedReleasedDuplicates: number;
}

export interface FixChangelogContentResult extends FixCounters {
	content: string;
}

interface HunkRef {
	path: string;
	index: number;
}

interface AddedItemCandidate {
	path: string;
	lineNumber: number;
	text: string;
	hunk: HunkRef;
	pairedWithRemoval: boolean;
}

interface RemovedItemOccurrence {
	path: string;
	text: string;
	hunk: HunkRef;
	pairedWithAddition: boolean;
}

export interface ChangedChangelogSummary extends FixCounters {
	path: string;
}

export interface RunChangelogFixerOptions {
	repoRoot?: string;
	since?: string;
	write?: boolean;
	recover?: boolean;
}

export interface RunChangelogFixerResult {
	since: string;
	changedFiles: ChangedChangelogSummary[];
}

interface CliOptions {
	mode: "write" | "dry-run" | "check";
	repoRoot?: string;
	since?: string;
	recover: boolean;
	pin: boolean;
	help: boolean;
}

interface HistoricalReleaseRecovery {
	itemKeys: Set<string>;
	sectionsByTitle: Map<string, ReleaseSection>;
}

function isReleaseHeading(line: string): boolean {
	return /^## \[[^\]]+\]/.test(line);
}

function isSubsectionHeading(line: string): boolean {
	return /^###\s+\S/.test(line);
}

function parseReleaseTitle(heading: string): string {
	const match = heading.match(/^## \[([^\]]+)\]/);
	return match?.[1] ?? heading.replace(/^##\s+/, "").trim();
}

function parseSubsectionTitle(heading: string): string {
	return heading.replace(/^###\s+/, "").trim();
}

function isListItemLine(line: string): boolean {
	return line.trimStart().startsWith("- ");
}

function normalizeItemText(text: string): string {
	return text.trim();
}

function splitContentLines(content: string): string[] {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (normalized.endsWith("\n")) {
		return normalized.slice(0, -1).split("\n");
	}
	return normalized.split("\n");
}

function createNumberedLine(text: string, lineNumber: number): NumberedLine {
	return { text, lineNumber };
}

export function parseChangelog(content: string): ChangelogDocument {
	const lines = splitContentLines(content);
	const numberedLines = lines.map((text, index) => createNumberedLine(text, index + 1));
	const prefixLines: NumberedLine[] = [];
	const sections: ReleaseSection[] = [];
	let index = 0;

	while (index < numberedLines.length && !isReleaseHeading(numberedLines[index]?.text ?? "")) {
		const line = numberedLines[index];
		if (line) prefixLines.push(line);
		index++;
	}

	while (index < numberedLines.length) {
		const headingLine = numberedLines[index];
		if (!headingLine) break;
		index++;

		const bodyLines: NumberedLine[] = [];
		while (index < numberedLines.length && !isReleaseHeading(numberedLines[index]?.text ?? "")) {
			const line = numberedLines[index];
			if (line) bodyLines.push(line);
			index++;
		}

		sections.push(parseReleaseSection(headingLine.text, bodyLines));
	}

	return { prefixLines, sections };
}

function parseReleaseSection(heading: string, bodyLines: readonly NumberedLine[]): ReleaseSection {
	const leadingLines: NumberedLine[] = [];
	const subsections: Subsection[] = [];
	let index = 0;

	while (index < bodyLines.length && !isSubsectionHeading(bodyLines[index]?.text ?? "")) {
		const line = bodyLines[index];
		if (line) leadingLines.push(line);
		index++;
	}

	while (index < bodyLines.length) {
		const headingLine = bodyLines[index];
		if (!headingLine) break;
		index++;

		const lines: NumberedLine[] = [];
		while (index < bodyLines.length && !isSubsectionHeading(bodyLines[index]?.text ?? "")) {
			const line = bodyLines[index];
			if (line) lines.push(line);
			index++;
		}

		subsections.push({ title: parseSubsectionTitle(headingLine.text), lines });
	}

	return {
		heading,
		title: parseReleaseTitle(heading),
		leadingLines,
		subsections,
	};
}

function trimBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim() === "") start++;
	while (end > start && lines[end - 1]?.trim() === "") end--;
	return lines.slice(start, end);
}

function numberedText(lines: readonly NumberedLine[]): string[] {
	return lines.map(line => line.text);
}

function syntheticLines(lines: readonly string[]): NumberedLine[] {
	return lines.map(text => ({ text, lineNumber: 0 }));
}

function appendSubsectionLines(target: Subsection, sourceLines: readonly string[]): void {
	const trimmedSource = trimBlankLines(sourceLines);
	if (trimmedSource.length === 0) return;

	const existing = trimBlankLines(numberedText(target.lines));
	if (existing.length === 0) {
		target.lines = syntheticLines(trimmedSource);
		return;
	}

	const lastExisting = existing[existing.length - 1] ?? "";
	const firstSource = trimmedSource[0] ?? "";
	const separator = isListItemLine(lastExisting) && isListItemLine(firstSource) ? [] : [""];
	target.lines = syntheticLines([...existing, ...separator, ...trimmedSource]);
}

export function parseItems(lines: readonly NumberedLine[]): ParsedItem[] {
	const items: ParsedItem[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (!line || !isListItemLine(line.text)) {
			index++;
			continue;
		}

		const start = index;
		index++;
		while (index < lines.length && !isListItemLine(lines[index]?.text ?? "")) {
			index++;
		}

		const itemLines = lines.slice(start, index);
		const firstLine = itemLines[0];
		const lastLine = itemLines[itemLines.length - 1];
		if (firstLine && lastLine) {
			items.push({
				startLine: firstLine.lineNumber,
				endLine: lastLine.lineNumber,
				lines: trimBlankLines(numberedText(itemLines)),
			});
		}
	}

	return items;
}

export function lineRangeSet(items: readonly ParsedItem[]): Set<number> {
	const lines = new Set<number>();
	for (const item of items) {
		for (let line = item.startLine; line <= item.endLine; line++) {
			lines.add(line);
		}
	}
	return lines;
}

function itemTextKey(itemLines: readonly string[]): string {
	return trimBlankLines(itemLines).join("\n");
}

function subsectionHasItem(subsection: Subsection, itemLines: readonly string[]): boolean {
	const wanted = itemTextKey(itemLines);
	if (!wanted) return true;
	for (const item of parseItems(subsection.lines)) {
		if (itemTextKey(item.lines) === wanted) return true;
	}
	return false;
}

function collectReleasedItemKeys(document: ChangelogDocument): Set<string> {
	const keys = new Set<string>();
	for (const section of document.sections) {
		if (section.title === "Unreleased") continue;
		for (const subsection of section.subsections) {
			for (const item of parseItems(subsection.lines)) {
				const key = itemTextKey(item.lines);
				if (key) keys.add(key);
			}
		}
	}
	return keys;
}

/**
 * Drop items from [Unreleased] that already appear verbatim in a released
 * section — the residue of a release that copied [Unreleased] into the new
 * version section without clearing it. The released copy is authoritative, so
 * the Unreleased duplicate is removed. Runs before promotion (while parse line
 * numbers are still real) and only ever mutates the Unreleased section.
 */
function dropUnreleasedDuplicatesOfReleased(
	document: ChangelogDocument,
	historicalReleasedItemKeys: ReadonlySet<string> = new Set<string>(),
): number {
	const unreleased = document.sections.find(section => section.title === "Unreleased");
	if (!unreleased) return 0;
	const releasedKeys = collectReleasedItemKeys(document);
	for (const key of historicalReleasedItemKeys) releasedKeys.add(key);
	if (releasedKeys.size === 0) return 0;

	let dropped = 0;
	for (const subsection of unreleased.subsections) {
		const duplicates = parseItems(subsection.lines).filter(item => releasedKeys.has(itemTextKey(item.lines)));
		if (duplicates.length === 0) continue;
		const linesToRemove = lineRangeSet(duplicates);
		subsection.lines = subsection.lines.filter(line => !linesToRemove.has(line.lineNumber));
		dropped += duplicates.length;
	}
	return dropped;
}

function getOrCreateUnreleasedSection(document: ChangelogDocument): ReleaseSection {
	const existing = document.sections.find(section => section.title === "Unreleased");
	if (existing) return existing;

	const section: ReleaseSection = {
		heading: "## [Unreleased]",
		title: "Unreleased",
		leadingLines: [],
		subsections: [],
	};
	document.sections.unshift(section);
	return section;
}

function getOrCreateSubsection(section: ReleaseSection, title: string): Subsection {
	const existing = section.subsections.findLast(subsection => subsection.title === title);
	if (existing) return existing;

	const subsection: Subsection = { title, lines: [] };
	section.subsections.push(subsection);
	return subsection;
}

function titleOrder(title: string): number {
	const index = ORDERED_SECTION_TITLES.indexOf(title as (typeof ORDERED_SECTION_TITLES)[number]);
	return index === -1 ? ORDERED_SECTION_TITLES.length : index;
}

function compactAdjacentListSpacing(lines: readonly string[]): string[] {
	const trimmedLines = trimBlankLines(lines);
	if (trimmedLines.length === 0) return [];

	const parsedItems = parseItems(syntheticLines(trimmedLines));
	if (parsedItems.length === 0) return [...trimmedLines];

	const flattenedItems = parsedItems.flatMap(item => item.lines);
	const nonBlankOriginal = trimmedLines.filter(line => line.trim() !== "");
	const nonBlankFlattened = flattenedItems.filter(line => line.trim() !== "");
	if (
		nonBlankOriginal.length !== nonBlankFlattened.length ||
		!nonBlankOriginal.every((line, index) => line === nonBlankFlattened[index])
	) {
		return [...trimmedLines];
	}

	return flattenedItems;
}

function normalizeSection(section: ReleaseSection): FixCounters {
	const counters: FixCounters = {
		promotedItems: 0,
		mergedDuplicateHeadings: 0,
		removedEmptyHeadings: 0,
		droppedReleasedDuplicates: 0,
	};
	const subsectionByTitle = new Map<string, Subsection>();
	const normalizedSubsections: Subsection[] = [];

	for (const subsection of section.subsections) {
		const trimmedLines = compactAdjacentListSpacing(trimBlankLines(numberedText(subsection.lines)));

		if (trimmedLines.length === 0) {
			counters.removedEmptyHeadings++;
			continue;
		}

		const existing = subsectionByTitle.get(subsection.title);
		if (existing) {
			appendSubsectionLines(existing, trimmedLines);
			counters.mergedDuplicateHeadings++;
			continue;
		}

		const normalized: Subsection = {
			title: subsection.title,
			lines: syntheticLines(trimmedLines),
		};
		subsectionByTitle.set(subsection.title, normalized);
		normalizedSubsections.push(normalized);
	}

	if (section.title === "Unreleased") {
		normalizedSubsections.sort((a, b) => titleOrder(a.title) - titleOrder(b.title));
	}

	section.leadingLines = syntheticLines(trimBlankLines(numberedText(section.leadingLines)));
	section.subsections = normalizedSubsections;
	return counters;
}

function cloneReleaseSection(section: ReleaseSection): ReleaseSection {
	return {
		heading: section.heading,
		title: section.title,
		leadingLines: syntheticLines(trimBlankLines(numberedText(section.leadingLines))),
		subsections: section.subsections.map(subsection => ({
			title: subsection.title,
			lines: syntheticLines(trimBlankLines(numberedText(subsection.lines))),
		})),
	};
}

function sectionHasContent(section: ReleaseSection): boolean {
	if (trimBlankLines(numberedText(section.leadingLines)).length > 0) return true;
	return section.subsections.some(subsection => trimBlankLines(numberedText(subsection.lines)).length > 0);
}

function compareVersionTitlesDesc(left: string, right: string): number {
	const leftParts = left.split(".").map(part => Number.parseInt(part, 10));
	const rightParts = right.split(".").map(part => Number.parseInt(part, 10));
	const limit = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < limit; index++) {
		const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function sortReleaseSections(document: ChangelogDocument): void {
	const unreleasedSections = document.sections.filter(section => section.title === "Unreleased");
	const releasedSections = document.sections
		.filter(section => section.title !== "Unreleased")
		.sort((left, right) => compareVersionTitlesDesc(left.title, right.title));
	document.sections = [...unreleasedSections, ...releasedSections];
}

function rebuildReleasedSectionsFromHistory(
	content: string,
	historicalSectionsByTitle: ReadonlyMap<string, ReleaseSection>,
): string {
	if (historicalSectionsByTitle.size === 0) return content;

	const document = parseChangelog(content);
	const unreleasedSections: ReleaseSection[] = [];
	const releasedSections: ReleaseSection[] = [];
	const seenTitles = new Set<string>();
	for (const section of document.sections) {
		if (section.title === "Unreleased") {
			unreleasedSections.push(section);
			continue;
		}
		if (seenTitles.has(section.title)) continue;
		seenTitles.add(section.title);

		const historical = historicalSectionsByTitle.get(section.title);
		if (historical) {
			releasedSections.push({
				heading: section.heading,
				title: section.title,
				leadingLines: syntheticLines(trimBlankLines(numberedText(historical.leadingLines))),
				subsections: historical.subsections.map(subsection => ({
					title: subsection.title,
					lines: syntheticLines(trimBlankLines(numberedText(subsection.lines))),
				})),
			});
			continue;
		}

		releasedSections.push(section);
	}

	for (const [title, section] of historicalSectionsByTitle) {
		if (seenTitles.has(title)) continue;
		releasedSections.push(cloneReleaseSection(section));
	}

	document.sections = [...unreleasedSections, ...releasedSections];
	sortReleaseSections(document);
	return renderChangelog(document);
}

export function renderChangelog(document: ChangelogDocument): string {
	const output: string[] = [];
	const prefix = trimBlankLines(numberedText(document.prefixLines));
	if (prefix.length > 0) {
		output.push(...prefix, "");
	}

	for (const section of document.sections) {
		output.push(section.heading);
		const leading = trimBlankLines(numberedText(section.leadingLines));
		if (leading.length > 0) {
			output.push("", ...leading);
		}

		for (const subsection of section.subsections) {
			const lines = trimBlankLines(numberedText(subsection.lines));
			if (lines.length === 0) continue;
			output.push("", `### ${subsection.title}`, "", ...lines);
		}

		output.push("");
	}

	while (output.length > 0 && output[output.length - 1] === "") {
		output.pop();
	}
	return `${output.join("\n")}\n`;
}

export function fixChangelogContent(
	content: string,
	promotableAddedItemStartLines: ReadonlySet<number>,
	historicalReleasedItemKeys: ReadonlySet<string> = new Set<string>(),
): FixChangelogContentResult {
	const document = parseChangelog(content);
	let unreleased = document.sections.find(section => section.title === "Unreleased");
	let promotedItems = 0;

	const droppedReleasedDuplicates = dropUnreleasedDuplicatesOfReleased(document, historicalReleasedItemKeys);

	for (const section of document.sections) {
		if (section.title === "Unreleased") continue;

		for (const subsection of section.subsections) {
			const items = parseItems(subsection.lines).filter(item => promotableAddedItemStartLines.has(item.startLine));
			if (items.length === 0) continue;

			const linesToRemove = lineRangeSet(items);
			subsection.lines = subsection.lines.filter(line => !linesToRemove.has(line.lineNumber));

			unreleased ??= getOrCreateUnreleasedSection(document);
			const targetSubsection = getOrCreateSubsection(unreleased, subsection.title);
			for (const item of items) {
				if (!subsectionHasItem(targetSubsection, item.lines)) {
					appendSubsectionLines(targetSubsection, item.lines);
				}
				promotedItems++;
			}
		}
	}

	let mergedDuplicateHeadings = 0;
	let removedEmptyHeadings = 0;
	for (const section of document.sections) {
		const counters = normalizeSection(section);
		mergedDuplicateHeadings += counters.mergedDuplicateHeadings;
		removedEmptyHeadings += counters.removedEmptyHeadings;
	}

	sortReleaseSections(document);
	const renderedContent = renderChangelog(document);
	return {
		content: renderedContent,
		promotedItems,
		mergedDuplicateHeadings,
		removedEmptyHeadings,
		droppedReleasedDuplicates,
	};
}

function hunkKey(hunk: HunkRef): string {
	return `${hunk.path}\0${hunk.index}`;
}
function isAddedReleaseHeadingLine(line: string): boolean {
	return line.startsWith("+## [");
}

function itemKey(pathName: string, text: string): string {
	return `${pathName}\0${normalizeItemText(text)}`;
}

export function collectPromotableAddedItemLines(diffText: string): Map<string, Set<number>> {
	const candidates: AddedItemCandidate[] = [];
	const removals: RemovedItemOccurrence[] = [];
	const addedReleaseHeadingHunks = new Set<string>();
	let currentPath = "";
	let newLine = 0;
	let hunkIndex = -1;
	for (const rawLine of diffText.replace(/\r\n/g, "\n").split("\n")) {
		if (rawLine.startsWith("+++ b/")) {
			currentPath = rawLine.slice("+++ b/".length);
			continue;
		}

		if (rawLine.startsWith("diff --git ")) {
			currentPath = "";
			hunkIndex = -1;
			continue;
		}

		const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunkMatch) {
			newLine = Number(hunkMatch[2]);
			hunkIndex++;
			continue;
		}

		if (!currentPath || hunkIndex < 0 || rawLine.length === 0) continue;

		const marker = rawLine[0];
		const text = rawLine.slice(1);
		const hunk = { path: currentPath, index: hunkIndex };
		if (marker === "+") {
			const hunkKeyValue = hunkKey(hunk);
			if (isAddedReleaseHeadingLine(rawLine)) {
				addedReleaseHeadingHunks.add(hunkKeyValue);
			}
			if (isListItemLine(text)) {
				candidates.push({
					path: currentPath,
					lineNumber: newLine,
					text,
					hunk,
					pairedWithRemoval: false,
				});
			}
			newLine++;
			continue;
		}

		if (marker === "-") {
			if (isListItemLine(text)) {
				removals.push({
					path: currentPath,
					text,
					hunk,
					pairedWithAddition: false,
				});
			}
			continue;
		}

		if (marker === " ") {
			newLine++;
		}
	}

	const removalsByItem = new Map<string, RemovedItemOccurrence[]>();
	for (const removal of removals) {
		const key = itemKey(removal.path, removal.text);
		const existing = removalsByItem.get(key);
		if (existing) {
			existing.push(removal);
		} else {
			removalsByItem.set(key, [removal]);
		}
	}

	for (const candidate of candidates) {
		const sameItemRemovals = removalsByItem.get(itemKey(candidate.path, candidate.text));
		const matchingRemoval = sameItemRemovals?.find(removal => !removal.pairedWithAddition);
		if (matchingRemoval) {
			matchingRemoval.pairedWithAddition = true;
			candidate.pairedWithRemoval = true;
		}
	}

	const unpairedRemovalCountByHunk = new Map<string, number>();
	for (const removal of removals) {
		if (removal.pairedWithAddition) continue;
		const key = hunkKey(removal.hunk);
		unpairedRemovalCountByHunk.set(key, (unpairedRemovalCountByHunk.get(key) ?? 0) + 1);
	}

	const linesByPath = new Map<string, Set<number>>();
	for (const candidate of candidates) {
		const key = hunkKey(candidate.hunk);
		if (candidate.pairedWithRemoval || addedReleaseHeadingHunks.has(key)) continue;
		const unpairedRemovalCount = unpairedRemovalCountByHunk.get(key) ?? 0;
		if (unpairedRemovalCount > 0) {
			unpairedRemovalCountByHunk.set(key, unpairedRemovalCount - 1);
			continue;
		}

		const existing = linesByPath.get(candidate.path);
		if (existing) {
			existing.add(candidate.lineNumber);
		} else {
			linesByPath.set(candidate.path, new Set([candidate.lineNumber]));
		}
	}

	return linesByPath;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
	const result = await $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`
		.cwd(cwd)
		.quiet();
	return result.text();
}

export async function resolveRepoRoot(repoRoot: string | undefined): Promise<string> {
	if (repoRoot) return path.resolve(repoRoot);
	return (await git(["rev-parse", "--show-toplevel"], process.cwd())).trim();
}

async function latestTag(repoRoot: string): Promise<string> {
	return ((await gitMaybe(["describe", "--tags", "--abbrev=0", "--match", "v*"], repoRoot)) ?? "").trim();
}

async function changelogBaselineCommit(repoRoot: string): Promise<string | undefined> {
	return (await gitMaybe(["rev-parse", "--verify", "--quiet", CHANGELOG_BASELINE_REF], repoRoot))?.trim() || undefined;
}

/**
 * The diff/scan floor for both operations. Prefer the `clog` baseline (the last
 * authoritative changelog rewrite) over the latest version tag whenever the
 * baseline is newer — i.e. a `--recover` landed after the last release. Once the
 * next release tags a commit that descends from the baseline, the version tag
 * wins again, so the pin self-expires without manual cleanup.
 *
 * The baseline lives in a custom ref outside `refs/tags/`, not a tag: this repo
 * runs background `git maintenance` with `fetch.pruneTags=true`, which deletes
 * any local tag not on the remote — a lightweight `clog` tag would vanish. A
 * non-tag ref is never touched by tag pruning and stays invisible to
 * `git describe --tags`.
 */
async function resolveSince(repoRoot: string, since: string | undefined): Promise<string> {
	if (since) return since;
	const versionTag = await latestTag(repoRoot);
	const baseline = await changelogBaselineCommit(repoRoot);
	if (!baseline) return versionTag;
	if (!versionTag) return CHANGELOG_BASELINE_REF;
	const versionTagIsNewer =
		(await gitMaybe(["merge-base", "--is-ancestor", baseline, versionTag], repoRoot)) !== undefined;
	return versionTagIsNewer ? versionTag : CHANGELOG_BASELINE_REF;
}

/**
 * Tags whose released bullets `--recover` treats as authoritative. Bounded to
 * the commits at or after the `clog` baseline so a recovery never resurrects a
 * bullet that was intentionally dropped before the last authoritative rewrite;
 * without a baseline it falls back to every tag (legacy behavior).
 */
async function recoveryTags(repoRoot: string): Promise<string[]> {
	const baseline = await changelogBaselineCommit(repoRoot);
	const listArgs = baseline ? ["tag", "--contains", baseline, "--sort=v:refname"] : ["tag", "--sort=v:refname"];
	return (await git(listArgs, repoRoot))
		.split("\n")
		.map(tag => tag.trim())
		.filter(tag => tag.length > 0);
}

async function pinChangelogBaseline(repoRoot: string): Promise<string> {
	const head = (await git(["rev-parse", "HEAD"], repoRoot)).trim();
	await git(["update-ref", CHANGELOG_BASELINE_REF, head], repoRoot);
	return head;
}

async function gitMaybe(args: readonly string[], cwd: string): Promise<string | undefined> {
	const result = await $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`
		.cwd(cwd)
		.quiet()
		.nothrow();
	if (result.exitCode !== 0) return undefined;
	return result.text();
}

async function collectHistoricalReleaseRecovery(
	repoRoot: string,
	paths: readonly string[],
): Promise<Map<string, HistoricalReleaseRecovery>> {
	const tags = await recoveryTags(repoRoot);
	const recoveryByPath = new Map<string, HistoricalReleaseRecovery>();

	for (const tag of tags) {
		for (const changelogPath of paths) {
			const content = await gitMaybe(["show", `${tag}:${changelogPath}`], repoRoot);
			if (content === undefined) continue;

			const document = parseChangelog(content);
			let recovery = recoveryByPath.get(changelogPath);
			for (const section of document.sections) {
				if (section.title === "Unreleased" || !sectionHasContent(section)) continue;
				if (!recovery) {
					recovery = { itemKeys: new Set<string>(), sectionsByTitle: new Map<string, ReleaseSection>() };
					recoveryByPath.set(changelogPath, recovery);
				}
				if (!recovery.sectionsByTitle.has(section.title)) {
					recovery.sectionsByTitle.set(section.title, cloneReleaseSection(section));
				}
				if (recovery.sectionsByTitle.get(section.title) !== undefined) {
					for (const subsection of section.subsections) {
						for (const item of parseItems(subsection.lines)) {
							recovery.itemKeys.add(itemTextKey(item.lines));
						}
					}
				}
			}
		}
	}

	return recoveryByPath;
}

export async function changelogPaths(repoRoot: string): Promise<string[]> {
	const glob = new Glob(CHANGELOG_GLOB);
	const paths: string[] = [];
	for await (const changelogPath of glob.scan(repoRoot)) {
		paths.push(path.isAbsolute(changelogPath) ? path.relative(repoRoot, changelogPath) : changelogPath);
	}
	paths.sort();
	return paths;
}

async function changelogDiff(repoRoot: string, since: string, paths: readonly string[]): Promise<string> {
	if (paths.length === 0) return "";
	return git(["diff", "--unified=0", "--no-color", "--no-ext-diff", since, "--", ...paths], repoRoot);
}

export async function runChangelogFixer(options: RunChangelogFixerOptions = {}): Promise<RunChangelogFixerResult> {
	const repoRoot = await resolveRepoRoot(options.repoRoot);
	const since = await resolveSince(repoRoot, options.since);
	const paths = await changelogPaths(repoRoot);
	const addedItemLines = options.recover
		? new Map<string, Set<number>>()
		: collectPromotableAddedItemLines(await changelogDiff(repoRoot, since, paths));
	const historicalRecoveryByPath = options.recover
		? await collectHistoricalReleaseRecovery(repoRoot, paths)
		: new Map<string, HistoricalReleaseRecovery>();
	const changedFiles: ChangedChangelogSummary[] = [];

	for (const changelogPath of paths) {
		const absolutePath = path.join(repoRoot, changelogPath);
		const currentContent = await Bun.file(absolutePath).text();
		const historicalRecovery = historicalRecoveryByPath.get(changelogPath);
		const recoveredContent =
			historicalRecovery === undefined
				? currentContent
				: rebuildReleasedSectionsFromHistory(currentContent, historicalRecovery.sectionsByTitle);
		const result = fixChangelogContent(
			recoveredContent,
			addedItemLines.get(changelogPath) ?? new Set<number>(),
			historicalRecovery?.itemKeys ?? new Set<string>(),
		);
		if (result.content === currentContent) continue;

		changedFiles.push({
			path: changelogPath,
			promotedItems: result.promotedItems,
			mergedDuplicateHeadings: result.mergedDuplicateHeadings,
			droppedReleasedDuplicates: result.droppedReleasedDuplicates,
			removedEmptyHeadings: result.removedEmptyHeadings,
		});

		if (options.write !== false) {
			await Bun.write(absolutePath, result.content);
		}
	}

	return { since, changedFiles };
}

async function dirtyChangelogs(repoRoot: string): Promise<string[]> {
	const paths = await changelogPaths(repoRoot);
	if (paths.length === 0) return [];
	return (await git(["status", "--porcelain", "--", ...paths], repoRoot))
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

function parseCliArgs(args: readonly string[]): CliOptions {
	const options: CliOptions = { mode: "write", recover: false, pin: false, help: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "--dry-run":
				options.mode = "dry-run";
				break;
			case "--check":
				options.mode = "check";
				break;
			case "--recover":
				options.recover = true;
				break;
			case "--pin":
				options.pin = true;
				break;
			case "--since": {
				const value = args[index + 1];
				if (!value) throw new Error("--since requires a tag or commit");
				options.since = value;
				index++;
				break;
			}
			case "--repo-root": {
				const value = args[index + 1];
				if (!value) throw new Error("--repo-root requires a path");
				options.repoRoot = value;
				index++;
				break;
			}
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function usage(): string {
	return [
		"Usage: bun scripts/fix-changelogs.ts [--dry-run|--check] [--since <tag>] [--recover] [--pin]",
		"",
		"Moves changelog items added since the baseline from released sections into [Unreleased],",
		"drops [Unreleased] items that already appear verbatim in a released section, removes",
		"blank separators between adjacent bullet items, then removes duplicate or empty",
		"### category headings.",
		"",
		`The baseline defaults to the '${CHANGELOG_BASELINE_NAME}' ref (the last authoritative rewrite)`,
		"when it is newer than the latest version tag, otherwise the latest version tag — so a",
		"--recover is not undone by a later plain run.",
		"",
		"With --recover, the fixer scans every tagged changelog snapshot from the baseline forward",
		"and treats every historically released bullet as authoritative, so stale [Unreleased]",
		"items copied forward by past bad releases are pruned even if the current file no longer",
		"contains a matching released copy. After committing a recovery, run --pin to mark it.",
		"",
		`With --pin, move the '${CHANGELOG_BASELINE_NAME}' baseline ref to HEAD and exit without fixing.`,
		"",
		"Options:",
		"  --dry-run          Print what would change without writing files.",
		"  --check            Exit 1 if any changelog would change.",
		"  --since <tag>      Compare changelog additions against this tag/commit instead of the baseline.",
		"  --recover          Rebuild against historically released bullets from the baseline forward.",
		`  --pin              Move the '${CHANGELOG_BASELINE_NAME}' baseline ref to HEAD, then exit.`,
		"  --repo-root <dir>  Run against an explicit repository root.",
	].join("\n");
}

function printSummary(result: RunChangelogFixerResult, mode: CliOptions["mode"]): void {
	const suffix = mode === "write" ? "" : ` (${mode}, not written)`;
	if (result.changedFiles.length === 0) {
		console.log(`Changelogs already clean since ${result.since}.`);
		return;
	}

	console.log(`Fixed ${result.changedFiles.length} changelog(s) since ${result.since}${suffix}:`);
	for (const file of result.changedFiles) {
		const parts = [
			`${file.promotedItems} promoted item(s)`,
			`${file.mergedDuplicateHeadings} merged duplicate heading(s)`,
			`${file.droppedReleasedDuplicates} dropped released duplicate(s)`,
			`${file.removedEmptyHeadings} removed empty heading(s)`,
		];
		console.log(`  ${file.path}: ${parts.join(", ")}`);
	}
}

async function main(): Promise<void> {
	try {
		const cliOptions = parseCliArgs(process.argv.slice(2));
		if (cliOptions.help) {
			console.log(usage());
			return;
		}

		if (cliOptions.pin) {
			const repoRoot = await resolveRepoRoot(cliOptions.repoRoot);
			const dirty = await dirtyChangelogs(repoRoot);
			if (dirty.length > 0) {
				console.warn(
					`Warning: ${dirty.length} changelog file(s) have uncommitted changes; the pinned commit ` +
						"will not include them. Commit first, then re-run --pin.",
				);
			}
			const head = await pinChangelogBaseline(repoRoot);
			console.log(
				`Pinned changelog baseline '${CHANGELOG_BASELINE_NAME}' (${CHANGELOG_BASELINE_REF}) to ${head.slice(0, 12)}.`,
			);
			return;
		}

		const result = await runChangelogFixer({
			repoRoot: cliOptions.repoRoot,
			since: cliOptions.since,
			write: cliOptions.mode === "write",
			recover: cliOptions.recover,
		});
		printSummary(result, cliOptions.mode);
		if (cliOptions.recover && cliOptions.mode === "write" && result.changedFiles.length > 0) {
			console.log(
				`\nAuthoritative rewrite written. Commit the changelog changes, then run ` +
					`'bun scripts/fix-changelogs.ts --pin' to move the '${CHANGELOG_BASELINE_NAME}' baseline ref.`,
			);
		}
		if (cliOptions.mode === "check" && result.changedFiles.length > 0) {
			process.exit(1);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
