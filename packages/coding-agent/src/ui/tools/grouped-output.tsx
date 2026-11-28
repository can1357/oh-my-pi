/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Grouped file output, as ast-grep and ast-edit print it for display:
 *
 *   # src/            directory header (one `#` per nesting level)
 *   ## a.ts (2 replacements)   file header, optional `(note)`
 *   *12│matched line  numbered code-frame rows (`*` marks a match)
 *    13│context
 *     meta: $A=x     anything else is a plain body row
 *
 * Blank lines separate groups. This module reads that text back (headers
 * resolved to full display paths) and describes it for Tern: per file a
 * path row and its lines as numbered `code` with match marks.
 */

import * as nodePath from "node:path";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { isUrlLikePath } from "@oh-my-pi/pi-utils";
import { HASHLINE_TAG_SUFFIX_RE } from "../../tools/hashline-format";
import { countText, pathSpans } from "./search-common";

const HEADER = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX = /\s+\([^)]*\)\s*$/;
/** `*12│text`, ` 12|text`, `*12:text`: match marker, line number, gutter, content. */
export const NUMBERED_ROW = /^\s*(\*?)(\d+)(?:│|[:|])(.*)$/;
const MATCH_ROW = /^\s*\*\d+(?:│|[:|])/;
/** `    │...`: a gap between non-adjacent context runs. */
const GAP_ROW = /^\s*│\.\.\.$/;

/** Whether a row is a code-frame row the search matched (`*12│…`). */
export function isMatchRow(line: string): boolean {
	return MATCH_ROW.test(line);
}

/** Whether a row is a `#` directory or file header (a single-file search prints none). */
export function isGroupedHeader(line: string): boolean {
	return HEADER.test(line);
}

/** One row of grouped output. */
export interface GroupedRow {
	readonly kind: "dir" | "file" | "content";
	/** `#` count of a header. */
	readonly depth: number;
	/** A file header's full display path (the folded directory chain and its name, without the hashline tag). */
	readonly path?: string;
	/** A file header's trailing `(note)`. */
	readonly suffix?: string;
	/** A header naming a URL. */
	readonly url?: boolean;
}

/** Classify every row, resolving file headers against the directory headers above them. */
export function classifyGroupedLines(lines: readonly string[]): GroupedRow[] {
	const rows: GroupedRow[] = [];
	const dirs: string[] = [];
	for (const line of lines) {
		const match = HEADER.exec(line);
		if (!match) {
			rows.push({ kind: "content", depth: 0 });
			continue;
		}
		const depth = match[1]!.length;
		const rest = match[2]!.trimEnd();
		const url = isUrlLikePath(rest);
		dirs.length = depth - 1;
		if (!url && rest.endsWith("/")) {
			dirs.push(rest);
			rows.push({ kind: "dir", depth });
			continue;
		}
		const suffix = HEADER_SUFFIX.exec(rest);
		const target = suffix ? rest.slice(0, suffix.index) : rest;
		const name = target.replace(HASHLINE_TAG_SUFFIX_RE, "");
		const note = suffix?.[0].trim();
		rows.push({
			kind: "file",
			depth,
			path: url ? name : dirs.join("") + name,
			...(note ? { suffix: note } : {}),
			...(url ? { url: true } : {}),
		});
	}
	return rows;
}

/** Where grouped output's display paths lead: the terminal looks link file and line rows with them. */
export interface GroupedLinks {
	/** What the cwd-relative display paths resolve against: the session cwd, else the search path. */
	readonly base?: string;
	/** The searched path: it owns the rows before any file header (a single-file search). */
	readonly scope?: string;
	/** The files internal-URL headers resolved to when the tool ran. */
	readonly targets?: Readonly<Record<string, string>>;
}

/** The links of a search's grouped output; undefined when nothing locates its paths. */
export function groupedLinks(
	details:
		| {
				readonly cwd?: string;
				readonly searchPath?: string;
				readonly displayTargets?: Readonly<Record<string, string>>;
		  }
		| undefined,
): GroupedLinks | undefined {
	const base = details?.cwd ?? details?.searchPath;
	const scope = details?.searchPath;
	const targets = details?.displayTargets;
	if (base === undefined && scope === undefined && targets === undefined) return undefined;
	return {
		...(base !== undefined ? { base } : {}),
		...(scope !== undefined ? { scope } : {}),
		...(targets !== undefined ? { targets } : {}),
	};
}

/**
 * Where a display path (a header's, or the scope) leads: its file resolved
 * against the base, a URL header's resolved file, or the URL itself when the
 * tool could not resolve it.
 */
