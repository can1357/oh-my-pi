import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { formatHashlineHeader, stripHashlinePrefixes } from "@oh-my-pi/hashline";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { isEnoent, isRecord, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import {
	type ArchiveMemberContent,
	archiveFormatFromPath,
	isWritableArchiveFormat,
	parseArchivePathCandidates,
	readArchiveEntries,
	writeArchive,
} from "@oh-my-pi/pi-utils/ar";
import { canonicalSnapshotKey, getFileSnapshotStore } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import { couldBecomeXdUrl, parseXdUrl } from "../internal-urls/xd-protocol";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import { getLanguageFromPath, highlightCode, type Theme } from "../modes/theme/theme";
import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { fileHyperlink, framedBlock, renderStatusLine } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { routeWriteThroughBridge } from "./acp-bridge";
import { resolveToolTier, truncateForPrompt } from "./approval";
import { assertEditableFile } from "./auto-generated-guard";
import {
	type ConflictEntry,
	conflictRegionPresent,
	conflictRegionsEqual,
	expandContentTokens,
	getConflictHistory,
	parseConflictUri,
	spliceConflict,
} from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { type OutputMeta, outputMeta } from "./output-meta";
import {
	formatPathRelativeToCwd,
	pathTargetsSsh,
	peelWriteUrlSelector,
	probeLiteralPathExists,
	resolveFileWriteApprovalTier,
	splitPathAndSel,
} from "./path-utils";
import { enforcePlanModeWrite, resolvePlanPath, unwrapHashlineHeaderPath } from "./plan-mode-guard";
import {
	cachedRenderedString,
	createRenderedStringCache,
	Ellipsis,
	formatDiagnostics,
	formatErrorDetail,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getLspBatchRequest,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import type { ToolActivityContext, ToolActivitySummary } from "./renderers";
import { dispatchReportIssueDevice, REPORT_ISSUE_DEVICE_NAME, renderReportIssueDeviceCall } from "./report-tool-issue";
import { dispatchResolutionDevice, isResolutionDeviceName, renderResolutionDeviceCall } from "./resolve";
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
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import {
	dispatchXdevTool,
	renderXdevCall,
	renderXdevResult,
	resolveXdevTool,
	type XdevDispatch,
	xdevActivitySummary,
	xdevListing,
} from "./xdev";

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
	path: type("string").describe("file path"),
	content: type("string").describe("file content"),
});

export type WriteToolInput = typeof writeSchema.infer;

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
	/** Set when the file was auto-chmod'd because content begins with a `#!` shebang. */
	madeExecutable?: boolean;
	/** Absolute filesystem path the write resolved to. Used by the renderer to wrap
	 * the (possibly cwd-relative) header path in an OSC 8 `file://` hyperlink. */
	resolvedPath?: string;
	/** Set when the write dispatched an `xd://` tool device; drives renderer delegation. */
	xdev?: XdevDispatch;
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Includes a fallback for loosely-formed section headers that still carry
 * line-number prefixes (for example legacy or malformed hashline echoes).
 */
