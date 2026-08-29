/**
 * Streaming edit preview strategies.
 *
 * Each edit mode owns a strategy that knows how to:
 * - collapse partial-JSON args to the subset safe to preview
 *   (`extractCompleteEdits`),
 * - compute unified diff previews for the in-flight args
 *   (`computeDiffPreview`), and
 * - render a text placeholder while no diff exists yet
 *   (`renderStreamingFallback`).
 *
 * The shared renderer / `ToolExecutionComponent` consult the strategy via
 * the injected `editMode` rather than probing argument shape.
 */

import {
	ABORT_MARKER,
	BEGIN_PATCH_MARKER,
	type Clipboard,
	containsRecognizableHashlineOperations,
	END_PATCH_MARKER,
	forkClipboard,
	type PatchSection as HashlineInputSection,
	Patch as HashlinePatch,
	type SnapshotStore,
} from "@oh-my-pi/hashline";
import type { Theme } from "../modes/theme/theme";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { computeEditDiff, type DiffError, type DiffResult } from "./diff";
import { computeHashlineDiff, computeHashlineSectionDiff } from "./hashline/diff";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import { computePatchDiff, type PatchEditEntry } from "./modes/patch";
import { computeSloppySectionDiff, splitSloppySections } from "./sloppy";

export interface PerFileDiffPreview {
	path: string;
	diff?: string;
	firstChangedLine?: number;
	error?: string;
}

export interface StreamingDiffContext {
	cwd: string;
	signal: AbortSignal;
	snapshots: SnapshotStore;
	fuzzyThreshold?: number;
	allowFuzzy?: boolean;
	/**
	 * True while the tool's arguments are still streaming in. Strategies that
	 * accept free-form text input (apply_patch, hashline) trim the trailing
	 * partial line so per-character growth of an in-flight `+added` line does
	 * not flicker in the preview.
	 */
	isStreaming?: boolean;
	/**
	 * Session-persistent clipboard register (`CUT`/`PASTE`). Previews
	 * fork it per frame — never mutating it — so a `PASTE` of content cut in
	 * an earlier edit call (or an earlier section of this patch) renders the
	 * real rows.
	 */
	clipboard?: Clipboard;
}

/**
 * Per-file projection of a streamed edit payload. Pairs one target file path
 * with the digest of only the lines added to that file, so path-scoped stream
 * matchers (TTSR) evaluate each file in isolation — a `tool:edit(*.ts)` rule
 * never fires on text that actually belongs to a sibling `README.md` hunk.
 */
export interface EditMatcherEntry {
	readonly path: string;
	readonly digest: string;
}

export interface EditStreamingStrategy<Args = unknown> {
	/**
	 * Return the args restricted to edits that are "complete enough" to
	 * compute a diff against. Strategies drop the trailing incomplete entry
	 * when `partialJson` indicates its closing `}` hasn't arrived yet.
	 */
	extractCompleteEdits(args: Args, partialJson: string | undefined, isStreaming: boolean): Args;
	/**
	 * Compute diff(s) for the given partial args. Returns `null` when args
	 * do not yet carry enough structure to compute anything.
	 */
	computeDiffPreview(args: Args, ctx: StreamingDiffContext): Promise<PerFileDiffPreview[] | null>;
	/**
	 * Rendered inline while the diff hasn't been computed yet (or when the
	 * compute returned `null` because args are still too partial).
	 */
	renderStreamingFallback(args: Args, uiTheme: Theme): string;
	/**
	 * Project the (potentially partial) args onto the plain text the edit
	 * introduces into files — added lines without patch grammar — so stream
	 * matchers (TTSR rules) can run source-level patterns against real content
	 * instead of the mode-specific wire format. Returns `undefined` when the
	 * args don't yet carry any content.
	 */
	matcherDigest(args: Args): string | undefined;
	/**
	 * Surface the target file paths a (potentially partial) call would touch,
	 * so path-scoped stream matchers (e.g. TTSR `tool:edit(*.ts)` globs) match
	 * even when the path is not a top-level argument but lives inside the wire
	 * payload — `hashline` section headers, `apply_patch` envelope markers.
	 * Returns `undefined` (or an empty list) when no paths are recoverable.
	 */
	matcherPaths(args: Args): readonly string[] | undefined;
	/**
	 * Per-file projection of the (potentially partial) args: one entry per
	 * touched file pairing the path with the digest of only the lines added to
	 * that file. Multi-file payloads (multi-section hashline / multi-hunk
	 * apply_patch) MUST split here so callers can evaluate each file under its
	 * own path scope instead of leaking added lines from one file into the
	 * other's match context. Same-path sections / hunks are merged into one
	 * entry. Returns `undefined` (or empty) when no per-file split is
	 * recoverable yet — the caller falls back to {@link matcherDigest} +
	 * {@link matcherPaths}.
	 */
	matcherEntries(args: Args): readonly EditMatcherEntry[] | undefined;
}

