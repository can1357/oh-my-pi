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
 * space indents, the GCD of all space-indent widths gives the stride (so a
 * 2/4/6 file reports `2`, a 4/8 file reports `4`). Returns `undefined` for any
 * field the content does not pin so a higher-precedence override (editorconfig)
 * can win without being overwritten by sniffing noise.
 */
export function detectIndentFromContent(content: string): DetectedIndent {
	if (content.length === 0) return {};

	let insertSpaces: boolean | undefined;
	let unit = 0;

	// Split is the cheapest reliable line walk on arbitrary text; the
	// per-line regex matches are O(leading whitespace) so total cost is
	// linear in the file's indented prefix bytes.
	for (const line of content.split("\n")) {
		// Skip blank/whitespace-only lines — they carry no indent signal.
		if (line.length === 0 || line.trim().length === 0) continue;

		const first = line[0];
		if (first !== " " && first !== "\t") continue;

		if (insertSpaces === undefined) {
			insertSpaces = first === " ";
		}

		// Tab-indented file: the unit is one tab per level; tabSize is a
		// display concern, leave it to caller defaults / editorconfig.
		if (first === "\t") continue;

		// Space-indented: count the leading spaces (stop at first tab to avoid
		// mixing). GCD across non-zero widths converges on the stride.
		let n = 0;
		while (n < line.length && line[n] === " ") n++;
		if (n === 0) continue;
		unit = unit === 0 ? n : gcd(unit, n);
	}

	const result: DetectedIndent = {};
	if (insertSpaces !== undefined) result.insertSpaces = insertSpaces;
	if (unit > 0 && insertSpaces === true) result.tabSize = unit;
	return result;
}

function gcd(a: number, b: number): number {
	let x = a;
	let y = b;
	while (y !== 0) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x;
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
