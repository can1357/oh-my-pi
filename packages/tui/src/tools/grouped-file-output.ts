import * as path from "node:path";

import {
	buildPathTree,
	isRecord,
	isUrlLikePath,
	type PathTreeInput,
	sanitizeText,
	walkPathTree,
} from "@oh-my-pi/pi-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { code, col, keyed } from "../native/describe";
import type { NativeNode } from "../native/node";
import { getLanguageFromPath } from "../lang-from-path";
import { fileHyperlink, uriHyperlink } from "../render/hyperlink";
import { FILE_NAME_COLOR, formatMoreItems, formatStyledPath, replaceTabs } from "../render/render-utils";
import { highlightCode, isHighlightLanguage, type Theme, type ThemeColor } from "../theme/theme";
import { formatHashlineHeader, HASHLINE_TAG_SUFFIX_RE } from "./hashline-format";
import { fileRow } from "./native-view";

// =============================================================================
// Grouped file output (grep / ast-grep / ast-edit / lsp diagnostics)
// =============================================================================

/**
 * One file's contribution to a grouped file output. The header itself is generated
 * by `formatGroupedFiles` (one `#` per nesting level); use `headerSuffix` to tack
 * on extras like ` (1 replacement)`.
 */
export interface GroupedFileSection {
	/** Optional suffix appended to the file header. */
	headerSuffix?: string;
	/** Body lines emitted into the textual model output. */
	modelLines: string[];
	/** Body lines emitted into the display output. Defaults to `modelLines`. */
	displayLines?: string[];
	/** When true, the file (and its header) is omitted entirely. */
	skip?: boolean;
}

/** Parallel model-facing and display-facing lines for grouped files. */
export interface GroupedFilesOutput {
	model: string[];
	display: string[];
	/** Per file, the `model` index just past its last line: a head cut keeping `n` lines shows it whole when this is <= n. */
	modelEnds: Map<string, number>;
}

/**
 * Render a list of files as a multi-level, prefix-folded directory tree shared by
 * grep, ast-grep, ast-edit, and the LSP diagnostic formatter.
 *
 * Layout (one `#` per level; the shared prefix folds into the top header):
 *   # packages/pkg/src/
 *   ## root.ts
 *   …body…
 *   ## nested/
 *   ### child.ts
 *   …body…
 *
 * Files in the (folded) project root become single-`#` headers with no parent
 * directory line. A blank line precedes every directory header and every
 * root-level file so the renderers can split the output into collapsible groups.
 */
export function formatGroupedFiles(
	files: string[],
	renderFile: (filePath: string) => GroupedFileSection,
): GroupedFilesOutput {
	const sections = new Map<string, GroupedFileSection>();
	const inputs: PathTreeInput[] = [];
	for (const filePath of files) {
		if (sections.has(filePath)) continue;
		const section = renderFile(filePath);
		if (section.skip) continue;
		sections.set(filePath, section);
		inputs.push({ path: filePath, isDir: false, key: filePath });
	}

	const tree = buildPathTree(inputs);
	const model: string[] = [];
	const display: string[] = [];
	const modelEnds = new Map<string, number>();
	let emitted = false;

	for (const event of walkPathTree(tree)) {
		const hashes = "#".repeat(event.depth + 1);
		const needsSeparator = emitted && (event.depth === 0 || event.kind === "dir");
		if (needsSeparator) {
			model.push("");
			display.push("");
		}
		emitted = true;
		if (event.kind === "dir") {
			const header = `${hashes} ${event.name}/`;
			model.push(header);
			display.push(header);
			continue;
		}
		const section = sections.get(event.key)!;
		const header = `${hashes} ${event.name}${section.headerSuffix ?? ""}`;
		model.push(header, ...section.modelLines);
		display.push(header, ...(section.displayLines ?? section.modelLines));
		modelEnds.set(event.key, model.length);
	}

	return { model, display, modelEnds };
}

/** One file's rendered search matches, plus its hashline tag when editable. */
export interface FileMatchSection {
	model: string[];
	display: string[];
	tag?: string;
}

