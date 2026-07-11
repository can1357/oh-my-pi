/**
 * Read-only hashline diff preview helpers used by the streaming edit
 * renderer. Reads the target file, parses + applies the section's edits in
 * memory (no FS write, no LSP writethrough), then hands the before/after
 * pair to {@link generateDiffString} so the renderer can show the diff
 * while the tool call is still streaming.
 *
 * Uses the same snapshot-tag semantics as the apply path: a live content-hash
 * match is accepted even when the tag was minted by a source that did not keep
 * history, and stale tags recover through the session snapshot store when possible.
 */
import {
	type ApplyResult,
	applyEdits,
	type Cursor,
	computeFileHash,
	type Edit,
	Patch as HashlinePatch,
	hasBlockEdit,
	MismatchError,
	missingSnapshotTagMessage,
	normalizeToLF,
	type Patch,
	type PatchSection,
	parsePatchStreaming,
	Recovery,
	resolveBlockEdits,
	type SnapshotStore,
	stripBom,
} from "@pk-nerdsaver-ai/hashline";
import { resolveToCwd } from "../../tools/path-utils";
import { generateDiffString } from "../diff";
import { readEditFileText } from "../read-file";
import { nativeBlockResolver } from "./block-resolver";

export interface HashlineDiffOptions {
	/**
	 * Use the streaming-tolerant applier ({@link PatchSection.applyPartialTo})
	 * so trailing in-flight ops do not throw or emit phantom edits. Streaming
	 * preview path only.
	 */
	streaming?: boolean;
	/**
	 * Skip snapshot-tag validation. Streaming previews use this so transient
	 * stale/missing tags do not flash re-read errors while the model is still
	 * authoring input; the final apply path still validates through Patcher.
	 */
	skipHashValidation?: boolean;
}

async function readSectionText(absolutePath: string, sectionPath: string): Promise<string> {
	try {
		return await readEditFileText(absolutePath, sectionPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message || `Unable to read ${sectionPath}`);
	}
}

/**
 * Streaming previews recompute on every streamed chunk; re-reading the target
 * file from disk each tick dominates the cost on large files. Cache the raw
 * section text keyed by mtime+size so any on-disk change invalidates
 * naturally. Used by the streaming path only — the args-complete pass always
 * reads fresh.
 */
const streamingTextCache = new Map<string, { mtimeMs: number; size: number; rawContent: string }>();
const STREAMING_TEXT_CACHE_MAX = 8;

