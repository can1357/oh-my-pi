/**
 * Coding-agent specific {@link Filesystem} adapter for the hashline patcher.
 *
 * Wires hashline's storage abstraction to the agent runtime:
 *
 * - Section paths are resolved through the plan-mode redirect so a bare
 *   `PLAN.md` lands at the canonical session artifact location.
 * - Reads go through `readEditFileText` (notebook-aware) and the
 *   auto-generated-file guard.
 * - Writes go through `serializeEditFileText` (notebook-aware) and the
 *   LSP writethrough, with FS-scan cache invalidation on success. The
 *   resulting `FileDiagnosticsResult` is captured per-path so the
 *   orchestrator can attach it to the tool result.
 *
 * Construct one per `executeHashlineSingle` call: per-section state
 * (batch request, diagnostics) lives on the instance and isn't safe to
 * share across concurrent edit tools.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Filesystem, NotFoundError, type PreflightWriteOptions, type WriteResult } from "@oh-my-pi/hashline";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../../lsp/client";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { deleteFileWithFallback, writeFileWithFallback } from "../../tools/file-write-fallback";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { isInternalUrlPath } from "../../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath, targetsLocalSandbox } from "../../tools/plan-mode-guard";
import { canonicalSnapshotKey } from "../file-snapshot-store";
import { isNotebookPath } from "../notebook";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { LspBatchRequest } from "../renderer";

export interface HashlineFilesystemOptions {
	session: ToolSession;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	signal?: AbortSignal;
	/**
	 * Outer LSP batch request inherited from the tool-call context. The
	 * orchestrator narrows this per-section (flush only on the final write)
	 * via {@link HashlineFilesystem.setBatchRequest}.
	 */
	batchRequest?: LspBatchRequest;
}

export class HashlineFilesystem extends Filesystem {
	readonly session: ToolSession;
	readonly #writethrough: WritethroughCallback;
	readonly #beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	readonly #signal: AbortSignal | undefined;
	#batchRequest: LspBatchRequest | undefined;
	#diagnosticsByPath = new Map<string, FileDiagnosticsResult | undefined>();

	constructor(options: HashlineFilesystemOptions) {
		super();
		this.session = options.session;
		this.#writethrough = options.writethrough;
		this.#beginDeferredDiagnosticsForPath = options.beginDeferredDiagnosticsForPath;
		this.#signal = options.signal;
		this.#batchRequest = options.batchRequest;
	}

	/**
	 * Set the LSP batch request used for the next {@link writeText} call.
	 * Multi-section orchestrators flip the `flush` flag to true before the
	 * final section so LSP diagnostics flush in one round-trip.
	 */
	setBatchRequest(batchRequest: LspBatchRequest | undefined): void {
		this.#batchRequest = batchRequest;
	}

	/**
	 * Look up (and clear) the diagnostics captured by the most-recent
	 * {@link writeText} call for `path`. Returns `undefined` if no write
	 * has happened or the writethrough returned no diagnostics.
	 */
	consumeDiagnostics(path: string): FileDiagnosticsResult | undefined {
		const value = this.#diagnosticsByPath.get(path);
		this.#diagnosticsByPath.delete(path);
		return value;
	}

	resolveAbsolute(relativePath: string): string {
		return resolvePlanPath(this.session, relativePath);
	}

	override canonicalPath(relativePath: string): string {
		return canonicalSnapshotKey(this.resolveAbsolute(relativePath));
	}