/**
 * Render per-file search matches (grep / ast-grep). Grouped mode nests files
 * via {@link formatGroupedFiles}, appending `#tag` to headers; flat mode
 * blank-separates files and prefixes each with a hashline header when tagged.
 * Files with no model lines are omitted.
 */
export function formatFileMatches(
	files: string[],
	grouped: boolean,
	renderFile: (filePath: string) => FileMatchSection,
): GroupedFilesOutput {
	if (grouped) {
		return formatGroupedFiles(files, filePath => {
			const rendered = renderFile(filePath);
			return {
				modelLines: rendered.model,
				displayLines: rendered.display,
				headerSuffix: rendered.tag ? `#${rendered.tag}` : "",
				skip: rendered.model.length === 0,
			};
		});
	}
	const model: string[] = [];
	const display: string[] = [];
	const modelEnds = new Map<string, number>();
	for (const filePath of files) {
		const rendered = renderFile(filePath);
		if (rendered.model.length === 0) continue;
		if (model.length > 0) {
			model.push("");
			display.push("");
		}
		if (rendered.tag) model.push(formatHashlineHeader(filePath, rendered.tag));
		model.push(...rendered.model);
		display.push(...rendered.display);
		modelEnds.set(filePath, model.length);
	}
	return { model, display, modelEnds };
}

// =============================================================================
// Parsing grouped output back into per-line context (TUI renderers)
// =============================================================================

const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;
/** `*12│text`, ` 12|text`, `*12:text`: optional match marker, line number, gutter, content. */
const GROUPED_NUMBERED_LINE_RE = /^\s*(\*?)(\d+)(?:│|[:|])(.*)$/;
const GROUPED_MATCH_ROW_RE = /^\s*\*\d+(?:│|[:|])/;

/** Whether a row of grouped output is a code-frame row the search matched (`*12│…`). */
export function isMatchRow(line: string): boolean {
	return GROUPED_MATCH_ROW_RE.test(line);
}

/** Per-line classification of grouped output, used by renderers for file rows and hyperlinks. */
export interface GroupedLineContext {
	/** Directory header, file header, or any non-header body/content line. */
	kind: "dir" | "file" | "content";
	/** Number of leading `#` for headers; 0 for content lines. */
	depth: number;
	/** Resolved absolute path of the file a header points at (when resolvable). */
	headerPath?: string;
	/**
	 * For file headers, the full display path: the folded directory chain joined
	 * with the name, without `#` markers or the hashline tag.
	 */
	displayPath?: string;
	/** For file headers, a trailing parenthesized note such as `(2 replacements)`. */
	suffix?: string;
	/** For content lines, the absolute path of the owning file (line hyperlinks). */
	filePath?: string;
	/**
	 * The internal or url-like target, as written, that a header names or a
	 * content line belongs to; the caller resolves it (no filesystem path).
	 */
	url?: string;
}

function resolveGroupedPath(parent: string | undefined, name: string): string | undefined {
	if (parent === undefined) return undefined;
	if (name === "" || name === ".") return parent;
	// `path.resolve` keeps an absolute `name` intact (out-of-cwd results) while
	// joining a relative folded chain (`packages/pkg/src`) onto the parent.
	return path.resolve(parent, name);
}

/**
 * Walk grouped output lines, tracking a directory stack keyed by header depth, so
 * each header and body line can be linked back to its absolute filesystem path
 * and each file header to its full display path.
 * Reconstruction is stack-based (not per-blank-group) so nested directory headers
 * resolve correctly across the whole output.
 *
 * `headerBase` is the directory the displayed (folded) header paths are relative
 * to — for grep/ast tools that is the session cwd, since display paths are
 * formatted relative to cwd regardless of the (sub)directory the search was
 * scoped to. `fileScope` is the initial owning file for body lines that appear
 * before any header (single-file scopes have no `#` headers); it defaults to
 * `headerBase` and should be passed the scoped file's absolute path. A URL base
 * or scope (`local://…`) is no filesystem path: headerless lines belong to the
 * URL, and headers under a URL base get no path.
 */
