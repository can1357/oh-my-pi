import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolArgStream,
	AgentToolArgStreamInit,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import {
	EditSession,
	editDescription,
	editGrammar,
	editInspect,
	type EditFileOutcome,
	type EditInspection,
	type EditPolicy,
	type EditWriteRequest,
	type EditWriteResponse,
} from "@oh-my-pi/pi-natives";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { resolveLocalRoot } from "../internal-urls";
import { cachedVaultRoots, isVaultEnabled } from "../internal-urls/vault-protocol";
import {
	createLspWritethrough,
	type FileDiagnosticsResult,
	flushLspWritethroughBatch,
	type WritethroughCallback,
	writethroughNoop,
} from "../lsp";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../lsp/client";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import type { ToolSession } from "../tools";
import { routeWriteThroughBridge } from "../tools/acp-bridge";
import { truncateForPrompt } from "../tools/approval";
import {
	deleteFileWithFallback,
	hasFileWriteFallback,
	isPermissionDeniedError,
	writeFileWithFallback,
} from "../tools/file-write-fallback";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../tools/fs-cache-invalidation";
import { outputMeta } from "../tools/output-meta";
import { resolveFileWriteApprovalTier } from "../tools/path-utils";
import { planLocalProtocolOptions } from "../tools/plan-mode-guard";
import { ToolError } from "../tools/tool-errors";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import { attemptEditAutoRepair, type EditAutoRepairOutcome } from "./auto-repair";
import { type AppliedEditSnapshot, createEditBlackboxRecorder } from "./blackbox";
import { type EditToolDetails, type EditToolPerFileResult, getLspBatchRequest, type Operation } from "./renderer";
import {
	type ApplyPatchParams,
	applyPatchSchema,
	type HashlineParams,
	hashlineEditParamsSchema,
	type PatchParams,
	patchEditSchema,
	type ReplaceBatchParams,
	type ReplaceParams,
	replaceEditSchema,
	type SloppyParams,
	sloppyEditSchema,
} from "./schemas";
import { getEditStore } from "./store";

export * from "./renderer";
export * from "./schemas";
export * from "./store";
export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof applyPatchSchema
	| typeof sloppyEditSchema;

type EditParams = ReplaceParams | ReplaceBatchParams | PatchParams | HashlineParams | ApplyPatchParams | SloppyParams;

const PATCH_EXAMPLES = [
	{
		caption: "Create",
		call: { path: "hello.txt", edits: [{ op: "create", diff: "Hello\n" }] },
	},
	{
		caption: "Update",
		call: {
			path: "src/app.py",
			edits: [{ op: "update", diff: "@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n" }],
		},
	},
	{
		caption: "Rename",
		call: {
			path: "src/app.py",
			edits: [{ op: "update", rename: "src/main.py", diff: "@@\n …\n" }],
		},
	},
	{
		caption: "Delete",
		call: { path: "obsolete.txt", edits: [{ op: "delete" }] },
	},
	{
		caption: "Multiple entries",
		note: "All entries in one call apply to the top-level `path`; use separate calls for different files.",
	},
] satisfies readonly ToolExample<PatchParams>[];

const APPLY_PATCH_EXAMPLES = [
	{
		caption: "Apply a combined patch file",
		call: {
			input: '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n',
		},
	},
] satisfies readonly ToolExample<ApplyPatchParams>[];

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") return undefined;
	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) throw new Error(`Invalid PI_EDIT_VARIANT: ${rawEditMode}`);
	return editMode;
}

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid PI_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") return session.settings.get("edit.fuzzyThreshold");
	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid PI_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}
	return threshold;
}

function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	const deduplicate = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
	return enableLsp
		? createLspWritethrough(session.cwd, {
				enableFormat,
				enableDiagnostics,
				transformDiagnostics: deduplicate
					? (filePath, result) => getDiagnosticsLedger(session).reduce(filePath, result)
					: undefined,
			})
		: writethroughNoop;
}