function stripWriteContentWithPotentialLooseHeader(lines: string[]): { text: string; stripped: boolean } {
	const cleaned = stripHashlinePrefixes(lines);
	if (cleaned !== lines) {
		return { text: cleaned.join("\n"), stripped: true };
	}

	const headerIndex = lines.findIndex(line => line.trim().length > 0);
	if (headerIndex === -1 || !LOOSE_HASHLINE_HEADER_RE.test(lines[headerIndex])) {
		return { text: lines.join("\n"), stripped: false };
	}

	const linesWithoutHeader = lines.slice(0, headerIndex).concat(lines.slice(headerIndex + 1));
	const cleanedWithoutHeader = stripHashlinePrefixes(linesWithoutHeader);
	if (cleanedWithoutHeader === linesWithoutHeader) {
		return { text: lines.join("\n"), stripped: false };
	}
	return { text: cleanedWithoutHeader.join("\n"), stripped: true };
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
	const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized, []);
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
		content: [{ type: "text", text: `Writing ${content.length} bytes to ${shortenPath(displayPath)}...` }],
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
	readonly description: string;
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
		this.description = prompt.render(writeDescription);
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
			content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${outputPath}` }],
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
		this.session.fileSnapshotStore?.invalidate(absolutePath);
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
			this.session.fileSnapshotStore?.invalidate(absolutePath);
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
		return untilAborted(signal, async () => {
			// Strip hashline display prefixes ([PATH#HASH] + LINE:) if the model copied them from read output
			const { text: cleanContent, stripped } = stripWriteContent(this.session, content);
			const internalRouter = InternalUrlRouter.instance();
			assertWriteTargetAddressable(path, internalRouter);
			if (internalRouter.canHandle(path)) {
				const parsed = parseInternalUrl(path);
				const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
				const handler = internalRouter.getHandler(scheme);
				if (handler?.write) {
					// Handler-owned writes mutate user data outside the local
					// sandbox. xd:// dispatches retain each wrapped tool's tier.
					if (scheme !== "xd") {
						enforcePlanModeWrite(this.session, path, { op: "update" });
						emitWriteProgress(onUpdate, cleanContent, path);
					}
					let xdResult: AgentToolResult<WriteToolDetails> | undefined;
					await internalRouter.write(path, cleanContent, {
						cwd: this.session.cwd,
						signal,
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
					let resultText = `Successfully wrote ${cleanContent.length} bytes to ${path}`;
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
				const archiveResult = await this.#writeArchiveEntry(cleanContent, resolvedArchivePath);
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
			const batchRequest = getLspBatchRequest(context?.toolCall);

			// Check if file exists and is auto-generated before overwriting
			if (await fs.exists(absolutePath)) {
				await assertEditableFile(absolutePath, path, this.session.settings);
			}

			const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
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
				const writeLine = `Successfully wrote ${cleanContent.length} bytes to ${displayPath}`;
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
			const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, cleanContent);

			const header = maybeWriteSnapshotHeader(this.session, absolutePath, cleanContent);
			const writeLine = `Successfully wrote ${cleanContent.length} bytes to ${displayPath}`;
			let resultText = header ? `${header}\n${writeLine}` : writeLine;
			if (stripped) {
				resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
			}
			if (madeExecutable) {
				resultText += `\n${EXECUTABLE_NOTICE}`;
			}
			if (!diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					resolvedPath: absolutePath,
					diagnostics,
					madeExecutable: madeExecutable || undefined,
					meta: outputMeta()
						.diagnostics(diagnostics.summary, diagnostics.messages ?? [])
						.get(),
				},
			};
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface WriteRenderArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

const WRITE_PREVIEW_LINES = 6;
const WRITE_STREAMING_PREVIEW_LINES = 12;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

/** Bounded newline scan: whether `text` spans more than `maxLines` lines.
 *  Runs on every live compose (the repaint predicate below), so it must not
 *  materialize the split the way `countLines` does. */
function exceedsLineCount(text: string, maxLines: number): boolean {
	if (!text) return false;
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		if (++lines > maxLines) return true;
	}
	return false;
}

function writeContentOf(args: unknown): string {
	if (args == null || typeof args !== "object" || !("content" in args)) return "";
	const content = args.content;
	return typeof content === "string" ? content : "";
}

function formatLineCountSuffix(lineCount: number, uiTheme: Theme): string {
	if (lineCount <= 0) return "";
	return uiTheme.fg("dim", ` · ${lineCount} line${lineCount === 1 ? "" : "s"}`);
}

function normalizeDisplayText(text: unknown): string {
	let displayText = "";
	if (typeof text === "string") {
		displayText = text;
	} else if (text !== undefined && text !== null) {
		displayText = String(text);
	}
	return displayText.replace(/\r/g, "");
}

/**
 * Minimum line-number gutter width for write previews. The streaming preview's
 * gutter must stay byte-stable as the line count grows: a width derived purely
 * from `String(totalLines).length` widens at the 10/100/1000-line crossings,
 * causing the live preview to jitter. Reserving 3 digits keeps the gutter
 * constant through 999 lines and keeps the streamed rows aligned with the
 * final result render.
 */
const WRITE_GUTTER_MIN_WIDTH = 3;

/**
 * Per-component streaming line index for {@link formatStreamingContent}.
 * Keyed on the ToolExecutionComponent's persistent render-state object (the
 * `options` argument renderers receive on every rebuild), so the entry lives
 * exactly as long as the component and never leaks across tool calls.
 *
 * Why: streamed write content is append-only, but the formatter used to
 * normalize + `split("\n")` the ENTIRE accumulated payload on every reveal
 * tick — O(n) per tick, O(n²) per stream, which was a measurable main-thread
 * stall on long writes (and multiplied across concurrent subagent writes).
 * Tracking the newline count incrementally and extracting only the tail
 * window makes each tick O(delta + preview lines).
 */
interface WriteStreamingLineIndex {
	/** Number of content code units scanned so far. */
	length: number;
	/** Bounded suffix used to detect a restarted/non-append stream. */
	suffix: string;
	/** `1 + count("\n")` over the scanned content. */
	lineCount: number;
}

const writeStreamingLineIndex = new WeakMap<object, WriteStreamingLineIndex>();

/** Keep append validation constant-time instead of comparing the entire prior payload. */
const WRITE_STREAMING_APPEND_GUARD_LENGTH = 64;

/** Total logical line count of `content`, resuming from the cached prefix scan when append-only. */
function streamingTotalLines(streamKey: object | undefined, content: string): number {
	if (streamKey === undefined) {
		let lines = 1;
		for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
		return lines;
	}
	let entry = writeStreamingLineIndex.get(streamKey);
	const continuesPrevious =
		entry !== undefined &&
		content.length >= entry.length &&
		content.startsWith(entry.suffix, entry.length - entry.suffix.length);
	if (entry !== undefined && continuesPrevious) {
		let lines = entry.lineCount;
		for (let i = entry.length; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
		entry.length = content.length;
		entry.suffix = content.slice(-WRITE_STREAMING_APPEND_GUARD_LENGTH);
		entry.lineCount = lines;
		return lines;
	}
	let lines = 1;
	for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
	entry = {
		length: content.length,
		suffix: content.slice(-WRITE_STREAMING_APPEND_GUARD_LENGTH),
		lineCount: lines,
	};
	writeStreamingLineIndex.set(streamKey, entry);
	return lines;
}

/**
 * Raw offset just after the (totalLines - previewLines)-th newline — i.e. the
 * start of the last `previewLines` logical lines — scanning back from the end.
 * Returns 0 when the whole content fits in the window. Equivalent to
 * `content.split("\n").slice(-previewLines).join("\n")` without materializing
 * the full line array.
 */
function tailWindowStart(content: string, previewLines: number): number {
	let newlinesSeen = 0;
	for (let i = content.length - 1; i >= 0; i--) {
		if (content.charCodeAt(i) === 10) {
			newlinesSeen++;
			if (newlinesSeen === previewLines) return i + 1;
		}
	}
	return 0;
}

function formatStreamingContent(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	spinnerFrame?: number,
	cache?: RenderedStringCache,
	streamKey?: object,
): string {
	if (!content) return "";
	const bodyText = cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		// Collapsed: follow the streaming edge with a bounded tail window so the box
		// stays short enough not to strand its scrolled-off head above the viewport
		// while the block is volatile. `Ctrl+O` (expanded) lifts the cap for a
		// deliberate full view — matching the eval streaming preview.
		let totalLines: number;
		let startIndex: number;
		let visibleText: string;
		if (expanded) {
			visibleText = normalizeDisplayText(content);
			totalLines = 1;
			for (let i = 0; i < visibleText.length; i++) if (visibleText.charCodeAt(i) === 10) totalLines++;
			startIndex = 0;
		} else {
			totalLines = streamingTotalLines(streamKey, content);
			startIndex = Math.max(0, totalLines - WRITE_STREAMING_PREVIEW_LINES);
			const tail =
				startIndex === 0 ? content : content.slice(tailWindowStart(content, WRITE_STREAMING_PREVIEW_LINES));
			visibleText = tail.replace(/\r/g, "");
		}
		if (visibleText.length === 0) return "";
		const hidden = startIndex;
		const highlighted = highlightCode(visibleText, language);
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);

		let text = "\n\n";
		if (hidden > 0) {
			text += `${uiTheme.fg("dim", `… (${hidden} earlier line${hidden === 1 ? "" : "s"})`)}\n`;
		}
		for (let i = 0; i < highlighted.length; i++) {
			const lineNum = startIndex + i + 1;
			const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")} `);
			const body = replaceTabs(highlighted[i] ?? "");
			text += `${gutter}${body}\n`;
		}
		return text;
	});
	if (bodyText.length === 0) return "";
	// The animated glyph lives on this trailing line — inside the transcript's
	// volatile-tail holdback — never in the header: an animating head row pins
	// the native-scrollback commit boundary at the top of the block, so a long
	// expanded preview could never scroll-append mid-stream.
	const spinner = spinnerFrame !== undefined ? `${formatStatusIcon("running", uiTheme, spinnerFrame)} ` : "";
	return `${bodyText}${spinner}${uiTheme.fg("dim", `… (streaming)`)}`;
}