export function classifyGroupedLines(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined = headerBase,
): GroupedLineContext[] {
	const result: GroupedLineContext[] = [];
	const base = headerBase !== undefined && isUrlLikePath(headerBase) ? undefined : headerBase;
	// Per depth (index `depth - 1`): each directory's absolute path, and its display
	// name with the trailing `/`, so the `# /` root of absolute paths keeps its separator.
	const dirAtDepth: (string | undefined)[] = [];
	const displayDirAtDepth: string[] = [];
	// Body lines before any header (single-file scopes) belong to the scoped file or URL.
	const scopeIsUrl = fileScope !== undefined && isUrlLikePath(fileScope);
	let currentFile = scopeIsUrl ? undefined : fileScope;
	let currentUrl = scopeIsUrl ? fileScope : undefined;

	for (const line of lines) {
		const match = GROUPED_HEADER_RE.exec(line);
		if (!match) {
			result.push({ kind: "content", depth: 0, filePath: currentFile, url: currentUrl });
			continue;
		}
		const depth = match[1]!.length;
		const rest = match[2]!.trimEnd();
		const parent = depth > 1 ? dirAtDepth[depth - 2] : base;
		const url = isUrlLikePath(rest);
		dirAtDepth.length = displayDirAtDepth.length = depth - 1;
		currentFile = currentUrl = undefined;
		if (!url && rest.endsWith("/")) {
			// Directory headers are always `name/`: a trailing `(…)` is part of the name, not a suffix.
			const name = rest.slice(0, -1);
			dirAtDepth.push(resolveGroupedPath(parent, name));
			displayDirAtDepth.push(`${name}/`);
			result.push({ kind: "dir", depth });
			continue;
		}
		const suffix = HEADER_SUFFIX_RE.exec(rest);
		const target = suffix ? rest.slice(0, suffix.index) : rest;
		const name = target.replace(HASHLINE_TAG_SUFFIX_RE, "");
		const note = suffix?.[0].trim();
		if (url) {
			currentUrl = target;
			result.push({ kind: "file", depth, url: target, displayPath: name, suffix: note });
			continue;
		}
		currentFile = name ? resolveGroupedPath(parent, name) : undefined;
		const displayPath = displayDirAtDepth.join("") + name;
		result.push({ kind: "file", depth, headerPath: currentFile, displayPath, suffix: note });
	}

	return result;
}

/**
 * Line groups with one file per group, for terminal tree lists: `# dir/`
 * header rows are dropped (each file row carries its full path), and every
 * file row starts a group of its own, so each file gets its own branch instead
 * of hanging under the previous file of its directory. Rows before a group's
 * first file row (notes, a single-file scope's matches) keep their group.
 */
