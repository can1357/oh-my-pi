import type { WriteToolDetails } from "@oh-my-pi/pi-tui/tools/write";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";

import { isEnoent, isRecord, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import {
	type ArchiveMemberContent,
	archiveFormatFromPath,
	isWritableArchiveFormat,
	parseArchivePathCandidates,
	readArchiveEntries,
	writeArchive,
} from "@oh-my-pi/pi-utils/ar";
import { getEditStore } from "../edit/store";
import { normalizeToLF } from "../edit/normalize";

import { InternalUrlRouter } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import { parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { createLspWritethrough, type WritethroughCallback, writethroughNoop } from "../lsp";

import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getLspBatchRequest } from "../lsp/batch";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";

import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import writeDeviceOnlyDescription from "../prompts/tools/write-device-only.md" with { type: "text" };
import type { ToolSession } from "../sdk";

import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { routeWriteThroughBridge, shouldRouteWriteThroughBridge } from "./acp-bridge";
import { resolveToolTier, truncateForPrompt } from "./approval";
import { assertEditableFile } from "./auto-generated-guard";

import {
	formatHashlineHeader,
	isReadTruncationNotice,
	splitAddressableFileLines,
	stripHashlinePrefixes,
} from "@oh-my-pi/pi-tui/tools/hashline-format";
import { type ConflictEntry } from "@oh-my-pi/pi-tui/tools/conflict-detect";
import {
	conflictRegionPresent,
	conflictRegionsEqual,
	expandContentTokens,
	getConflictHistory,
	parseConflictUri,
	spliceConflict,
} from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";

import { outputMeta } from "./output-meta";
import {
	formatPathRelativeToCwd,
	pathTargetsSsh,
	peelWriteUrlSelector,
	probeLiteralPathExists,
	resolveFileWriteApprovalTier,
} from "./path-utils";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import {
	enforcePlanModeWrite,
	resolvePlanPath,
	targetsLocalSandbox,
	unwrapHashlineHeaderPath,
} from "./plan-mode-guard";
import { decodeUtf8Text } from "./read-format";
import { routeReadThroughBridge } from "./read-summary";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";

import { dispatchReportIssueDevice } from "./report-tool-issue";
import { REPORT_ISSUE_DEVICE_NAME } from "@oh-my-pi/pi-tui/tools/report-tool-issue";
import { dispatchResolutionDevice } from "./resolve";
import { isResolutionDeviceName } from "@oh-my-pi/pi-tui/tools/resolve";
import {
	deleteRowByKey,
	deleteRowByRowId,
	insertRow,
	isSqliteFile,
	parseSqlitePathCandidates,
	resolveTableRowLookup,
	updateRowByKey,
	updateRowByRowId,
} from "./sqlite-reader";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { dispatchXdevTool, resolveXdevTool, xdevListing } from "./xdev";

const LOOSE_HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;
const EXECUTABLE_NOTICE = "[Notice: Made executable via chmod +x]";
const URI_LIKE_WRITE_PATH_RE = /^([a-z][a-z0-9+.-]*):\/{1,2}(.*)$/i;
const XD_MISSING_DELIMITER_RE = /^xd\/+(.*)$/i;
const XD_SCHEME_NEAR_MISSES: Record<string, true> = { dx: true, xdd: true, xdt: true };

function assertWriteTargetAddressable(target: string, router: InternalUrlRouter): void {
	const trimmed = target.trim();
	if (path.win32.isAbsolute(trimmed) || router.canHandle(trimmed)) return;

	const missingDelimiter = trimmed.match(XD_MISSING_DELIMITER_RE);
	if (missingDelimiter) {
		throw new ToolError(
			`Unknown URI-like write target '${trimmed}'. Did you mean 'xd://${missingDelimiter[1]}'? Prefix the path with './' to write it as a filesystem path.`,
		);
	}

	const uriLike = trimmed.match(URI_LIKE_WRITE_PATH_RE);
	if (!uriLike) return;

	const scheme = uriLike[1]!.toLowerCase();
	// conflict:// has no router handler but is spliced downstream by
	// parseConflictUri (which emits its own precise id/scope errors); let it pass.
	if (scheme === "conflict") return;
	const canonicalScheme = router.getHandler(scheme) ? scheme : XD_SCHEME_NEAR_MISSES[scheme] ? "xd" : undefined;
	const suggestion = canonicalScheme
		? ` Did you mean '${canonicalScheme}://${uriLike[2]}'?`
		: " Tool devices use 'xd://<tool>'.";
	throw new ToolError(
		`Unknown URI-like write target '${trimmed}'.${suggestion} Prefix the path with './' to write it as a filesystem path.`,
	);
}

/**
 * Fail closed when a local write target looks like a mis-dispatched read.
 *
 * A read-only step that selects `write` instead of `read` passes the full read
 * expression (`src/foo.tsx:1-260:raw`) as the target. Because a literal colon
 * filename is legal on POSIX (issue #4618), that request otherwise resolves to
 * filesystem creation and reports success, leaving a stray zero-byte file the
 * model cannot recover from — the local analogue of the `xd://` near-miss guard
 * ({@link assertWriteTargetAddressable}, issue #6123).
 *
 * Fires only on the high-confidence combination the report identifies: the tail
 * parses as a read-tool selector, the literal target is missing, and no content
 * was supplied. Non-empty content is the escape hatch — it is never blocked, so
 * a deliberate write to a selector-shaped filename still succeeds. An existing
 * literal path or an ambiguous stat (`"unknown"`: EACCES, transient I/O) also
 * passes through so a real file is never shadowed by the guard.
 */
function readSelectorForEmptyWrite(target: string, content: string): string | undefined {
	if (content.length > 0) return undefined;
	return splitPathAndSel(target).sel;
}

function throwReadSelectorMisfire(target: string, sel: string): never {
	throw new ToolError(
		`write target '${target}' ends with a read-tool selector ':${sel}' and no such file exists — refusing to create a literal file by that name. ` +
			`If you meant to read it, use read({ path: "${target}" }). ` +
			`If you truly intend to create this file, pass its contents in \`content\` (a non-empty write is never blocked).`,
	);
}

/**
 * Recognize a semicolon-joined list of read-tool selectors mis-dispatched as a
 * single write target — the multi-file read expression the scout emitted in
 * issue #6809 (`a.txt:1-2;b/c.txt:3-4`). Every `;`-segment must be non-empty and
 * carry its own read selector ({@link splitPathAndSel} peels a `:N-M`, `:raw`,
 * or `:conflicts` tail). No real call targets such a list: `read` accepts one
 * path, `write` writes one file. Unlike {@link readSelectorForEmptyWrite} this
 * fires regardless of `content` — the non-empty-content escape hatch exists for
 * a lone selector-shaped *filename*, never a `;`-list, and honoring it here
 * silently creates a nested directory tree (`a.txt:1-2;b/`) in the workspace.
 * The caller still probes the literal target first, so an existing POSIX file
 * by that exact name stays writable (same escape as the single-selector guard).
 */
function readSelectorListMisfire(target: string): number | undefined {
	if (!target.includes(";")) return undefined;
	const segments = target.split(";");
	if (segments.length < 2) return undefined;
	for (const segment of segments) {
		const trimmed = segment.trim();
		if (trimmed.length === 0 || splitPathAndSel(trimmed).sel === undefined) return undefined;
	}
	return segments.length;
}

function throwReadSelectorListMisfire(target: string, count: number): never {
	throw new ToolError(
		`write target '${target}' is a semicolon-joined list of ${count} read-tool selectors, not a filesystem path — refusing to create it. ` +
			`write creates a single file; issue one read() per path to read these ranges (e.g. read({ path: "<one path>:<range>" })).`,
	);
}

async function assertNotReadSelectorMisfire(target: string, content: string, cwd: string): Promise<void> {
	const listCount = readSelectorListMisfire(target);
	if (listCount !== undefined && (await probeLiteralPathExists(target, cwd)) === "missing") {
		throwReadSelectorListMisfire(target, listCount);
	}
	const sel = readSelectorForEmptyWrite(target, content);
	if (sel === undefined) return;
	if ((await probeLiteralPathExists(target, cwd)) !== "missing") return;
	throwReadSelectorMisfire(target, sel);
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

const writeSchema = type({
	path: "string",
	content: "string",
});

export type WriteToolInput = typeof writeSchema.infer;

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
function stripWriteContent(session: ToolSession, content: string): { text: string; stripped: boolean } {
	if (!resolveFileDisplayMode(session).hashLines) {
		return { text: content, stripped: false };
	}
	return stripWriteContentWithPotentialLooseHeader(content.split("\n"));
}
/** `write agent://<id>`: a peer message (read tier, allowed in plan mode and device-only sessions). */
const AGENT_URL_RE = /^agent:\/\//i;
/** `write proc://<id>[/mode]`: service stdin, job cancel/service stop, or service mode (exec tier). */
const PROC_URL_RE = /^proc:\/\//i;

function endsWithReadTruncationNotice(content: string): boolean {
	const lines = splitAddressableFileLines(normalizeToLF(content));
	const noticeIndex = lines.findLastIndex(line => line.trim().length > 0);
	if (noticeIndex === -1) return false;
	return isReadTruncationNotice(lines[noticeIndex]!);
}

async function readCurrentWriteSource(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
): Promise<string | undefined> {
	const readDisk = async (): Promise<string | undefined> => {
		try {
			return await Bun.file(absolutePath).text();
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
	};
	if (!shouldRouteWriteThroughBridge(session, requestedPath, absolutePath)) return readDisk();
	const bridgeRead = routeReadThroughBridge(session, absolutePath);
	if (!bridgeRead) return readDisk();
	try {
		return await bridgeRead;
	} catch {
		return readDisk();
	}
}

/**
 * Byte span (UTF-16 length) of a read projection's shown payload — everything
 * up to but excluding its trailing `read` truncation notice and the blank
 * separator before it. Returns `undefined` when the content does not end in
 * such a notice.
 *
 * Excluding the notice matters at the byte-budget boundary: a single line
 * truncated just past the limit renders as a ~50 KB prefix plus a footer whose
 * combined length can exceed the original line, yet it still covers strictly
 * less source. Measuring the shown payload — not the rendered length — is what
 * the truncation marker, not character count, establishes as incomplete.
 */
function readProjectionPayloadLength(content: string): number | undefined {
	const lines = splitAddressableFileLines(normalizeToLF(content));
	const noticeIndex = lines.findLastIndex(line => line.trim().length > 0);
	if (noticeIndex === -1 || !isReadTruncationNotice(lines[noticeIndex]!)) return undefined;
	let end = noticeIndex;
	while (end > 0 && lines[end - 1]!.trim().length === 0) end--;
	return lines.slice(0, end).join("\n").length;
}

function assertNotShorterReadProjection(
	displayPath: string,
	rawContent: string,
	currentContent: string | undefined,
	writeContent: string = rawContent,
): void {
	const rawPayloadLength = readProjectionPayloadLength(rawContent);
	if (rawPayloadLength === undefined || currentContent === undefined) return;
	const payloadLength = writeContent === rawContent ? rawPayloadLength : normalizeToLF(writeContent).length;
	if (payloadLength >= normalizeToLF(currentContent).length) return;
	throw new ToolError(
		`Refusing to overwrite '${displayPath}' with an incomplete read projection: the content ends with an omp read truncation notice and covers less than the current source, so it would discard unseen content. Re-read the omitted ranges and write the complete file, or use edit for a partial change.`,
	);
}

async function assertNotTruncatedFileReadProjection(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
	displayPath: string,
	rawContent: string,
	writeContent: string,
): Promise<void> {
	if (!endsWithReadTruncationNotice(rawContent)) return;
	const currentContent = await readCurrentWriteSource(session, requestedPath, absolutePath);
	assertNotShorterReadProjection(displayPath, rawContent, currentContent, writeContent);
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
function maybeWriteSnapshotHeader(session: ToolSession, absolutePath: string, content: string): string | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const tag = getEditStore(session).recordSnapshot(absolutePath, normalized, []);
	return formatHashlineHeader(formatPathRelativeToCwd(absolutePath, session.cwd), tag);
}

/**
 * Append a trailing note line to the first text block of a tool result.
 * Mutates `result` in place (the result object is owned by this call).
 */
function appendNoteToResult(result: AgentToolResult<WriteToolDetails>, note: string): void {
	const firstText = result.content.find(
		(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
	);
	if (firstText) {
		firstText.text = firstText.text.length > 0 ? `${firstText.text}\n${note}` : note;
	} else {
		result.content.push({ type: "text", text: note });
	}
}

function emitWriteProgress(
	onUpdate: AgentToolUpdateCallback<WriteToolDetails> | undefined,
	content: string,
	displayPath: string,
	resolvedPath?: string,
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text: `Writing ${Buffer.byteLength(content, "utf8")} bytes to ${shortenPath(displayPath)}...`,
			},
		],
		details: resolvedPath ? { resolvedPath } : {},
	});
}

