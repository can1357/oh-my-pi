/**
 * `conflict://` reads and writes against the session's {@link ConflictHistory}:
 * rendering a registered marker block (or one side of it) with its original
 * file line numbers, and splicing replacement content over registered blocks.
 */
import * as fs from "node:fs/promises";
import { type ConflictEntry, renderConflictRegion } from "@oh-my-pi/pi-tui/tools/conflict-detect";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getEditStore } from "../edit/store";
import type { InternalWriteResult } from "../internal-urls/types";
import { writethroughNoop } from "../lsp/writethrough";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import {
	conflictRegionPresent,
	conflictRegionsEqual,
	expandContentTokens,
	getConflictHistory,
	parseConflictUri,
	type ParsedConflictUri,
	spliceConflict,
} from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import type { ToolSession } from "./index";
import { formatPathRelativeToCwd } from "./path-utils";
import { formatTextWithMode, hashlineHeaderContext, prependHashlineHeader } from "./read-format";
import { maybeWriteSnapshotHeader, stripWriteContent } from "./write-content";

/** A rendered `conflict://<N>[/<scope>]` region. */
export interface ConflictRegionRead {
	/** Model-facing text: hashline header + anchored lines, or numbered/plain lines per display mode. */
	text: string;
	/** Prefix-free region lines for transcript display. */
	rawText: string;
	/** 1-based file line number of the first rendered line. */
	startLine: number;
	/** File the conflict block lives in. */
	absolutePath: string;
}

const STRIPPED_NOTE = "Note: auto-stripped hashline display prefixes from content before writing.";

function parseTarget(raw: string): ParsedConflictUri {
	const parsed = parseConflictUri(raw);
	if (!parsed) {
		throw new ToolError(
			`Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*'.`,
		);
	}
	return parsed;
}

function requireEntry(session: ToolSession, id: number): ConflictEntry {
	const entry = getConflictHistory(session).get(id);
	if (!entry) {
		throw new ToolError(
			`Conflict #${id} not found. Conflict ids are registered when \`read\` surfaces a marker block; re-read the file to get a current id.`,
		);
	}
	return entry;
}

/**
 * Render a `conflict://<N>` (or `conflict://<N>/<scope>`) region as regular
 * file content. Lines keep their original file line numbers and, in hashline
 * mode, a snapshot tag is recorded against the underlying file so anchors
 * line up with the source for `edit`.
 */
export function readConflictUri(session: ToolSession, raw: string): ConflictRegionRead {
	const target = parseTarget(raw);
	if (target.id === "*") {
		throw new ToolError(
			"Reading `conflict://*` is not supported — wildcards are write-only. Use the `<path>:conflicts` read selector for the full list of conflicts in a file, or read `conflict://<N>` to inspect a single block.",
		);
	}
	const entry = requireEntry(session, target.id);
	const region = renderConflictRegion(entry, target.scope);
	const displayMode = resolveFileDisplayMode(session);
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

	const rawText = region.lines.join("\n");
	const tag = shouldAddHashLines ? getEditStore(session).recordSnapshotFile(entry.absolutePath) : undefined;
	const hashContext = tag
		? hashlineHeaderContext(formatPathRelativeToCwd(entry.absolutePath, session.cwd), tag)
		: undefined;
	const formattedBody = formatTextWithMode(rawText, region.startLine, shouldAddHashLines, shouldAddLineNumbers);
	return {
		text: prependHashlineHeader(formattedBody, hashContext),
		rawText,
		startLine: region.startLine,
		absolutePath: entry.absolutePath,
	};
}

/**
 * Resolve a `conflict://<N>` or `conflict://*` write. `content` is the raw
 * model payload: hashline prefixes are stripped here (per-id `conflict://*`
 * directives are parsed before stripping, which would eat their `<id>:` heads).
 * Scoped URIs (`/ours`, `/theirs`, `/base`) are read-only.
 */
export async function writeConflictUri(
	session: ToolSession,
	raw: string,
	content: string,
	signal: AbortSignal | undefined,
): Promise<InternalWriteResult> {
	const target = parseTarget(raw);
	if (target.scope) {
		throw new ToolError(
			`Conflict URI scope '/${target.scope}' is read-only — read \`conflict://${target.id}/${target.scope}\` to inspect that side. To write, drop the scope (\`conflict://${target.id}\`) and put the chosen content (or shorthand like \`@${target.scope}\`) in \`content\`.`,
		);
	}
	const { text: cleanContent, stripped } = stripWriteContent(session, content);
	if (target.id === "*") return resolveAllConflicts(session, cleanContent, stripped, signal, content);
	return resolveConflict(session, requireEntry(session, target.id), cleanContent, stripped, signal);
}

