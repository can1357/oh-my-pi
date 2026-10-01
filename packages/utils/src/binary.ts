/**
 * Content-based binary/text classification for files that are about to be
 * decoded as UTF-8 text and shown to a model or user.
 *
 * The read tool and `@file` auto-read both materialize file bytes as UTF-8
 * strings. For a binary file (font, object, archive, packed blob) that decode
 * is lossy: NUL bytes and invalid sequences survive as control characters and
 * U+FFFD replacements, which corrupt terminal rendering and waste the context
 * window with mojibake. Sniff the header first and refuse instead.
 *
 * @example
 * if (await isProbablyBinary(path)) return "[binary file omitted]";
 * const text = await Bun.file(path).text();
 */
import { peekFile, peekFileSync } from "./peek-file";

/**
 * Header window sniffed for the binary heuristic; mirrors git's 8000-byte scan.
 * Exported so callers that already hold the whole file in memory can sniff the
 * identical prefix through {@link isProbablyBinaryHeader} instead of reopening.
 */
export const BINARY_SNIFF_BYTES = 8192;

/**
 * Classify an in-memory byte header as binary (non-UTF-8-text).
 *
 * Binary when the header contains a NUL byte (true binary, plus UTF-16/UTF-32
 * text whose ASCII range is NUL-padded) or when it is not valid UTF-8. The
 * decode runs in streaming mode so a multibyte sequence truncated at the header
 * boundary is tolerated, while any genuinely invalid byte still fails — matching
 * the strict `fatal` decode the `local://`/`ssh://` read paths already use.
 */
export function isProbablyBinaryHeader(header: Uint8Array): boolean {
	if (header.indexOf(0) !== -1) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(header, { stream: true });
		return false;
	} catch {
		return true;
	}
}

/**
 * Sniff the first {@link BINARY_SNIFF_BYTES} of `filePath` and report whether it
 * is binary (non-UTF-8-text). See {@link isProbablyBinaryHeader} for the rule.
 */
export function isProbablyBinary(filePath: string, maxBytes = BINARY_SNIFF_BYTES): Promise<boolean> {
	return peekFile(filePath, maxBytes, isProbablyBinaryHeader);
}

/** Synchronous {@link isProbablyBinary}. */
export function isProbablyBinarySync(filePath: string, maxBytes = BINARY_SNIFF_BYTES): boolean {
	return peekFileSync(filePath, maxBytes, isProbablyBinaryHeader);
}