/**
 * If `content` begins with a `#!` shebang, ensure the file is executable.
 *
 * Mirrors `chmod a+x` (adds user/group/other execute bits to existing mode).
 * Errors are swallowed: chmod failure (e.g. Windows ACL, read-only mount)
 * MUST NOT fail an otherwise successful write. Returns whether the mode
 * actually changed so the caller can surface a note.
 */
async function maybeMarkExecutableForShebang(absolutePath: string, content: string): Promise<boolean> {
	if (!content.startsWith("#!")) return false;
	try {
		const stat = await fs.stat(absolutePath);
		const currentMode = stat.mode & 0o7777;
		const newMode = currentMode | 0o111;
		if (newMode === currentMode) return false;
		await fs.chmod(absolutePath, newMode);
		return true;
	} catch {
		return false;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type WriteParams = WriteToolInput;

interface ResolvedArchiveWritePath {
	absolutePath: string;
	archivePath: string;
	archiveSubPath: string;
	exists: boolean;
}

interface ResolvedSqliteWritePath {
	absolutePath: string;
	sqlitePath: string;
	table: string;
	key?: string;
	exists: boolean;
}

function isArchivePathNotFound(error: unknown): boolean {
	if (isEnoent(error)) return true;
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}

function normalizeArchiveWriteSubPath(rawPath: string): string {
	const normalized = rawPath.replace(/\\/g, "/");
	if (normalized.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}
	if (normalized.endsWith("/")) {
		throw new ToolError("Archive write path must target a file, not a directory");
	}

	const parts = normalized.split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			throw new ToolError("Archive path cannot contain '..'");
		}
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}

	return normalizedParts.join("/");
}

