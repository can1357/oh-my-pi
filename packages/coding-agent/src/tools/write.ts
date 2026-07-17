import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { formatHashlineHeader, stripHashlinePrefixes } from "@pk-nerdsaver-ai/hashline";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@pk-nerdsaver-ai/pi-agent-core";
import type { Component } from "@pk-nerdsaver-ai/pi-tui";
import { isEnoent, isRecord, prompt, untilAborted } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";

import { canonicalSnapshotKey, getFileSnapshotStore } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import { getLanguageFromPath, highlightCode, type Theme } from "../modes/theme/theme";
import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { fileHyperlink, framedBlock, renderStatusLine } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import {
	type ArchiveMemberContent,
	archiveFormatFromPath,
	parseArchivePathCandidates,
	readArchiveEntries,
	writeArchive,
} from "../utils/zip";
import { truncateForPrompt } from "./approval";
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
import { formatPathRelativeToCwd, isInternalUrlPath, pathTargetsSsh, peelWriteUrlSelector } from "./path-utils";
import { enforcePlanModeWrite, resolvePlanPath, unwrapHashlineHeaderPath } from "./plan-mode-guard";
import {
	cachedRenderedString,
	createRenderedStringCache,
	formatDiagnostics,
	formatErrorDetail,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getLspBatchRequest,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
} from "./render-utils";
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

const LOOSE_HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;
const EXECUTABLE_NOTICE = "[Notice: Made executable via chmod +x]";

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
 * after a successful edit: the model gets a tag without an extra `read`.
 */
function maybeWriteSnapshotHeader(session: ToolSession, absolutePath: string, content: string): string | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized);
	return formatHashlineHeader(formatPathRelativeToCwd(absolutePath, session.cwd), tag);
}

