/**
 * Edit tool renderer and LSP batching helpers.
 */

import { HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_MOVE_KEYWORD, HL_REM_KEYWORD } from "@oh-my-pi/hashline";
import type { Component } from "@oh-my-pi/pi-tui";
import { sliceWithWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { FileDiagnosticsResult } from "../lsp";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import type { OutputMeta } from "../tools/output-meta";
import {
	cachedRenderedString,
	createRenderedStringCache,
	formatDiagnostics,
	formatExpandHint,
	formatStatusIcon,
	getDiffStats,
	getLspBatchRequest,
	invalidateRenderedStringCache,
	type LspBatchRequest,
	PREVIEW_LIMITS,
	previewWindowRows,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
	truncateDiffByHunk,
} from "../tools/render-utils";
import type { ToolActivityContext, ToolActivitySummary } from "../tools/renderers";
import {
	fileHyperlink,
	framedBlock,
	Hasher,
	type RenderCache,
	renderStatusLine,
	truncateToWidth,
	WidthAwareText,
} from "../tui";
import type { EditMode } from "../utils/edit-mode";
import type { DiffError, DiffResult } from "./diff";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import type { Operation } from "./modes/patch";
import { type SloppySection, splitSloppySections } from "./sloppy";
import type { PerFileDiffPreview } from "./streaming";

// ═══════════════════════════════════════════════════════════════════════════
// LSP Batching
// ═══════════════════════════════════════════════════════════════════════════

export { getLspBatchRequest, type LspBatchRequest };

// ═══════════════════════════════════════════════════════════════════════════
// Tool Details Types
// ═══════════════════════════════════════════════════════════════════════════

export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	/** TUI-friendly error text. When present, rendered to the user instead of `errorText`.
	 * Set when the underlying error carries a `displayMessage` (e.g. {@link HashlineMismatchError}). */
	displayErrorText?: string;
	meta?: OutputMeta;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The header renders `sourcePath → path`. */
	sourcePath?: string;
}

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
	/** Operation type (patch mode only) */
	op?: Operation;
	/** New path after move/rename (patch mode only) */
	move?: string;
	/** Structured output metadata */
	meta?: OutputMeta;
	/** Per-file results (multi-file edits) */
	perFileResults?: EditToolPerFileResult[];
	/** Absolute file path for single-file edit results. Required by ACP diff metadata consumers. */
	path?: string;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The header renders `sourcePath → path`. */
	sourcePath?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Renderer
// ═══════════════════════════════════════════════════════════════════════════

interface EditRenderArgs {
	path?: unknown;
	file_path?: unknown;
	oldText?: string;
	newText?: string;
	patch?: string;
	input?: string;
	_input?: string;
	replace_all?: boolean;
	// Patch mode fields
	op?: Operation;
	rename?: unknown;
	diff?: string;
	/**
	 * Computed preview diff (used when tool args don't include a diff, e.g. hashline mode).
	 */
	previewDiff?: string;
	__partialJson?: string;
	// Hashline mode fields
	edits?: EditRenderEntry[];
}

type EditRenderEntry = {
	path?: unknown;
	rename?: unknown;
	move?: unknown;
	op?: Operation;
};

interface HashlineInputEntry {
	path: string;
	op?: Operation;
	rename?: string;
	/** A PUT/CUT line edit precedes the file op — keeps a move framed. */
	hasLineEdits?: boolean;
}

interface HashlineInputRenderSummary {
	entries: HashlineInputEntry[];
}

interface ApplyPatchRenderSummary {
	entries: ApplyPatchEntry[];
	error?: string;
}

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Edit mode resolved by the caller; lets the renderer dispatch without shape-sniffing */
	editMode?: EditMode;
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: DiffResult | DiffError;
	/** Multi-file streaming diff preview (edits spanning several files) */
	perFileDiffPreview?: PerFileDiffPreview[];
	/** Raw in-flight edit text shown while a computed diff preview is unavailable */
	editStreamingFallback?: string;
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
}

const EDIT_STREAMING_PREVIEW_LINES = 12;

/**
 * Lazily grown per-file preview cache slots: the file count of a streaming
 * multi-file patch is discovered mid-stream, so a fixed-size array would
 * silently bypass caching for late files.
 */
function previewCacheAt(caches: RenderedStringCache[] | undefined, index: number): RenderedStringCache | undefined {
	if (!caches) return undefined;
	let cache = caches[index];
	if (cache === undefined) {
		cache = createRenderedStringCache();
		caches[index] = cache;
	}
	return cache;
}

const CALL_TEXT_PREVIEW_LINES = 6;
const CALL_TEXT_PREVIEW_WIDTH = 80;

/** Extract file path from an edit entry. */
function filePathFromEditEntry(p: unknown): string | undefined {
	if (typeof p !== "string") {
		return undefined;
	}
	return p;
}

function decodePartialJsonStringFragment(fragment: string): string {
	// Trim a trailing partial escape so JSON.parse sees a well-formed string.
	let text = fragment.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
	const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0;
	if (trailingBackslashes % 2 === 1) text = text.slice(0, -1);
	try {
		return JSON.parse(`"${text}"`) as string;
	} catch {
		// Streaming fragment isn't a valid JSON string yet; surface it raw rather
		// than ad-hoc unescaping that mishandles surrogates and partial escapes.
		return text;
	}
}

