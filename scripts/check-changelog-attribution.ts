#!/usr/bin/env bun
/**
 * Checks the entries a change adds to a package CHANGELOG.
 *
 * Two rules from AGENTS.md that reviewers keep correcting by hand:
 *
 * 1. New entries always go under `## [Unreleased]`. A released section is
 *    immutable, so an added bullet there is always a mistake.
 * 2. An external contribution credits the PR and its author:
 *    `([#123](https://github.com/<repo>/pull/123) by [@login](https://github.com/login))`.
 *    Internal fixes keep their issue link.
 *
 * Usage:
 *   bun scripts/check-changelog-attribution.ts --base origin/main
 *   bun scripts/check-changelog-attribution.ts --base <sha> --pr 123 --author login --association CONTRIBUTOR
 *
 * Without `--pr`, only rule 1 runs (local use); the issue/PR link check needs
 * PR context. CI passes the pull request
 * number, author, and `author_association`; MEMBER/OWNER/COLLABORATOR skip
 * rule 2 because internal fixes cite issues instead.
 */
import * as path from "node:path";
import { $ } from "bun";

export const DEFAULT_REPO = "can1357/oh-my-pi";
const INTERNAL_ASSOCIATIONS = new Set(["MEMBER", "OWNER", "COLLABORATOR"]);

export interface AddedLine {
	/** 1-based line number in the new file. */
	line: number;
	text: string;
}

export interface EvaluateArgs {
	path: string;
	changelog: string;
	added: AddedLine[];
	repo?: string;
	prNumber?: number;
	author?: string;
	association?: string;
}

/** 1-based inclusive range of `## [Unreleased]`, or null when the section is missing. */
export function unreleasedRange(lines: readonly string[]): { start: number; end: number } | null {
	const start = lines.findIndex(line => line.trim() === "## [Unreleased]");
	if (start < 0) return null;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		if (lines[index].startsWith("## ")) {
			end = index;
			break;
		}
	}
	return { start: start + 1, end };
}

function hasAnyRepoLink(entry: string, repo: string): boolean {
	const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\]\\(https://github\\.com/${escaped}/(?:issues|pull)/\\d+\\)`).test(entry);
}

function hasPullCredit(entry: string, repo: string, prNumber: number, author: string): boolean {
	const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pull = new RegExp(`\\]\\(https://github\\.com/${escaped}/pull/${prNumber}\\)`).test(entry);
	const credit = new RegExp(
		`by \\[@${author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(https://github\\.com/${author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
		"i",
	).test(entry);
	return pull && credit;
}

/** Same item detection as `fix-changelogs.ts`: nested bullets are items too. */
function isListItemLine(line: string): boolean {
	return line.trimStart().startsWith("- ");
}

/**
 * Full text of the item whose bullet `first` sits at 1-based `line`, plus its
 * wrapped continuation lines, up to the next item, heading, or blank line.
 */
export function itemText(lines: readonly string[], line: number, first: string): string {
	const parts = [first];
	for (let index = line; index < lines.length; index++) {
		const next = lines[index];
		if (next.trim() === "" || isListItemLine(next) || next.trimStart().startsWith("#")) break;
		parts.push(next);
	}
	return parts.map(part => part.trim()).join(" ");
}

/** Problems for one changelog file, one per offending added entry. */
export function evaluateChangelog(args: EvaluateArgs): string[] {
	const repo = args.repo ?? DEFAULT_REPO;
	const lines = args.changelog.split("\n");
	const range = unreleasedRange(lines);
	const inPullRequest = args.prNumber !== undefined;
	const external =
		inPullRequest && args.author !== undefined && !INTERNAL_ASSOCIATIONS.has((args.association ?? "").toUpperCase());
	const problems: string[] = [];

	for (const added of args.added) {
		if (!isListItemLine(added.text)) continue;
		const where = `${args.path}:${added.line}`;
		if (!range || added.line <= range.start || added.line > range.end) {
			problems.push(`${where} adds a changelog entry outside "## [Unreleased]"; released sections are immutable`);
			continue;
		}
		if (!inPullRequest) continue;
		const entry = itemText(lines, added.line, added.text);
		if (!hasAnyRepoLink(entry, repo)) {
			problems.push(`${where} has no issue or pull request link`);
			continue;
		}
		if (external && !hasPullCredit(entry, repo, args.prNumber!, args.author!)) {
			problems.push(
				`${where} must credit this PR and its author: ` +
					`([#${args.prNumber}](https://github.com/${repo}/pull/${args.prNumber}) by [@${args.author}](https://github.com/${args.author}))`,
			);
		}
	}

	return problems;
}

interface HunkLine {
	path: string;
	line: number;
	text: string;
}

/** Added lines from `git diff -U0`, resolved to new-file line numbers. */
export function parseAddedLines(diff: string): HunkLine[] {
	const added: HunkLine[] = [];
	let currentPath: string | undefined;
	let nextLine = 0;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ b/")) {
			currentPath = raw.slice("+++ b/".length);
			continue;
		}
		if (raw.startsWith("+++ ")) {
			currentPath = undefined;
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
		if (hunk) {
			nextLine = Number(hunk[1]);
			continue;
		}
		if (!currentPath) continue;
		if (raw.startsWith("+")) {
			added.push({ path: currentPath, line: nextLine, text: raw.slice(1) });
			nextLine++;
			continue;
		}
		// Context lines do not advance the new file in -U0 hunks, but a bare
		// "\ No newline" marker does not either.
	}
	return added;
}

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
	const base = arg("base") ?? "origin/main";
	const repo = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
	const prNumber = arg("pr") ? Number(arg("pr")) : undefined;
	const author = arg("author");
	const association = arg("association");

	const diff = await $`git diff --unified=0 --no-color ${base} HEAD -- packages/*/CHANGELOG.md`.quiet().text();
	const byPath = new Map<string, AddedLine[]>();
	for (const entry of parseAddedLines(diff)) {
		const list = byPath.get(entry.path) ?? [];
		list.push({ line: entry.line, text: entry.text });
		byPath.set(entry.path, list);
	}

	const problems: string[] = [];
	for (const [file, added] of byPath) {
		const changelog = await Bun.file(path.resolve(file)).text();
		problems.push(...evaluateChangelog({ path: file, changelog, added, repo, prNumber, author, association }));
	}

	if (problems.length > 0) {
		for (const problem of problems) console.error(problem);
		console.error(`\nFix the changelog entries above (AGENTS.md § Changelog).`);
		process.exit(1);
	}
	console.log(`OK: ${byPath.size} changelog file(s) checked against ${base}`);
}