function renderContentPreview(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	cache?: RenderedStringCache,
): string {
	if (!content) return "";
	return cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const rawLines = normalizeDisplayText(content).split("\n");
		const totalLines = rawLines.length;
		const maxLines = expanded ? totalLines : Math.min(totalLines, WRITE_PREVIEW_LINES);
		const visibleLines = rawLines.slice(0, maxLines);
		const highlighted = highlightCode(visibleLines.join("\n"), language);
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);
		const hidden = totalLines - maxLines;

		let text = "\n\n";
		for (let i = 0; i < highlighted.length; i++) {
			const lineNum = i + 1;
			const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")} `);
			const body = replaceTabs(highlighted[i] ?? "");
			text += `${gutter}${body}\n`;
		}
		if (!expanded && hidden > 0) {
			const hint = formatExpandHint(uiTheme, expanded, hidden > 0);
			const moreLine = `${formatMoreItems(hidden, "line")}${hint ? ` ${hint}` : ""}`;
			text += uiTheme.fg("dim", moreLine);
		}
		return text.trimEnd();
	});
}

/** Render context for the write tool: resolves an `xd://`-mounted tool so its live renderer drives device dispatch previews. */
export interface WriteRenderContext {
	resolveXdevMounted?: (name: string) => AgentTool | undefined;
}