export function groupsByFile(
	groups: readonly (readonly number[])[],
	contexts: readonly GroupedLineContext[],
): number[][] {
	const result: number[][] = [];
	for (const group of groups) {
		let current: number[] = [];
		for (const index of group) {
			const kind = contexts[index]!.kind;
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

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function stringRecordField(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
	const value = record[key];
	if (!isRecord(value)) return undefined;
	for (const entry in value) if (typeof value[entry] !== "string") return undefined;
	return value as Record<string, string>;
}

/** Details fields a grouped-output tool records for links: the display base paths and resolved URL targets. */
export interface GroupedLinkDetails {
	cwd?: string;
	searchPath?: string;
	displayTargets?: Record<string, string>;
}

/**
 * Link targets for the rows of sanitized grouped output: a file row's file, a
 * body row's owning file, and for an internal URL the file `displayTargets`
 * resolves it to. Destinations keep the original path bytes: while the raw
 * `displayContent` still aligns line-for-line with the sanitized `displayText`,
 * a row takes its raw classification's target. Raw text never links a row the
 * sanitized output leaves unlinked.
 */
export function groupedLinkTargets(
	contexts: readonly GroupedLineContext[],
	displayText: string,
	details: GroupedLinkDetails | undefined,
	rawDetails: unknown,
): (index: number) => string | undefined {
	const targetOf = (ctx: GroupedLineContext, urlTargets: Record<string, string> | undefined) =>
		(ctx.kind === "file" ? ctx.headerPath : ctx.filePath) ?? (ctx.url ? urlTargets?.[ctx.url] : undefined);
	// Detail sanitization keeps record keys raw; the display rows carry sanitized URLs.
	const displayTargets = details?.displayTargets
		? Object.fromEntries(Object.entries(details.displayTargets).map(([url, file]) => [sanitizeText(url), file]))
		: undefined;
	const raw = rawDetails !== details && isRecord(rawDetails) ? rawDetails : undefined;
	const rawContent = raw && stringField(raw, "displayContent");
	const rawLines = rawContent?.split("\n");
	const rawContexts =
		raw && rawLines?.length === contexts.length && sanitizeText(rawContent!) === displayText
			? classifyGroupedLines(
					rawLines,
					stringField(raw, "cwd") ?? stringField(raw, "searchPath"),
					stringField(raw, "searchPath"),
				)
			: undefined;
	const rawTargets = raw && stringRecordField(raw, "displayTargets");
	return index => {
		const ctx = contexts[index]!;
		const target = targetOf(ctx, displayTargets);
		const rawContext = rawContexts?.[index];
		if (!target || rawContext?.kind !== ctx.kind || rawContext.depth !== ctx.depth) return target;
		return targetOf(rawContext, rawTargets) ?? target;
	};
}

/**
 * A memoized styler for the rows of grouped output, so a collapsed preview
 * styles only the rows it shows. A file row is its full path (dim directory,
 * name in {@link FILE_NAME_COLOR}; a URL whole in that color) and any dim
 * suffix, linked to `linkTarget`'s file or, for an unresolved URL, the URL.
 * Body rows come from `styleBody`, tabs expanded; with `linkLines` a numbered
 * code-frame row links to its line in the owning file.
 */
export function createGroupedRowStyler(
	lines: readonly string[],
	contexts: readonly GroupedLineContext[],
	theme: Theme,
	options: {
		linkTarget: (index: number) => string | undefined;
		styleBody: (index: number) => string;
		linkLines?: boolean;
	},
): (index: number) => string {
	const styled: string[] = [];
	return index => {
		const cached = styled[index];
		if (cached !== undefined) return cached;
		const ctx = contexts[index]!;
		const target = options.linkTarget(index);
		let row: string;
		if (ctx.kind === "file") {
			const name = replaceTabs(ctx.displayPath ?? "");
			const label = ctx.url ? theme.fg(FILE_NAME_COLOR, name) : formatStyledPath(name, theme);
			const suffix = ctx.suffix ? ` ${theme.fg("dim", replaceTabs(ctx.suffix))}` : "";
			const linked = target ? fileHyperlink(target, label) : ctx.url ? uriHyperlink(ctx.url, label) : label;
			row = linked + suffix;
		} else {
			row = replaceTabs(options.styleBody(index));
			const line = options.linkLines && target ? GROUPED_NUMBERED_LINE_RE.exec(lines[index]!)?.[2] : undefined;
			if (line) row = fileHyperlink(target!, row, { line: Number(line) });
		}
		styled[index] = row;
		return row;
	};
}

/**
 * Fit line groups (one file each) into `budget` rows, the `… N more` summary row
 * included: whole groups first, then the next group cut short when it can still
 * show a row under its file row (the first group always shows its head). The
 * summary counts the `unit`s left out, the rows `isUnit` accepts, out of `total`
 * when the caller knows it; with none left out it counts hidden lines. `gap`
 * rows separate shown groups (framed lists put a blank line between files).
 */
export function fitGroupsToBudget(
	groups: readonly (readonly number[])[],
	budget: number,
	options: { isUnit: (index: number) => boolean; unit: string; total?: number; gap?: number },
): { shown: (readonly number[])[]; summary: string } {
	const gap = options.gap ?? 0;
	let totalLines = Math.max(groups.length - 1, 0) * gap;
	for (const group of groups) totalLines += group.length;
	if (totalLines <= budget) return { shown: [...groups], summary: "" };
	if (budget <= 0) return { shown: [], summary: "" };

	const room = budget - 1;
	const shown: (readonly number[])[] = [];
	let used = 0;
	let shownUnits = 0;
	for (const group of groups) {
		const lead = shown.length > 0 ? gap : 0;
		const take = Math.min(group.length, room - used - lead);
		if (take <= 0 || (take < Math.min(group.length, 2) && shown.length > 0)) break;
		const part = take === group.length ? group : group.slice(0, take);
		shown.push(part);
		used += lead + take;
		for (const index of part) if (options.isUnit(index)) shownUnits++;
		if (part !== group) break;
	}

	let allUnits = options.total ?? 0;
	if (!allUnits) for (const group of groups) for (const index of group) if (options.isUnit(index)) allUnits++;
	const hiddenUnits = allUnits - shownUnits;
	if (hiddenUnits > 0) return { shown, summary: formatMoreItems(hiddenUnits, options.unit) };
	const hiddenLines = totalLines - used;
	return { shown, summary: hiddenLines > 0 ? formatMoreItems(hiddenLines, "line") : "" };
}

/**
 * Split line indices into blank-line-separated groups, mirroring
 * `splitGroupsByBlankLine`: when any blank line is present, break on runs of
 * blanks; otherwise return a single group of the non-empty lines. Returning
 * indices lets callers slice parallel arrays (raw lines, styled lines, contexts).
 */
export function groupLineIndicesByBlank(rawLines: readonly string[]): number[][] {
	const hasSeparators = rawLines.some(line => line.trim().length === 0);
	const groups: number[][] = [];
	if (hasSeparators) {
		let current: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i]!.trim().length === 0) {
				if (current.length > 0) {
					groups.push(current);
					current = [];
				}
				continue;
			}
			current.push(i);
		}
		if (current.length > 0) groups.push(current);
	} else {
		const current: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i]!.trim().length > 0) current.push(i);
		}
		if (current.length > 0) groups.push(current);
	}
	return groups;
}