// -----------------------------------------------------------------------------
// Partial-JSON handling
// -----------------------------------------------------------------------------

/**
 * Given an edits array parsed from partial JSON, drop the last entry when the
 * corresponding object in `partialJson` has not yet closed with `}`.
 *
 * The streaming parser materializes a trailing edit object from the fields seen
 * so far before its closing `}` arrives, so an unfinished last entry can render
 * as a (partial) edit mid-stream. Dropping it until the object closes keeps the
 * preview from showing an incomplete edit.
 */
export function dropIncompleteLastEdit<T>(edits: readonly T[], partialJson: string | undefined, listKey: string): T[] {
	if (!Array.isArray(edits) || edits.length === 0) return [...(edits ?? [])];
	if (!partialJson) return [...edits];

	const keyMarker = `"${listKey}"`;
	const keyIdx = partialJson.indexOf(keyMarker);
	if (keyIdx === -1) return [...edits];

	// Find the `[` that opens the list value.
	let i = partialJson.indexOf("[", keyIdx + keyMarker.length);
	if (i === -1) return [...edits];
	i++;

	let depth = 0;
	let inString = false;
	let escaped = false;
	let lastClose = -1;
	for (; i < partialJson.length; i++) {
		const ch = partialJson[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{" || ch === "[") {
			depth++;
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (ch === "}" && depth === 0) {
				lastClose = i;
			}
			if (ch === "]" && depth === -1) {
				// End of list reached.
				break;
			}
		}
	}

	// If we're still inside the list and saw no closing `}` for the last entry,
	// or there is trailing non-whitespace after the last `}` before the list
	// ended (i.e. a new object has opened), drop the trailing entry.
	const tail = lastClose === -1 ? partialJson.slice(i) : partialJson.slice(lastClose + 1);
	const sawNewObjectAfterLastClose = /\{/.test(tail);
	const listIsStillOpen = depth >= 0;

	if (lastClose === -1 || (listIsStillOpen && sawNewObjectAfterLastClose)) {
		return edits.slice(0, -1);
	}
	return [...edits];
}

// -----------------------------------------------------------------------------
// Apply_patch remains multi-file because the Codex envelope carries paths per hunk.
// -----------------------------------------------------------------------------

function groupApplyPatchEntriesByPath(entries: readonly ApplyPatchEntry[]): Map<string, ApplyPatchEntry[]> {
	const groups = new Map<string, ApplyPatchEntry[]>();

	for (const entry of entries) {
		let bucket = groups.get(entry.path);
		if (!bucket) {
			bucket = [];
			groups.set(entry.path, bucket);
		}
		bucket.push(entry);
	}
	return groups;
}

/**
 * Extract the lines a patch-style payload adds (`+` prefix, excluding `+++ `
 * file headers), stripped of the prefix. When the text carries no added lines,
 * returns the whole text if `fallbackToWhole` (full-content payloads such as a
 * `create` op), otherwise an empty string (grammar-only payloads).
 */
function extractAddedLines(text: string, fallbackToWhole: boolean): string {
	const added: string[] = [];
	let lineStart = 0;
	while (lineStart <= text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = text.length;
		if (text.charCodeAt(lineStart) === 43 /* + */ && !text.startsWith("+++ ", lineStart)) {
			added.push(text.slice(lineStart + 1, lineEnd));
		}
		lineStart = lineEnd + 1;
	}
	if (added.length === 0) return fallbackToWhole ? text : "";
	return added.join("\n");
}

/**
 * Extract hashline `[path#TAG]` (and untagged `[path]`) section-header paths
 * from a (possibly partial) hashline buffer. Tolerant of streaming chunks
 * where `Patch.parse` would still throw on the trailing op — only fully
 * closed header lines are recognised.
 */
function extractHashlineHeaderPaths(input: string): string[] {
	const paths: string[] = [];
	const re = /^\s*\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/gm;
	for (const match of input.matchAll(re)) {
		const candidate = stripApplyPatchPathNoise(match[1]).trim();
		if (candidate.length > 0) paths.push(candidate);
	}
	return paths;
}

/**
 * Strip the `*** Add/Update/Delete File:` / `*** Move to:` noise that the
 * model sometimes pastes into a hashline header (the hashline tokenizer does
 * the same in its recovery path).
 */
function stripApplyPatchPathNoise(value: string): string {
	return value
		.replace(/^\s*\*{3}\s*(?:Add|Update|Delete)\s+File\s*:\s*/i, "")
		.replace(/^\s*\*{3}\s*Move\s+to\s*:\s*/i, "");
}

/** Extract `*** Add/Update/Delete File:` paths from a (possibly partial) apply_patch envelope. */
function extractApplyPatchEnvelopePaths(input: string): string[] {
	const paths: string[] = [];
	const re = /^\s*\*{3}\s+(?:Add|Update|Delete)\s+File\s*:\s*(\S.*?)\s*$/gm;
	for (const match of input.matchAll(re)) {
		const candidate = match[1].trim();
		if (candidate.length > 0) paths.push(candidate);
	}
	return paths;
}

/**
 * Split a (possibly partial) hashline buffer into one matcher entry per
 * touched file: pair the section header path with the added lines from that
 * section's body, merging sections that target the same file into one entry.
 * Header-line regex (not `Patch.parse`) so a mid-typed trailing op still
 * yields entries for completed sections.
 */
function splitHashlinePerFile(input: string): EditMatcherEntry[] {
	const headerRe = /^\s*\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/gm;
	const sections: { path: string; headerStart: number; bodyStart: number }[] = [];
	let match: RegExpExecArray | null = headerRe.exec(input);
	while (match !== null) {
		const candidate = stripApplyPatchPathNoise(match[1]).trim();
		if (candidate.length > 0) {
			sections.push({ path: candidate, headerStart: match.index, bodyStart: headerRe.lastIndex });
		}
		match = headerRe.exec(input);
	}
	if (sections.length === 0) return [];

	const byPath = new Map<string, string>();
	for (let i = 0; i < sections.length; i++) {
		const { path: sectionPath, bodyStart } = sections[i];
		const bodyEnd = i + 1 < sections.length ? sections[i + 1].headerStart : input.length;
		const added = extractAddedLines(input.slice(bodyStart, bodyEnd), false);
		if (added.length === 0) continue;
		const existing = byPath.get(sectionPath);
		byPath.set(sectionPath, existing === undefined ? added : `${existing}\n${added}`);
	}
	return Array.from(byPath, ([path, digest]) => ({ path, digest }));
}

/**
 * Split a (possibly partial) apply_patch envelope into one matcher entry per
 * touched file. Same-path hunks are merged into one entry. Falls back to the
 * streaming-tolerant parser when the envelope hasn't reached `*** End Patch`.
 */
function splitApplyPatchPerFile(input: string): EditMatcherEntry[] {
	let entries: ApplyPatchEntry[];
	try {
		entries = expandApplyPatchToEntries({ input });
	} catch {
		try {
			entries = expandApplyPatchToPreviewEntries({ input });
		} catch {
			return [];
		}
	}
	const byPath = new Map<string, string>();
	for (const entry of entries) {
		if (typeof entry.diff !== "string") continue;
		const added = extractAddedLines(entry.diff, false);
		if (added.length === 0) continue;
		const existing = byPath.get(entry.path);
		byPath.set(entry.path, existing === undefined ? added : `${existing}\n${added}`);
	}
	return Array.from(byPath, ([path, digest]) => ({ path, digest }));
}

// -----------------------------------------------------------------------------
// Strategies
// -----------------------------------------------------------------------------

interface ReplaceArgs {
	path?: string;
	old_string?: string;
	new_string?: string;
	replace_all?: boolean;
	__partialJson?: string;
}

const replaceStrategy: EditStreamingStrategy<ReplaceArgs> = {
	extractCompleteEdits(args, partialJson) {
		// While args are still streaming, `old_string` is only trustworthy once
		// the parser has moved past it — i.e. the `new_string` key has appeared.
		// Previewing a half-streamed `old_string` would flash a bogus
		// "no match" diff error until the rest of the value arrives.
		if (!partialJson || partialJson.includes('"new_string"')) return args;
		return { ...args, old_string: undefined, new_string: undefined };
	},
	async computeDiffPreview(args, ctx) {
		if (!args.path) return null;
		if (args.old_string === undefined || args.new_string === undefined) return null;
		ctx.signal.throwIfAborted();
		const result = await computeEditDiff(
			args.path,
			args.old_string,
			args.new_string,
			ctx.cwd,
			ctx.allowFuzzy ?? true,
			args.replace_all,
			ctx.fuzzyThreshold,
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(args.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
	matcherDigest(args) {
		return typeof args?.new_string === "string" ? args.new_string : undefined;
	},
	matcherPaths(args) {
		return typeof args?.path === "string" && args.path.length > 0 ? [args.path] : undefined;
	},
	matcherEntries(args) {
		const path = args?.path;
		if (typeof path !== "string" || path.length === 0) return undefined;
		const digest = replaceStrategy.matcherDigest(args);
		return digest === undefined ? undefined : [{ path, digest }];
	},
};

interface PatchArgs {
	path?: string;
	edits?: PatchEditEntry[];
	__partialJson?: string;
}

const patchStrategy: EditStreamingStrategy<PatchArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview(args, ctx) {
		if (!args.path) return null;
		const first = args.edits?.[0];
		if (!first) return null;
		ctx.signal.throwIfAborted();
		const result = await computePatchDiff(
			{ path: args.path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
			ctx.cwd,
			// Match the apply path: JSON-mode `op: "create"` is a sanctioned
			// full-file overwrite, so the preview must not reject it either.
			{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy, allowCreateOverwrite: true },
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(args.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
	matcherDigest(args) {
		const edits = args?.edits;
		if (!Array.isArray(edits)) return undefined;
		let digest: string | undefined;
		for (const edit of edits) {
			if (typeof edit?.diff !== "string") continue;
			// `create` ops carry full file content in `diff` with no +/- markers;
			// pass that content through whole.
			const added = extractAddedLines(edit.diff, edit.op === "create");
			digest = digest === undefined ? added : `${digest}\n${added}`;
		}
		return digest;
	},
	matcherPaths(args) {
		return typeof args?.path === "string" && args.path.length > 0 ? [args.path] : undefined;
	},
	matcherEntries(args) {
		const path = args?.path;
		if (typeof path !== "string" || path.length === 0) return undefined;
		const digest = patchStrategy.matcherDigest(args);
		return digest === undefined ? undefined : [{ path, digest }];
	},
};

interface HashlineArgs {
	input?: string;
	_input?: string;
	__partialJson?: string;
}

/**
 * Text payload of a hashline edit call. The public schema declares `input`, but
 * streaming sees the raw model output before validation coerces aliases, so a
 * provider that emits the legacy `_input` key still previews correctly.
 */
function hashlineEditText(args: HashlineArgs | undefined): string | undefined {
	return args?.input ?? args?._input;
}

/**
 * While streaming a free-form text payload (apply_patch envelope, hashline
 * input), trim the trailing partial line so per-character growth of an
 * in-flight `+added` line does not cause the diff preview to flicker. The
 * full line will show on the next streaming tick once its `\n` arrives.
 * Returns `text` unchanged when not streaming or when no newline is present.
 */
function trimTrailingPartialLine(text: string, isStreaming: boolean | undefined): string {
	if (!isStreaming) return text;
	const idx = text.lastIndexOf("\n");
	if (idx === -1) return "";
	return text.slice(0, idx + 1);
}

/**
 * Build a per-file diff preview directly from a partial `apply_patch`
 * envelope by emitting its body lines in *input order*. This bypasses the
 * file-state re-diff (`computePatchDiff` → `Diff.structuredPatch`) whose
 * coalescing reorders the model's `-old +new -old +new` stream into
 * `-old -old +new +new` and visibly shifts existing `+added` lines
 * downward each time a new `-` arrives. The preview therefore grows
 * monotonically at the bottom while streaming and only becomes a real
 * unified diff once the args are complete.
 */
function buildApplyPatchNaturalOrderPreviews(input: string): PerFileDiffPreview[] | null {
	const lines = input.split("\n");
	const groups = new Map<string, string[]>();
	let currentPath: string | undefined;
	const ensure = (path: string): string[] => {
		let bucket = groups.get(path);
		if (!bucket) {
			bucket = [];
			groups.set(path, bucket);
		}
		return bucket;
	};
	for (const raw of lines) {
		const trimmedEnd = raw.trimEnd();
		if (trimmedEnd === BEGIN_PATCH_MARKER || trimmedEnd === END_PATCH_MARKER || trimmedEnd === ABORT_MARKER) {
			continue;
		}
		if (trimmedEnd.startsWith("*** Add File: ")) {
			currentPath = trimmedEnd.slice("*** Add File: ".length);
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith("*** Delete File: ")) {
			currentPath = trimmedEnd.slice("*** Delete File: ".length);
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith("*** Update File: ")) {
			currentPath = trimmedEnd.slice("*** Update File: ".length);
			ensure(currentPath);
			continue;
		}
		if (trimmedEnd.startsWith("*** Move to:") || trimmedEnd.startsWith("*** End of File")) {
			continue;
		}
		if (!currentPath) continue;
		// Diff body: keep `-/+/space`-prefixed lines and `@@` hunk headers in
		// input order. parseDiffLine accepts the no-line-number legacy form so
		// the renderer styles them as additions/removals/context naturally.
		if (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" ") || raw.startsWith("@@")) {
			ensure(currentPath).push(raw);
		}
	}
	if (groups.size === 0) return null;
	const previews: PerFileDiffPreview[] = [];
	for (const [path, body] of groups) {
		if (body.length === 0) continue;
		previews.push({ path, diff: body.join("\n") });
	}
	return previews.length > 0 ? previews : null;
}

const hashlineStrategy: EditStreamingStrategy<HashlineArgs> = {
	extractCompleteEdits(args) {
		return args;
	},
	async computeDiffPreview(args, ctx) {
		const input = hashlineEditText(args);
		if (typeof input !== "string" || input.length === 0) return null;
		// Unlike apply_patch, hashline previews flow through `applyPartialTo`,
		// whose streaming-tolerant parser (`parsePatchStreaming` → `endStreaming`)
		// drops a payload-less trailing op and projects a partially-typed payload
		// line onto the file as it grows. Trimming the trailing partial line here
		// would instead strip the sole payload of a single-op `replace`/`insert`
		// for almost the entire stream, collapsing the preview to "No changes" and
		// rendering a blank box. Feed the raw in-flight text straight through.
		ctx.signal.throwIfAborted();

		let sections: readonly HashlineInputSection[];
		try {
			sections = HashlinePatch.parse(input, { cwd: ctx.cwd }).sections;
		} catch {
			// While streaming, the trailing op may still be mid-typed and fail
			// to parse; suppress until the next chunk arrives. Once args are
			// complete, surface the error so the model sees what went wrong.
			if (ctx.isStreaming) return null;
			const result = await computeHashlineDiff({ input }, ctx.cwd, ctx.snapshots, {
				clipboard: forkClipboard(ctx.clipboard),
			});
			ctx.signal.throwIfAborted();
			return [toPerFilePreview("", result)];
		}
		if (sections.length === 0) return null;

		// While the trailing section is still being typed (no operations yet)
		// skip it so its empty/parse-error result doesn't replace previews of
		// already-completed sections with an opaque header.
		const lastIndex = sections.length - 1;
		const trailingIncomplete =
			sections.length > 1 && !containsRecognizableHashlineOperations(sections[lastIndex].diff);
		const sectionsToProcess = trailingIncomplete ? sections.slice(0, -1) : sections;
		const trailingProcessedIndex = sectionsToProcess.length - 1;

		const previews: PerFileDiffPreview[] = [];
		// Fork the session register per preview frame: sections feed each other
		// in patch order, but a preview must never mutate the live register.
		const clipboard = forkClipboard(ctx.clipboard);
		for (let i = 0; i < sectionsToProcess.length; i++) {
			ctx.signal.throwIfAborted();
			const section = sectionsToProcess[i];
			const result = await computeHashlineSectionDiff(section, ctx.cwd, ctx.snapshots, {
				streaming: ctx.isStreaming,
				skipHashValidation: ctx.isStreaming === true,
				clipboard,
			});
			ctx.signal.throwIfAborted();
			// Ignore parse/apply errors from the trailing (actively-typed)
			// section while streaming: a mid-typed op may transiently resolve to
			// "No changes" or an out-of-bounds anchor, and surfacing that would
			// wipe the already-stable previews (or, for a lone section, the prior
			// good frame). Returning no entry preserves the last preview. Earlier
			// sections, and every section once args are complete, stay rendered so
			// real errors still reach the model.
			if ((ctx.isStreaming || sectionsToProcess.length > 1) && i === trailingProcessedIndex && "error" in result) {
				continue;
			}
			previews.push(toPerFilePreview(section.path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback() {
		// Never leak raw hashline syntax (`64:`, `|payload`, `[path#hash]`)
		// to the user — the streaming preview already projects every
		// parseable op onto the real file via applyPartialTo, and an
		// unparseable trailing chunk renders as "no preview yet" rather
		// than a sigil dump.
		return "";
	},
	matcherDigest(args) {
		const input = hashlineEditText(args);
		if (typeof input !== "string") return undefined;
		// Body rows are `+TEXT`; headers and op lines are grammar, never content.
		return extractAddedLines(input, false);
	},
	matcherPaths(args) {
		const input = hashlineEditText(args);
		if (typeof input !== "string" || input.length === 0) return undefined;
		const paths = extractHashlineHeaderPaths(input);
		return paths.length > 0 ? paths : undefined;
	},
	matcherEntries(args) {
		const input = hashlineEditText(args);
		if (typeof input !== "string" || input.length === 0) return undefined;
		const entries = splitHashlinePerFile(input);
		return entries.length > 0 ? entries : undefined;
	},
};

interface ApplyPatchArgs {
	input?: string;
}

const applyPatchStrategy: EditStreamingStrategy<ApplyPatchArgs> = {
	extractCompleteEdits(args) {
		// Apply_patch payload is plain text, not an edits array. Nothing to trim.
		return args;
	},
	async computeDiffPreview(args, ctx) {
		if (typeof args.input !== "string" || args.input.length === 0) return null;
		const input = trimTrailingPartialLine(args.input, ctx.isStreaming);
		if (input.length === 0) return null;
		if (ctx.isStreaming) {
			// Render the envelope's diff body in input order so newly streamed
			// `+added` lines append at the bottom instead of being shuffled
			// upward as later `-removed` lines arrive and reorder the unified
			// diff that `Diff.structuredPatch` would otherwise produce.
			return buildApplyPatchNaturalOrderPreviews(input);
		}
		let entries: ApplyPatchEntry[];
		try {
			entries = expandApplyPatchToEntries({ input });
		} catch {
			try {
				entries = expandApplyPatchToPreviewEntries({ input });
			} catch (err) {
				return [{ path: "", error: err instanceof Error ? err.message : String(err) }];
			}
		}
		const groups = groupApplyPatchEntriesByPath(entries);
		if (groups.size === 0) return null;
		const previews: PerFileDiffPreview[] = [];
		for (const [path, fileEntries] of groups) {
			const first = fileEntries[0];
			if (!first) continue;
			ctx.signal.throwIfAborted();
			const result = await computePatchDiff(
				{ path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
				ctx.cwd,
				{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy },
			);
			ctx.signal.throwIfAborted();
			previews.push(toPerFilePreview(path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback() {
		return "";
	},
	matcherDigest(args) {
		const input = args?.input;
		if (typeof input !== "string") return undefined;
		// Envelope markers and `@@` hunk headers are grammar, never content.
		return extractAddedLines(input, false);
	},
	matcherPaths(args) {
		const input = args?.input;
		if (typeof input !== "string" || input.length === 0) return undefined;
		const paths = extractApplyPatchEnvelopePaths(input);
		return paths.length > 0 ? paths : undefined;
	},
	matcherEntries(args) {
		const input = args?.input;
		if (typeof input !== "string" || input.length === 0) return undefined;
		const entries = splitApplyPatchPerFile(input);
		return entries.length > 0 ? entries : undefined;
	},
};
interface SloppyArgs {
	input?: string;
}

/**
 * Sloppy previews apply each complete `[path]` section in memory and diff the
 * result — the same pure engine the executor runs, never writing.
 */
const sloppyStrategy: EditStreamingStrategy<SloppyArgs> = {
	extractCompleteEdits(args, _partialJson, isStreaming) {
		const input = args.input;
		return isStreaming && typeof input === "string" ? { input: trimTrailingPartialLine(input, true) } : args;
	},
	async computeDiffPreview(args, ctx) {
		if (typeof args.input !== "string" || args.input.length === 0) return null;
		const input = trimTrailingPartialLine(args.input, ctx.isStreaming);
		const sections = splitSloppySections(input);
		if (sections.length === 0) return null;
		const previews: PerFileDiffPreview[] = [];
		const lastIndex = sections.length - 1;
		for (let i = 0; i < sections.length; i++) {
			ctx.signal.throwIfAborted();
			const result = await computeSloppySectionDiff(sections[i], ctx.cwd);
			ctx.signal.throwIfAborted();
			// The trailing section is still being typed while streaming; a
			// transient parse/match error there would wipe stable previews of
			// earlier sections. Suppress it until args are complete.
			if (ctx.isStreaming && i === lastIndex && "error" in result) continue;
			previews.push(toPerFilePreview(sections[i].path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback() {
		// Never leak the raw payload (§/¤ grammar, unsanitized tabs) into the TUI.
		return "";
	},
	matcherDigest(args) {
		return typeof args?.input === "string" ? args.input : undefined;
	},
	matcherPaths(args) {
		// Paths live in the payload's `[path]` section headers.
		if (typeof args?.input !== "string") return undefined;
		const sections = splitSloppySections(args.input);
		return sections.length > 0 ? sections.map(section => section.path) : undefined;
	},
	matcherEntries(args) {
		if (typeof args?.input !== "string") return undefined;
		const sections = splitSloppySections(args.input);
		if (sections.length === 0) return undefined;
		return sections.map(section => ({ path: section.path, digest: section.body }));
	},
};

export const EDIT_MODE_STRATEGIES: Record<EditMode, EditStreamingStrategy<unknown>> = {
	replace: replaceStrategy as EditStreamingStrategy<unknown>,
	patch: patchStrategy as EditStreamingStrategy<unknown>,
	hashline: hashlineStrategy as EditStreamingStrategy<unknown>,
	apply_patch: applyPatchStrategy as EditStreamingStrategy<unknown>,
	sloppy: sloppyStrategy as EditStreamingStrategy<unknown>,
};

export { resolveEditMode };

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function toPerFilePreview(path: string, result: DiffResult | DiffError): PerFileDiffPreview {
	if ("error" in result) {
		return { path, error: result.error };
	}
	return { path, diff: result.diff, firstChangedLine: result.firstChangedLine };
}
