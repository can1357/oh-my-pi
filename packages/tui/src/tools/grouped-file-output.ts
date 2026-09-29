import * as path from "node:path";

import { buildPathTree, isUrlLikePath, type PathTreeInput, walkPathTree } from "@oh-my-pi/pi-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { code, col, keyed, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
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
	}

	return { model, display };
}

// =============================================================================
// Parsing grouped output back into per-line context (TUI renderers)
// =============================================================================

const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;
const HEADER_HASH_TAG_RE = /#[0-9a-f]+$/i;

/** Per-line classification of grouped output, used by renderers for hyperlinks. */
export interface GroupedLineContext {
	/** Directory header, file header, or any non-header body/content line. */
	kind: "dir" | "file" | "content";
	/** Number of leading `#` for headers; 0 for content lines. */
	depth: number;
	/** Resolved absolute path of the dir/file a header points at (when resolvable). */
	headerPath?: string;
	/** For content lines, the absolute path of the owning file (line hyperlinks). */
	filePath?: string;
	/** Header is an internal/url-like target the caller resolves itself. */
	isUrl?: boolean;
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
 * each header and body line can be linked back to its absolute filesystem path.
 * Reconstruction is stack-based (not per-blank-group) so nested directory headers
 * resolve correctly across the whole output.
 *
 * `headerBase` is the directory the displayed (folded) header paths are relative
 * to — for grep/ast tools that is the session cwd, since display paths are
 * formatted relative to cwd regardless of the (sub)directory the search was
 * scoped to. `fileScope` is the initial owning file for body lines that appear
 * before any header (single-file scopes have no `#` headers); it defaults to
 * `headerBase` and should be passed the scoped file's absolute path.
 */
export function classifyGroupedLines(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined = headerBase,
): GroupedLineContext[] {
	const result: GroupedLineContext[] = [];
	const dirAtDepth = new Map<number, string>();
	// Body lines before any header (single-file scopes) link to the scoped file.
	let currentFile = fileScope;

	const clearDeeper = (depth: number) => {
		for (const key of dirAtDepth.keys()) {
			if (key >= depth) dirAtDepth.delete(key);
		}
	};

	for (const line of lines) {
		const match = GROUPED_HEADER_RE.exec(line);
		if (!match) {
			result.push({ kind: "content", depth: 0, filePath: currentFile });
			continue;
		}
		const depth = match[1]!.length;
		const rest = match[2]!.trimEnd();
		if (isUrlLikePath(rest)) {
			clearDeeper(depth);
			currentFile = undefined;
			result.push({ kind: "file", depth, isUrl: true });
			continue;
		}
		const parent = depth > 1 ? dirAtDepth.get(depth - 1) : headerBase;
		if (rest.endsWith("/")) {
			const name = rest.slice(0, -1).replace(HEADER_SUFFIX_RE, "");
			const abs = resolveGroupedPath(parent, name);
			clearDeeper(depth);
			if (abs !== undefined) dirAtDepth.set(depth, abs);
			currentFile = undefined;
			result.push({ kind: "dir", depth, headerPath: abs });
			continue;
		}
		const name = rest.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
		const abs = name ? resolveGroupedPath(parent, name) : undefined;
		currentFile = abs;
		result.push({ kind: "file", depth, headerPath: abs });
	}

	return result;
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
// Native (TSP) description of grouped output
// =============================================================================

/** One event of {@link walkGroupedOutput}: a directory header, a file header, or a non-blank body line. */
export type GroupedOutputEvent =
	| { readonly kind: "dir" }
	| { readonly kind: "file"; readonly path: string; readonly suffix?: string }
	| { readonly kind: "line"; readonly text: string };

/**
 * Walk grouped output (`# dir/`, `## file.ts (suffix)`, body lines), resolving
 * each file header to its full display path (the folded directory chain
 * joined with the name) and dropping blank separator lines.
 */
export function* walkGroupedOutput(lines: readonly string[]): Generator<GroupedOutputEvent> {
	const dirAtDepth: string[] = [];
	for (const line of lines) {
		const header = GROUPED_HEADER_RE.exec(line);
		if (!header) {
			if (line.trim().length > 0) yield { kind: "line", text: line };
			continue;
		}
		const depth = header[1]!.length;
		const rest = header[2]!.trimEnd();
		dirAtDepth.length = depth - 1;
		if (rest.endsWith("/") && !isUrlLikePath(rest)) {
			dirAtDepth[depth - 1] = rest.slice(0, -1).replace(HEADER_SUFFIX_RE, "");
			yield { kind: "dir" };
			continue;
		}
		const suffix = HEADER_SUFFIX_RE.exec(rest)?.[0].trim();
		const name = rest.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
		const prefix = dirAtDepth.filter(Boolean).join("/");
		yield { kind: "file", path: prefix ? `${prefix}/${name}` : name, suffix };
	}
}

/** `*12│text`, ` 12|text`, `*12:text`: optional match marker, line number, gutter, content. */
const GROUPED_NUMBERED_LINE_RE = /^\s*(\*?)(\d+)(?:│|[:|])(.*)$/;

/** One source line for {@link numberedCode}: its number (`null` for an elision marker), text and match mark. */
export interface NumberedLine {
	n: number | null;
	text: string;
	mark?: boolean;
}

/**
 * Numbered `code` for possibly non-contiguous source lines: one block per run
 * of consecutive line numbers (`start` = the run's first line, match lines
 * `mark`ed), with a `…` row wherever the numbers jump or an elision marker
 * (`n: null`) sits. No path header: the row or head above names the file.
 */
export function numberedCode(lines: readonly NumberedLine[], opts: { lang?: string } = {}): NativeNode[] {
	const out: NativeNode[] = [];
	let run: { start: number; text: string[]; marks: { line: number; tone: TspTone }[] } | undefined;
	const flush = () => {
		if (!run) return;
		// The quiet `…` row between two non-adjacent runs.
		if (out.length > 0) out.push(keyed(text([span("…", "dim")], { wrap: "none" }), `g${run.start}`));
		out.push(
			keyed(
				code(run.text.join("\n"), {
					start: run.start,
					numbers: true,
					lang: opts.lang,
					marks: run.marks.length > 0 ? run.marks : undefined,
				}),
				`c${run.start}`,
			),
		);
		run = undefined;
	};
	for (const line of lines) {
		if (line.n === null) {
			flush();
			continue;
		}
		if (run && run.start + run.text.length !== line.n) flush();
		run ??= { start: line.n, text: [], marks: [] };
		run.text.push(line.text);
		if (line.mark) run.marks.push({ line: line.n, tone: "accent" });
	}
	flush();
	return out;
}

/**
 * Describe grouped search output (grep / ast-grep / ast-edit display content)
 * by file (§7.3 grep): per file a 22px path row (dim dir, strong name, the
 * header's suffix or the match count as a chip), then its lines as
 * {@link numberedCode} with match lines marked and `…` between non-adjacent
 * runs. Unnumbered body lines stay plain `code`. `maxFiles` keeps only the
 * first files (the caller says how many were left out).
 */
export function describeGroupedOutput(
	lines: readonly string[],
	options: { lang?: (path: string) => string | undefined; maxFiles?: number } = {},
): NativeNode[] {
	const files: NativeNode[] = [];
	const loose: NativeNode[] = [];
	let current: { path: string; suffix?: string; children: NativeNode[]; marks: number } | undefined;
	let numbered: NumberedLine[] = [];
	let plain: string[] = [];

	const flushLines = () => {
		const target = current?.children ?? loose;
		if (numbered.length > 0) {
			target.push(...numberedCode(numbered, { lang: current ? options.lang?.(current.path) : undefined }));
			numbered = [];
		}
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
			flushFile();
			if (options.maxFiles !== undefined && files.length >= options.maxFiles) break;
			if (event.kind === "file") current = { path: event.path, suffix: event.suffix, children: [], marks: 0 };
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