// =============================================================================
// Code frames highlighted in their file's language (TUI renderers)
// =============================================================================

/** A code-frame row split after its rule: the gutter (match marker, line number, rule) and the source line. */
interface CodeFrameRow {
	gutter: string;
	source: string;
}

/**
 * Draw the code-frame rows of consecutive source lines: each gutter in
 * `color`, the sources highlighted in `lang` as one run, so a multi-line
 * string or comment keeps its colors. Without a language the sources take
 * `color` too.
 */
function renderCodeFrameRun(
	rows: readonly CodeFrameRow[],
	lang: string | undefined,
	color: ThemeColor,
	theme: Theme,
): string[] {
	const sources = rows.map(row => replaceTabs(row.source));
	const highlighted = isHighlightLanguage(lang) ? highlightCode(sources.join("\n"), lang, theme) : undefined;
	return rows.map((row, index) => {
		const source = highlighted?.[index] ?? theme.fg(color, sources[index]!);
		return `${theme.fg(color, row.gutter)}${source}`;
	});
}

/** A numbered code-frame row of search output, with its line number. */
interface NumberedCodeFrame {
	row: CodeFrameRow;
	n: number;
}

function parseNumberedCodeFrame(line: string): NumberedCodeFrame | undefined {
	const match = GROUPED_NUMBERED_LINE_RE.exec(line);
	if (!match) return undefined;
	const source = match[3]!;
	return { row: { gutter: line.slice(0, line.length - source.length), source }, n: Number(match[2]) };
}

/**
 * Source rows highlighted together. A run longer than this (a huge AST match) highlights chunk by chunk as rows
 * are requested, so a collapsed view never tokenizes source it hides; a string or comment spanning a chunk
 * boundary loses its continuation there.
 */
const CODE_FRAME_CHUNK_ROWS = 64;

/**
 * Styled code-frame rows of grouped search output, highlighted in each owning
 * file's language (`lang` overrides it when the highlighter knows it). A run of
 * consecutive line numbers in one file highlights together on its first
 * request; a gap row, a jump in line numbers or another file starts a new run.
 * Rows without a numbered code frame (headers, gap rows, notes) return
 * undefined, for the caller to style.
 */
