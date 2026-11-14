/**
 * Per-file LSP `FormattingOptions` resolution.
 *
 * Replaces the historical hardcoded `{ tabSize: 3, insertSpaces: true }` default
 * that fed every `textDocument/formatting` request — it silently re-indented
 * 2-space YAML (and any LSP-formatted file) on every write/edit (issue #2329).
 *
 * Precedence, highest to lowest:
 *   1. `.editorconfig` in the file's chain (`indent_style`, `indent_size`, `tab_width`).
 *   2. Indent detected from the file content the agent is about to write.
 *   3. Hardcoded fallback — 2 spaces, matching the dominant convention for YAML,
 *      JSON, JS/TS, Python (PEP 8 is 4 but most LSP servers honour their own
 *      defaults when ours don't disagree), and most config formats. The previous
 *      `3` default was an unusual stride that actively damaged every file with
 *      a 2/4-space convention.
 */
import { getEditorConfigFormatting } from "@oh-my-pi/pi-utils";

/** Subset of the LSP `FormattingOptions` we send. */
export interface LspFormattingOptions {
	tabSize: number;
	insertSpaces: boolean;
	trimTrailingWhitespace: boolean;
	insertFinalNewline: boolean;
	trimFinalNewlines: boolean;
}

/** Sensible fallback when neither `.editorconfig` nor file content pins the indent. */
const FALLBACK_TAB_SIZE = 2;
const FALLBACK_INSERT_SPACES = true;

/** Static flags we always pass — these have no per-file analogue and match common formatter expectations. */
const TRIM_OPTIONS = {
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
} as const;

interface DetectedIndent {
	tabSize?: number;
	insertSpaces?: boolean;
}

/**
 * Sniff `insertSpaces` and the indent unit from `content`.
 *
 * Walks the buffer once: the first indented line decides spaces vs tabs; for
 * space indents, the most frequent indent increase between consecutive lines
 * gives the stride (so a 2/4/6 file reports `2`, a 4/8 file reports `4`).
 * Lines inside block comments are skipped: JSDoc continuations (` * …`) sit
 * one space past `/*`, not one indent level deeper. Taking the mode keeps
 * one-off alignment (template-literal bodies, hanging continuations) from
 * dragging the stride down. Returns `undefined` for any field the content does
 * not pin so a higher-precedence override (editorconfig) can win without being
 * overwritten by sniffing noise.
 */
export function detectIndentFromContent(content: string): DetectedIndent {
	if (content.length === 0) return {};

	let insertSpaces: boolean | undefined;
	let inBlockComment = false;
	let prevWidth = 0;
	// Indent increase (in spaces) → number of lines that stepped in by it.
	const steps = new Map<number, number>();

	for (const line of content.split("\n")) {
		const body = line.trim();
		// Blank/whitespace-only lines carry no indent signal.
		if (body.length === 0) continue;

		if (inBlockComment) {
			if (body.includes("*/")) inBlockComment = false;
			continue;
		}
		// The opener line itself is indented like code; only its continuations are skipped.
		if (body.startsWith("/*") && !body.includes("*/", 2)) inBlockComment = true;

		// Tab-indented line: the unit is one tab per level; tabSize is a
		// display concern, leave it to caller defaults / editorconfig.
		if (line[0] === "\t") {
			insertSpaces ??= false;
			continue;
		}

		// Space-indented (or unindented): count leading spaces, stopping at the
		// first tab to avoid mixing.
		let width = 0;
		while (line[width] === " ") width++;
		if (width > 0) insertSpaces ??= true;
		if (width > prevWidth) {
			const step = width - prevWidth;
			steps.set(step, (steps.get(step) ?? 0) + 1);
		}
		prevWidth = width;
	}

	const result: DetectedIndent = {};
	if (insertSpaces !== undefined) result.insertSpaces = insertSpaces;
	if (insertSpaces === true) {
		const unit = mostFrequentStep(steps);
		if (unit > 0) result.tabSize = unit;
	}
	return result;
}

/** Most frequent key in `steps`; ties go to the smaller step. `0` when empty. */
function mostFrequentStep(steps: Map<number, number>): number {
	let best = 0;
	let bestCount = 0;
	for (const [step, count] of steps) {
		if (count > bestCount || (count === bestCount && step < best)) {
			best = step;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Resolve the `FormattingOptions` payload for a `textDocument/formatting` request
 * targeting `filePath` with `content`.
 *
 * The two fields that actually affect on-disk bytes (`tabSize`, `insertSpaces`)
 * are layered: editorconfig wins, then content sniffing, then the fallback.
 * Trim/final-newline flags are static.
 */
export function resolveFormatOptions(filePath: string, content: string): LspFormattingOptions {
	const fromConfig = getEditorConfigFormatting(filePath);
	const detected = detectIndentFromContent(content);

	return {
		tabSize: fromConfig.tabSize ?? detected.tabSize ?? FALLBACK_TAB_SIZE,
		insertSpaces: fromConfig.insertSpaces ?? detected.insertSpaces ?? FALLBACK_INSERT_SPACES,
		...TRIM_OPTIONS,
	};
}