export function groupedLinkTarget(
	links: GroupedLinks,
	displayPath: string,
): { readonly file?: string; readonly url?: string } {
	if (isUrlLikePath(displayPath)) {
		const file = links.targets?.[displayPath];
		return file ? { file } : { url: displayPath };
	}
	const base = links.base !== undefined && !isUrlLikePath(links.base) ? links.base : undefined;
	return base === undefined ? {} : { file: nodePath.resolve(base, displayPath) };
}

/**
 * Each row's owning display path: a file header's own, a body row's file
 * header above it (before any header, the scope); none under a bare
 * directory header.
 */
export function groupedRowOwners(rows: readonly GroupedRow[], scope?: string): (string | undefined)[] {
	let owner = scope;
	return rows.map(row => {
		if (row.kind === "dir") owner = undefined;
		else if (row.kind === "file") owner = row.path;
		return owner;
	});
}

/** Row indices split at blank lines (one group when there are none). */
export function groupLineIndicesByBlank(lines: readonly string[]): number[][] {
	const groups: number[][] = [];
	let current: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim().length === 0) {
			if (current.length > 0) groups.push(current);
			current = [];
			continue;
		}
		current.push(i);
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

/**
 * Groups with one file each: directory headers dropped (each file row names
 * its full path), every file header starting a group. Rows before a group's
 * first file header keep their group.
 */
export function groupsByFile(groups: readonly (readonly number[])[], rows: readonly GroupedRow[]): number[][] {
	const result: number[][] = [];
	for (const group of groups) {
		let current: number[] = [];
		for (const index of group) {
			const kind = rows[index]!.kind;
			if (kind === "dir") continue;
			if (kind === "file" && current.length > 0) {
				result.push(current);
				current = [];
			}
			current.push(index);
		}
		if (current.length > 0) result.push(current);
	}
	return result;
}

/** The output's rows without groups that start with one of `drop` (limit and parse notes), blank-separated. */
export function keptGroupedLines(lines: readonly string[], drop: readonly string[], separate: boolean): string[] {
	return groupLineIndicesByBlank(lines)
		.filter(indices => !drop.some(prefix => lines[indices[0]!]!.startsWith(prefix)))
		.flatMap(indices => {
			const kept = indices.map(index => lines[index]!);
			return separate ? [...kept, ""] : kept;
		});
}

/** One event of a walk over grouped output: a directory header, a file header, or a non-blank body row. */
export type GroupedEvent =
	| { readonly kind: "dir" }
	| { readonly kind: "file"; readonly path: string; readonly suffix?: string }
	| { readonly kind: "line"; readonly text: string };

/** Walk grouped output, file headers resolved to full paths, blank rows dropped. */
export function* walkGroupedOutput(lines: readonly string[]): Generator<GroupedEvent> {
	const rows = classifyGroupedLines(lines);
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index]!;
		if (row.kind === "dir") yield { kind: "dir" };
		else if (row.kind === "file")
			yield {
				kind: "file",
				path: row.path ?? "",
				...(row.suffix ? { suffix: row.suffix } : {}),
			};
		else if (lines[index]!.trim().length > 0) yield { kind: "line", text: lines[index]! };
	}
}

interface NumberedLine {
	readonly n: number | null;
	readonly text: string;
	readonly mark?: boolean;
}

/** One numbered `code` block (`start` when contiguous, else `nums`), match lines marked; nothing without numbers. */
function NumberedCode(props: { readonly lines: readonly NumberedLine[]; readonly path?: string }): JSXNode {
	const nums: number[] = [];
	const body: string[] = [];
	const marks: { line: number; tone: "accent" }[] = [];
	let contiguous = true;
	for (const line of props.lines) {
		if (line.n === null) continue;
		if (nums.length > 0 && line.n !== nums[nums.length - 1]! + 1) contiguous = false;
		nums.push(line.n);
		body.push(line.text);
		if (line.mark) marks.push({ line: line.n, tone: "accent" });
	}
	if (nums.length === 0) return undefined;
	return (
		<code
			key={`c${nums[0]}`}
			text={body.join("\n")}
			start={contiguous ? nums[0] : undefined}
			nums={contiguous ? undefined : nums}
			numbers
			path={props.path}
			marks={marks.length > 0 ? marks : undefined}
		/>
	);
}

