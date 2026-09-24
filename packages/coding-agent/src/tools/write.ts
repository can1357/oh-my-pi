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
import { normalizeToLF } from "../edit/normalize";

import { InternalUrlRouter, sessionResolveContext, sessionWriteContext } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import { createLspWritethrough, type WritethroughCallback, writethroughNoop } from "../lsp";

import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getLspBatchRequest } from "../lsp/batch";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";

import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import writeDeviceOnlyDescription from "../prompts/tools/write-device-only.md" with { type: "text" };
import type { ToolSession } from "../sdk";

import { routeWriteThroughBridge, shouldRouteWriteThroughBridge } from "./acp-bridge";
import { truncateForPrompt } from "./approval";
import { assertEditableFile } from "./auto-generated-guard";

import { isReadTruncationNotice, splitAddressableFileLines } from "@oh-my-pi/pi-tui/tools/hashline-format";
import { recoverConflictUriPrefix } from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";

import { outputMeta } from "./output-meta";
import { formatPathRelativeToCwd, peelWriteUrlSelector, probeLiteralPathExists } from "./path-utils";
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
import { maybeWriteSnapshotHeader, stripWriteContent } from "./write-content";

import { cfgLspDiagnosticsDeduplicate, cfgLspDiagnosticsOnWrite, cfgLspFormatOnWrite } from "../lsp/settings";

const EXECUTABLE_NOTICE = "[Notice: Made executable via chmod +x]";
const URI_LIKE_WRITE_PATH_RE = /^([a-z][a-z0-9+.-]*):\/{1,2}(.*)$/i;
const MISSING_DELIMITER_RE = /^([a-z][a-z0-9+.-]*)\/+(.*)$/i;

/** True when `typo` is exactly one insertion, deletion, substitution, or adjacent swap away from `word`. */
function isOneEditAway(typo: string, word: string): boolean {
	if (typo === word || Math.abs(typo.length - word.length) > 1) return false;
	let common = 0;
	while (common < typo.length && common < word.length && typo[common] === word[common]) common++;
	const a = typo.slice(common);
	const b = word.slice(common);
	if (a.slice(1) === b.slice(1) || a.slice(1) === b || a === b.slice(1)) return true;
	return a.length >= 2 && a[0] === b[1] && a[1] === b[0] && a.slice(2) === b.slice(2);
}