/**
 * Resolve a single `conflict://<N>` write by splicing the recorded
 * marker region in the registered file with `replacementContent`.
 * The write deliberately bypasses the LSP writethrough: the file may
 * still hold other unresolved marker blocks, so formatting could
 * corrupt them and diagnostics would be marker-noise anyway.
 *
 * Entry ids are session-stable: they keep working even after later
 * writes resolve other blocks in the same file. The recorded range
 * is re-validated on disk before splicing so an out-of-band edit
 * surfaces as a clear error instead of corrupting the file.
 */
async function resolveConflict(
	session: ToolSession,
	entry: ConflictEntry,
	replacementContent: string,
	stripped: boolean,
	signal: AbortSignal | undefined,
): Promise<InternalWriteResult> {
	const absolutePath = entry.absolutePath;
	if (!(await fs.exists(absolutePath))) {
		throw new ToolError(`Conflict #${entry.id} target '${entry.displayPath}' no longer exists.`);
	}

	const expanded = expandContentTokens(replacementContent, entry);
	const originalText = await Bun.file(absolutePath).text();
	const splice = spliceConflict(originalText, entry, expanded);
	const newContent = splice.text;

	await writethroughNoop(absolutePath, newContent, signal);
	invalidateFsScanAfterWrite(absolutePath);
	session.bumpFileMutationVersion?.(absolutePath);
	getEditStore(session).invalidate(absolutePath);
	const history = session.conflictHistory;
	history?.invalidate(entry.id);
	if (history) {
		// Drop stale duplicate registrations of the same region: a re-read
		// after an out-of-band shift registers a fresh id at the new
		// startLine while the stale twin persists at the old one. A DISTINCT
		// conflict block that is merely byte-identical still occurs in the
		// post-splice content and must stay addressable.
		for (const other of history.entries()) {
			if (
				other.absolutePath === absolutePath &&
				conflictRegionsEqual(other, entry) &&
				!conflictRegionPresent(newContent, other)
			) {
				history.invalidate(other.id);
			}
		}
	}

	const header = maybeWriteSnapshotHeader(session, absolutePath, newContent);
	const range =
		entry.startLine === entry.endLine ? `line ${entry.startLine}` : `lines ${entry.startLine}\u2013${entry.endLine}`;
	const summary = `Resolved conflict #${entry.id} at ${range} in ${entry.displayPath}.`;
	let resultText = header ? `${header}\n${summary}` : summary;
	if (stripped) {
		resultText += `\n${STRIPPED_NOTE}`;
	}
	const echoTrimmed = splice.trimmedLeading + splice.trimmedTrailing;
	if (echoTrimmed > 0) {
		resultText += `\nNote: dropped ${echoTrimmed} content line(s) that duplicated the code adjacent to the conflict region — writes replace only the marker block; surrounding lines stay in place.`;
	}

	return {
		content: [{ type: "text", text: resultText }],
		details: { resolvedPath: absolutePath },
	};
}

const BULK_DIRECTIVE_RE = /^#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/;
/**
 * The head of a per-id directive line — `<id>:` / `<id>=` (optionally `#`-prefixed),
 * regardless of whether its value is a valid `@side` token. Used only to sharpen the
 * error message when a directive block is malformed (e.g. `15: some literal text`).
 */
const BULK_DIRECTIVE_HEAD_RE = /^#?\d+\s*[:=]/;

function truncateDirectiveLine(line: string): string {
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * Parse `conflict://*` per-id directive content: every non-empty line must be
 * `<id>: @side` (also accepted: `#<id> = @side`), where `@side` is one of
 * `@ours` / `@theirs` / `@base` / `@both`.
 *
 * Returns `null` only when NO line is directive-shaped (→ uniform bulk mode).
 * Throws on duplicate ids, and — critically — on a *partial* directive block:
 * content that mixes valid `<id>: @side` lines with lines that aren't. Without
 * that guard a per-id write carrying any non-token value (a literal or
 * multi-line replacement, e.g. `15: <multi-line content>`) fell through to
 * uniform bulk mode, which pasted the raw directive text verbatim into every
 * block and still reported success. Per-id bulk is token-only; literal or
 * multi-line replacements must go through individual `conflict://<N>` writes.
 */
function parseBulkDirectives(content: string): Map<number, string> | null {
	const map = new Map<number, string>();
	const stray: string[] = [];
	let sawDirective = false;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		const match = line.match(BULK_DIRECTIVE_RE);
		if (!match) {
			stray.push(line);
			continue;
		}
		sawDirective = true;
		const id = Number.parseInt(match[1], 10);
		if (map.has(id)) {
			throw new ToolError(`Bulk directive lists conflict #${id} twice — each id may appear once.`);
		}
		map.set(id, match[2]);
	}
	// No directive lines at all → not a per-id block; caller uses uniform mode.
	if (!sawDirective) return null;
	if (stray.length > 0) {
		const sample = stray[0]!;
		const tokenHint = BULK_DIRECTIVE_HEAD_RE.test(sample)
			? `Per-id bulk only accepts the tokens @ours/@theirs/@base/@both — one side per id, single line. `
			: "";
		throw new ToolError(
			`Malformed \`conflict://*\` per-id block: ${stray.length} line(s) are not \`<id>: @side\` directives (first: \`${truncateDirectiveLine(sample)}\`). ` +
				tokenHint +
				`Literal or multi-line replacement content isn't supported in a per-id block — resolve those blocks with individual \`write({ path: "conflict://<N>", content })\` calls (you can issue several at once). ` +
				`For a pure pick-a-side pass, make every non-empty line \`<id>: @ours\` (or @theirs/@base/@both).`,
		);
	}
	return map;
}