function extractPartialJsonString(partialJson: string | undefined, key: string): string | undefined {
	if (!partialJson) return undefined;
	const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "u");
	const match = pattern.exec(partialJson);
	if (!match) return undefined;
	return decodePartialJsonStringFragment(match[1]);
}

function getPartialJsonEditPath(args: EditRenderArgs): string | undefined {
	return filePathFromEditEntry(extractPartialJsonString(args.__partialJson, "path"));
}

/** Count distinct file paths in an edits array. */
function countEditFiles(edits: EditRenderEntry[]): number {
	return new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;
}

function getOperationTitle(op: Operation | undefined): string {
	return op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";
}

interface EditPathDisplayOptions {
	rename?: string;
	firstChangedLine?: number;
	linkPath?: string;
	renameLinkPath?: string;
	maxPathWidth?: number;
}

function truncateEditTitlePath(displayPath: string, maxWidth: number | undefined): string {
	if (maxWidth === undefined) return displayPath;
	const width = visibleWidth(displayPath);
	const safeMaxWidth = Math.max(0, Math.floor(maxWidth));
	if (width <= safeMaxWidth) return displayPath;

	const contentWidth = safeMaxWidth - 1;
	if (contentWidth <= 0) return "…";

	const headWidth = Math.floor(contentWidth / 2);
	const tailWidth = contentWidth - headWidth;
	const head = sliceWithWidth(displayPath, 0, headWidth, true).text;
	const tail = sliceWithWidth(displayPath, Math.max(0, width - tailWidth), tailWidth, true).text;
	return `${head}…${tail}`;
}

function formatEditTitlePath(pathValue: string, maxWidth?: number): string {
	return truncateEditTitlePath(replaceTabs(shortenPath(pathValue)), maxWidth);
}

function formatEditPathDisplay(
	rawPath: string,
	uiTheme: Theme,
	options?: EditPathDisplayOptions,
): { text: string; pathWidth: number } {
	// `rawPath`/`rename` are shown (cwd-relative) but the OSC 8 link targets the
	// absolute path when known — a relative `rawPath` would otherwise yield a
	// `file:///rel` URI that resolves against filesystem root instead of cwd.
	const linkTarget = options?.linkPath || rawPath;
	const lineLink = options?.firstChangedLine ? { line: options.firstChangedLine } : undefined;
	const primaryDisplay = rawPath ? formatEditTitlePath(rawPath, options?.maxPathWidth) : "…";
	let pathDisplay = rawPath
		? fileHyperlink(linkTarget, uiTheme.fg("accent", primaryDisplay), lineLink)
		: uiTheme.fg("toolOutput", primaryDisplay);
	let pathWidth = visibleWidth(primaryDisplay);

	if (options?.rename) {
		const renameTarget = options.renameLinkPath || options.rename;
		const renameDisplay = formatEditTitlePath(options.rename, options.maxPathWidth);
		pathDisplay += ` ${uiTheme.fg("dim", "→")} ${fileHyperlink(renameTarget, uiTheme.fg("accent", renameDisplay))}`;
		pathWidth += visibleWidth(renameDisplay);
	}

	return { text: pathDisplay, pathWidth };
}

function formatEditDescription(
	rawPath: string,
	uiTheme: Theme,
	options?: EditPathDisplayOptions,
): { language: string; description: string; pathWidth: number } {
	const language = getLanguageFromPath(rawPath) ?? "text";
	const icon = uiTheme.fg("muted", uiTheme.getLangIcon(language));
	const pathDisplay = formatEditPathDisplay(rawPath, uiTheme, options);
	return {
		language,
		description: `${icon} ${pathDisplay.text}`,
		pathWidth: pathDisplay.pathWidth,
	};
}

function editHeaderLabelBudget(width: number, uiTheme: Theme): number {
	const leftGlyphs = `${uiTheme.boxRound.topLeft}${uiTheme.boxRound.horizontal.repeat(3)}`;
	return Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(uiTheme.boxRound.topRight) - 2);
}

function renderEditHeader(
	width: number,
	uiTheme: Theme,
	options: {
		icon?: "pending" | "success" | "error";
		iconOverride?: string;
		op?: Operation;
		rawPath: string;
		rename?: string;
		firstChangedLine?: number;
		linkPath?: string;
		statsSuffix?: string;
		extraSuffix?: string;
		title?: string;
	},
): string {
	const title = options.title ?? getOperationTitle(options.op);
	const descriptionOptions: EditPathDisplayOptions = {
		rename: options.rename,
		firstChangedLine: options.firstChangedLine,
		linkPath: options.linkPath,
	};
	const formatted = formatEditDescription(options.rawPath, uiTheme, descriptionOptions);
	const suffix = `${options.statsSuffix ?? ""}${options.extraSuffix ?? ""}`;
	const buildHeader = (description: string): string =>
		renderStatusLine(
			{
				icon: options.icon,
				iconOverride: options.iconOverride,
				title,
				description,
			},
			uiTheme,
		) + suffix;

	const header = buildHeader(formatted.description);
	const overflow = visibleWidth(header) - editHeaderLabelBudget(width, uiTheme);
	if (overflow <= 0 || formatted.pathWidth <= 1) return header;

	const pathCount = Math.max(1, (options.rawPath ? 1 : 0) + (options.rename ? 1 : 0));
	const fittedPathWidth = Math.max(1, Math.floor((formatted.pathWidth - overflow) / pathCount));
	const fitted = formatEditDescription(options.rawPath, uiTheme, {
		...descriptionOptions,
		maxPathWidth: fittedPathWidth,
	});
	return buildHeader(fitted.description);
}