/** A file's path row (`omp.tool.file`): icon, path cut in the middle, the header's note or match count as a badge. */
function GroupedFileRow(props: {
	readonly path: string;
	readonly badge?: { readonly text: string; readonly title?: string };
}): JSXNode {
	return (
		<row key="file" role="omp.tool.file">
			<icon name="file" />
			<text spans={pathSpans(props.path)} title={props.path} truncate="middle" lines={1} shrink={1} />
			{props.badge ? <badge text={props.badge.text} title={props.badge.title} /> : undefined}
		</row>
	);
}

/**
 * Grouped output by file (`omp.tool.search.file`): its path row, then its
 * rows as numbered code (match lines marked, gaps from jumps in the numbers);
 * unnumbered rows stay plain `code`. Rows before any header are loose, unless
 * `file` owns them (a single-file search prints no header, yet its rows get the
 * same file row). `maxFiles` keeps the first files only (the caller says how
 * many it left out).
 */
export function groupedOutputNodes(
	lines: readonly string[],
	options: { readonly maxFiles?: number; readonly file?: string } = {},
): JSXNode[] {
	const files: JSXNode[] = [];
	const loose: JSXNode[] = [];
	let current: { path: string; suffix?: string; children: JSXNode[]; marks: number } | undefined;
	let numbered: NumberedLine[] = [];
	let plain: string[] = [];
	// `options.file` until the first row or header claims it.
	let headless = options.file;
	const flushLines = (): void => {
		const target = current?.children ?? loose;
		const block = <NumberedCode lines={numbered} path={current?.path} />;
		if (block !== undefined) target.push(block);
		numbered = [];
		if (plain.length > 0) {
			target.push(<code key={`p${target.length}`} text={plain.join("\n")} />);
			plain = [];
		}
	};
	const flushFile = (): void => {
		flushLines();
		if (!current) return;
		const count = current.marks;
		const badge = current.suffix
			? { text: current.suffix.replace(/^\(|\)$/g, "") }
			: count > 0
				? { text: String(count), title: countText(count, "match") }
				: undefined;
		files.push(
			<col key={`f:${current.path}`} gap="xs" role="omp.tool.search.file">
				<GroupedFileRow path={current.path} badge={badge} />
				{current.children}
			</col>,
		);
		current = undefined;
	};
	for (const event of walkGroupedOutput(lines)) {
		if (event.kind !== "line") {
			headless = undefined;
			flushFile();
			if (options.maxFiles !== undefined && files.length >= options.maxFiles) break;
			if (event.kind === "file")
				current = {
					path: event.path,
					...(event.suffix ? { suffix: event.suffix } : {}),
					children: [],
					marks: 0,
				};
			continue;
		}
		if (headless !== undefined) {
			current = { path: headless, children: [], marks: 0 };
			headless = undefined;
		}
		if (GAP_ROW.test(event.text)) {
			numbered.push({ n: null, text: "" });
			continue;
		}
		const match = NUMBERED_ROW.exec(event.text);
		if (!match) {
			if (numbered.length > 0) flushLines();
			plain.push(event.text);
			continue;
		}
		if (plain.length > 0) flushLines();
		const mark = match[1] === "*";
		if (mark && current) current.marks++;
		numbered.push({ n: Number.parseInt(match[2]!, 10), text: match[3]!, mark });
	}
	flushFile();
	return [...loose, ...files];
}

/** Parse issues as a folded warning section over their list. */
export function ParseIssues(props: { readonly errors: readonly string[]; readonly total?: number }): JSXNode {
	if (props.errors.length === 0) return undefined;
	return (
		<section
			key="parse-errors"
			head={[{ s: "warning", t: parseIssuesLabel(props.errors, props.total) }]}
			collapsible
			collapsed
		>
			<code text={props.errors.join("\n")} />
		</section>
	);
}

/** Parse issues listed at most. */
export const PARSE_ERRORS_LIMIT = 20;

/** `3 parse issues`, or `20 / 31 parse issues` past the cap. */
export function parseIssuesLabel(errors: readonly string[], total?: number): string {
	const count = total ?? errors.length;
	return count > PARSE_ERRORS_LIMIT
		? `${PARSE_ERRORS_LIMIT} / ${count} parse issues`
		: `${count} parse issue${count !== 1 ? "s" : ""}`;
}

/** Paths a scope argument names: a list, a JSON-encoded list, or one path. */
export function pathList(input: string | readonly string[] | undefined): string[] {
	if (input === undefined) return [];
	if (typeof input !== "string") return [...input];
	const trimmed = input.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) return parsed as string[];
		} catch {
			// a literal path that happens to look like JSON
		}
	}
	return [input];
}