/**
 * Resolve per-id directives, preferring the pre-strip `raw` content and falling
 * back to the hashline-stripped `stripped` content.
 *
 * Raw is preferred because the `<id>:` directive heads look exactly like
 * hashline `LINE:` prefixes and would be eaten by stripping. When the two
 * contents are identical (hashline mode off) a single parse decides everything,
 * so a malformed-block error propagates straight through — the previous
 * `?? parseBulkDirectives(...)` chain would have swallowed it and silently
 * degraded to uniform bulk mode, pasting the raw directive text into every
 * block. When they differ, a malformed raw block still defers to a *clean*
 * stripped block, but otherwise surfaces its error rather than degrading.
 */
function resolveBulkDirectives(raw: string, stripped: string): Map<number, string> | null {
	if (raw === stripped) return parseBulkDirectives(raw);
	let rawResult: Map<number, string> | null;
	try {
		rawResult = parseBulkDirectives(raw);
	} catch (rawError) {
		let fallback: Map<number, string> | null = null;
		try {
			fallback = parseBulkDirectives(stripped);
		} catch {
			fallback = null;
		}
		if (fallback) return fallback;
		throw rawError;
	}
	return rawResult ?? parseBulkDirectives(stripped);
}

/**
 * Bulk-resolve every registered conflict via `conflict://*`.
 *
 * Entries are grouped by file and applied bottom-up by recorded start
 * line so each splice keeps later anchors valid. `content` tokens are
 * expanded *per entry*, so `content: "@ours"` keeps each block's own
 * ours side rather than collapsing every conflict to the first
 * block's ours.
 *
 * All-or-nothing semantics within a file: if any splice for a file
 * fails (stale anchors, missing base for `@base`, etc.), that file is
 * left untouched and the error is surfaced. Files that succeed are
 * still written. The result text reports per-file counts so the agent
 * can re-read the failed files and retry.
 */