function operationFromNative(op: string): Operation | undefined {
	return op === "create" || op === "delete" || op === "update" ? op : undefined;
}

function parseDiagnostics(json: string | undefined): FileDiagnosticsResult | undefined {
	if (!json) return undefined;
	try {
		return JSON.parse(json) as FileDiagnosticsResult;
	} catch {
		return undefined;
	}
}

function mergeDiagnosticsWithWarnings(
	diagnostics: FileDiagnosticsResult | undefined,
	warnings: readonly string[],
): FileDiagnosticsResult | undefined {
	if (warnings.length === 0) return diagnostics;
	const warningMessages = warnings.map(warning => `patch: ${warning}`);
	if (!diagnostics) {
		return {
			server: "patch",
			messages: warningMessages,
			summary: `Patch warnings: ${warnings.length}`,
			errored: false,
		};
	}
	return {
		...diagnostics,
		messages: [...warningMessages, ...diagnostics.messages],
		summary: `${diagnostics.summary}; Patch warnings: ${warnings.length}`,
	};
}

function toPerFileResult(file: EditFileOutcome, mode: EditMode): EditToolPerFileResult {
	let diagnostics = parseDiagnostics(file.diagnosticsJson);
	if (mode === "patch" || mode === "apply_patch") {
		diagnostics = mergeDiagnosticsWithWarnings(diagnostics, file.warnings);
	}
	const resultPath = file.moveTo ?? file.path;
	return {
		path: resultPath,
		diff: file.diff,
		firstChangedLine: file.firstChangedLine,
		diagnostics,
		op: operationFromNative(file.op),
		move: file.moveTo,
		sourcePath: file.moveTo ? file.path : undefined,
		oldText: file.oldText,
		newText: file.newText,
		snapshotsPruned: file.snapshotsPruned || undefined,
		meta: outputMeta()
			.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
			.get(),
	};
}

function aggregateDetails(files: readonly EditFileOutcome[], mode: EditMode): EditToolDetails | undefined {
	if (files.length === 0) return undefined;
	const perFileResults = files.map(file => toPerFileResult(file, mode));
	if (perFileResults.length === 1) {
		const [file] = perFileResults;
		return {
			diff: file.diff,
			firstChangedLine: file.firstChangedLine,
			diagnostics: file.diagnostics,
			op: file.op,
			move: file.move,
			sourcePath: file.sourcePath,
			path: file.path,
			oldText: file.oldText,
			newText: file.newText,
			snapshotsPruned: file.snapshotsPruned,
			meta: file.meta,
		};
	}
	return {
		diff: perFileResults
			.map(file => file.diff)
			.filter(Boolean)
			.join("\n"),
		firstChangedLine: perFileResults.find(file => file.firstChangedLine !== undefined)?.firstChangedLine,
		perFileResults: capPerFileSnapshots(perFileResults),
	};
}

/**
 * Combined `oldText` + `newText` character budget shared across a multi-file
 * result. The engine already prunes each file on its own; this keeps a
 * many-small-files batch from accumulating unbounded snapshot bytes in the
 * session JSONL (#3787). Early entries keep their diff visualization; later
 * ones degrade to text-only.
 */
const MAX_EDIT_SNAPSHOT_TEXT_CHARS = 32_768;

function capPerFileSnapshots(entries: EditToolPerFileResult[]): EditToolPerFileResult[] {
	let remaining = MAX_EDIT_SNAPSHOT_TEXT_CHARS;
	return entries.map(entry => {
		const kept = (entry.oldText?.length ?? 0) + (entry.newText?.length ?? 0);
		if (kept === 0) return entry;
		if (kept <= remaining) {
			remaining -= kept;
			return entry;
		}
		const { oldText: _old, newText: _new, ...rest } = entry;
		return { ...rest, snapshotsPruned: true };
	});
}