export function createCodeFrameStyler(
	lines: readonly string[],
	contexts: readonly GroupedLineContext[],
	color: ThemeColor,
	theme: Theme,
	lang?: string,
): (index: number) => string | undefined {
	// Each body row's language: the override, else its owning file's, from the resolved path or its header's name.
	const langOverride = isHighlightLanguage(lang) ? lang : undefined;
	const langs: (string | undefined)[] = [];
	let headerLang: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const ctx = contexts[index]!;
		if (ctx.kind === "content") {
			langs.push(langOverride ?? (ctx.filePath ? getLanguageFromPath(ctx.filePath) : headerLang));
			continue;
		}
		headerLang = ctx.kind === "file" ? getLanguageFromPath(ctx.displayPath ?? "") : undefined;
		langs.push(undefined);
	}

	const frames: (NumberedCodeFrame | null)[] = [];
	const frameAt = (index: number): NumberedCodeFrame | null => {
		let frame = frames[index];
		if (frame === undefined) {
			frame = contexts[index]!.kind === "content" ? (parseNumberedCodeFrame(lines[index]!) ?? null) : null;
			frames[index] = frame;
		}
		return frame;
	};
	// Whether the row at `index` continues the run of the row above it.
	const continuesRun = (index: number): boolean => {
		if (index <= 0 || langs[index] !== langs[index - 1]) return false;
		const frame = frameAt(index);
		const above = frameAt(index - 1);
		return frame !== null && above !== null && frame.n === above.n + 1;
	};
	// First row of each row's run, memoized so walking back through a long run happens once.
	const runStarts: number[] = [];
	const runStartOf = (index: number): number => {
		let row = index;
		while (runStarts[row] === undefined && continuesRun(row)) row--;
		const start = runStarts[row] ?? row;
		for (let filled = row; filled <= index; filled++) runStarts[filled] = start;
		return start;
	};

	const styled: string[] = [];
	return index => {
		if (frameAt(index) === null) return undefined;
		const cached = styled[index];
		if (cached !== undefined) return cached;
		const runStart = runStartOf(index);
		const start = runStart + Math.floor((index - runStart) / CODE_FRAME_CHUNK_ROWS) * CODE_FRAME_CHUNK_ROWS;
		let end = index + 1;
		while (end < start + CODE_FRAME_CHUNK_ROWS && end < lines.length && continuesRun(end)) end++;
		const chunkRows: CodeFrameRow[] = [];
		for (let row = start; row < end; row++) chunkRows.push(frameAt(row)!.row);
		renderCodeFrameRun(chunkRows, langs[index], color, theme).forEach((row, offset) => {
			styled[start + offset] = row;
		});
		return styled[index];
	};
}

// =============================================================================
// Native (TSP) description of grouped output
// =============================================================================

/** One event of {@link walkGroupedOutput}: a directory header, a file header, or a non-blank body line. */
export type GroupedOutputEvent =
	| { readonly kind: "dir" }
	| { readonly kind: "file"; readonly path: string; readonly suffix?: string }
	| { readonly kind: "line"; readonly text: string };

/**
 * Walk grouped output (`# dir/`, `## file.ts (suffix)`, body lines), resolving
 * each file header to its full display path (see {@link classifyGroupedLines})
 * and dropping blank separator lines.
 */
export function* walkGroupedOutput(lines: readonly string[]): Generator<GroupedOutputEvent> {
	const contexts = classifyGroupedLines(lines, undefined);
	for (const [index, ctx] of contexts.entries()) {
		if (ctx.kind === "dir") {
			yield { kind: "dir" };
		} else if (ctx.kind === "file") {
			yield { kind: "file", path: ctx.displayPath ?? "", suffix: ctx.suffix };
		} else {
			const text = lines[index]!;
			if (text.trim().length > 0) yield { kind: "line", text };
		}
	}
}

/** `    │...`: grep's gap between non-adjacent context runs (Tern draws it from the jump in {@link numberedCode}'s numbers). */
const GROUPED_GAP_LINE_RE = /^\s*│\.\.\.$/;

/** One source line for {@link numberedCode}: its number (`null` for an elision marker, which adds no line), text and match mark. */
export interface NumberedLine {
	n: number | null;
	text: string;
	mark?: boolean;
}