/**
 * Inline status row for delete / move-only edits — they carry no diff, so they
 * render as a single line instead of an empty framed container. The completed
 * result uses the eraser/move glyph; a still-streaming call uses the shared
 * pending hourglass like every other tool.
 */
function renderInlineEditRow(
	uiTheme: Theme,
	opts: { op?: Operation; rename?: string; rawPath: string; linkPath?: string; pending: boolean },
): Component {
	const isDelete = opts.op === "delete";
	return new WidthAwareText(
		width =>
			renderEditHeader(width, uiTheme, {
				icon: opts.pending ? "pending" : undefined,
				iconOverride: opts.pending
					? undefined
					: uiTheme.styledSymbol(isDelete ? "tool.delete" : "tool.move", "accent"),
				op: opts.op,
				title: isDelete ? "Delete" : "Move",
				rawPath: opts.rawPath,
				rename: opts.rename,
				linkPath: opts.linkPath,
			}),
		0,
		0,
	);
}

/**
 * Whether a streaming edit call carries any payload worth boxing (a diff
 * preview, replacement text, or a non-empty edits array). Used to keep a
 * move-with-edits framed while a payload-less move/delete folds to an inline
 * row — gated on args, not the async preview, so it can't flash inline before
 * the diff arrives.
 */
function hasEditCallPayload(args: EditRenderArgs, renderContext: EditRenderContext | undefined): boolean {
	const multi = renderContext?.perFileDiffPreview;
	if (multi && multi.length > 1 && multi.some(p => p.diff || p.error)) return true;
	if (args.previewDiff || args.diff || args.newText || args.patch) return true;
	if (Array.isArray(args.edits) && args.edits.length > 0) return true;
	if (renderContext?.editStreamingFallback) return true;
	return false;
}

