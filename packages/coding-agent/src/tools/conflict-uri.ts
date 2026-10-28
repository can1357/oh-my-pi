/**
 * `conflict://` reads and writes against the session's {@link ConflictHistory}:
 * rendering a registered marker block (or one side of it) with its original
 * file line numbers, and splicing replacement content over registered blocks.
 */
import * as fs from "node:fs/promises";
import { type ConflictEntry, renderConflictRegion } from "@oh-my-pi/pi-tui/tools/conflict-detect";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getEditStore } from "../edit/store";
import type { InternalWriteResult } from "../internal-urls/types";
import { writethroughNoop } from "../lsp/writethrough";
import {
	expandContentTokens,
	getConflictHistory,
	parseConflictUri,
	type ParsedConflictUri,
	reconcileRegisteredConflicts,
	scanConflictLines,
	spliceConflict,
} from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import type { ToolSession } from "./index";
import { formatPathRelativeToCwd } from "./path-utils";
import { maybeWriteSnapshotHeader, stripWriteContent } from "./write-content";

/** Raw `conflict://<N>[/<scope>]` content for the shared read selector pipeline. */
export interface ConflictRegionRead {
	/** Prefix-free region text, sliced before any read formatting. */
	text: string;
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

async function requireEntry(session: ToolSession, id: number): Promise<ConflictEntry> {
	const history = getConflictHistory(session);
	// Only the addressed block's file needs re-checking; other files keep their ids until touched.
	const registered = history.get(id);
	if (registered) await reconcileRegisteredConflicts(history, registered.absolutePath);
	const entry = history.get(id);
	if (!entry) {
		const byPath = new Map<string, number[]>();
		for (const registered of history.entries()) {
			const ids = byPath.get(registered.absolutePath) ?? [];
			ids.push(registered.id);
			byPath.set(registered.absolutePath, ids);
		}
		// Capped: a session can hold hundreds of ids after `:conflicts` scans.
		const limit = PREVIEW_LIMITS.COLLAPSED_ITEMS;
		const more = (hidden: number, noun: string) => (hidden > 0 ? ` (+${hidden} more${noun})` : "");
		const files = [...byPath].slice(0, limit).map(
			([absolutePath, ids]) =>
				`${ids
					.slice(0, limit)
					.map(n => `#${n}`)
					.join(", ")}${more(ids.length - limit, "")} in ${formatPathRelativeToCwd(absolutePath, session.cwd)}`,
		);
		const known =
			byPath.size > 0
				? `Registered: ${files.join("; ")}${more(byPath.size - limit, " files")}.`
				: "No conflicts are registered.";
		throw new ToolError(
			`Conflict #${id} not found: it was resolved, became stale, or no \`read\` has shown its block yet (a ranged read registers only the blocks it shows, so unseen blocks' ids can't be guessed). Read \`<path>:conflicts\` on the file to list and register its blocks. ${known}`,
		);
	}
	return entry;
}

/**
 * Select a `conflict://<N>` (or `conflict://<N>/<scope>`) body. The shared
 * read pipeline slices its raw text and renders once using source coordinates.
 */