function assertWriteTargetAddressable(target: string, router: InternalUrlRouter): void {
	const trimmed = target.trim();
	if (path.win32.isAbsolute(trimmed) || router.canHandle(trimmed)) return;

	// Tool-device transports get typo recovery: a bare `<device>/x` or a near-miss
	// scheme is a mistyped dispatch, never an intended filesystem path.
	const deviceSchemes: string[] = [];
	for (const [scheme, spec] of router.specs()) {
		if (spec.write?.scope === "device") deviceSchemes.push(scheme);
	}

	const missingDelimiter = trimmed.match(MISSING_DELIMITER_RE);
	if (missingDelimiter && deviceSchemes.includes(missingDelimiter[1]!.toLowerCase())) {
		throw new ToolError(
			`Unknown URI-like write target '${trimmed}'. Did you mean '${missingDelimiter[1]!.toLowerCase()}://${missingDelimiter[2]}'? Prefix the path with './' to write it as a filesystem path.`,
		);
	}

	const uriLike = trimmed.match(URI_LIKE_WRITE_PATH_RE);
	if (!uriLike) return;

	const scheme = uriLike[1]!.toLowerCase();
	const canonicalScheme = router.getHandler(scheme)
		? scheme
		: deviceSchemes.find(device => isOneEditAway(scheme, device));
	const suggestion = canonicalScheme
		? ` Did you mean '${canonicalScheme}://${uriLike[2]}'?`
		: deviceSchemes.length > 0
			? ` Tool devices use '${deviceSchemes[0]}://<tool>'.`
			: "";
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
 * model cannot recover from — the local analogue of the device-scheme near-miss guard
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

const writeSchema = type({
	path: "string",
	"content?": "string",
});

/** Write arguments; `content` may be omitted only where the target scheme's write policy allows it. */
export type WriteToolInput = typeof writeSchema.infer;

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
	if (!(await shouldRouteWriteThroughBridge(session, requestedPath, absolutePath))) return readDisk();
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
		const { path: rawPath, content } = args as Partial<WriteParams>;
		if (typeof rawPath !== "string") return "write";
		// Unwrap a hashline `[path#TAG]` wrapper first (parity with execute) so a
		// wrapped `[scheme://h/x#ABCD]` gets the same tier as the bare URL.
		return InternalUrlRouter.instance().writeTier(
			unwrapHashlineHeaderPath(rawPath),
			typeof content === "string" ? content : undefined,
			this.session,
		);
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

	readonly #deferredDiagnostics: DeferredDiagnostics | undefined;

	constructor(private readonly session: ToolSession) {
		this.#deferredDiagnostics = session.queueDeferredDiagnostics ? new DeferredDiagnostics(session) : undefined;
	}

	/** Resolves the LSP writethrough from the current `lsp.*` settings so changes apply to the next write. */
	#lspWritethrough(): { writethrough: WritethroughCallback; deferred: DeferredDiagnostics | undefined } {
		if (!(this.session.enableLsp ?? true)) return { writethrough: writethroughNoop, deferred: undefined };
		const { settings } = this.session;
		const enableDiagnostics = cfgLspDiagnosticsOnWrite.get(settings);
		const dedup = enableDiagnostics && cfgLspDiagnosticsDeduplicate.get(settings);
		const writethrough = createLspWritethrough(this.session.cwd, {
			enableFormat: cfgLspFormatOnWrite.get(settings),
			enableDiagnostics,
			transformDiagnostics: dedup
				? (path, result) => getDiagnosticsLedger(this.session).reduce(path, result)
				: undefined,
		});
		return { writethrough, deferred: enableDiagnostics ? this.#deferredDiagnostics : undefined };
	}

	async #resolveArchiveWritePath(writePath: string): Promise<ResolvedArchiveWritePath | null> {
		const candidates = parseArchivePathCandidates(writePath).filter(candidate => candidate.archivePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallback: ResolvedArchiveWritePath = {
			absolutePath: await resolvePlanPath(this.session, fallbackCandidate.archivePath),
			archivePath: fallbackCandidate.archivePath,
			archiveSubPath: normalizeArchiveWriteSubPath(fallbackCandidate.subPath),
			exists: false,
		};

		for (const candidate of candidates) {
			const absolutePath = await resolvePlanPath(this.session, candidate.archivePath);
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
			absolutePath: await resolvePlanPath(this.session, fallbackCandidate.sqlitePath),
			sqlitePath: fallbackCandidate.sqlitePath,
			table: fallbackTarget.table,
			key: fallbackTarget.key,
			exists: false,
		};

		let sawExistingNonSqlite = false;
		for (const candidate of candidates) {
			const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString);
			const absolutePath = await resolvePlanPath(this.session, candidate.sqlitePath);
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

	async execute(
		_toolCallId: string,
		{ path: rawPath, content: rawContent }: WriteParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// Strip a hashline `[path#TAG]` wrapper up front so every downstream
		// decision (scheme routing, internal-URL handler dispatch, plan-mode
		// guard, plan path resolution, ACP bridge routing) sees the same
		// filesystem target. Without this, a model that pastes a `read`
		// header as the `path` arg would slip past internal-URL detection
		// (which fails on a leading `[`) and the bridge router would send a
		// `[local://scratch.md#ABCD]` write to the editor instead of the
		// session-local sandbox.
		// Peel a read-tool selector (`:raw`, `:1-20`, …) so the write target matches
		// what `read` resolves for the same URL; line-range/malformed selectors throw.
		// A `<file>:conflict://N` target is normalized to its URL; the note tells the model.
		const recovered = recoverConflictUriPrefix(peelWriteUrlSelector(unwrapHashlineHeaderPath(rawPath)));
		const path = recovered.path;
		const router = InternalUrlRouter.instance();
		const url = router.canHandle(path) ? parseInternalUrl(path) : undefined;
		const handler = url ? router.getHandler(url.protocol.replace(/:$/, "")) : undefined;
		const policy = handler?.spec.write;
		if (rawContent === undefined && !(url && policy?.contentOptional?.(url))) {
			throw new ToolError(`content is required for ${path}.`);
		}
		const content = rawContent ?? "";
		// A device-only session grants `write` purely as the device transport (see
		// createTools): device dispatches and coordination messages proceed, every
		// other target is rejected before any handler, guard, conflict resolver, or
		// bridge sees it. Active plan mode additionally permits its sandbox, but does
		// not relax the restriction for working-tree or other internal URLs.
		if (
			this.session.deviceOnlyWrite === true &&
			policy?.scope !== "device" &&
			policy?.scope !== "coordination" &&
			!(this.session.getPlanModeState?.()?.enabled === true && (await targetsLocalSandbox(this.session, path)))
		) {
			throw new ToolError(
				"This `write` tool is limited to the xd:// device transport: call it with path `xd://<tool>` and the device's JSON arguments in `content` (`read xd://` lists mounted devices). Active plan mode additionally permits local:// sandbox drafts. Filesystem writes are not available elsewhere.",
			);
		}
		return untilAborted(signal, async () => {
			// Text payloads get hashline display prefixes ([PATH#HASH] + LINE:) stripped if the model
			// copied them from read output. Verbatim payloads (messages, process stdin, setting
			// values, conflict directives) reach their handler exactly as the model wrote them.
			const verbatim = policy?.payload === "verbatim";
			const { text: cleanContent, stripped } = verbatim
				? { text: content, stripped: false }
				: stripWriteContent(this.session, content);
			assertWriteTargetAddressable(path, router);
			if (url) {
				if (handler?.write) {
					// Device payloads are dispatch arguments, not resource text, so only
					// non-device text writes are checked against a truncated read projection.
					if (!verbatim && handler.spec.backing !== "device" && endsWithReadTruncationNotice(content)) {
						const currentResource = await router.resolve(path, sessionResolveContext(this.session, { signal }));
						assertNotShorterReadProjection(path, content, currentResource.content, cleanContent);
					}
					// Handler-owned writes mutate state outside the sandbox unless the
					// scheme is coordination (peer messages) or a device (which keeps each
					// dispatched tool's own tier and policy).
					if (policy?.scope !== "device") {
						if (policy?.scope !== "coordination") {
							await enforcePlanModeWrite(this.session, path, { op: "update" });
						}
						emitWriteProgress(onUpdate, cleanContent, path);
					}
					const handlerResult = await router.write(
						path,
						cleanContent,
						sessionWriteContext(this.session, {
							signal,
							toolCall: { id: _toolCallId, onUpdate, context },
						}),
					);
					if (handlerResult) {
						const result: AgentToolResult<WriteToolDetails> = {
							content: handlerResult.content,
							details: handlerResult.details ?? {},
							isError: handlerResult.isError,
							useless: handlerResult.useless,
						};
						if (recovered.note) appendNoteToResult(result, recovered.note);
						return result;
					}
					let resultText = `Successfully wrote ${Buffer.byteLength(cleanContent, "utf8")} bytes to ${path}`;
					if (stripped) {
						resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
					return { content: [{ type: "text", text: resultText }], details: {} };
				}
				// Read-only scheme: the router rejects the write with its uniform error.
				if (!policy) await router.write(path, cleanContent);
				// A writable scheme without a handler write is file-backed: the pipeline
				// below locates its target (resolvePlanPath) so write and read share one path.
			}

			const resolvedArchivePath = await this.#resolveArchiveWritePath(path);
			if (resolvedArchivePath) {
				await enforcePlanModeWrite(this.session, resolvedArchivePath.archivePath, {
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
				await enforcePlanModeWrite(this.session, resolvedSqlitePath.sqlitePath, { op: "update" });

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
			await enforcePlanModeWrite(this.session, path, { op: "create" });
			const absolutePath = await resolvePlanPath(this.session, path);
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

			const { writethrough, deferred } = this.#lspWritethrough();
			const diagnostics = await writethrough(absolutePath, cleanContent, signal, undefined, batchRequest, dst =>
				deferred?.begin(dst),
			);
			invalidateFsScanAfterWrite(absolutePath);
			if (!deferred || batchRequest?.flush === false) {
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
