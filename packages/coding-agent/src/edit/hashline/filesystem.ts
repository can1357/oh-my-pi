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
import { Filesystem, NotFoundError, type PreflightWriteOptions, type WriteResult } from "@pk-nerdsaver-ai/hashline";
import { isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { isInternalUrlPath } from "../../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath, targetsLocalSandbox } from "../../tools/plan-mode-guard";
import { canonicalSnapshotKey } from "../file-snapshot-store";
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

	canonicalPath(relativePath: string): string {
		return canonicalSnapshotKey(this.resolveAbsolute(relativePath));
	}

	allowTagPathRecovery(authoredPath: string, resolvedPath: string): boolean {
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
		assertEditableFileContent(content, relativePath);
		return content;
	}

	async preflightWrite(relativePath: string, options?: PreflightWriteOptions): Promise<void> {
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

	async delete(relativePath: string): Promise<void> {
		enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
		const absolutePath = this.resolveAbsolute(relativePath);
		try {
			await fs.rm(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
		invalidateFsScanAfterWrite(absolutePath);
	}

	async move(fromRelative: string, toRelative: string, content?: string): Promise<void> {
		enforcePlanModeWrite(this.session, fromRelative, { op: "update", move: toRelative });
		const fromAbsolute = this.resolveAbsolute(fromRelative);
		const toAbsolute = this.resolveAbsolute(toRelative);
		if (content !== undefined) {
			await Bun.write(toAbsolute, content);
			await fs.rm(fromAbsolute);
		} else {
			await fs.rename(fromAbsolute, toAbsolute);
		}
		invalidateFsScanAfterWrite(fromAbsolute);
		invalidateFsScanAfterWrite(toAbsolute);
	}

	async writeText(relativePath: string, content: string): Promise<WriteResult> {
		await this.preflightWrite(relativePath);
		const absolutePath = this.resolveAbsolute(relativePath);
		const finalContent = await serializeEditFileText(absolutePath, relativePath, content);

		// Route through ACP bridge when available; skips internal artifacts.
		if (await routeWriteThroughBridge(this.session, relativePath, absolutePath, finalContent)) {
			this.#diagnosticsByPath.set(relativePath, undefined);
			return { text: finalContent };
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
		return { text: finalContent };
	}

	async exists(relativePath: string): Promise<boolean> {
		const absolutePath = this.resolveAbsolute(relativePath);
		return Bun.file(absolutePath).exists();
	}
}
