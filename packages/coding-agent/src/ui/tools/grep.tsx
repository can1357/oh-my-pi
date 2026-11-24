/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Grep: `Grep “pattern” in src  5 matches · 2 files`, then the matches
 * grouped by file (a file row and a numbered code excerpt with the match
 * lines marked). Collapsed shows the first two files.
 *
 * Terminal look: `grep` (`src/ui/styles/tools/grep.ts`): a status-glyph head
 * line and a branch tree of files and their match rows.
 */
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import { highlightSpans } from "@oh-my-pi/pi-tui/text/highlight";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import {
	classifyGroupedLines,
	type GroupedLinks,
	groupedLinks,
	groupedOutputNodes,
	isGroupedHeader,
} from "./grouped-output";
import type { OutputMeta } from "../../tools/output-meta-format";
import { toPathList } from "../../utils/render-utils";
import { registerToolPresenter } from "./registry";
import { countText, inlineErrorView, StatsFoot } from "./search-common";

/** The args grep shows. */
export interface GrepArgs {
	readonly pattern?: string;
	readonly path?: string | string[];
	/** Pre-`path` argument name (a list or one delimited string); historical transcripts carry it. */
	readonly paths?: string | string[];
	readonly glob?: string;
	readonly i?: boolean;
	readonly context?: number;
	/** `false`: case-insensitive. */
	readonly case?: boolean;
	readonly gitignore?: boolean;
	readonly skip?: number;
}

/** Result details grep reports. */
export interface GrepDetails {
	readonly matchCount?: number;
	readonly fileCount?: number;
	/** The matched files (cwd-relative display paths). */
	readonly files?: readonly string[];
	readonly displayContent?: string;
	readonly error?: string;
	readonly truncated?: boolean;
	readonly scopePath?: string;
	readonly searchPath?: string;
	readonly cwd?: string;
	/** Files internal-URL headers resolved to when the search ran. */
	readonly displayTargets?: Readonly<Record<string, string>>;
	readonly missingPaths?: readonly string[];
	readonly binaryMatches?: readonly string[];
	readonly meta?: Pick<OutputMeta, "truncation" | "artifactError" | "source"> & {
		readonly limits?: { readonly columnTruncated?: unknown };
	};
}

/** Files listed while collapsed. */
const COLLAPSED_FILES = 2;
/** Body rows shown while collapsed. */
const PREVIEW_LINES = 12;

/** A pattern highlighted by the regex grammar, tabs drawn as spaces; plain text when nothing is styled. */
export function patternText(pattern: string): TspText {
	const spans: TspSpan[] = [];
	const push = (span: TspSpan): void => {
		const last = spans[spans.length - 1];
		if (last && last.s === span.s) spans[spans.length - 1] = { ...last, t: last.t + span.t };
		else spans.push(span);
	};
	highlightSpans(pattern, "Regular Expression").forEach((line, i) => {
		if (i > 0) push({ t: "\n" });
		for (const span of line) push({ ...span, t: replaceTabs(span.t) });
	});
	if (spans.length === 0) return "";
	return spans.length === 1 && spans[0]!.s === undefined ? spans[0]!.t : spans;
}

/** The searched paths. */
export function argPaths(args: GrepArgs | undefined): string[] {
	if (!args) return [];
	return toPathList(args.paths ?? args.path).filter(path => typeof path === "string" && path !== "");
}

/** Flag arguments that differ from the defaults: `case:insensitive`, `gitignore:false`, `skip:N`. */
function flagMeta(args: GrepArgs): string[] {
	const meta: string[] = [];
	if (args.case === false) meta.push("case:insensitive");
	if (args.gitignore === false) meta.push("gitignore:false");
	if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);
	return meta;
}

/** The head: the pattern, then `meta`, or before a result, the scope (`in src, test`) and flag arguments. */
function grepHead(args: GrepArgs | undefined, meta?: readonly (TspText | undefined)[]): ToolHead {
	const pattern = args?.pattern;
	const facts: TspText[] = [];
	if (meta) {
		for (const fact of meta) if (fact !== undefined) facts.push(fact);
	} else if (args) {
		const paths = argPaths(args);
		if (paths.length > 0) facts.push(`in ${paths.join(", ")}`);
		facts.push(...flagMeta(args));
	}
	return {
		title: "Grep",
		target: pattern ? patternText(pattern) : "?",
		targetKind: "pattern",
		meta: facts,
	};
}

/** One line of grep output. */
export interface GrepLine {
	/** The row's gutter as printed (`*12│`, ` *9│`, ` 3│`). */
	readonly prefix: string;
	readonly line: number;
	readonly match: boolean;
	readonly text: string;
}

/** Lines of one file (or of the single searched file, without a path). */
export interface GrepGroup {
	readonly path?: string;
	readonly lines: GrepLine[];
}

const ROW = /^( *(\*?)(\d+)│)(.*)$/;

/**
 * Parse grep's grouped output: `#` directory and file headers at any depth (a file header's path
 * is the directory chain above it), `*N│` match and ` N│` context rows. Rows before any header
 * form a headerless group (a single-file search).
 */