function renderPlainTextPreview(text: string, uiTheme: Theme, _filePath?: string): string {
	const previewLines = sanitizeText(text).split("\n");
	let preview = "\n\n";
	for (const line of previewLines.slice(0, CALL_TEXT_PREVIEW_LINES)) {
		preview += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), CALL_TEXT_PREVIEW_WIDTH))}\n`;
	}
	if (previewLines.length > CALL_TEXT_PREVIEW_LINES) {
		preview += uiTheme.fg("dim", `… ${previewLines.length - CALL_TEXT_PREVIEW_LINES} more lines`);
	}
	return preview.trimEnd();
}

interface StreamingDiffTail {
	content: string;
	hidden: boolean;
}

/**
 * Select the trailing physical lines that fit the live preview budget.
 *
 * Walk backward from the end instead of splitting the complete diff. This keeps
 * allocation and scanning proportional to the visible suffix. One physical line
 * may exceed the budget, but it is still kept so the newest change is visible.
 */
function sliceStreamingDiffTail(diff: string, innerWidth: number, budget: number): StreamingDiffTail {
	let end = diff.length;
	while (end > 0 && diff.charCodeAt(end - 1) === 10) end--;
	if (end === 0) return { content: "", hidden: false };

	const rowLimit = Math.max(1, budget);
	let start = end;
	let cursor = end;
	let visualRows = 0;
	while (cursor >= 0) {
		const newline = cursor > 0 ? diff.lastIndexOf("\n", cursor - 1) : -1;
		const lineStart = newline + 1;
		const lineRows = Math.max(1, wrapTextWithAnsi(replaceTabs(diff.slice(lineStart, cursor)), innerWidth).length);
		if (visualRows > 0 && visualRows + lineRows > rowLimit) break;
		visualRows += lineRows;
		start = lineStart;
		if (newline < 0) break;
		cursor = newline;
	}

	return { content: diff.slice(start, end), hidden: start > 0 };
}

function formatStreamingDiff(
	diff: string,
	rawPath: string,
	width: number,
	uiTheme: Theme,
	expanded: boolean,
	label = "streaming",
	spinnerFrame?: number,
	cache?: RenderedStringCache,
): string {
	if (!diff) return "";
	// Clamp the tail to the viewport so a tall or fast-growing diff cannot
	// outgrow the live window. Otherwise its mutating rows scroll above the
	// native-scrollback commit boundary mid-stream and freeze into immutable
	// history as a stale preview snapshot; the finalize repair then recommits
	// the final render below it — a duplicated block on the tape. Collapsed
	// gets a short fixed tail; expanded widens it to the viewport-sized window,
	// never unbounded. The budget is VISUAL rows (a long wrapped line counts
	// for more than one) at the framed block's inner width (border only —
	// contentPaddingLeft is 0); only the visible suffix is syntax-colored, so
	// the cheap raw-line wrap walk keeps the per-chunk cost bounded.
	// innerWidth/budget are in the cache salt so a resize re-slices.
	const innerWidth = Math.max(1, width - 2);
	const budget = expanded ? previewWindowRows() : Math.min(EDIT_STREAMING_PREVIEW_LINES, previewWindowRows());
	let text = cachedRenderedString(cache, uiTheme, expanded, `${rawPath}:${innerWidth}:${budget}`, diff, () => {
		// "Cursor" tail window: pin the last rows to the bottom so freshly streamed
		// changes stay on screen. The whole-file diff is recomputed every chunk and
		// its Myers alignment is not monotonic in payload length, so a hunk-aware
		// window stutters as rows move between hunks. Expanded widens the window
		// to the viewport; the full diff appears once the result finalizes.
		const tail = sliceStreamingDiffTail(diff, innerWidth, budget);
		let rendered = "\n\n";
		if (tail.hidden) {
			// Exact hidden line/hunk counts require scanning the discarded prefix,
			// which would make every streaming update scale with the complete diff.
			rendered += `${uiTheme.fg("dim", "… (content above)")}\n`;
		}
		rendered += renderDiffColored(tail.content, { filePath: rawPath, theme: uiTheme });
		return rendered;
	});
	// The animated glyph rides this trailing line — inside the transcript's
	// volatile-tail holdback — never the block header: an animating head row
	// pins the native-scrollback commit boundary at the top of the block, so a
	// tall expanded preview could never scroll-append mid-stream.
	const spinner = spinnerFrame !== undefined ? `${formatStatusIcon("running", uiTheme, spinnerFrame)} ` : "";
	// Expanded approval previews hide the "(preview)" label (#1992) but keep
	// the animated glyph when one is active so the volatile tail stays live.
	const hideLabel = expanded && label === "preview";
	if (spinner || !hideLabel) {
		text += `\n${hideLabel ? spinner.trimEnd() : `${spinner}${uiTheme.fg("dim", `(${label})`)}`}`;
	}
	return text;
}

function formatMultiFileStreamingDiff(
	previews: PerFileDiffPreview[],
	width: number,
	uiTheme: Theme,
	expanded: boolean,
	spinnerFrame?: number,
	caches?: RenderedStringCache[],
): string {
	const parts: string[] = [];
	for (let index = 0; index < previews.length; index++) {
		const preview = previews[index]!;
		if (!preview.diff && !preview.error) continue;
		const header = uiTheme.fg("dim", `\n\n── ${shortenPath(preview.path)} ──`);
		if (preview.error) {
			parts.push(`${header}\n${uiTheme.fg("error", replaceTabs(preview.error))}`);
			continue;
		}
		if (preview.diff) {
			// Only the last file's preview carries the animated streaming glyph;
			// earlier files have settled and must stay byte-stable so their rows
			// can commit to native scrollback mid-stream.
			const isLast = index === previews.length - 1;
			const cache = previewCacheAt(caches, index);
			parts.push(
				`${header}${formatStreamingDiff(preview.diff, preview.path, width, uiTheme, expanded, "preview", isLast ? spinnerFrame : undefined, cache)}`,
			);
		}
	}
	return parts.join("");
}

function getCallPreview(
	args: EditRenderArgs,
	rawPath: string,
	width: number,
	uiTheme: Theme,
	renderContext: EditRenderContext | undefined,
	expanded: boolean,
	spinnerFrame?: number,
	caches?: RenderedStringCache[],
): string {
	const multi = renderContext?.perFileDiffPreview;
	if (multi && multi.length > 1 && multi.some(p => p.diff || p.error)) {
		return formatMultiFileStreamingDiff(multi, width, uiTheme, expanded, spinnerFrame, caches);
	}
	const cache = previewCacheAt(caches, 0);
	if (args.previewDiff) {
		return formatStreamingDiff(args.previewDiff, rawPath, width, uiTheme, expanded, "preview", spinnerFrame, cache);
	}
	if (args.diff && args.op) {
		return formatStreamingDiff(args.diff, rawPath, width, uiTheme, expanded, "streaming", spinnerFrame, cache);
	}
	if (args.diff) {
		return renderPlainTextPreview(args.diff, uiTheme, rawPath);
	}
	if (args.newText || args.patch) {
		return renderPlainTextPreview(args.newText ?? args.patch ?? "", uiTheme, rawPath);
	}
	if (renderContext?.editStreamingFallback) {
		return renderContext.editStreamingFallback;
	}
	return "";
}

const MISSING_APPLY_PATCH_END_ERROR = "The last line of the patch must be '*** End Patch'";

function normalizeHashlineInputPreviewPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const hashStart = /#[0-9a-fA-F]{4}$/u.exec(trimmed)?.index;
	const withoutHash = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart);
	if (withoutHash.length < 2) return withoutHash;
	const first = withoutHash[0];
	const last = withoutHash[withoutHash.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return withoutHash.slice(1, -1);
	}
	return withoutHash;
}

function parseHashlineInputPreviewHeader(line: string): string | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX)) return null;
	// Keep streaming previews tolerant while the closing bracket is still
	// being generated; the parser enforces the final `[path#TAG]` shape.
	const bodyEnd = trimmed.endsWith(HL_FILE_SUFFIX) ? trimmed.length - HL_FILE_SUFFIX.length : trimmed.length;
	const body = trimmed.slice(HL_FILE_PREFIX.length, bodyEnd).trim();
	const previewPath = normalizeHashlineInputPreviewPath(body);
	return previewPath.length > 0 ? previewPath : null;
}

// Line-editing op headers (PUT/CUT family), distinct from file-level
// REM/MV ops. Body rows are `+TEXT`, so this only matches real headers.
const HL_LINE_OP_HEADER = /^(?:PUT|CUT)\b/;

/**
 * Walk a (possibly mid-stream) hashline payload into per-section descriptors:
 * the target path plus any file-level op (`REM` → delete, `MV dest` → rename)
 * and whether a line edit precedes it. Tolerant of partial input so the call
 * preview can label a delete/move before the payload finishes streaming.
 */
