/**
 * Re-number a unified diff that uses the `+<lineNum>|content` /
 * `-<lineNum>|content` / ` <lineNum>|content` line format into a compact
 * current-file preview. Removed lines are counted for stats and post-edit
 * offset tracking, but omitted from the preview. Added and context lines are
 * anchored to their post-edit positions so a follow-up edit can reuse visible
 * concrete lines directly. Long contiguous added runs are summarized with a
 * `…` marker instead of echoing every inserted line.
 *
 * This is intentionally decoupled from the diff producer: anything that
 * emits the `<sign><lineNum>|<content>` shape works.
 */
import type { CompactDiffOptions, CompactDiffPreview, RenumberDelta } from "./types";

const DEFAULT_ADDED_RUN_CONTEXT_LINES = 2;

const PREVIEW_ELISION_MARKER = "…";
/** Blank row separating non-contiguous regions of a numbered diff. */
const PREVIEW_GAP_ROW = "";
const RAW_ELISION_MARKERS = new Set(["...", PREVIEW_ELISION_MARKER, `+${PREVIEW_ELISION_MARKER}`]);

function isPreviewSeparator(line: string | undefined): boolean {
	return line === PREVIEW_ELISION_MARKER || line === PREVIEW_GAP_ROW;
}

function appendPreviewLine(output: string[], line: string): void {
	const normalized = RAW_ELISION_MARKERS.has(line) ? PREVIEW_ELISION_MARKER : line;
	// Separators (elision markers, blank gap rows) never stack: omitted
	// removed lines between two separators would otherwise leave them
	// adjacent. A leading separator is dropped outright.
	if (isPreviewSeparator(normalized) && (output.length === 0 || isPreviewSeparator(output[output.length - 1]))) {
		return;
	}
	output.push(normalized);
}

interface ParsedDiffLine {
	kind: "+" | "-" | " ";
	lineNumber: number;
	content: string;
}

function normalizeAddedRunContext(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_ADDED_RUN_CONTEXT_LINES;
	return Math.max(1, Math.trunc(value));
}

function parseNumberedDiffLine(line: string): ParsedDiffLine | undefined {
	const kind = line[0];
	if (kind !== "+" && kind !== "-" && kind !== " ") return undefined;

	const body = line.slice(1);
	const sep = body.indexOf("|");
	if (sep === -1) return undefined;

	const lineNumber = Number.parseInt(body.slice(0, sep), 10);
	if (!Number.isFinite(lineNumber)) return undefined;

	return { kind, lineNumber, content: body.slice(sep + 1) };
}

function appendAddedRun(output: string[], run: string[], edgeLines: number): void {
	if (run.length === 0) return;

	const collapseThreshold = edgeLines * 2 + 1;
	if (run.length <= collapseThreshold) {
		for (const text of run) appendPreviewLine(output, text);
		return;
	}

	for (let i = 0; i < edgeLines; i++) appendPreviewLine(output, run[i]);
	appendPreviewLine(output, PREVIEW_ELISION_MARKER);
	for (let i = run.length - edgeLines; i < run.length; i++) appendPreviewLine(output, run[i]);
}

export function buildCompactDiffPreview(diff: string, options: CompactDiffOptions = {}): CompactDiffPreview {
	const lines = diff.length === 0 ? [] : diff.split("\n");
	const addedRunContext = normalizeAddedRunContext(options.maxAddedRunContext ?? options.maxUnchangedRun);
	let addedLines = 0;
	let removedLines = 0;
	const formatted: string[] = [];
	const addedRun: string[] = [];

	const flushAddedRun = (): void => {
		appendAddedRun(formatted, addedRun, addedRunContext);
		addedRun.length = 0;
	};

	// Per-hunk renumber tracking (issue #8603): a "hunk" is a maximal
	// contiguous run of `+`/`-` rows; context rows separate hunks. Each hunk
	// reports one delta keyed to ORIGINAL numbering so the entries are
	// independent and composable (see RenumberDelta): a consumer below every
	// hunk sums them, a consumer between two hunks applies only the deltas
	// above its anchor.
	//
	// Anchor resolution for a hunk's `fromLine` (the last original line after
	// which nothing in that hunk sits): the last `-` row's pre-edit number
	// when the hunk removes anything; otherwise (pure insertion) the
	// pre-edit number of the context row immediately BEFORE the run, or the
	// row immediately AFTER minus 1, whichever the diff exposes. A pure-add
	// run with neither (diff produced no context at all) has no original
	// anchor and is skipped — its shift still counts toward `addedLines -
	// removedLines`, and the renderer's `net` line fires whenever that total
	// disagrees with the sum of the emitted per-hunk deltas.
	const renumbers: RenumberDelta[] = [];
	let runAdded = 0;
	let runRemoved = 0;
	let runLastRemovedLine: number | undefined;
	let contextBeforeRun: number | undefined;
	const flushRenumberRun = (contextAfterRun: number | undefined): void => {
		if (runAdded === 0 && runRemoved === 0) return;
		const delta = runAdded - runRemoved;
		const fromLine =
			runLastRemovedLine ?? contextBeforeRun ?? (contextAfterRun !== undefined ? contextAfterRun - 1 : undefined);
		if (delta !== 0 && fromLine !== undefined) renumbers.push({ fromLine, delta });
		runAdded = 0;
		runRemoved = 0;
		runLastRemovedLine = undefined;
	};

	// External diff producers number `+` lines with the post-edit line number,
	// `-` lines with the pre-edit line number, and context lines with the
	// pre-edit line number. To emit fresh line numbers usable for follow-up
	// edits, convert context-line numbers to post-edit positions by tracking
	// the running offset (added so far - removed so far) as we walk the diff.
	for (const line of lines) {
		const parsed = parseNumberedDiffLine(line);
		if (!parsed) {
			flushAddedRun();
			// Unparsed rows (elision markers, gap rows) break contiguity and
			// carry no original line number, so they also break hunk runs
			// without contributing an anchor.
			flushRenumberRun(undefined);
			contextBeforeRun = undefined;
			appendPreviewLine(formatted, line);
			continue;
		}

		switch (parsed.kind) {
			case "+": {
				addedLines++;
				runAdded++;
				addedRun.push(`${parsed.lineNumber}:${parsed.content}`);
				break;
			}
			case "-":
				flushAddedRun();
				removedLines++;
				runRemoved++;
				runLastRemovedLine = parsed.lineNumber;
				break;
			default: {
				flushAddedRun();
				flushRenumberRun(parsed.lineNumber);
				contextBeforeRun = parsed.lineNumber;
				const newLineNumber = parsed.lineNumber + addedLines - removedLines;
				appendPreviewLine(formatted, `${newLineNumber}:${parsed.content}`);
				break;
			}
		}
	}
	flushAddedRun();
	flushRenumberRun(undefined);
	while (formatted.length > 0 && isPreviewSeparator(formatted[formatted.length - 1])) formatted.pop();

	return { preview: formatted.join("\n"), addedLines, removedLines, renumbers };
}