export async function readConflictUri(session: ToolSession, raw: string): Promise<ConflictRegionRead> {
	const target = parseTarget(raw);
	if (target.id === "*") {
		throw new ToolError(
			"Reading `conflict://*` is not supported — wildcards are write-only. Use the `<path>:conflicts` read selector for the full list of conflicts in a file, or read `conflict://<N>` to inspect a single block.",
		);
	}
	const entry = await requireEntry(session, target.id);
	const region = renderConflictRegion(entry, target.scope);
	return {
		text: region.lines.join("\n"),
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
	return resolveConflict(session, await requireEntry(session, target.id), cleanContent, stripped, signal);
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
	history?.reconcilePath(absolutePath, { blocks: scanConflictLines(newContent.split("\n"), 1) });

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

/** `<id>: @side`, optionally behind a copied `LINE:` display prefix (`40:#4 = @ours`). */
const BULK_DIRECTIVE_RE = /^(?:\d+:)?#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/;
/**
 * The head of a per-id directive line — `<id>:` / `<id>=` (optionally `#`-prefixed,
 * and optionally behind a copied `LINE:` prefix like `BULK_DIRECTIVE_RE`),
 * regardless of whether its value is a valid `@side` token. Used to recognise a
 * per-id block with literal values (e.g. `15: some literal text`) and to sharpen
 * its error message.
 */
const BULK_DIRECTIVE_HEAD_RE = /^(?:\d+:)?#?(\d+)\s*[:=]/;

function truncateDirectiveLine(line: string): string {
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * Parse `conflict://*` per-id directive content: every non-empty line must be
 * `<id>: @side` (also accepted: `#<id> = @side`), where `@side` is one of
 * `@ours` / `@theirs` / `@base` / `@both`.
 *
 * Returns `null` only when the content is not a per-id block (→ uniform bulk mode).
 * Throws on duplicate ids, and — critically — on a *malformed* directive block:
 * content that mixes valid `<id>: @side` lines with lines that aren't, or a
 * block of `<id>: <literal>` values naming registered conflicts. Without that
 * guard a per-id write carrying non-token values (a literal or multi-line
 * replacement, e.g. `15: <multi-line content>`) fell through to uniform bulk
 * mode, which pasted the directive text (or, in hashline mode, the text with
 * its `<id>:` heads stripped as line numbers) into every block and still
 * reported success. Per-id bulk is token-only; literal or multi-line
 * replacements must go through individual `conflict://<N>` writes.
 */
function parseBulkDirectives(content: string, registeredIds: ReadonlySet<number>): Map<number, string> | null {
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
	// No `<id>: @side` line → uniform mode, unless the content opens with `<id>:`
	// naming a registered conflict, no line carries a head naming anything else
	// (copied `LINE:` rows do), and either every line is such a head or at least two
	// registered ids head lines: a per-id block with (possibly multi-line) literal values.
	if (!sawDirective) {
		const heads = stray.map(line => {
			const head = line.match(BULK_DIRECTIVE_HEAD_RE);
			return head ? Number.parseInt(head[1], 10) : undefined;
		});
		const registeredHeads = heads.filter(id => id !== undefined && registeredIds.has(id));
		const literalPerIdBlock =
			heads[0] !== undefined &&
			registeredIds.has(heads[0]) &&
			heads.every(id => id === undefined || registeredIds.has(id)) &&
			(registeredHeads.length === heads.length || new Set(registeredHeads).size >= 2);
		if (!literalPerIdBlock) return null;
	}
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
function resolveBulkDirectives(
	raw: string,
	stripped: string,
	registeredIds: ReadonlySet<number>,
): Map<number, string> | null {
	if (raw === stripped) return parseBulkDirectives(raw, registeredIds);
	let rawResult: Map<number, string> | null;
	try {
		rawResult = parseBulkDirectives(raw, registeredIds);
	} catch (rawError) {
		let fallback: Map<number, string> | null = null;
		try {
			fallback = parseBulkDirectives(stripped, registeredIds);
		} catch {
			fallback = null;
		}
		if (fallback) return fallback;
		throw rawError;
	}
	return rawResult ?? parseBulkDirectives(stripped, registeredIds);
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
	await reconcileRegisteredConflicts(history);
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
	const known = new Set(allEntries.map(entry => entry.id));
	const directives = resolveBulkDirectives(rawContent, replacementContent, known);
	if (directives) {
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
		history.reconcilePath(absolutePath, { blocks: scanConflictLines(text.split("\n"), 1) });
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
	if (directives) {
		const remaining = history
			.entries()
			.filter(entry => !directives.has(entry.id))
			.map(entry => `#${entry.id}`);
		if (remaining.length > 0) {
			summaryLines.push(
				`Directive mode: ${remaining.length} unlisted ${conflictWord(remaining.length)} still registered (${remaining.join(", ")}).`,
			);
		}
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