function getHashlineInputSections(input: string): HashlineInputEntry[] {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const entries: HashlineInputEntry[] = [];
	let current: HashlineInputEntry | undefined;
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const headerPath = parseHashlineInputPreviewHeader(line);
		if (headerPath) {
			current = { path: headerPath };
			entries.push(current);
			continue;
		}
		if (!current) continue;
		const trimmed = line.trim();
		if (trimmed === HL_REM_KEYWORD) {
			current.op = "delete";
		} else if (trimmed.startsWith(`${HL_MOVE_KEYWORD} `)) {
			current.rename = normalizeHashlineInputPreviewPath(trimmed.slice(HL_MOVE_KEYWORD.length + 1));
		} else if (HL_LINE_OP_HEADER.test(trimmed)) {
			current.hasLineEdits = true;
		}
	}
	return entries;
}

function getHashlineInputRenderSummary(
	args: EditRenderArgs,
	editMode: EditMode | undefined,
): HashlineInputRenderSummary | undefined {
	const input = args.input ?? args._input;
	if (editMode !== "hashline" || typeof input !== "string") {
		return undefined;
	}
	return { entries: getHashlineInputSections(input) };
}

/**
 * Per-file section descriptors for a (possibly mid-stream) sloppy payload.
 * Paths live inside the payload's `[path]` headers, so the call header would
 * otherwise render a bare `…` for the whole stream.
 */
function getSloppyInputRenderSummary(
	args: EditRenderArgs,
	editMode: EditMode | undefined,
): { entries: SloppySection[] } | undefined {
	const input = args.input ?? args._input;
	if (editMode !== "sloppy" || typeof input !== "string") {
		return undefined;
	}
	const entries = splitSloppySections(input);
	return entries.length > 0 ? { entries } : undefined;
}