function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
	if (queryString.trim().length > 0) {
		throw new ToolError("SQLite write paths do not support query parameters");
	}

	const normalized = subPath.replace(/^:+/, "").trim();
	if (!normalized) {
		throw new ToolError("SQLite write path must target a table");
	}

	const separatorIndex = normalized.indexOf(":");
	const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1);
	if (!table) {
		throw new ToolError("SQLite write path must target a table");
	}
	if (key !== undefined && key.length === 0) {
		throw new ToolError("SQLite row writes require a non-empty row key");
	}

	return { table, key };
}

/**
 * Write tool implementation.
 *
 * Creates or overwrites files with optional LSP formatting and diagnostics.
 */
export class WriteTool implements AgentTool<typeof writeSchema, WriteToolDetails> {
	readonly name = "write";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawPath = (args as Partial<WriteParams>).path;
		if (typeof rawPath !== "string") return "write";
		// Unwrap a hashline `[path#TAG]` wrapper first (parity with execute) so a
		// wrapped `[ssh://h/x#ABCD]` can't dodge scheme detection and the tier checks below.
		const path = unwrapHashlineHeaderPath(rawPath);
		// xd:// device writes execute the mounted tool — take its approval tier.
		// The resolution devices (xd://resolve, xd://reject, xd://propose)
		// finalize a staged, already-previewed action, so they stay at read tier.
		const xdevTarget = parseXdUrl(path);
		if (xdevTarget) {
			if (xdevTarget.name === REPORT_ISSUE_DEVICE_NAME) return "write";
			if (xdevTarget.name && isResolutionDeviceName(xdevTarget.name)) return "read";
			const inst =
				xdevTarget.name && this.session.xdev ? resolveXdevTool(this.session.xdev, xdevTarget.name) : undefined;
			if (!inst) return "exec";
			// Decode the device JSON payload and evaluate the mounted tool's own
			// approval (which may be argument-dependent, e.g. ast_edit is read-tier
			// for internal-URL paths, debug is read-tier for inspection actions).
			// Malformed JSON, non-object payloads, missing content, and approval
			// functions that reject schema-invalid objects stay exec so the gate
			// fails closed — the dispatch itself rejects invalid arguments too.
			const rawContent = (args as Partial<WriteParams>).content;
			if (typeof rawContent !== "string") return "exec";
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawContent);
			} catch {
				return "exec";
			}
			if (!isRecord(parsed)) return "exec";
			try {
				// The tier is the mounted tool's own (argument-dependent) approval; the
				// policyKey makes the outer gate consult `tools.approval.<device>` for
				// this dispatch before falling back to `tools.approval.write`, so users
				// can scope allow/deny/prompt to a single device (issue #7923).
				return { tier: resolveToolTier(inst, parsed), policyKey: xdevTarget.name! };
			} catch {
				return "exec";
			}
		}
		// Peer messages are coordination, not mutation; proc:// writes drive
		// processes (stdin, stop, mode).
		if (AGENT_URL_RE.test(path)) return "read";
		if (PROC_URL_RE.test(path)) return "exec";
		// Remote SSH writes open an outbound connection and run a remote shell —
		// gate them like the exec-tier `ssh` tool, ahead of the handler-write
		// logic. Substring match also covers selector-suffixed targets.
		if (pathTargetsSsh(path)) return "exec";
		return resolveFileWriteApprovalTier(path);
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<WriteParams>;
		const targetPath = typeof params.path === "string" ? params.path : "(missing)";
		const content = typeof params.content === "string" ? params.content : "";
		return [`Path: ${truncateForPrompt(targetPath)}`, `Content:\n${truncateForPrompt(content)}`];
	};
	readonly label = "Write";
	get description(): string {
		const deviceOnly = this.session.deviceOnlyWrite === true && this.session.pendingFullWriteDescription !== true;
		return prompt.render(deviceOnly ? writeDeviceOnlyDescription : writeDescription);
	}
	readonly parameters = writeSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "essential";

	/** Stream matchers should see the real file content, not its JSON-escaped argument encoding. */
	matcherDigest(args: unknown): string | undefined {
		const content = (args as Partial<WriteParams>).content;
		return typeof content === "string" ? content : undefined;
	}

	readonly #writethrough: WritethroughCallback;
	readonly #deferredDiagnostics: DeferredDiagnostics | undefined;

	constructor(private readonly session: ToolSession) {
		const enableLsp = session.enableLsp ?? true;
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
		const dedup = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
		this.#deferredDiagnostics =
			enableDiagnostics && session.queueDeferredDiagnostics ? new DeferredDiagnostics(session, dedup) : undefined;
		this.#writethrough = enableLsp
			? createLspWritethrough(session.cwd, {
					enableFormat,
					enableDiagnostics,
					transformDiagnostics: dedup
						? (path, result) => getDiagnosticsLedger(session).reduce(path, result)
						: undefined,
				})
			: writethroughNoop;
	}

	async #resolveArchiveWritePath(writePath: string): Promise<ResolvedArchiveWritePath | null> {
		const candidates = parseArchivePathCandidates(writePath).filter(candidate => candidate.archivePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallback: ResolvedArchiveWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.archivePath),
			archivePath: fallbackCandidate.archivePath,
			archiveSubPath: normalizeArchiveWriteSubPath(fallbackCandidate.subPath),
			exists: false,
		};

		for (const candidate of candidates) {
			const absolutePath = resolvePlanPath(this.session, candidate.archivePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}

				return {
					absolutePath,
					archivePath: candidate.archivePath,
					archiveSubPath: normalizeArchiveWriteSubPath(candidate.subPath),
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		return fallback;
	}

	async #writeArchiveEntry(
		content: string,
		rawContent: string,
		resolvedArchivePath: ResolvedArchiveWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// Resolve symlinks before the tmp+rename swap: renaming over a symlink
		// replaces the link itself with a regular file instead of writing
		// through to its target.
		const finalPath = resolvedArchivePath.exists
			? await fs.realpath(resolvedArchivePath.absolutePath).catch(() => resolvedArchivePath.absolutePath)
			: resolvedArchivePath.absolutePath;
		// A realpath swap can land on a name without an archive extension; a
		// whole-archive rewrite then defaults to an uncompressed tar.
		const inferredFormat = archiveFormatFromPath(finalPath);
		const format = inferredFormat ?? "tar";
		if (!isWritableArchiveFormat(format)) {
			throw new ToolError(`Writing entries inside ${format} archives is not supported (read-only format).`);
		}
		// Rewrites are whole-archive: write to a temp file and rename so a
		// crash/disk-full mid-write can't destroy the original archive.
		const tmpPath = `${finalPath}.tmp-${process.pid}`;

		const parentDir = path.dirname(resolvedArchivePath.absolutePath);
		if (parentDir && parentDir !== ".") {
			await fs.mkdir(parentDir, { recursive: true });
		}

		const entries = new Map<string, ArchiveMemberContent>();
		if (resolvedArchivePath.exists) {
			try {
				const existing = await readArchiveEntries({ path: finalPath, format });
				for (const [entryPath, data] of existing) {
					entries.set(entryPath, data);
				}
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
		}
		const writeTarget = `${resolvedArchivePath.archivePath}:${resolvedArchivePath.archiveSubPath}`;
		const sel = readSelectorForEmptyWrite(writeTarget, content);
		if (sel !== undefined && !entries.has(resolvedArchivePath.archiveSubPath)) {
			throwReadSelectorMisfire(writeTarget, sel);
		}
		const existingTarget = entries.get(resolvedArchivePath.archiveSubPath);
		if (existingTarget !== undefined && endsWithReadTruncationNotice(rawContent)) {
			const existingBytes =
				existingTarget instanceof Blob ? new Uint8Array(await existingTarget.arrayBuffer()) : existingTarget;
			const existingText = typeof existingBytes === "string" ? existingBytes : decodeUtf8Text(existingBytes);
			assertNotShorterReadProjection(writeTarget, rawContent, existingText ?? undefined, content);
		}
		entries.set(resolvedArchivePath.archiveSubPath, content);

		try {
			await writeArchive(tmpPath, format, entries);
			await fs.rename(tmpPath, finalPath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}

		invalidateFsScanAfterWrite(resolvedArchivePath.absolutePath);
		const outputPath = `${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
			resolvedArchivePath.archiveSubPath
		}`;
		return {
			content: [
				{ type: "text", text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${outputPath}` },
			],
			details: { resolvedPath: resolvedArchivePath.absolutePath },
		};
	}

	async #resolveSqliteWritePath(writePath: string): Promise<ResolvedSqliteWritePath | null> {
		const candidates = parseSqlitePathCandidates(writePath).filter(candidate => candidate.sqlitePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallbackTarget = parseSqliteWriteTarget(fallbackCandidate.subPath, fallbackCandidate.queryString);
		const fallback: ResolvedSqliteWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.sqlitePath),
			sqlitePath: fallbackCandidate.sqlitePath,
			table: fallbackTarget.table,
			key: fallbackTarget.key,
			exists: false,
		};

		let sawExistingNonSqlite = false;
		for (const candidate of candidates) {
			const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString);
			const absolutePath = resolvePlanPath(this.session, candidate.sqlitePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}
				if (!(await isSqliteFile(absolutePath))) {
					sawExistingNonSqlite = true;
					continue;
				}

				return {
					absolutePath,
					sqlitePath: candidate.sqlitePath,
					table: target.table,
					key: target.key,
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		if (sawExistingNonSqlite) {
			return null;
		}

		return fallback;
	}

	async #writeSqliteRow(
		displayPath: string,
		content: string,
		resolvedSqlitePath: ResolvedSqliteWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		let db: Database | null = null;
		try {
			if (!resolvedSqlitePath.exists) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}

			db = new Database(resolvedSqlitePath.absolutePath, { create: false, strict: true });
			db.run("PRAGMA busy_timeout = 3000");

			const trimmedContent = content.trim();
			let resultText: string;
			if (trimmedContent.length === 0) {
				if (!resolvedSqlitePath.key) {
					throw new ToolError("SQLite deletes require a row key in the path");
				}

				const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
				const deleted =
					lookup.kind === "pk"
						? deleteRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key)
						: deleteRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key);
				resultText =
					deleted > 0
						? `Deleted row '${resolvedSqlitePath.key}' from ${resolvedSqlitePath.table}`
						: `No row deleted from ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
			} else {
				let parsedContent: unknown;
				try {
					parsedContent = Bun.JSON5.parse(content);
				} catch (error) {
					throw new ToolError(
						`SQLite write content must be valid JSON5: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				if (!isRecord(parsedContent)) {
					throw new ToolError("SQLite write content must be a JSON object");
				}

				if (resolvedSqlitePath.key) {
					const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
					const updated =
						lookup.kind === "pk"
							? updateRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key, parsedContent)
							: updateRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key, parsedContent);
					resultText =
						updated > 0
							? `Updated row '${resolvedSqlitePath.key}' in ${resolvedSqlitePath.table}`
							: `No row updated in ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
				} else {
					insertRow(db, resolvedSqlitePath.table, parsedContent);
					resultText = `Inserted row into ${resolvedSqlitePath.table}`;
				}
			}

			invalidateFsScanAfterWrite(resolvedSqlitePath.absolutePath);
			return toolResult<WriteToolDetails>({ resolvedPath: resolvedSqlitePath.absolutePath })
				.text(resultText)
				.sourcePath(resolvedSqlitePath.absolutePath)
				.done();
		} catch (error) {
			if (isEnoent(error)) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}
			if (error instanceof ToolError) {
				throw error;
			}
			throw new ToolError(error instanceof Error ? error.message : String(error));
		} finally {
			db?.close();
		}
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
	async #resolveConflict(
		entry: ConflictEntry,
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
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
		this.session.bumpFileMutationVersion?.(absolutePath);
		getEditStore(this.session).invalidate(absolutePath);
		const history = this.session.conflictHistory;
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

		const header = maybeWriteSnapshotHeader(this.session, absolutePath, newContent);
		const range =
			entry.startLine === entry.endLine
				? `line ${entry.startLine}`
				: `lines ${entry.startLine}\u2013${entry.endLine}`;
		const summary = `Resolved conflict #${entry.id} at ${range} in ${entry.displayPath}.`;
		let resultText = header ? `${header}\n${summary}` : summary;
		if (stripped) {
			resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
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

	/**
	 * Look up a single conflict entry by id and dispatch to {@link #resolveConflict}.
	 * Throws a clear `not found` error when the id has been invalidated.
	 */
	async #resolveSingleConflictById(
		id: number,
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const entry = getConflictHistory(this.session).get(id);
		if (!entry) {
			throw new ToolError(
				`Conflict #${id} not found. Conflict ids are registered when \`read\` surfaces a marker block; re-read the file to get a current id.`,
			);
		}
		return this.#resolveConflict(entry, replacementContent, stripped, signal);
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
	async #resolveAllConflicts(
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
		rawContent: string = replacementContent,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const history = getConflictHistory(this.session);
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
		const contentFor = (entry: ConflictEntry): string =>
			directives ? (directives.get(entry.id) as string) : replacementContent;

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
			this.session.bumpFileMutationVersion?.(absolutePath);
			getEditStore(this.session).invalidate(absolutePath);
			for (const entry of resolvedEntries) history.invalidate(entry.id);
			for (const entry of staleEntries) history.invalidate(entry.id);
			const header = maybeWriteSnapshotHeader(this.session, absolutePath, text);
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
			summaryLines.push("Note: auto-stripped hashline display prefixes from content before writing.");
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

	async execute(
		_toolCallId: string,
		{ path: rawPath, content }: WriteParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// Strip a hashline `[path#TAG]` wrapper up front so every downstream
		// decision (scheme routing, internal-URL handler dispatch, plan-mode
		// guard, plan path resolution, ACP bridge routing) sees the same
		// filesystem target. Without this, a model that pastes a `read`
		// header as the `path` arg would slip past `isInternalUrlPath`
		// (which fails on a leading `[`) and the bridge router would send a
		// `[local://scratch.md#ABCD]` write to the editor instead of the
		// session-local sandbox.
		// Peel a read-tool selector (`:raw`, `:1-20`, …) so the write target matches
		// what `read` resolves for the same URL; line-range/malformed selectors throw.
		const path = peelWriteUrlSelector(unwrapHashlineHeaderPath(rawPath));
		// A device-only session grants `write` purely as the xd:// transport (see
		// createTools): device dispatches proceed, every other target is rejected
		// before any handler, guard, conflict resolver, or bridge sees it. Active
		// plan mode additionally permits its local artifact sandbox, but does not
		// relax the restriction for working-tree or non-xd internal URLs.
		if (
			this.session.deviceOnlyWrite === true &&
			!parseXdUrl(path) &&
			!AGENT_URL_RE.test(path) &&
			!(this.session.getPlanModeState?.()?.enabled === true && targetsLocalSandbox(this.session, path))
		) {
			throw new ToolError(
				"This `write` tool is limited to the xd:// device transport: call it with path `xd://<tool>` and the device's JSON arguments in `content` (`read xd://` lists mounted devices). Active plan mode additionally permits local:// sandbox drafts. Filesystem writes are not available elsewhere.",
			);
		}
		return untilAborted(signal, async () => {
			// Strip hashline display prefixes ([PATH#HASH] + LINE:) if the model copied them from read output.
			// Messages and process stdin are verbatim payloads, never file text.
			const { text: cleanContent, stripped } =
				AGENT_URL_RE.test(path) || PROC_URL_RE.test(path)
					? { text: content, stripped: false }
					: stripWriteContent(this.session, content);
			const internalRouter = InternalUrlRouter.instance();
			assertWriteTargetAddressable(path, internalRouter);
			if (internalRouter.canHandle(path)) {
				const parsed = parseInternalUrl(path);
				const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
				const handler = internalRouter.getHandler(scheme);
				if (handler?.write) {
					if (
						scheme !== "xd" &&
						scheme !== "agent" &&
						scheme !== "proc" &&
						endsWithReadTruncationNotice(content)
					) {
						const currentResource = await internalRouter.resolve(path, {
							cwd: this.session.cwd,
							settings: this.session.settings,
							signal,
						});
						assertNotShorterReadProjection(path, content, currentResource.content, cleanContent);
					}
					// Handler-owned writes mutate user data outside the local
					// sandbox. xd:// dispatches retain each wrapped tool's tier;
					// agent:// messages are coordination and stay allowed.
					if (scheme !== "xd") {
						if (scheme !== "agent") enforcePlanModeWrite(this.session, path, { op: "update" });
						emitWriteProgress(onUpdate, cleanContent, path);
					}
					let xdResult: AgentToolResult<WriteToolDetails> | undefined;
					const handlerResult = await internalRouter.write(path, cleanContent, {
						cwd: this.session.cwd,
						signal,
						session: this.session,
						xd: {
							write: async (name, deviceContent) => {
								if (name === REPORT_ISSUE_DEVICE_NAME) {
									const { result, xdev } = await dispatchReportIssueDevice(this.session, deviceContent);
									xdResult = {
										content: result.content,
										details: { xdev },
										isError: result.isError,
										useless: result.useless,
									};
									return;
								}
								if (name && isResolutionDeviceName(name)) {
									const { result, xdev } = await dispatchResolutionDevice(this.session, name, deviceContent);
									xdResult = {
										content: result.content,
										details: { xdev },
										isError: result.isError,
										useless: result.useless,
									};
									return;
								}
								const xdev = this.session.xdev;
								if (!xdev) {
									throw new ToolError("xd:// is not mounted in this session.");
								}
								if (!name) {
									throw new ToolError(`Cannot write to xd:// itself — pick a device:\n${xdevListing(xdev)}`);
								}
								const { result, xdev: dispatch } = await dispatchXdevTool(
									xdev,
									name,
									deviceContent,
									_toolCallId,
									signal,
									onUpdate as AgentToolUpdateCallback,
									// The write tool's own gate just resolved approval at this
									// device's tier (see #approval above) — mark it so a wrapped
									// inner tool does not prompt a second time.
									context ? { ...context, xdevApproved: true } : undefined,
								);
								xdResult = {
									content: result.content,
									details: { xdev: dispatch },
									isError: result.isError,
									useless: result.useless,
								};
							},
						},
					});
					if (xdResult) return xdResult;
					if (handlerResult)
						return {
							content: [{ type: "text", text: handlerResult.text }],
							details: handlerResult.details ?? {},
							isError: handlerResult.isError,
						};
					let resultText = `Successfully wrote ${Buffer.byteLength(cleanContent, "utf8")} bytes to ${path}`;
					if (stripped) {
						resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
					return { content: [{ type: "text", text: resultText }], details: {} };
				}
				if (scheme !== "local") await internalRouter.write(path, cleanContent);
				// local:// is backed by the session-local artifact sandbox and is
				// resolved by resolvePlanPath below so write/read share the same root.
			}

			const conflictUri = parseConflictUri(path);
			if (conflictUri) {
				if (conflictUri.scope) {
					throw new ToolError(
						`Conflict URI scope '/${conflictUri.scope}' is read-only — read \`conflict://${conflictUri.id}/${conflictUri.scope}\` to inspect that side. To write, drop the scope (\`conflict://${conflictUri.id}\`) and put the chosen content (or shorthand like \`@${conflictUri.scope}\`) in \`content\`.`,
					);
				}
				emitWriteProgress(onUpdate, cleanContent, path);
				const result =
					conflictUri.id === "*"
						? await this.#resolveAllConflicts(cleanContent, stripped, signal, content)
						: await this.#resolveSingleConflictById(conflictUri.id, cleanContent, stripped, signal);
				if (conflictUri.recoveredPrefix !== undefined) {
					appendNoteToResult(
						result,
						`Note: stripped erroneous '${conflictUri.recoveredPrefix}:' prefix from path; conflict URIs are global (use \`conflict://${conflictUri.id}\`, not \`<file>:conflict://${conflictUri.id}\`).`,
					);
				}
				return result;
			}
			const resolvedArchivePath = await this.#resolveArchiveWritePath(path);
			if (resolvedArchivePath) {
				enforcePlanModeWrite(this.session, resolvedArchivePath.archivePath, {
					op: resolvedArchivePath.exists ? "update" : "create",
				});

				emitWriteProgress(
					onUpdate,
					cleanContent,
					`${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
						resolvedArchivePath.archiveSubPath
					}`,
					resolvedArchivePath.absolutePath,
				);
				const archiveResult = await this.#writeArchiveEntry(cleanContent, content, resolvedArchivePath);
				if (stripped) {
					const firstText = archiveResult.content.find(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					);
					if (firstText) {
						firstText.text += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
				}
				return archiveResult;
			}

			const resolvedSqlitePath = await this.#resolveSqliteWritePath(path);
			if (resolvedSqlitePath) {
				enforcePlanModeWrite(this.session, resolvedSqlitePath.sqlitePath, { op: "update" });

				emitWriteProgress(onUpdate, cleanContent, path, resolvedSqlitePath.absolutePath);
				const sqliteResult = await this.#writeSqliteRow(path, cleanContent, resolvedSqlitePath);
				if (stripped) {
					const firstText = sqliteResult.content.find(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					);
					if (firstText) {
						firstText.text += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
				}
				return sqliteResult;
			}

			await assertNotReadSelectorMisfire(path, cleanContent, this.session.cwd);
			enforcePlanModeWrite(this.session, path, { op: "create" });
			const absolutePath = resolvePlanPath(this.session, path);
			const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
			const batchRequest = getLspBatchRequest(context?.toolCall);

			// Check if file exists and is auto-generated before overwriting.
			if (await fs.exists(absolutePath)) {
				await assertEditableFile(absolutePath, path, this.session.settings);
			}
			await assertNotTruncatedFileReadProjection(
				this.session,
				path,
				absolutePath,
				displayPath,
				content,
				cleanContent,
			);

			emitWriteProgress(onUpdate, cleanContent, displayPath, absolutePath);

			// Try ACP bridge first for editor-visible filesystem paths. Internal
			// artifacts such as local:// plans are owned by OMP, not the editor.
			const bridgeWrite = await routeWriteThroughBridge(this.session, path, absolutePath, cleanContent, signal);
			if (bridgeWrite) {
				// `write` always replaces the whole file, so (unlike hashline's
				// hunk-scoped diff) there's no size cost to keying the header/
				// executable-bit check on the verified post-write content —
				// use it so a drifted write (e.g. client format-on-save) still
				// hands back a tag that matches what's actually on disk.
				const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, bridgeWrite.text);
				const header = maybeWriteSnapshotHeader(this.session, absolutePath, bridgeWrite.text);
				const writeLine = `Successfully wrote ${Buffer.byteLength(cleanContent, "utf8")} bytes to ${displayPath}`;
				let resultText = header ? `${header}\n${writeLine}` : writeLine;
				if (stripped) {
					resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
				}
				if (madeExecutable) {
					resultText += `\n${EXECUTABLE_NOTICE}`;
				}
				return {
					content: [{ type: "text", text: resultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			const diagnostics = await this.#writethrough(
				absolutePath,
				cleanContent,
				signal,
				undefined,
				batchRequest,
				dst => this.#deferredDiagnostics?.begin(dst),
			);
			invalidateFsScanAfterWrite(absolutePath);
			if (!this.#deferredDiagnostics || batchRequest?.flush === false) {
				this.session.bumpFileMutationVersion?.(absolutePath);
			}
			const finalContent = diagnostics.finalContent;
			const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, finalContent);

			const header = maybeWriteSnapshotHeader(this.session, absolutePath, finalContent);
			const writeLine = `Successfully wrote ${Buffer.byteLength(finalContent, "utf8")} bytes to ${displayPath}`;
			let resultText = header ? `${header}\n${writeLine}` : writeLine;
			if (stripped) {
				resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
			}
			if (madeExecutable) {
				resultText += `\n${EXECUTABLE_NOTICE}`;
			}
			if (!diagnostics.diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					resolvedPath: absolutePath,
					diagnostics: diagnostics.diagnostics,
					madeExecutable: madeExecutable || undefined,
					meta: outputMeta()
						.diagnostics(diagnostics.diagnostics.summary, diagnostics.diagnostics.messages ?? [])
						.get(),
				},
			};
		});
	}
}
