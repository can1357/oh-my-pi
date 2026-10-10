import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_LINE_BODY_SEP,
} from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import type { ToolSession } from ".";

/** Shortest run of identical rows worth replacing; the marker costs about as much as three short rows. */
const MIN_ELIDED_RUN = 4;

/** Splits a `N:text` hashline row into its line number and text; `undefined` for headers, ellipses, and notices. */
function parseRow(line: string): { number: number; text: string } | undefined {
	const sep = line.indexOf(HL_LINE_BODY_SEP);
	if (sep <= 0) return undefined;
	for (let i = 0; i < sep; i++) {
		const code = line.charCodeAt(i);
		if (code < 48 || code > 57) return undefined;
	}
	return { number: Number(line.slice(0, sep)), text: line.slice(sep + 1) };
}

/** The `path` of a leading `[path#TAG]` hashline header line, or `undefined` when the line is not one. */
function headerPath(line: string): string | undefined {
	const tagStart = line.length - HL_FILE_HASH_LENGTH - 2;
	if (!line.startsWith(HL_FILE_PREFIX) || !line.endsWith("]") || line[tagStart] !== HL_FILE_HASH_SEP) return undefined;
	return line.slice(HL_FILE_PREFIX.length, tagStart);
}

/** Rows of `path` that read results still in the live context show, keyed by line number (newest read wins). */
function collectContextRows(session: ToolSession, path: string): Map<number, string> {
	const rows = new Map<number, string>();
	const messages = session.sessionManager?.buildSessionContext?.().messages;
	if (!messages) return rows;
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "read" || message.isError) continue;
		if (message.prunedAt !== undefined) continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const lines = block.text.split("\n");
			if (headerPath(lines[0]) !== path) continue;
			for (let i = 1; i < lines.length; i++) {
				const row = parseRow(lines[i]);
				if (row) rows.set(row.number, row.text);
			}
		}
	}
	return rows;
}

/**
 * Replace rows of a hashline `read` result that an earlier read of the same file
 * still in the live context already shows, row for row, with a one-line marker.
 * The model keeps every row it would have seen: the marker names the line range
 * and the rows themselves sit earlier in its context. The edit store already
 * counts every returned row as seen, so anchors into elided rows stay valid.
 *
 * Reads that rest on earlier results are flagged through `details.reusedRows`, so
 * pruning never supersedes the read they point at (see `readResultReusesRows`).
 */
export function elideRowsAlreadyInContext(session: ToolSession, result: AgentToolResult<ReadToolDetails>): void {
	if (result.isError) return;
	const block = result.content?.find(entry => entry.type === "text");
	if (!block || typeof block.text !== "string") return;
	const lines = block.text.split("\n");
	const path = headerPath(lines[0]);
	if (path === undefined) return;
	const known = collectContextRows(session, path);
	if (known.size === 0) return;

	const out: string[] = [lines[0]];
	let reused = 0;
	let i = 1;
	while (i < lines.length) {
		const first = parseRow(lines[i]);
		if (!first || known.get(first.number) !== first.text) {
			out.push(lines[i++]);
			continue;
		}
		let end = i + 1;
		while (end < lines.length) {
			const next = parseRow(lines[end]);
			if (!next || next.number !== first.number + (end - i) || known.get(next.number) !== next.text) break;
			end++;
		}
		const runLength = end - i;
		if (runLength < MIN_ELIDED_RUN) {
			for (; i < end; i++) out.push(lines[i]);
			continue;
		}
		out.push(`[${first.number}-${first.number + runLength - 1} unchanged since earlier read]`);
		reused += runLength;
		i = end;
	}
	if (reused === 0) return;
	block.text = out.join("\n");
	result.details = { ...result.details, reusedRows: reused };
}
