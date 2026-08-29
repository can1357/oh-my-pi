/**
 * Text normalization utilities for the edit tool.
 *
 * Whitespace, Unicode, and indentation helpers. Line-ending and BOM
 * primitives live in `@oh-my-pi/hashline` and are re-exported here so
 * existing consumers see one stable surface.
 */

import { padding } from "@oh-my-pi/pi-tui";

export {
	type BomResult,
	detectLineEnding,
	type LineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "@oh-my-pi/hashline";

// ═══════════════════════════════════════════════════════════════════════════
// Whitespace Utilities
// ═══════════════════════════════════════════════════════════════════════════

/** Count leading whitespace characters in a line */
export function countLeadingWhitespace(line: string): number {
	let count = 0;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === " " || char === "\t") {
			count++;
		} else {
			break;
		}
	}
	return count;
}

/** Get the leading whitespace string from a line */
export function getLeadingWhitespace(line: string): string {
	return line.slice(0, countLeadingWhitespace(line));
}

function isNonEmptyLine(line: string): boolean {
	return line.trim().length > 0;
}

/** Compute minimum indentation of non-empty lines */
export function minIndent(text: string): number {
	const lines = text.split("\n");
	let min = Infinity;
	for (const line of lines) {
		if (isNonEmptyLine(line)) {
			min = Math.min(min, countLeadingWhitespace(line));
		}
	}
	return min === Infinity ? 0 : min;
}

/** Detect the indentation character used in text (space or tab) */
export function detectIndentChar(text: string): string {
	const lines = text.split("\n");
	for (const line of lines) {
		const ws = getLeadingWhitespace(line);
		if (ws.length > 0) {
			return ws[0];
		}
	}
	return " ";
}

function gcd(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const temp = y;
		y = x % y;
		x = temp;
	}
	return x;
}

interface IndentProfile {
	lines: string[];
	indentCounts: number[];
	char: " " | "\t" | undefined;
	spaceOnly: boolean;
	tabOnly: boolean;
	mixed: boolean;
	unit: number;
	nonEmptyCount: number;
}

function buildIndentProfile(text: string): IndentProfile {
	const lines = text.split("\n");
	const indentCounts: number[] = [];
	let char: " " | "\t" | undefined;
	let spaceOnly = true;
	let tabOnly = true;
	let mixed = false;
	let nonEmptyCount = 0;
	let unit = 0;

	for (const line of lines) {
		if (!isNonEmptyLine(line)) continue;
		nonEmptyCount++;
		const indent = getLeadingWhitespace(line);
		indentCounts.push(indent.length);
		if (indent.includes(" ")) {
			tabOnly = false;
		}
		if (indent.includes("\t")) {
			spaceOnly = false;
		}
		if (indent.includes(" ") && indent.includes("\t")) {
			mixed = true;
		}
		if (indent.length > 0) {
			const currentChar = indent[0] as " " | "\t";
			if (!char) {
				char = currentChar;
			} else if (char !== currentChar) {
				mixed = true;
			}
		}
	}

	if (spaceOnly && nonEmptyCount > 0) {
		let current = 0;
		for (const count of indentCounts) {
			if (count === 0) continue;
			current = current === 0 ? count : gcd(current, count);
		}
		unit = current;
	}

	if (tabOnly && nonEmptyCount > 0) {
		unit = 1;
	}

	return {
		lines,
		indentCounts,
		char,
		spaceOnly,
		tabOnly,
		mixed,
		unit,
		nonEmptyCount,
	};
}

