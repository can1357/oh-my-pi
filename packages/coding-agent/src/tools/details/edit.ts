import { type EditInspection, editInspect } from "@oh-my-pi/pi-natives";
import type { FileDiagnosticsResult } from "./lsp";
import type { OutputMeta } from "../output-meta-format";
import {
	HASHLINE_TAG_SUFFIX_RE,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_MOVE_KEYWORD,
	HL_REM_KEYWORD,
} from "../hashline-format";

/** Edit payload syntax selected by the caller. */
export type EditMode = "replace" | "patch" | "hashline" | "apply_patch" | "sloppy";

// ═══════════════════════════════════════════════════════════════════════════
// Tool Details Types
// ═══════════════════════════════════════════════════════════════════════════

/** Filesystem operation represented by an edit. */
export type Operation = "create" | "delete" | "update";

/** Computed streaming diff, preview error, or notice for one file. */
export interface PerFileDiffPreview {
	path: string;
	diff?: string;
	firstChangedLine?: number;
	error?: string;
	/** Why the file has no diff yet, when that is not a failure (a remote file fetched only once the edit runs). */
	notice?: string;
}

type EditDiffPreview =
	| { diff: string; firstChangedLine?: number }
	| { error: string; diff?: undefined; firstChangedLine?: undefined };

/** Result metadata for one edited file. */
export interface EditToolPerFileResult {
	path: string;
	/** The edited worktree differs from the session's checkout of the same Git repository. */
	checkoutNotice?: string;
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

/** Diff, diagnostics, and snapshots returned by an edit. */
export interface EditToolDetails {
	/** Unified diff of the changes made; empty when the edit failed */
	diff: string;
	/** Why the edit failed, as the engine classed it (`unseen_lines`, `stale_tag`, `parse`, …) */
	errorKind?: string;
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
	/** The edited worktree differs from the session's checkout of the same Git repository. */
	checkoutNotice?: string;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The header renders `sourcePath → path`. */
	sourcePath?: string;
}

/** Added and removed lines of an edit's diff ({@link EditToolDetails.diff}). */
export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff ? diff.split("\n") : []) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Renderer
// ═══════════════════════════════════════════════════════════════════════════

/** Memoized native inspection of the streamed payload, tagged onto the args it came from. */
const kInspectedInput = Symbol("edit.inspectedInput");

type InspectedInput = { mode: EditMode; input: string } & (
	| { entries: InspectedInputEntry[]; error?: undefined }
	| { entries?: undefined; error: unknown }
);

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
	[kInspectedInput]?: InspectedInput;
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

interface InspectedInputEntry {
	path: string;
	op?: Operation;
	rename?: string;
}

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Edit mode resolved by the caller; lets the renderer dispatch without shape-sniffing */
	editMode?: EditMode;
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: EditDiffPreview;
	/** Multi-file streaming diff preview (edits spanning several files) */
	perFileDiffPreview?: PerFileDiffPreview[];
	/** Raw in-flight edit text shown while a computed diff preview is unavailable */
	editStreamingFallback?: string;
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
	/** Unsanitized result metadata, used only for filesystem link targets. */
	rawDetails?: unknown;
}

/** A model-typed `[path#tag]` header may spell the tag in lowercase. */
const TYPED_TAG_SUFFIX_RE = new RegExp(HASHLINE_TAG_SUFFIX_RE.source, "i");

function normalizeHashlineInputPreviewPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const hashStart = TYPED_TAG_SUFFIX_RE.exec(trimmed)?.index;
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

/** Extract display targets using the existing parsers for supported freeform edit modes. */
export function getEditInputPaths(input: string, resolvedMode?: EditMode): readonly string[] {
	const mode =
		resolvedMode ??
		(/^\*\*\* (?:Add|Update|Delete) File:/m.test(input)
			? "apply_patch"
			: /^[ \t]*\*{3}[ \t]+Edit[ \t]+File:/im.test(input)
				? "sloppy"
				: undefined);
	try {
		const entries =
			mode && mode !== "hashline" ? inspectInputEntries({}, mode, input) : getHashlineInputSections(input);
		const paths: string[] = [];
		for (const entry of entries) {
			if (entry.path) paths.push(entry.path);
			if (entry.rename && entry.rename !== entry.path) paths.push(entry.rename);
		}
		return paths;
	} catch {
		return [];
	}
}

/**
 * Per-file entries of a possibly partial payload. The native inspect re-parses
 * the whole payload, and the call header and compact activity row both ask on
 * every frame, so the answer (or the parser's rejection) is memoized on `args`
 * for as long as `input` is unchanged.
 */
function inspectInputEntries(args: EditRenderArgs, mode: EditMode, input: string): InspectedInputEntry[] {
	const cached = args[kInspectedInput];
	if (cached && cached.mode === mode && cached.input === input) {
		if (cached.entries) return cached.entries;
		throw cached.error;
	}
	let inspection: EditInspection;
	try {
		inspection = editInspect(mode, JSON.stringify({ input }));
	} catch (error) {
		args[kInspectedInput] = { mode, input, error };
		throw error;
	}
	const entries = new Map<string, InspectedInputEntry>();
	for (const path of inspection.paths) entries.set(path, { path });
	for (const intent of inspection.fileOps) {
		const entry = entries.get(intent.path) ?? { path: intent.path };
		if (intent.kind === "delete") {
			entry.op = "delete";
		} else if (intent.kind === "move") {
			entry.op = "update";
			entry.rename = intent.to;
		}
		entries.set(intent.path, entry);
	}
	const result = [...entries.values()];
	args[kInspectedInput] = { mode, input, entries: result };
	return result;
}