export function parseGrepOutput(text: string): GrepGroup[] {
	const lines = text.split("\n");
	const rows = classifyGroupedLines(lines);
	const groups: GrepGroup[] = [];
	let current: GrepGroup | undefined;
	for (let i = 0; i < lines.length; i++) {
		const kind = rows[i]!.kind;
		if (kind !== "content") {
			current = undefined;
			if (kind === "file") {
				current = { path: rows[i]!.path, lines: [] };
				groups.push(current);
			}
			continue;
		}
		const row = ROW.exec(lines[i]!);
		if (!row) continue;
		if (!current) {
			current = { lines: [] };
			groups.push(current);
		}
		current.lines.push({ prefix: row[1]!, match: row[2] === "*", line: Number(row[3]), text: row[4]! });
	}
	return groups.filter(group => group.lines.length > 0);
}

function notes(details: GrepDetails | undefined): (string | undefined)[] {
	const missing = details?.missingPaths ?? [];
	const binary = details?.binaryMatches?.length ?? 0;
	return [
		missing.length > 0 ? `skipped missing: ${missing.join(", ")}` : undefined,
		binary > 0 ? `binary matches: ${countText(binary, "file")}` : undefined,
	];
}

/** The terminal facts the look needs beyond the native view. */
export type GrepTerm = {
	readonly look: "grep";
	/** Searched paths (`in src`), from the args. */
	readonly scope?: string;
	/** Output rows (detailed results: the grouped output; plain results: the non-empty lines). */
	readonly output?: string;
	/** The result carried match counts. */
	readonly detailed?: boolean;
	readonly matchCount?: number;
	/** Missing/binary notes, each its own row. */
	readonly notes?: readonly string[];
	/** The message of an empty result without details. */
	readonly empty?: string;
	/** A failed search's message. */
	readonly error?: string;
	/** Where the output's paths lead (file and match rows link). */
	readonly links?: GroupedLinks;
	/** The searched path the scope links to. */
	readonly scopeLink?: string;
};

function term(args: GrepArgs | undefined, extra: Omit<GrepTerm, "look" | "scope">): GrepTerm {
	const paths = argPaths(args);
	return {
		look: "grep",
		scope: paths.length > 0 ? paths.join(", ") : undefined,
		...extra,
	};
}

/** A result's links: its output's paths, and its one searched path (the tool's scope) as the scope's. */
function resultLinks(
	args: GrepArgs | undefined,
	details: GrepDetails | undefined,
): Pick<GrepTerm, "links" | "scopeLink"> {
	const links = groupedLinks(details);
	const scopeLink = details?.scopePath && argPaths(args).length === 1 ? details.searchPath : undefined;
	return { ...(links ? { links } : {}), ...(scopeLink ? { scopeLink } : {}) };
}

export const grepPresenter: ToolPresenter<GrepArgs, GrepDetails> = {
	inline: true,
	merge: true,
	call: args => ({ head: grepHead(args), term: term(args, {}) }),
	result(result, state, args): ToolView {
		const details = result.details;
		const text = details?.displayContent ?? resultText(result);
		if (result.isError || details?.error) {
			const message = details?.error || resultText(result) || "Unknown error";
			return inlineErrorView(grepHead(args), message, { term: term(args, { error: message }) });
		}
		const detailed = details?.matchCount !== undefined || details?.fileCount !== undefined;
		const matchCount = details?.matchCount ?? 0;
		const footNotes = notes(details);
		const rowNotes = footNotes.filter((note): note is string => note !== undefined);
		const scope = details?.scopePath ? `in ${details.scopePath}` : undefined;
		if ((!detailed && (!text || text === "No matches found")) || (detailed && matchCount === 0)) {
			return {
				head: grepHead(args, [scope, "0 matches"]),
				tone: "warning",
				body: <StatsFoot notes={footNotes} />,
				term: detailed
					? term(args, { detailed, matchCount, notes: rowNotes, ...resultLinks(args, details) })
					: term(args, { empty: "No matches found" }),
			};
		}
		const lines = text.split("\n");
		const fileCount = details?.fileCount ?? 0;
		const singleFile = scope !== undefined && fileCount === 1 && !lines.some(isGroupedHeader);
		const counts = detailed
			? singleFile
				? countText(matchCount, "match")
				: `${countText(matchCount, "match")} · ${countText(fileCount, "file")}`
			: undefined;
		const truncated = Boolean(
			details?.truncated || details?.meta?.truncation || details?.meta?.limits?.columnTruncated,
		);
		const hidden = state.expanded ? 0 : Math.max(0, fileCount - COLLAPSED_FILES);
		const head = grepHead(args, [scope, counts]);
		return {
			head: truncated ? { ...head, badges: [{ text: "truncated", tone: "warning" }] } : head,
			preview: { lines: PREVIEW_LINES },
			body: [
				groupedOutputNodes(lines, {
					...(state.expanded ? {} : { maxFiles: COLLAPSED_FILES }),
					...(details?.files?.length === 1 ? { file: details.files[0] } : {}),
				}),
				<StatsFoot
					notes={[hidden > 0 ? countText(hidden, "more file", "more files") : undefined, ...footNotes]}
					meta={details?.meta}
				/>,
			],
			term: detailed
				? term(args, { output: text, detailed, matchCount, notes: rowNotes, ...resultLinks(args, details) })
				: term(args, { output: text, ...resultLinks(args, details) }),
		};
	},
};

registerToolPresenter("grep", grepPresenter);