function getApplyPatchRenderSummary(
	args: EditRenderArgs,
	isPartial: boolean,
	editMode: EditMode | undefined,
): ApplyPatchRenderSummary | undefined {
	if (editMode !== undefined && editMode !== "apply_patch") {
		return undefined;
	}

	if (typeof args.input !== "string") {
		return undefined;
	}

	try {
		return { entries: expandApplyPatchToEntries({ input: args.input }) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		if (isPartial && error === MISSING_APPLY_PATCH_END_ERROR) {
			return { entries: expandApplyPatchToPreviewEntries({ input: args.input }) };
		}
		return { entries: [], error };
	}
}
/** Header facts (path, op, rename, file count) resolved from streamed edit args; shared by the framed call header and the compact activity summary. */
interface EditCallFacts {
	rawPath: string;
	rename?: string;
	op?: Operation;
	/** Distinct files touched by the call (0 when unknown). */
	fileCount: number;
	/** Apply-patch envelope parse error, when the payload failed to parse. */
	applyPatchError?: string;
	/** A hashline PUT/CUT line edit precedes the file op — keeps a move framed. */
	hasHashlineLineEdits: boolean;
}

function resolveEditCallFacts(
	editArgs: EditRenderArgs,
	isPartial: boolean,
	editMode: EditMode | undefined,
): EditCallFacts {
	const hashlineInputSummary = getHashlineInputRenderSummary(editArgs, editMode);
	const sloppyInputSummary = getSloppyInputRenderSummary(editArgs, editMode);
	const applyPatchSummary = getApplyPatchRenderSummary(editArgs, isPartial, editMode);
	const firstApplyPatchEntry = applyPatchSummary?.entries[0];
	const firstHashlineInputEntry = hashlineInputSummary?.entries[0];
	// Extract path from first edit entry when top-level path is absent (new schema)
	const firstEdit = Array.isArray(editArgs.edits) && editArgs.edits.length > 0 ? editArgs.edits[0] : undefined;
	const rawPath =
		typeof editArgs.file_path === "string"
			? editArgs.file_path
			: typeof editArgs.path === "string"
				? editArgs.path
				: (filePathFromEditEntry(firstEdit?.path) ??
					getPartialJsonEditPath(editArgs) ??
					firstHashlineInputEntry?.path ??
					sloppyInputSummary?.entries[0]?.path ??
					firstApplyPatchEntry?.path ??
					"");
	const rename =
		(typeof editArgs.rename === "string" ? editArgs.rename : undefined) ??
		filePathFromEditEntry(firstEdit?.rename) ??
		filePathFromEditEntry(firstEdit?.move) ??
		firstApplyPatchEntry?.rename ??
		firstHashlineInputEntry?.rename;
	const op = editArgs.op || firstEdit?.op || firstApplyPatchEntry?.op || firstHashlineInputEntry?.op;
	let fileCount =
		hashlineInputSummary?.entries.length ??
		sloppyInputSummary?.entries.length ??
		applyPatchSummary?.entries.length ??
		0;
	if (Array.isArray(editArgs.edits)) {
		fileCount = countEditFiles(editArgs.edits);
	}
	return {
		rawPath,
		rename,
		op,
		fileCount,
		applyPatchError: applyPatchSummary?.error,
		hasHashlineLineEdits: Boolean(firstHashlineInputEntry?.hasLineEdits),
	};
}

function formatDiffStatsSuffix(diff: string, uiTheme: Theme): string {
	const { added, removed } = getDiffStats(diff);
	if (added === 0 && removed === 0) return "";
	const stats = [
		added > 0 ? uiTheme.fg("toolDiffAdded", `+${added}`) : undefined,
		removed > 0 ? uiTheme.fg("toolDiffRemoved", `-${removed}`) : undefined,
	].filter(value => value !== undefined);
	return ` ${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${stats.join(uiTheme.fg("dim", "/"))}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;
}
function renderDiffSection(
	diff: string,
	rawPath: string,
	expanded: boolean,
	innerWidth: number,
	uiTheme: Theme,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
	renderCache?: RenderedStringCache,
	sectionCache?: RenderedStringCache,
): string {
	return cachedRenderedString(sectionCache, uiTheme, expanded, `${rawPath}:${innerWidth}`, diff, () => {
		const {
			text: truncatedDiff,
			hiddenHunks,
			hiddenLines: logicallyHiddenLines,
		} = expanded
			? { text: diff, hiddenHunks: 0, hiddenLines: 0 }
			: truncateDiffByHunk(diff, PREVIEW_LIMITS.DIFF_COLLAPSED_HUNKS, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);

		const renderedDiff = cachedRenderedString(renderCache, uiTheme, expanded, rawPath, truncatedDiff, () =>
			renderDiffFn(truncatedDiff, { filePath: rawPath }),
		);
		const { text: visibleDiff, hiddenLines: visuallyHiddenLines } = expanded
			? { text: renderedDiff, hiddenLines: 0 }
			: sliceCollapsedDiffRows(renderedDiff, innerWidth, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);
		const hiddenLines = logicallyHiddenLines + visuallyHiddenLines;

		let text = `\n${visibleDiff}`;
		if (!expanded && (hiddenHunks > 0 || hiddenLines > 0)) {
			const remainder: string[] = [];
			if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
			if (hiddenLines > 0) remainder.push(`${hiddenLines} more lines`);
			text += uiTheme.fg("toolOutput", `\n… (${remainder.join(", ")}) ${formatExpandHint(uiTheme)}`);
		}
		return text;
	});
}

function wrapEditRendererLine(line: string, width: number): string[] {
	if (width <= 0) return [line];
	if (line.length === 0) return [""];

	const startAnsi = line.match(/^((?:\x1b\[[0-9;]*m)*)/)?.[1] ?? "";
	const bodyWithReset = line.slice(startAnsi.length);
	const body = bodyWithReset.endsWith("\x1b[39m") ? bodyWithReset.slice(0, -"\x1b[39m".length) : bodyWithReset;
	// Gutter shapes produced by formatCodeFrameLine: "-315│", " 313│", "+322│",
	// plus the deduplicated forms "   +│" and "    │" whose repeated line number
	// renderDiff blanked (single-line replacement pairs and insert-then-context
	// runs) — all │-separated. ASCII "|" gutters may arrive from injected
	// renderers that preserve raw canonical rows; those always carry a marker
	// column ("+"/"-"/space) and a line number. So
	// the number is optional for "│", while "|" requires the full canonical
	// shape; anything else (a body line merely starting with "|", error text
	// like "123|…") is not a diff row and wraps generically.
	const diffMatch = /^(\s*[+-]?\s*\d*)([|│])(.*)$/s.exec(body);

	if (!diffMatch || diffMatch[1].length === 0 || (diffMatch[2] === "|" && !/^[+\-\s]\s*\d+$/.test(diffMatch[1]))) {
		return wrapTextWithAnsi(line, width);
	}

	const [, gutter, separator, content] = diffMatch;
	const prefix = `${gutter}${separator}`;
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const continuationPrefix = `${" ".repeat(Math.max(0, prefixWidth - 1))}${separator}`;
	const wrappedContent = wrapTextWithAnsi(content ?? "", contentWidth);

	// Each visual row is a standalone terminal line: wrapTextWithAnsi re-opens
	// active SGR state at the next row's start, so a row that breaks inside an
	// intra-line diff highlight still ends with inverse video active. Close it
	// alongside the foreground reset — otherwise the frame padding appended
	// after the row is painted as an inverse block (default-foreground cells).
	return wrappedContent.map(
		(segment, index) => `${startAnsi}${index === 0 ? prefix : continuationPrefix}${segment}\x1b[27m\x1b[39m`,
	);
}

function sliceCollapsedDiffRows(
	renderedDiff: string,
	innerWidth: number,
	maxRows: number,
): { text: string; hiddenLines: number } {
	const lines = renderedDiff.split("\n");
	const visibleRows: string[] = [];
	let completeLines = 0;

	for (const line of lines) {
		const wrapped = wrapEditRendererLine(line, innerWidth);
		const remainingRows = maxRows - visibleRows.length;
		if (wrapped.length <= remainingRows) {
			visibleRows.push(...wrapped);
			completeLines++;
			continue;
		}
		if (remainingRows > 0) visibleRows.push(...wrapped.slice(0, remainingRows));
		break;
	}

	return {
		text: visibleRows.join("\n"),
		hiddenLines: lines.length - completeLines,
	};
}

export const editToolRenderer = {
	mergeCallAndResult: true,
	/** Compact one-line activity: operation + target path instead of the payload's first line. */
	activitySummary(args: unknown, context: ToolActivityContext): ToolActivitySummary {
		const editArgs = (args ?? {}) as EditRenderArgs;
		const editMode = (context.renderContext as EditRenderContext | undefined)?.editMode;
		const facts = resolveEditCallFacts(editArgs, context.isPartial, editMode);
		const label = getOperationTitle(facts.op);
		if (!facts.rawPath) return { label };
		let detail = formatEditTitlePath(facts.rawPath);
		if (facts.rename) detail += ` → ${formatEditTitlePath(facts.rename)}`;
		if (facts.fileCount > 1) detail += ` (+${facts.fileCount - 1} more)`;
		return { label, detail };
	},

	renderCall(
		args: EditRenderArgs,
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
	): Component {
		const renderContext = options.renderContext;
		const editArgs = args as EditRenderArgs;
		const { rawPath, rename, op, fileCount, applyPatchError, hasHashlineLineEdits } = resolveEditCallFacts(
			editArgs,
			options.isPartial,
			renderContext?.editMode,
		);
		// Delete / payload-less move calls render as an inline pending row (no
		// empty framed container), mirroring the completed result but with the
		// shared hourglass instead of the eraser/move glyph.
		const hasPayload = hasEditCallPayload(editArgs, renderContext) || hasHashlineLineEdits;
		if (fileCount <= 1 && !applyPatchError && (op === "delete" || (rename !== undefined && !hasPayload))) {
			return renderInlineEditRow(uiTheme, { op, rename, rawPath, pending: true });
		}
		const callPreviewCaches: RenderedStringCache[] = [];
		return framedBlock(uiTheme, width => {
			// No status icon on the head row: it's the head of the framed block,
			// and native-scrollback commits are prefix-only — an animated glyph
			// would pin the commit boundary at the top, and the pending hourglass
			// just adds noise. The liveness cue rides the trailing "(preview)" /
			// "(streaming)" line instead.
			const header = renderEditHeader(width, uiTheme, {
				op,
				rawPath,
				rename,
				extraSuffix: fileCount > 1 ? uiTheme.fg("dim", ` (+${fileCount - 1} more)`) : undefined,
			});
			let body = getCallPreview(
				editArgs,
				rawPath,
				width,
				uiTheme,
				renderContext,
				options.expanded,
				options?.spinnerFrame,
				callPreviewCaches,
			);
			if (applyPatchError) {
				body += `\n${uiTheme.fg("error", truncateToWidth(replaceTabs(applyPatchError), Math.max(1, width - 2)))}`;
			}
			const bodyLines = body ? body.split("\n") : [];
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: applyPatchError ? "error" : "pending",
				borderColor: applyPatchError ? "error" : "borderMuted",
				width,
				contentPaddingLeft: 0,
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
		args?: EditRenderArgs,
	): Component {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		const perFileResults = result.details?.perFileResults;
		const totalFiles = edits ? countEditFiles(edits) : 0;
		if (perFileResults && (perFileResults.length > 1 || totalFiles > 1)) {
			return renderMultiFileResult(perFileResults, totalFiles, options, uiTheme);
		}
		return renderSingleFileResult(result, options, uiTheme, args);
	},
};

function renderSingleFileResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: EditToolDetails | EditToolPerFileResult;
		isError?: boolean;
	},
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
	args?: EditRenderArgs,
): Component {
	const details = result.details;
	const isError = result.isError ?? (details && "isError" in details ? details.isError : false);
	const edits = Array.isArray(args?.edits) ? args.edits : undefined;
	const firstEdit = edits?.[0];
	const hashlineInputSummary = getHashlineInputRenderSummary(args ?? {}, options.renderContext?.editMode);
	const firstHashlineInputEntry = hashlineInputSummary?.entries[0];
	const moveSource =
		details && "sourcePath" in details && typeof details.sourcePath === "string" ? details.sourcePath : undefined;
	const detailPath = details && "path" in details && typeof details.path === "string" ? details.path : undefined;
	const rawPath =
		moveSource ??
		(typeof args?.file_path === "string"
			? args.file_path
			: typeof args?.path === "string"
				? args.path
				: (filePathFromEditEntry(firstEdit?.path) ?? detailPath ?? firstHashlineInputEntry?.path ?? ""));
	const op = args?.op || firstEdit?.op || details?.op;
	const rename =
		(typeof args?.rename === "string" ? args.rename : undefined) ??
		filePathFromEditEntry(firstEdit?.rename) ??
		filePathFromEditEntry(firstEdit?.move) ??
		(details && "move" in details && typeof details.move === "string" ? details.move : undefined);

	const displayErrorText = isError && details && "displayErrorText" in details ? details.displayErrorText : undefined;
	const errorText = isError
		? displayErrorText ||
			(details && "errorText" in details && details.errorText) ||
			(result.content?.find(c => c.type === "text")?.text ?? "")
		: "";

	// Delete and move-only results carry no diff to box. Per design these render
	// as an inline status row (eraser / move glyph) rather than an empty framed
	// container. Errors, no-ops, creates, move-with-edits, and anything with
	// diagnostics keep the framed block below.
	if (!isError && !details?.diff && !details?.diagnostics && (op === "delete" || rename)) {
		const linkPath = details && "path" in details ? details.path : undefined;
		return renderInlineEditRow(uiTheme, { op, rename, rawPath, linkPath, pending: false });
	}

	const renderFallbackDiff = (diffText: string, diffOptions?: { filePath?: string }): string =>
		renderDiffColored(diffText, { filePath: diffOptions?.filePath, theme: uiTheme });

	let diffSectionRenderDiffFn: ((t: string, o?: { filePath?: string }) => string) | undefined;
	const diffSectionCache = createRenderedStringCache();
	const renderedDiffCache = createRenderedStringCache();
	const statsSuffixCache = createRenderedStringCache();

	return framedBlock(uiTheme, width => {
		const { expanded, renderContext } = options;
		// A finalized result is authoritative: its `details` describe exactly
		// what happened. The shared streaming `editDiffPreview` is a call-phase
		// artifact (in a batch it reflects only the first file), so consulting it
		// for an empty-diff delete/move/no-op result mislabels the card. Fall
		// back to the preview only when no details exist yet.
		const editDiffPreview = details ? undefined : renderContext?.editDiffPreview;
		const renderDiffFn = renderContext?.renderDiff ?? renderFallbackDiff;

		if (diffSectionRenderDiffFn !== renderDiffFn) {
			diffSectionRenderDiffFn = renderDiffFn;
			invalidateRenderedStringCache(diffSectionCache);
			invalidateRenderedStringCache(renderedDiffCache);
		}
		const firstChangedLine =
			(editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined) ||
			(details && !isError ? details.firstChangedLine : undefined);
		const linkPath = details && "path" in details ? details.path : undefined;

		// Change stats ride inline on the header bar next to the path.
		const previewDiff = editDiffPreview && !("error" in editDiffPreview) ? editDiffPreview.diff : undefined;
		const headerDiff = isError ? undefined : details?.diff || previewDiff;
		const statsSuffix = headerDiff
			? cachedRenderedString(statsSuffixCache, uiTheme, false, "", headerDiff, () =>
					formatDiffStatsSuffix(headerDiff, uiTheme),
				)
			: "";
		const header = renderEditHeader(width, uiTheme, {
			icon: isError ? "error" : "success",
			iconOverride: !isError && !options.isPartial ? uiTheme.styledSymbol("tool.edit", "accent") : undefined,
			op,
			rawPath,
			rename,
			firstChangedLine,
			linkPath,
			statsSuffix,
		});
		const innerWidth = Math.max(1, width - 2);

		let body = "";
		if (isError) {
			if (errorText) body = uiTheme.fg("error", replaceTabs(errorText));
		} else if (details?.diff) {
			body = renderDiffSection(
				details.diff,
				rawPath,
				expanded,
				innerWidth,
				uiTheme,
				renderDiffFn,
				renderedDiffCache,
				diffSectionCache,
			);
		} else if (details) {
			// Authoritative result with no textual diff: a delete, a move-only
			// rename, or a genuine no-op. The header already names the op
			// (Delete / `src → dst`); only a true no-op needs an explanatory
			// body so an empty card isn't mistaken for a stalled edit.
			if (op !== "delete" && op !== "create" && !rename) {
				const noChangePath = linkPath ? shortenPath(linkPath) : rawPath ? shortenPath(rawPath) : "";
				body = uiTheme.fg("dim", `No changes were made${noChangePath ? ` to ${noChangePath}` : ""}.`);
			}
		} else if (editDiffPreview) {
			if ("error" in editDiffPreview) body = uiTheme.fg("error", replaceTabs(editDiffPreview.error));
			else if (editDiffPreview.diff)
				body = renderDiffSection(
					editDiffPreview.diff,
					rawPath,
					expanded,
					innerWidth,
					uiTheme,
					renderDiffFn,
					renderedDiffCache,
					diffSectionCache,
				);
		}
		if (details?.diagnostics) {
			body += formatDiagnostics(details.diagnostics, expanded, uiTheme, (fp: string) =>
				uiTheme.getLangIcon(getLanguageFromPath(fp)),
			);
		}

		// Diff lines self-wrap with a continuation gutter; pre-wrap to the frame's
		// inner width so renderOutputBlock's generic wrap is a no-op. Edit frames
		// use a flush left border because code-frame gutters already provide padding.
		const bodyLines = body.length > 0 ? body.split("\n").flatMap(line => wrapEditRendererLine(line, innerWidth)) : [];
		while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();

		return {
			header,
			sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
			state: isError ? "error" : options.isPartial ? "pending" : "success",
			borderColor: isError ? "error" : "borderMuted",
			width,
			contentPaddingLeft: 0,
		};
	});
}

function renderMultiFileResult(
	perFileResults: EditToolPerFileResult[],
	totalFiles: number,
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
): Component {
	const fileComponents = perFileResults.map(fileResult =>
		renderSingleFileResult({ content: [], details: fileResult, isError: fileResult.isError }, options, uiTheme),
	);
	const remaining = Math.max(0, totalFiles - perFileResults.length);

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const key = new Hasher().bool(options.expanded).u32(width).u32(perFileResults.length).u32(remaining).digest();
			if (cached?.key === key) return cached.lines;

			const allLines: string[] = [];
			for (let i = 0; i < fileComponents.length; i++) {
				if (i > 0) {
					allLines.push("");
				}
				allLines.push(...fileComponents[i].render(width));
			}

			// Show pending indicator for files still being processed
			if (remaining > 0) {
				if (allLines.length > 0) allLines.push("");
				const spinnerFrame = options.spinnerFrame;
				const spinner = spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, spinnerFrame) : "";
				// Spinner while actively rendering, otherwise no icon — never the
				// pending hourglass on the head row.
				allLines.push(
					renderStatusLine(
						{
							iconOverride: spinner,
							title: "Edit",
							description: uiTheme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						uiTheme,
					),
				);
			}

			cached = { key, lines: allLines };
			return allLines;
		},
		invalidate() {
			cached = undefined;
			for (const c of fileComponents) c.invalidate?.();
		},
	};
}