/**
 * One numbered `code` block for possibly non-contiguous source lines (match
 * lines `mark`ed by their line number): `start` when the numbers run on
 * consecutively, else `nums` (each line's number), from whose jumps Tern draws
 * the `…` gap rows in the gutter. Elision markers (`n: null`) add no line; the
 * numbers jump around them. `path` is the file the lines come from: Tern picks
 * their grammar from it and draws no header (the row or head above names the
 * file). `wrap` soft-wraps long lines instead of scrolling the block sideways.
 * `undefined` when no line is numbered.
 */
export function numberedCode(
	lines: readonly NumberedLine[],
	opts: { path?: string; wrap?: boolean } = {},
): NativeNode | undefined {
	const nums: number[] = [];
	const body: string[] = [];
	const marks: { line: number; tone: TspTone }[] = [];
	let contiguous = true;
	for (const line of lines) {
		if (line.n === null) continue;
		if (nums.length > 0 && line.n !== nums[nums.length - 1]! + 1) contiguous = false;
		nums.push(line.n);
		body.push(line.text);
		if (line.mark) marks.push({ line: line.n, tone: "accent" });
	}
	if (nums.length === 0) return undefined;
	return keyed(
		code(body.join("\n"), {
			start: contiguous ? nums[0] : undefined,
			nums: contiguous ? undefined : nums,
			numbers: true,
			path: opts.path,
			wrap: opts.wrap,
			marks: marks.length > 0 ? marks : undefined,
		}),
		`c${nums[0]}`,
	);
}

/**
 * Describe grouped search output (grep / ast-grep / ast-edit display content)
 * by file (§7.3 grep): per file a 22px path row (dim dir, strong name, the
 * header's suffix or the match count as a chip), then its lines as
 * one {@link numberedCode} block with match lines marked (gaps between
 * non-adjacent runs drawn in its gutter). Unnumbered body lines stay plain
 * `code`. `maxFiles` keeps only the first files (the caller says how many
 * were left out). `file` owns the lines
 * before any header: a single-file search prints none, yet its lines get the
 * same file row as a directory search's.
 */
export function describeGroupedOutput(
	lines: readonly string[],
	options: { maxFiles?: number; file?: string } = {},
): NativeNode[] {
	const files: NativeNode[] = [];
	const loose: NativeNode[] = [];
	let current: { path: string; suffix?: string; children: NativeNode[]; marks: number } | undefined;
	let numbered: NumberedLine[] = [];
	let plain: string[] = [];
	// `options.file` until the first line or header claims it.
	let headless = options.file;

	const flushLines = () => {
		const target = current?.children ?? loose;
		const block = numberedCode(numbered, { path: current?.path });
		if (block) target.push(block);
		numbered = [];
		if (plain.length > 0) {
			target.push(keyed(code(plain.join("\n")), `p${target.length}`));
			plain = [];
		}
	};
	const flushFile = () => {
		flushLines();
		if (!current) return;
		const count = current.marks;
		const chip = current.suffix
			? { text: current.suffix.replace(/^\(|\)$/g, "") }
			: count > 0
				? { text: String(count), title: count === 1 ? "1 match" : `${count} matches` }
				: undefined;
		const head = fileRow(current.path, { chip, key: "file" });
		files.push(
			keyed(col([head, ...current.children], { gap: "xs", role: "omp.tool.search.file" }), `f:${current.path}`),
		);
		current = undefined;
	};

	for (const event of walkGroupedOutput(lines)) {
		if (event.kind !== "line") {
			headless = undefined;
			flushFile();
			if (options.maxFiles !== undefined && files.length >= options.maxFiles) break;
			if (event.kind === "file") current = { path: event.path, suffix: event.suffix, children: [], marks: 0 };
			continue;
		}
		if (headless !== undefined) {
			current = { path: headless, children: [], marks: 0 };
			headless = undefined;
		}
		if (GROUPED_GAP_LINE_RE.test(event.text)) {
			numbered.push({ n: null, text: "" });
			continue;
		}
		const match = GROUPED_NUMBERED_LINE_RE.exec(event.text);
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