export const writeToolRenderer = {
	/** Compact one-line activity: device writes read as the mounted tool (`LSP · references foo`), file writes as `Write · <path>`. */
	activitySummary(args: unknown, context: ToolActivityContext): ToolActivitySummary {
		const writeArgs = (args ?? {}) as WriteRenderArgs;
		const rawPath =
			typeof writeArgs.file_path === "string"
				? writeArgs.file_path
				: typeof writeArgs.path === "string"
					? writeArgs.path
					: "";
		if (!rawPath) return { label: "Write" };
		const xdev = parseXdUrl(rawPath);
		if (xdev?.name) {
			const resolveMounted = (context.renderContext as WriteRenderContext | undefined)?.resolveXdevMounted;
			return xdevActivitySummary(xdev.name, writeArgs.content, resolveMounted);
		}
		return { label: "Write", detail: shortenPath(rawPath) };
	},

	renderCall(
		args: WriteRenderArgs,
		options: RenderResultOptions & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
	): Component | undefined {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		// Render NOTHING until the streamed path arrives and provably is not an
		// xd:// device. Device writes then render as queued until execution starts,
		// after which they delegate to the mounted tool's renderer.
		// A present-but-malformed path (array/object from a bad provider parse)
		// is definitively not xd:// — fall through to the legacy frame.
		if (args.path === undefined && args.file_path === undefined) return undefined;
		if (rawPath && couldBecomeXdUrl(rawPath)) {
			const xdev = parseXdUrl(rawPath);
			// The path string is settled once the content field started streaming.
			const pathSettled = args.content !== undefined;
			if (!xdev?.name || !pathSettled) return undefined;
			if (isResolutionDeviceName(xdev.name)) return renderResolutionDeviceCall(xdev.name, args.content, uiTheme);
			if (xdev.name === REPORT_ISSUE_DEVICE_NAME) return renderReportIssueDeviceCall(args.content, uiTheme);
			return renderXdevCall(xdev.name, args.content, options, uiTheme, options.renderContext?.resolveXdevMounted);
		}
		const filePath = shortenPath(rawPath);
		const lang = rawPath ? (getLanguageFromPath(rawPath) ?? "text") : "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		// No status icon on the head row: it's the head of the framed block, and
		// native-scrollback commits are prefix-only — an animated glyph would pin
		// the commit boundary at the top, and the pending hourglass just adds
		// noise. The liveness cue rides the trailing "(streaming)" line instead.
		const header = renderStatusLine(
			{
				title: "Write",
				description: `${langIcon} ${pathDisplay}`,
			},
			uiTheme,
		);
		// Raw content, not normalizeDisplayText(args.content): the collapsed
		// streaming path normalizes only its tail window, so a full-payload
		// normalize on every reveal tick would re-introduce the O(n²) streaming
		// cost formatStreamingContent avoids. Non-string content still falls
		// back to the normalizing stringify.
		const content = typeof args.content === "string" ? args.content : normalizeDisplayText(args.content);
		const streamingCache = createRenderedStringCache();
		return framedBlock(uiTheme, width => {
			const body = content
				? formatStreamingContent(
						content,
						Boolean(options?.expanded),
						lang,
						uiTheme,
						options?.spinnerFrame,
						streamingCache,
						// `options` is the ToolExecutionComponent's persistent
						// render-state object — a stable identity across reveal ticks
						// that keys the incremental line index.
						options,
					)
				: "";
			const bodyLines = body ? body.split("\n") : [];
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: "pending",
				borderColor: "borderMuted",
				width,
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		// xd:// dispatch results render as the mounted tool's own result.
		const xdev = result.details?.xdev;
		if (xdev) {
			const delegated = renderXdevResult(xdev, result, options, uiTheme, options.renderContext?.resolveXdevMounted);
			if (delegated) return delegated;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			return new Text(uiTheme.fg("toolOutput", replaceTabs(text)), 0, 0);
		}
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const filePath = shortenPath(rawPath);
		const fileContent = normalizeDisplayText(args?.content);
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		// The header shows the cwd-relative path but links to the absolute path the
		// write resolved to (args.path may be relative, which would yield a broken
		// `file://` URI). Falls back to plain text when the result lacks a path.
		const linkTarget = result.details?.resolvedPath;
		const styledPath = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const pathDisplay = filePath && linkTarget ? fileHyperlink(linkTarget, styledPath) : styledPath;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const header = renderStatusLine(
				{ icon: "error", title: "Write", description: `${langIcon} ${pathDisplay}` },
				uiTheme,
			);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const isPartial = options.isPartial === true;
		const progressText = result.content?.find(c => c.type === "text")?.text ?? "";
		const lineCount = countLines(fileContent);
		const lineSuffix = formatLineCountSuffix(lineCount, uiTheme);
		const execSuffix =
			!isPartial && result.details?.madeExecutable
				? `${uiTheme.fg("dim", " · ")}${uiTheme.fg("success", "made executable!")}`
				: "";
		const header = renderStatusLine(
			{
				icon: isPartial ? "running" : undefined,
				iconOverride: isPartial ? undefined : uiTheme.styledSymbol("tool.write", "accent"),
				spinnerFrame: options.spinnerFrame,
				title: "Write",
				description: `${langIcon} ${pathDisplay}${lineSuffix}${execSuffix}`,
			},
			uiTheme,
		);
		const diagnostics = result.details?.diagnostics;

		const previewCache = createRenderedStringCache();
		return framedBlock(uiTheme, width => {
			const { expanded } = options;
			let body = renderContentPreview(fileContent, expanded, lang, uiTheme, previewCache);
			if (isPartial && progressText) {
				const safeProgressText = truncateToWidth(
					replaceTabs(progressText),
					TRUNCATE_LENGTHS.LINE,
					Ellipsis.Unicode,
				);
				body = `${uiTheme.fg("muted", safeProgressText)}${body ? `\n${body}` : ""}`;
			}
			if (!isPartial && diagnostics) {
				const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, fp =>
					uiTheme.getLangIcon(getLanguageFromPath(fp)),
				);
				if (diagText.trim()) {
					const diagLines = diagText.split("\n");
					const firstNonEmpty = diagLines.findIndex(line => line.trim());
					if (firstNonEmpty >= 0) body += `\n${diagLines.slice(firstNonEmpty).join("\n")}`;
				}
			}
			const bodyLines = body.split("\n");
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				width,
			};
		});
	},
	mergeCallAndResult: true,
	// The collapsed pending preview follows the streaming edge with a tail
	// window once the content outgrows it (`… (N earlier lines)` + last rows);
	// the first partial result re-anchors the frame to the top of the file, so
	// tail rows already committed to viewport/native scrollback would survive
	// as stale content above the new frame without a full replay. Expanded and
	// short previews stay top-anchored and skip the (scrollback-wiping) reset.
	forceFirstResultViewportRepaint: (args: unknown, options: RenderResultOptions) =>
		!options.expanded && exceedsLineCount(writeContentOf(args), WRITE_STREAMING_PREVIEW_LINES),
};
