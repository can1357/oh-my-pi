/**
 * Content helpers shared by every whole-file writer: the `write` tool's file
 * pipeline and handler-owned writes that splice files directly (conflict://).
 */
import { formatHashlineHeader, stripHashlinePrefixes } from "@oh-my-pi/pi-tui/tools/hashline-format";
import { normalizeToLF } from "../edit/normalize";
import { getEditStore } from "../edit/store";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from "./index";
import { formatPathRelativeToCwd } from "./path-utils";

const LOOSE_HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;

/**
 * Strip hashline display prefixes from write content.
 *
 * Includes a fallback for loosely-formed section headers that still carry
 * line-number prefixes (for example legacy or malformed hashline echoes).
 */
function stripWriteContentWithPotentialLooseHeader(lines: string[]): { text: string; stripped: boolean } {
	const originalText = lines.join("\n");
	const cleanedText = stripHashlinePrefixes(lines).join("\n");
	if (cleanedText !== originalText) {
		return { text: cleanedText, stripped: true };
	}

	const headerIndex = lines.findIndex(line => line.trim().length > 0);
	if (headerIndex === -1 || !LOOSE_HASHLINE_HEADER_RE.test(lines[headerIndex])) {
		return { text: lines.join("\n"), stripped: false };
	}

	const linesWithoutHeader = lines.slice(0, headerIndex).concat(lines.slice(headerIndex + 1));
	const textWithoutHeader = linesWithoutHeader.join("\n");
	const cleanedWithoutHeader = stripHashlinePrefixes(linesWithoutHeader).join("\n");
	if (cleanedWithoutHeader === textWithoutHeader) {
		return { text: originalText, stripped: false };
	}
	return { text: cleanedWithoutHeader, stripped: true };
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Only active when hashline edit mode is enabled — the model sees `[PATH#HASH]`
 * headers plus `LINE:` prefixes in read output and sometimes copies them into write content.
 */
export function stripWriteContent(session: ToolSession, content: string): { text: string; stripped: boolean } {
	if (!resolveFileDisplayMode(session).hashLines) {
		return { text: content, stripped: false };
	}
	return stripWriteContentWithPotentialLooseHeader(content.split("\n"));
}

/**
 * Record a snapshot of the freshly-written `content` for `absolutePath`
 * so subsequent hashline edits address the new file with a current tag,
 * and return the matching `[displayPath#TAG]` header. Returns `undefined`
 * when the session is not in hashline mode so callers can no-op cheaply.
 *
 * Mirrors the post-commit snapshot recording the hashline patcher performs
 * after a successful edit — the model gets a tag without an extra `read` —
 * but with EMPTY seen-line provenance: a write displays no numbered lines,
 * so anchored edits against this tag must first see the anchor content (the
 * patcher rejects them with an inline reveal). Authoring content is not
 * knowing its line numbers.
 */
export function maybeWriteSnapshotHeader(
	session: ToolSession,
	absolutePath: string,
	content: string,
): string | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const tag = getEditStore(session).recordSnapshot(absolutePath, normalized, []);
	return formatHashlineHeader(formatPathRelativeToCwd(absolutePath, session.cwd), tag);
}