async function readSectionTextCached(absolutePath: string, sectionPath: string): Promise<string> {
	let stamp: { mtimeMs: number; size: number } | undefined;
	try {
		const stat = await Bun.file(absolutePath).stat();
		stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		stamp = undefined;
	}
	if (stamp) {
		const cached = streamingTextCache.get(absolutePath);
		if (cached && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached.rawContent;
	}
	const rawContent = await readSectionText(absolutePath, sectionPath);
	if (stamp) {
		if (streamingTextCache.size >= STREAMING_TEXT_CACHE_MAX && !streamingTextCache.has(absolutePath)) {
			const oldest = streamingTextCache.keys().next().value;
			if (oldest !== undefined) streamingTextCache.delete(oldest);
		}
		streamingTextCache.set(absolutePath, { mtimeMs: stamp.mtimeMs, size: stamp.size, rawContent });
	}
	return rawContent;
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		if (edit.kind === "block") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function createMismatchError(
	section: PatchSection,
	absolutePath: string,
	normalized: string,
	snapshots: SnapshotStore,
	expected: string,
): MismatchError {
	return new MismatchError({
		path: section.path,
		expectedFileHash: expected,
		actualFileHash: computeFileHash(normalized),
		fileLines: normalized.split("\n"),
		anchorLines: section.collectAnchorLines(),
		hashRecognized: snapshots.byHash(absolutePath, expected) !== null,
	});
}

function parsePreviewEdits(section: PatchSection, streaming: boolean | undefined): readonly Edit[] {
	return streaming ? parsePatchStreaming(section.diff).edits : section.edits;
}

function resolvePreviewEdits(args: {
	section: PatchSection;
	absolutePath: string;
	normalized: string;
	snapshots: SnapshotStore;
	expected: string | undefined;
	liveMatches: boolean;
	edits: readonly Edit[];
}): readonly Edit[] {
	const { section, absolutePath, normalized, snapshots, expected, liveMatches, edits } = args;
	if (!hasBlockEdit(edits)) return edits;
	const baseText = expected === undefined || liveMatches ? normalized : snapshots.byHash(absolutePath, expected)?.text;
	if (baseText === undefined) {
		throw createMismatchError(section, absolutePath, normalized, snapshots, expected ?? "");
	}
	return resolveBlockEdits(edits, baseText, section.path, nativeBlockResolver, { onUnresolved: "throw" });
}

function applyPreviewEdits(args: {
	section: PatchSection;
	absolutePath: string;
	normalized: string;
	snapshots: SnapshotStore;
	options: HashlineDiffOptions;
}): ApplyResult {
	const { section, absolutePath, normalized, snapshots, options } = args;
	const expected = section.fileHash;
	if (!options.skipHashValidation && expected === undefined) {
		throw new Error(missingSnapshotTagMessage(section.path));
	}
	const liveMatches = expected !== undefined && computeFileHash(normalized) === expected;
	const edits = parsePreviewEdits(section, options.streaming);
	const resolved = resolvePreviewEdits({ section, absolutePath, normalized, snapshots, expected, liveMatches, edits });
	if (options.skipHashValidation || expected === undefined || liveMatches) return applyEdits(normalized, resolved);
	if (!hasAnchorScopedEdit(resolved)) return applyEdits(normalized, resolved);

	const recovered = new Recovery(snapshots).tryRecover({
		path: absolutePath,
		currentText: normalized,
		fileHash: expected,
		edits: resolved,
	});
	if (recovered) return recovered;
	throw createMismatchError(section, absolutePath, normalized, snapshots, expected);
}

/**
 * Map an insert cursor to the 1-indexed line where its payload lands, used to
 * number the `+` rows of a streaming preview. Deliberately approximate: it
 * ignores line shifts introduced by sibling ops, because the args-complete
 * pass renumbers everything through the real unified diff.
 */
function insertCursorLine(cursor: Cursor, fileLineCount: number): number {
	switch (cursor.kind) {
		case "bof":
			return 1;
		case "eof":
			return fileLineCount + 1;
		case "before_anchor":
			return cursor.anchor.line;
		case "after_anchor":
			return cursor.anchor.line + 1;
	}
}

/**
 * Build a streaming diff preview by emitting, per op in patch order, the
 * removed file lines followed by the op's `+` payload rows — never a whole-file
 * Myers re-diff. {@link generateDiffString} re-aligns the in-flight payload
 * against the removed block on every streamed chunk (it greedily matches shared
 * `}`/blank/`return` rows), so additions jump between hunks and the tail window
 * the renderer pins stutters tick to tick. Natural order keeps the removed
 * block fixed and grows the payload monotonically at the bottom so the streamed
 * cursor stays put. Mirrors the apply_patch streaming strategy; the
 * args-complete pass still produces the real unified diff.
 */
function buildStreamingSectionDiff(
	section: PatchSection,
	normalized: string,
): { diff: string; firstChangedLine: number | undefined } | { error: string } {
	const { edits, fileOp } = parsePatchStreaming(section.diff);
	const resolved = resolveBlockEdits(edits, normalized, section.path, nativeBlockResolver, { onUnresolved: "drop" });
	if (resolved.length === 0) {
		// A whole-file op (REM / MV) carries no line edits: the change is the
		// delete/move itself, conveyed by the result header, so emit an empty
		// diff rather than a misleading "No changes" error.
		if (fileOp) return { diff: "", firstChangedLine: undefined };
		return { error: `No changes would be made to ${section.path}.` };
	}

	const fileLines = normalized.split("\n");
	const rows: string[] = [];
	let firstChangedLine: number | undefined;

	// Every edit emitted from one op header carries that header's patch line
	// number and the edits sit contiguously (a replace lays down its replacement
	// inserts then its range deletes; block ops expand to the same shape). Group
	// on that boundary so each op stays intact and ordered.
	for (let i = 0; i < resolved.length; ) {
		const opLine = resolved[i].lineNum;
		const deletes: number[] = [];
		const inserts: string[] = [];
		let insertBase: number | undefined;
		while (i < resolved.length && resolved[i].lineNum === opLine) {
			const edit = resolved[i];
			if (edit.kind === "delete") deletes.push(edit.anchor.line);
			else if (edit.kind === "insert") {
				insertBase ??= insertCursorLine(edit.cursor, fileLines.length);
				inserts.push(edit.text);
			}
			i++;
		}
		// Removed lines first (a fixed block), payload second (grows at the
		// bottom = the streamed cursor).
		deletes.sort((a, b) => a - b);
		for (const line of deletes) {
			firstChangedLine ??= line;
			const content = line >= 1 && line <= fileLines.length ? fileLines[line - 1] : "";
			rows.push(`-${line}|${content}`);
		}
		let newLine = insertBase ?? deletes[0] ?? 1;
		for (const text of inserts) {
			firstChangedLine ??= newLine;
			rows.push(`+${newLine}|${text}`);
			newLine++;
		}
	}

	if (rows.length === 0) return { error: `No changes would be made to ${section.path}.` };
	return { diff: rows.join("\n"), firstChangedLine };
}

export async function computeHashlineSectionDiff(
	section: PatchSection,
	cwd: string,
	snapshots: SnapshotStore,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	try {
		const absolutePath = resolveToCwd(section.path, cwd);
		const rawContent = options.streaming
			? await readSectionTextCached(absolutePath, section.path)
			: await readSectionText(absolutePath, section.path);
		const { text: content } = stripBom(rawContent);
		const normalized = normalizeToLF(content);
		// Streaming favors a stable, monotonic preview over an exact unified
		// diff: feed the in-flight ops through the natural-order builder so the
		// streamed cursor stays pinned to the bottom. The args-complete pass
		// (`streaming` unset) falls through to the real Myers diff below.
		if (options.streaming) return buildStreamingSectionDiff(section, normalized);
		const result = applyPreviewEdits({ section, absolutePath, normalized, snapshots, options });
		if (normalized === result.text) {
			// REM/MV-only sections change no text; the header conveys the
			// delete/move, so don't surface a "No changes" error.
			if (section.fileOp) return { diff: "", firstChangedLine: undefined };
			return { error: `No changes would be made to ${section.path}.` };
		}
		return generateDiffString(normalized, result.text, undefined, { path: section.path });
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function computeHashlineDiff(
	input: { input: string },
	cwd: string,
	snapshots: SnapshotStore,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	let patch: Patch;
	try {
		patch = HashlinePatch.parse(input.input, { cwd });
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	if (patch.sections.length !== 1) {
		return { error: "Streaming diff preview supports exactly one hashline section." };
	}
	return computeHashlineSectionDiff(patch.sections[0], cwd, snapshots, options);
}