	override allowTagPathRecovery(authoredPath: string, resolvedPath: string): boolean {
		// Internal-URL authored targets (`local://`, `vault://`, …) are approved
		// at the lower "read" privilege; never let one redirect onto a "write".
		if (isInternalUrlPath(authoredPath)) return false;
		// Recovery rebinds a bare/mis-typed authored path onto the file its
		// snapshot tag uniquely names. Confine the redirect to locations a plain
		// "write" may legitimately target:
		//  1. the working tree (the model dropped the directory), or
		//  2. the session `local://` sandbox where plan/scratch artifacts live —
		//     the snapshot tag proves the model wrote/read that exact file this
		//     session, so a bare `plan.md#tag` should land on `local://plan.md`.
		// The secret vault and any other out-of-tree path stay refused.
		const root = canonicalSnapshotKey(this.session.cwd);
		if (resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`)) return true;
		return targetsLocalSandbox(this.session, resolvedPath);
	}

	async readText(relativePath: string): Promise<string> {
		const absolutePath = this.resolveAbsolute(relativePath);
		let content: string;
		try {
			content = await readEditFileText(absolutePath, relativePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			if (error instanceof Error && error.message === `File not found: ${relativePath}`) {
				throw new NotFoundError(relativePath, error);
			}
			throw error;
		}
		// Refuse edits against generated files (lockfiles, models.json, …).
		assertEditableFileContent(content, relativePath, this.session.settings);
		return content;
	}

	override async readBinary(relativePath: string): Promise<Uint8Array | undefined> {
		const absolutePath = this.resolveAbsolute(relativePath);
		if (isNotebookPath(absolutePath)) return undefined;
		try {
			return await fs.readFile(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
	}

	override async preflightWrite(relativePath: string, options?: PreflightWriteOptions): Promise<void> {
		const fileOp = options?.fileOp;
		if (fileOp?.kind === "rem") {
			enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
			return;
		}
		if (fileOp?.kind === "move") {
			enforcePlanModeWrite(this.session, relativePath, { op: "update", move: fileOp.dest });
			return;
		}
		enforcePlanModeWrite(this.session, relativePath, { op: "update" });
	}

	override async delete(relativePath: string): Promise<void> {
		enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
		const absolutePath = this.resolveAbsolute(relativePath);
		try {
			await deleteFileWithFallback(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
		if (this.session.enableLsp ?? true) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[{ filePath: absolutePath, type: FileChangeType.Deleted }],
				this.#signal,
			);
		}
		invalidateFsScanAfterWrite(absolutePath);
	}

	override async move(fromRelative: string, toRelative: string, content?: string): Promise<void> {
		enforcePlanModeWrite(this.session, fromRelative, { op: "update", move: toRelative });
		const fromAbsolute = this.resolveAbsolute(fromRelative);
		const toAbsolute = this.resolveAbsolute(toRelative);
		if (content !== undefined) {
			// The one `edit` write that does not pass through the writethrough, so it
			// routes to the fallback seam directly. `patcher.ts` always supplies
			// `content` for a hashline `MV`, making this the live branch. The source
			// unlink is a separate primitive with its own seam, so a move out of the
			// workspace and a move out of denied territory both complete.
			await writeFileWithFallback(toAbsolute, content);
			await deleteFileWithFallback(fromAbsolute);
		} else {
			await fs.rename(fromAbsolute, toAbsolute);
		}
		if (this.session.enableLsp ?? true) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[
					{ filePath: fromAbsolute, type: FileChangeType.Deleted },
					{ filePath: toAbsolute, type: FileChangeType.Created },
				],
				this.#signal,
			);
		}
		invalidateFsScanAfterWrite(fromAbsolute);
		invalidateFsScanAfterWrite(toAbsolute);
	}

	async writeText(relativePath: string, content: string): Promise<WriteResult> {
		await this.preflightWrite(relativePath);
		const absolutePath = this.resolveAbsolute(relativePath);
		const finalContent = await serializeEditFileText(absolutePath, relativePath, content);

		// Route through ACP bridge when available; skips internal artifacts.
		// `finalContent` is storage-space (e.g. a notebook's full JSON); the
		// bridge may also report content that diverges from it (e.g. the
		// client reformatted on save). `WriteResult.text` must stay in
		// view-space — the same space `readText` returns — so a follow-up
		// `readText` sees exactly what this write reports.
		const bridgeResult = await routeWriteThroughBridge(
			this.session,
			relativePath,
			absolutePath,
			finalContent,
			this.#signal,
		);
		if (bridgeResult) {
			this.#diagnosticsByPath.set(relativePath, undefined);
			if (!bridgeResult.driftedFromRequest) {
				// No client-side transform: the view we sent is what's on disk.
				return { text: content };
			}
			// Drifted (e.g. format-on-save): re-derive the view from what
			// actually landed on disk instead of assuming `content` still
			// matches. Falls back to `content` if the drifted file can't be
			// re-read as a valid view (e.g. a formatter broke notebook JSON).
			try {
				return { text: await readEditFileText(absolutePath, relativePath) };
			} catch {
				return { text: content };
			}
		}

		const diagnostics = await this.#writethrough(
			absolutePath,
			finalContent,
			this.#signal,
			Bun.file(absolutePath),
			this.#batchRequest,
			dst => (dst === absolutePath ? this.#beginDeferredDiagnosticsForPath(absolutePath) : undefined),
		);
		invalidateFsScanAfterWrite(absolutePath);
		this.#diagnosticsByPath.set(relativePath, diagnostics);
		return { text: content };
	}

	override async exists(relativePath: string): Promise<boolean> {
		const absolutePath = this.resolveAbsolute(relativePath);
		return Bun.file(absolutePath).exists();
	}
}