export function convertLeadingTabsToSpaces(text: string, spacesPerTab: number): string {
	if (spacesPerTab <= 0) return text;
	return text
		.split("\n")
		.map(line => {
			const trimmed = line.trimStart();
			if (trimmed.length === 0) return line;
			const leading = getLeadingWhitespace(line);
			if (!leading.includes("\t") || leading.includes(" ")) return line;
			const converted = padding(leading.length * spacesPerTab);
			return converted + trimmed;
		})
		.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Unicode Normalization
// ═══════════════════════════════════════════════════════════════════════════

const NON_ASCII_RE = /[^\x00-\x7F]/;
const UNICODE_REPLACEMENT_RE = /[\u00A0\u00BD\u2002-\u200D\u2010-\u201F\u202F\u205F\u2212\u2260\u3000\uFEFF]/g;

function replaceUnicodeCharacter(character: string): string {
	const codePoint = character.charCodeAt(0);
	if ((codePoint >= 0x2010 && codePoint <= 0x2015) || codePoint === 0x2212) return "-";
	if (codePoint >= 0x2018 && codePoint <= 0x201b) return "'";
	if (codePoint >= 0x201c && codePoint <= 0x201f) return '"';
	if (
		codePoint === 0x00a0 ||
		(codePoint >= 0x2002 && codePoint <= 0x200a) ||
		codePoint === 0x202f ||
		codePoint === 0x205f ||
		codePoint === 0x3000
	) {
		return " ";
	}
	if (codePoint === 0x2260) return "!=";
	if (codePoint === 0x00bd) return "1/2";
	return "";
}

export function normalizeUnicode(s: string): string {
	const trimmed = s.trim();
	if (!NON_ASCII_RE.test(trimmed)) return trimmed;
	return trimmed.replace(UNICODE_REPLACEMENT_RE, replaceUnicodeCharacter).normalize("NFC");
}

/**
 * Normalize a line for fuzzy comparison.
 * Trims, collapses whitespace, and normalizes punctuation.
 */
export function normalizeForFuzzy(line: string): string {
	const trimmed = line.trim();
	if (trimmed.length === 0) return "";

	return trimmed
		.replace(/[""„‟«»]/g, '"')
		.replace(/[''‚‛`´]/g, "'")
		.replace(/[‐‑‒–—−]/g, "-")
		.replace(/[ \t]+/g, " ");
}

function isIndentationOnlyRewrite(oldText: string, newText: string): boolean {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	if (oldLines.length !== newLines.length) {
		return false;
	}
	for (let i = 0; i < oldLines.length; i++) {
		if (oldLines[i].trim() !== newLines[i].trim()) {
			return false;
		}
	}
	return true;
}

function maybeConvertTabIndentation(
	oldProfile: IndentProfile,
	actualProfile: IndentProfile,
	newProfile: IndentProfile,
	newText: string,
): string | undefined {
	if (!actualProfile.spaceOnly || !oldProfile.tabOnly || !newProfile.tabOnly || actualProfile.unit <= 0) {
		return undefined;
	}

	const lineCount = Math.min(oldProfile.lines.length, actualProfile.lines.length);
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldProfile.lines[i];
		const actualLine = actualProfile.lines[i];
		if (!isNonEmptyLine(oldLine) || !isNonEmptyLine(actualLine)) continue;
		const oldIndent = getLeadingWhitespace(oldLine);
		if (oldIndent.length === 0) continue;
		const actualIndent = getLeadingWhitespace(actualLine);
		if (actualIndent.length !== oldIndent.length * actualProfile.unit) {
			return undefined;
		}
	}

	return convertLeadingTabsToSpaces(newText, actualProfile.unit);
}

function computeUniformIndentDelta(oldProfile: IndentProfile, actualProfile: IndentProfile): number | undefined {
	const lineCount = Math.min(oldProfile.lines.length, actualProfile.lines.length);
	const deltas: number[] = [];
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldProfile.lines[i];
		const actualLine = actualProfile.lines[i];
		if (!isNonEmptyLine(oldLine) || !isNonEmptyLine(actualLine)) continue;
		deltas.push(countLeadingWhitespace(actualLine) - countLeadingWhitespace(oldLine));
	}

	if (deltas.length === 0) {
		return undefined;
	}

	const delta = deltas[0];
	return deltas.every(value => value === delta) ? delta : undefined;
}

function applyIndentDelta(text: string, delta: number, indentChar: string): string {
	const adjusted = text.split("\n").map(line => {
		if (!isNonEmptyLine(line)) {
			return line;
		}
		if (delta > 0) {
			return indentChar.repeat(delta) + line;
		}
		const toRemove = Math.min(-delta, countLeadingWhitespace(line));
		return line.slice(toRemove);
	});

	return adjusted.join("\n");
}

function hasNonEmptyIndentProfiles(...profiles: IndentProfile[]): boolean {
	return profiles.every(profile => profile.nonEmptyCount > 0);
}

function hasMixedIndentation(...profiles: IndentProfile[]): boolean {
	return profiles.some(profile => profile.mixed);
}

// ═══════════════════════════════════════════════════════════════════════════
// Indentation Adjustment
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Adjust newText indentation to match the indentation delta between
 * what was provided (oldText) and what was actually matched (actualText).
 *
 * If oldText has 0 indent but actualText has 12 spaces, we add 12 spaces
 * to each line in newText.
 */
export function adjustIndentation(oldText: string, actualText: string, newText: string): string {
	// If old text already matches actual text exactly, preserve agent's intended indentation
	if (oldText === actualText) {
		return newText;
	}

	// If the patch is purely an indentation change (same trimmed content), apply exactly as specified
	if (isIndentationOnlyRewrite(oldText, newText)) {
		return newText;
	}

	const oldProfile = buildIndentProfile(oldText);
	const actualProfile = buildIndentProfile(actualText);
	const newProfile = buildIndentProfile(newText);

	if (!hasNonEmptyIndentProfiles(oldProfile, actualProfile, newProfile)) {
		return newText;
	}

	if (hasMixedIndentation(oldProfile, actualProfile, newProfile)) {
		return newText;
	}

	if (oldProfile.char && actualProfile.char && oldProfile.char !== actualProfile.char) {
		const converted = maybeConvertTabIndentation(oldProfile, actualProfile, newProfile, newText);
		if (converted !== undefined) {
			return converted;
		}
		return newText;
	}

	const delta = computeUniformIndentDelta(oldProfile, actualProfile);
	if (delta === undefined || delta === 0) {
		return newText;
	}

	if (newProfile.char && actualProfile.char && newProfile.char !== actualProfile.char) {
		return newText;
	}

	const indentChar = actualProfile.char ?? oldProfile.char ?? detectIndentChar(actualText);
	return applyIndentDelta(newText, delta, indentChar);
}