async function mkdirAllowingFallback(directory: string): Promise<void> {
	try {
		await mkdir(directory, { recursive: true });
	} catch (error) {
		if (!hasFileWriteFallback() || !isPermissionDeniedError(error)) throw error;
	}
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

export class EditTool implements AgentTool<TInput> {
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #deferredDiagnostics: DeferredDiagnostics;
	readonly #sessions = new Map<string, EditSession>();

	constructor(
		private readonly session: ToolSession,
		mode?: EditMode,
	) {
		const {
			PI_EDIT_FUZZY: editFuzzy = "auto",
			PI_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			PI_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;
		this.#editMode = mode ?? resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		const deduplicateDiagnostics =
			(session.enableLsp ?? true) &&
			session.settings.get("lsp.diagnosticsOnEdit") &&
			session.settings.get("lsp.diagnosticsDeduplicate");
		this.#deferredDiagnostics = new DeferredDiagnostics(session, deduplicateDiagnostics);
		this.#writethrough = createEditWritethrough(session);
	}

	get mode(): EditMode {
		return this.#editMode ?? resolveEditMode(this.session);
	}

	get description(): string {
		return prompt.render(editDescription(this.mode));
	}

	get parameters(): TInput {
		switch (this.mode) {
			case "replace":
				return replaceEditSchema;
			case "patch":
				return patchEditSchema;
			case "apply_patch":
				return applyPatchSchema;
			case "hashline":
				return hashlineEditParamsSchema;
			case "sloppy":
				return sloppyEditSchema;
		}
	}

	get examples(): readonly ToolExample[] | undefined {
		if (this.mode === "patch") return PATCH_EXAMPLES;
		if (this.mode === "apply_patch") return APPLY_PATCH_EXAMPLES;
		return undefined;
	}

	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		const definition = editGrammar(this.mode);
		return definition === null ? undefined : { syntax: "lark", definition };
	}

	get customWireName(): string | undefined {
		return this.mode === "apply_patch" ? "apply_patch" : undefined;
	}

	readonly approval = (args: unknown) => {
		const targets = this.#inspect(args).paths;
		return targets.length > 0 && targets.every(target => resolveFileWriteApprovalTier(target) === "read")
			? "read"
			: "write";
	};

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const targets = this.#inspect(args).paths;
		return targets.length === 0 ? ["File: (unknown)"] : targets.map(target => `File: ${truncateForPrompt(target)}`);
	};

	matcherDigest(args: unknown): string | undefined {
		const digest = this.#inspect(args)
			.entries.map(entry => entry.digest)
			.filter(Boolean)
			.join("\n");
		return digest || undefined;
	}

	matcherPaths(args: unknown): readonly string[] | undefined {
		const inspection = this.#inspect(args);
		const paths = inspection.entries.length > 0 ? inspection.entries.map(entry => entry.path) : inspection.paths;
		return paths.length > 0 ? paths : undefined;
	}

	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		const entries = this.#inspect(args).entries;
		return entries.length > 0 ? entries : undefined;
	}

	openArgStream(init: AgentToolArgStreamInit): AgentToolArgStream {
		const existing = this.#sessions.get(init.toolCallId);
		if (existing) existing.close();
		// A call that arrived through the custom-tool wire streams the payload
		// verbatim; JSON function calls stream JSON text.
		const rawInput = init.customWireName !== undefined;
		const editSession = new EditSession(getEditStore(this.session), this.#policy(rawInput), (error, batch) => {
			if (error) {
				logger.debug("Native edit preview failed", { error: error.message, toolCallId: init.toolCallId });
				return;
			}
			init.emit(batch);
		});
		this.#sessions.delete(init.toolCallId);
		this.#sessions.set(init.toolCallId, editSession);
		while (this.#sessions.size > 32) {
			const oldestId = this.#sessions.keys().next().value;
			if (oldestId === undefined) break;
			this.#sessions.get(oldestId)?.close();
			this.#sessions.delete(oldestId);
		}
		return {
			push: delta => editSession.push(delta),
			end: () => editSession.finish(),
			cancel: () => {
				editSession.close();
				if (this.#sessions.get(init.toolCallId) === editSession) this.#sessions.delete(init.toolCallId);
			},
		};
	}

	async execute(
		toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		let editSession = this.#sessions.get(toolCallId);
		if (!editSession) {
			// No deltas were streamed (non-streaming provider, inline recovery,
			// Cursor batch frames): the parsed args are the whole payload.
			editSession = new EditSession(getEditStore(this.session), this.#policy(false));
			editSession.setArgsJson(JSON.stringify(params));
			editSession.finish();
		}
		const batch = getLspBatchRequest(context?.toolCall);
		let outcome;
		try {
			outcome = await editSession.apply(
				{ lspBatchId: batch?.id, lspFlush: batch?.flush ?? false },
				(_error, request) => this.#write(request, signal),
			);
			if (outcome.isError && batch?.flush) {
				await flushLspWritethroughBatch(batch.id, this.session.cwd, signal);
			}
		} catch (error) {
			if (batch?.flush) await flushLspWritethroughBatch(batch.id, this.session.cwd, signal);
			throw error;
		} finally {
			editSession.close();
			if (this.#sessions.get(toolCallId) === editSession) this.#sessions.delete(toolCallId);
		}

		if (outcome.isError) {
			return { content: [{ type: "text", text: outcome.text }], isError: true };
		}

		const details = aggregateDetails(outcome.files, this.mode);
		const result: AgentToolResult<EditToolDetails, TInput> = {
			content: [{ type: "text", text: outcome.text }],
			...(details ? { details } : {}),
		};
		const record = createEditBlackboxRecorder(this.session, this.mode, params);
		const notes: string[] = [];
		for (const file of outcome.files) {
			if (!file.parseRegressed || file.oldText === undefined || file.newText === undefined) continue;
			const snapshot: AppliedEditSnapshot = {
				path: file.moveTo ?? file.path,
				prev: file.oldText,
				next: file.newText,
			};
			try {
				await record?.(snapshot);
			} catch {
				// Blackbox recording is diagnostic only.
			}
			const display = path.relative(this.session.cwd, snapshot.path) || snapshot.path;
			let repaired: EditAutoRepairOutcome | undefined;
			try {
				repaired = await attemptEditAutoRepair({
					session: this.session,
					snapshot,
					writethrough: this.#writethrough,
					signal,
				});
				if (repaired) getEditStore(this.session).invalidate(snapshot.path);
			} catch (error) {
				logger.warn("Edit auto-repair failed", {
					path: snapshot.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			notes.push(
				repaired
					? `Note: ${display} stopped parsing after this edit; an automatic syntax repair (${repaired.model}) was applied on top:\n${repaired.diff}\nReview the repaired region; adjust it if the repair guessed wrong.`
					: `Warning: ${display} no longer parses after this edit. The change was applied; re-read the edited region and fix the syntax, or revert if unintended.`,
			);
		}
		if (notes.length > 0) result.content.push({ type: "text", text: notes.join("\n\n") });
		return result;
	}

	#inspect(args: unknown): EditInspection {
		try {
			return editInspect(this.mode, JSON.stringify(args ?? {}));
		} catch {
			return { paths: [], entries: [], fileOps: [] };
		}
	}

	#policy(rawInput: boolean): EditPolicy {
		let localSandboxRoot: string | undefined;
		try {
			localSandboxRoot = path.resolve(resolveLocalRoot(planLocalProtocolOptions(this.session)));
		} catch {
			// Sessions without artifact wiring have no local:// sandbox.
		}
		return {
			cwd: this.session.cwd,
			mode: this.mode,
			allowFuzzy: this.#allowFuzzy,
			fuzzyThreshold: this.#fuzzyThreshold,
			enforceSeenLines: this.session.settings.get("edit.enforceSeenLines"),
			blockAutoGenerated: this.session.settings.get("edit.blockAutoGenerated"),
			planActive: this.session.getPlanModeState?.()?.enabled ?? false,
			localSandboxRoot,
			vaultRoots: isVaultEnabled() ? cachedVaultRoots() : undefined,
			homeDir: os.homedir(),
			rawInput,
		};
	}

	async #write(request: EditWriteRequest, signal?: AbortSignal): Promise<EditWriteResponse> {
		if (request.op === "delete") {
			await deleteFileWithFallback(request.path, Bun.file(request.path));
			if (this.session.enableLsp ?? true) {
				await notifyWorkspaceWatchedFiles(
					this.session.cwd,
					[{ filePath: request.path, type: FileChangeType.Deleted }],
					signal,
				);
			}
			invalidateFsScanAfterDelete(request.path);
			this.session.bumpFileMutationVersion?.(request.path);
			const diagnostics =
				request.flushLsp && request.lspBatchId
					? await flushLspWritethroughBatch(request.lspBatchId, this.session.cwd, signal)
					: undefined;
			return {
				written: "",
				diagnosticsJson: diagnostics ? JSON.stringify(diagnostics) : undefined,
			};
		}

		if (request.content === undefined) {
			throw new ToolError(`Native edit ${request.op} request omitted content`, { path: request.path });
		}

		if (request.op === "move") {
			if (!request.moveTo) {
				throw new ToolError("Native edit move request omitted destination", { path: request.path });
			}
			await mkdirAllowingFallback(path.dirname(request.moveTo));
			await writeFileWithFallback(request.moveTo, request.content);
			await deleteFileWithFallback(request.path, Bun.file(request.path));
			if (this.session.enableLsp ?? true) {
				await notifyWorkspaceWatchedFiles(
					this.session.cwd,
					[
						{ filePath: request.path, type: FileChangeType.Deleted },
						{ filePath: request.moveTo, type: FileChangeType.Created },
					],
					signal,
				);
			}
			invalidateFsScanAfterRename(request.path, request.moveTo);
			this.session.bumpFileMutationVersion?.(request.path);
			this.session.bumpFileMutationVersion?.(request.moveTo);
			const diagnostics =
				request.flushLsp && request.lspBatchId
					? await flushLspWritethroughBatch(request.lspBatchId, this.session.cwd, signal)
					: undefined;
			return {
				written: request.content,
				diagnosticsJson: diagnostics ? JSON.stringify(diagnostics) : undefined,
			};
		}

		const bridge = await routeWriteThroughBridge(
			this.session,
			request.displayPath,
			request.path,
			request.content,
			signal,
		);
		if (bridge) return { written: bridge.text };

		let preWriteBytes: Uint8Array | undefined;
		if (request.op === "update") {
			try {
				preWriteBytes = await Bun.file(request.path).bytes();
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		} else if (request.op === "create") {
			await mkdirAllowingFallback(path.dirname(request.path));
		}

		const diagnostics = await this.#writethrough(
			request.path,
			request.content,
			signal,
			Bun.file(request.path),
			request.lspBatchId ? { id: request.lspBatchId, flush: request.flushLsp } : undefined,
			destination => (destination === request.path ? this.#deferredDiagnostics.begin(request.path) : undefined),
		);

		if (preWriteBytes !== undefined) {
			const requestedBytes = new TextEncoder().encode(request.content);
			if (!bytesEqual(requestedBytes, preWriteBytes)) {
				let postWriteBytes: Uint8Array | undefined;
				try {
					postWriteBytes = await Bun.file(request.path).bytes();
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
				if (postWriteBytes !== undefined && bytesEqual(postWriteBytes, preWriteBytes)) {
					throw new ToolError(
						`edit appeared successful but file content did not change on disk: ${request.displayPath}`,
						{ path: request.path },
					);
				}
			}
		}

		invalidateFsScanAfterWrite(request.path);
		this.session.bumpFileMutationVersion?.(request.path);
		return {
			written: request.content,
			diagnosticsJson: diagnostics ? JSON.stringify(diagnostics) : undefined,
		};
	}
}