async function resolveAllConflicts(
	session: ToolSession,
	replacementContent: string,
	stripped: boolean,
	signal: AbortSignal | undefined,
	rawContent: string,
): Promise<InternalWriteResult> {
	const history = getConflictHistory(session);
	const allEntries = history.entries();
	if (allEntries.length === 0) {
		throw new ToolError(
			"`conflict://*` has nothing to resolve — no conflicts are currently registered. Re-read the file(s) with conflicts first.",
		);
	}

	// Per-id directive mode: content made solely of `<id>: @side` lines
	// resolves each listed conflict with that side in one call. Ideal for
	// merge-hell files where dozens of pick-one blocks each need their own
	// winner — one call instead of one write per conflict. Parsed from the
	// PRE-strip content: hashline prefix stripping would otherwise eat the
	// `<id>: ` heads as echoed line numbers.
	const directives = resolveBulkDirectives(rawContent, replacementContent);
	if (directives) {
		const known = new Set(allEntries.map(entry => entry.id));
		const unknown = [...directives.keys()].filter(id => !known.has(id));
		if (unknown.length > 0) {
			throw new ToolError(
				`Bulk directive references unknown conflict id(s) ${unknown.map(id => `#${id}`).join(", ")}. Currently registered: ${allEntries.map(e => `#${e.id}`).join(", ")}.`,
			);
		}
	}
	const selectedEntries = directives ? allEntries.filter(entry => directives.has(entry.id)) : allEntries;
	const contentFor = (entry: ConflictEntry): string => directives?.get(entry.id) ?? replacementContent;

	const byFile = new Map<string, ConflictEntry[]>();
	for (const entry of selectedEntries) {
		const bucket = byFile.get(entry.absolutePath) ?? [];
		bucket.push(entry);
		byFile.set(entry.absolutePath, bucket);
	}

	const succeededFiles: { displayPath: string; count: number; header?: string }[] = [];
	const failedFiles: { displayPath: string; count: number; error: string }[] = [];
	let totalResolvedIds = 0;
	let totalEchoTrimmed = 0;

	for (const [absolutePath, fileEntries] of byFile) {
		const sample = fileEntries[0]!;
		if (!(await fs.exists(absolutePath))) {
			failedFiles.push({
				displayPath: sample.displayPath,
				count: fileEntries.length,
				error: "file no longer exists",
			});
			continue;
		}

		fileEntries.sort((a, b) => b.startLine - a.startLine);

		let text: string;
		const resolvedEntries: ConflictEntry[] = [];
		const staleEntries: ConflictEntry[] = [];
		let failure: string | undefined;
		try {
			text = await Bun.file(absolutePath).text();
		} catch (error) {
			failedFiles.push({
				displayPath: sample.displayPath,
				count: fileEntries.length,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		for (const entry of fileEntries) {
			try {
				const expanded = expandContentTokens(contentFor(entry), entry);
				const splice = spliceConflict(text, entry, expanded);
				text = splice.text;
				totalEchoTrimmed += splice.trimmedLeading + splice.trimmedTrailing;
				resolvedEntries.push(entry);
			} catch (error) {
				// A locate-miss for a region an earlier entry already spliced
				// in this pass is a stale duplicate registration (re-read after
				// an out-of-band shift) — treat it as already resolved.
				if (resolvedEntries.some(done => conflictRegionsEqual(done, entry))) {
					staleEntries.push(entry);
					continue;
				}
				failure = error instanceof Error ? error.message : String(error);
				break;
			}
		}
		if (failure !== undefined) {
			failedFiles.push({
				displayPath: sample.displayPath,
				count: fileEntries.length,
				error: failure,
			});
			continue;
		}

		await writethroughNoop(absolutePath, text, signal);
		invalidateFsScanAfterWrite(absolutePath);
		session.bumpFileMutationVersion?.(absolutePath);
		getEditStore(session).invalidate(absolutePath);
		for (const entry of resolvedEntries) history.invalidate(entry.id);
		for (const entry of staleEntries) history.invalidate(entry.id);
		const header = maybeWriteSnapshotHeader(session, absolutePath, text);
		succeededFiles.push({ displayPath: sample.displayPath, count: resolvedEntries.length, header });
		totalResolvedIds += resolvedEntries.length;
	}

	const summaryLines: string[] = [];
	const fileWord = (n: number) => (n === 1 ? "file" : "files");
	const conflictWord = (n: number) => (n === 1 ? "conflict" : "conflicts");
	if (succeededFiles.length > 0) {
		summaryLines.push(
			`Resolved ${totalResolvedIds} ${conflictWord(totalResolvedIds)} across ${succeededFiles.length} ${fileWord(succeededFiles.length)}:`,
		);
		for (const file of succeededFiles) {
			summaryLines.push(`  ${file.displayPath}: ${file.count} ${conflictWord(file.count)}`);
		}
	}
	if (directives && selectedEntries.length < allEntries.length) {
		const remaining = allEntries.filter(entry => !directives.has(entry.id)).map(entry => `#${entry.id}`);
		summaryLines.push(
			`Directive mode: ${remaining.length} unlisted ${conflictWord(remaining.length)} still registered (${remaining.join(", ")}).`,
		);
	}
	if (totalEchoTrimmed > 0) {
		summaryLines.push(
			`Note: dropped ${totalEchoTrimmed} content line(s) that duplicated code adjacent to conflict regions — writes replace only the marker block; surrounding lines stay in place.`,
		);
	}
	if (failedFiles.length > 0) {
		summaryLines.push(
			`Failed to resolve ${failedFiles.length} ${fileWord(failedFiles.length)} — registered entries left intact for retry:`,
		);
		for (const file of failedFiles) {
			summaryLines.push(`  ${file.displayPath}: ${file.count} ${conflictWord(file.count)} (${file.error})`);
		}
	}
	const headerLines = succeededFiles
		.map(file => file.header)
		.filter((header): header is string => header !== undefined);
	if (headerLines.length > 0) {
		summaryLines.push("Snapshots:");
		for (const header of headerLines) summaryLines.push(`  ${header}`);
	}
	if (stripped && !directives) {
		summaryLines.push(STRIPPED_NOTE);
	}
	const resultText = summaryLines.join("\n");

	if (failedFiles.length > 0 && succeededFiles.length === 0) {
		throw new ToolError(resultText);
	}
	return {
		content: [{ type: "text", text: resultText }],
		details: {},
		isError: failedFiles.length > 0 ? true : undefined,
	};
}