function shouldRouteWriteThroughBridge(session: ToolSession, requestedPath: string, absolutePath: string): boolean {
	if (isInternalUrlPath(requestedPath)) return false;

	const state = session.getPlanModeState?.();
	if (!state?.enabled || !isInternalUrlPath(state.planFilePath)) return true;

	return absolutePath !== resolvePlanPath(session, state.planFilePath);
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
	readonly approval = (args: unknown): ToolTier => {
		const rawPath = (args as Partial<WriteParams>).path;
		// Substring scan on the raw arg so a hashline-wrapped `[ssh://…#TAG]`
		// path cannot dodge the exec tier.
		if (typeof rawPath === "string" && pathTargetsSsh(rawPath)) return "exec";
		if (typeof rawPath !== "string" || !isInternalUrlPath(rawPath)) return "write";
		// Internal URLs are usually session-local artifacts (read tier), but a
		// scheme whose handler exposes a `write` hook mutates handler-owned
		// user data (e.g. vault:// notes, host-owned mcp:// URIs) and must take
		// the write tier so always-ask mode actually prompts.
		const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rawPath.trim());
		const handler = match ? InternalUrlRouter.instance().getHandler(match[1]!.toLowerCase()) : undefined;
		return handler?.write ? "write" : "read";
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
	readonly loadMode = "discoverable";
	readonly summary = "Write content to a file (creates or overwrites)";

	/** Stream matchers should see the real file content, not its JSON-escaped argument encoding. */
	matcherDigest(args: unknown): string | undefined {
		const content = (args as Partial<WriteParams>).content;
		return typeof content === "string" ? content : undefined;
	}

	readonly #writethrough: WritethroughCallback;

	constructor(private readonly session: ToolSession) {
		const enableLsp = session.enableLsp ?? true;
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
		const dedup = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
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
		// whole-archive rewrite then defaults to an uncompressed tar, matching the
		// previous `isZip`/`isGzip`/else fallthrough.
		const format = archiveFormatFromPath(finalPath) ?? "tar";
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
				const existing = await readArchiveEntries({ bytes: await Bun.file(finalPath).bytes(), format });
				for (const [entryPath, data] of existing) {
					entries.set(entryPath, data);
				}
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
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
		const newContent = spliceConflict(originalText, entry, expanded);

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
	): Promise<AgentToolResult<WriteToolDetails>> {
		const history = getConflictHistory(this.session);
		const allEntries = history.entries();
		if (allEntries.length === 0) {
			throw new ToolError(
				"`conflict://*` has nothing to resolve — no conflicts are currently registered. Re-read the file(s) with conflicts first.",
			);
		}

		const byFile = new Map<string, ConflictEntry[]>();
		for (const entry of allEntries) {
			const bucket = byFile.get(entry.absolutePath) ?? [];
			bucket.push(entry);
			byFile.set(entry.absolutePath, bucket);
		}

		const succeededFiles: { displayPath: string; count: number; header?: string }[] = [];
		const failedFiles: { displayPath: string; count: number; error: string }[] = [];
		let totalResolvedIds = 0;

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
					const expanded = expandContentTokens(replacementContent, entry);
					text = spliceConflict(text, entry, expanded);
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
		if (stripped) {
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

	#routeWriteThroughBridge(absolutePath: string, content: string): Promise<void> | undefined {
		const bridge = this.session.getClientBridge?.();
		if (!bridge?.capabilities.writeTextFile || !bridge.writeTextFile) return undefined;
		return bridge.writeTextFile({ path: absolutePath, content });
	}
	async execute(
		_toolCallId: string,
		{ path: rawPath, content }: WriteParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
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
		// Peel read-tool selectors off internal-URL targets up front: whole-file
		// display modes (`:raw`, `:conflicts`) drop harmlessly, anything else
		// (line ranges, malformed tails) throws before any handler/SSH op runs.
		const path = peelWriteUrlSelector(unwrapHashlineHeaderPath(rawPath));
		return untilAborted(signal, async () => {
			// Strip hashline display prefixes ([PATH#HASH] + LINE:) if the model copied them from read output
			const { text: cleanContent, stripped } = stripWriteContent(this.session, content);
			const internalRouter = InternalUrlRouter.instance();
			if (internalRouter.canHandle(path)) {
				const parsed = parseInternalUrl(path);
				const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
				const handler = internalRouter.getHandler(scheme);
				if (handler?.write) {
					// Handler-owned writes (vault:// notes, host URIs) mutate user
					// data outside the local sandbox — plan mode must reject them.
					enforcePlanModeWrite(this.session, path, { op: "update" });
					await handler.write(parsed, cleanContent, { cwd: this.session.cwd, signal });
					let resultText = `Successfully wrote ${cleanContent.length} bytes to ${path}`;
					if (stripped) {
						resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
					return { content: [{ type: "text", text: resultText }], details: {} };
				}
				// Schemes without a `write` hook fall through to existing logic
				// (local:// resolves to a backing file via plan-mode-guard) or are
				// rejected downstream when no backing file exists.
			}

			const conflictUri = parseConflictUri(path);
			if (conflictUri) {
				if (conflictUri.scope) {
					throw new ToolError(
						`Conflict URI scope '/${conflictUri.scope}' is read-only — read \`conflict://${conflictUri.id}/${conflictUri.scope}\` to inspect that side. To write, drop the scope (\`conflict://${conflictUri.id}\`) and put the chosen content (or shorthand like \`@${conflictUri.scope}\`) in \`content\`.`,
					);
				}
				const result =
					conflictUri.id === "*"
						? await this.#resolveAllConflicts(cleanContent, stripped, signal)
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

			enforcePlanModeWrite(this.session, path, { op: "create" });
			const absolutePath = resolvePlanPath(this.session, path);
			const batchRequest = getLspBatchRequest(context?.toolCall);

			// Check if file exists and is auto-generated before overwriting
			if (await fs.exists(absolutePath)) {
				await assertEditableFile(absolutePath, path);
			}

			// Try ACP bridge first for editor-visible filesystem paths. Internal
			// artifacts such as local:// plans are owned by OMP, not the editor.
			const bridgePromise = shouldRouteWriteThroughBridge(this.session, path, absolutePath)
				? this.#routeWriteThroughBridge(absolutePath, cleanContent)
				: undefined;
			if (bridgePromise !== undefined) {
				try {
					await bridgePromise;
				} catch (error) {
					throw new ToolError(error instanceof Error ? error.message : String(error));
				}
				invalidateFsScanAfterWrite(absolutePath);
				this.session.bumpFileMutationVersion?.(absolutePath);
				const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, cleanContent);
				const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
				const header = maybeWriteSnapshotHeader(this.session, absolutePath, cleanContent);
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

			const diagnostics = await this.#writethrough(absolutePath, cleanContent, signal, undefined, batchRequest);
			invalidateFsScanAfterWrite(absolutePath);
			this.session.bumpFileMutationVersion?.(absolutePath);
			const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, cleanContent);

			const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
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
	path?: string;
	file_path?: string;
	content?: string;
}

const WRITE_PREVIEW_LINES = 6;
const WRITE_STREAMING_PREVIEW_LINES = 12;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatLineCountSuffix(lineCount: number, uiTheme: Theme): string {
	if (lineCount <= 0) return "";
	return uiTheme.fg("dim", ` · ${lineCount} line${lineCount === 1 ? "" : "s"}`);
}

function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/**
 * Minimum line-number gutter width for write previews. The streaming preview's
 * gutter must stay byte-stable as the line count grows: a width derived purely
 * from `String(totalLines).length` widens at the 10/100/1000-line crossings,
 * rewriting every already-rendered row — which forces the transcript's commit
 * audit to recommit the block's committed prefix (a full duplicate in native
 * scrollback). Reserving 3 digits keeps the gutter constant through 999 lines
 * and keeps the streamed rows byte-identical to the final result render.
 */
const WRITE_GUTTER_MIN_WIDTH = 3;

function formatStreamingContent(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	spinnerFrame?: number,
	cache?: RenderedStringCache,
): string {
	if (!content) return "";
	const bodyText = cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const lines = normalizeDisplayText(content).split("\n");
		const totalLines = lines.length;
		// Collapsed: follow the streaming edge with a bounded tail window so the box
		// stays short enough not to strand its scrolled-off head above the viewport
		// while the block is volatile. `Ctrl+O` (expanded) lifts the cap for a
		// deliberate full view — matching the eval streaming preview.
		const startIndex = expanded ? 0 : Math.max(0, totalLines - WRITE_STREAMING_PREVIEW_LINES);
		const visibleLines = lines.slice(startIndex);
		const hidden = startIndex;
		const highlighted = highlightCode(visibleLines.join("\n"), language);
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

export const writeToolRenderer = {
	renderCall(args: WriteRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const lang = getLanguageFromPath(rawPath) ?? "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		// Static pending icon, never the animated glyph: the header is the head
		// row of the framed block, and native-scrollback commits are prefix-only
		// — an animating head row would pin the commit boundary at the top and
		// keep a tall expanded preview from scroll-appending mid-stream. The
		// liveness cue rides the trailing "(streaming)" line instead.
		const header = renderStatusLine(
			{
				icon: "pending",
				title: "Write",
				description: `${langIcon} ${pathDisplay}`,
			},
			uiTheme,
		);
		const streamingCache = createRenderedStringCache();
		return framedBlock(uiTheme, width => {
			const body = args.content
				? formatStreamingContent(
						args.content,
						Boolean(options?.expanded),
						lang,
						uiTheme,
						options?.spinnerFrame,
						streamingCache,
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
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const fileContent = args?.content || "";
		const lang = getLanguageFromPath(rawPath);
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

		const lineCount = countLines(fileContent);
		const lineSuffix = formatLineCountSuffix(lineCount, uiTheme);
		const execSuffix = result.details?.madeExecutable
			? `${uiTheme.fg("dim", " · ")}${uiTheme.fg("success", "made executable!")}`
			: "";
		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.write", "accent"),
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
			if (diagnostics) {
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
				state: "success",
				borderColor: "borderMuted",
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
