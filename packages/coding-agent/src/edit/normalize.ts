export type LineEnding = "\r\n" | "\n";

/** Detect the first line-ending style. Defaults to LF. */
export function detectLineEnding(content: string): LineEnding {
	const crlfIndex = content.indexOf("\r\n");
	const lfIndex = content.indexOf("\n");
	if (lfIndex === -1 || crlfIndex === -1) return "\n";
	return crlfIndex < lfIndex ? "\r\n" : "\n";
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
	return text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n");
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Strip a UTF-8 BOM and preserve it for round-tripping. */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

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

export function normalizeUnicode(value: string): string {
	const trimmed = value.trim();
	if (!NON_ASCII_RE.test(trimmed)) return trimmed;
	return trimmed.replace(UNICODE_REPLACEMENT_RE, replaceUnicodeCharacter).normalize("NFC");
}
