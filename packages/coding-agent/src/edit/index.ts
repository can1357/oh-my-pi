import { MismatchError as HashlineMismatchError } from "@pk-nerdsaver-ai/hashline";
import hashlineGrammar from "@pk-nerdsaver-ai/hashline/grammar.lark" with { type: "text" };
import hashlineDescription from "@pk-nerdsaver-ai/hashline/prompt.md" with { type: "text" };
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@pk-nerdsaver-ai/pi-agent-core";
import type { ToolExample } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import {
	createLspWritethrough,
	type FileDiagnosticsResult,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
	writethroughNoop,
} from "../lsp";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import applyPatchDescription from "../prompts/tools/apply-patch.md" with { type: "text" };
import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import type { DeferredDiagnosticsEntry, ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/approval";
import { isInternalUrlPath } from "../tools/path-utils";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import type { ResolvedToolProfile } from "../tools/tool-profiles";
import {
	resolveProfileEditRuntimeMode,
	selectEditGrammar,
	type EditGrammarSelection,
} from "../tools/tool-profiles";
import { executeHashlineSingle, hashlineEditParamsSchema } from "./hashline";
import { type ApplyPatchParams, applyPatchSchema, expandApplyPatchToEntries } from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import { executePatchSingle, type PatchEditEntry, type PatchParams, patchEditSchema } from "./modes/patch";
import { executeReplaceSingle, type ReplaceEditEntry, type ReplaceParams, replaceEditSchema } from "./modes/replace";
import { type EditToolDetails, type EditToolPerFileResult, getLspBatchRequest, type LspBatchRequest } from "./renderer";
import { EDIT_MODE_STRATEGIES } from "./streaming";

export * from "@pk-nerdsaver-ai/hashline";
export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";
export * from "./apply-patch";
export * from "./diff";
export * from "./file-snapshot-store";
export * from "./hashline";
export * from "./modes/apply-patch";
export * from "./modes/patch";
export * from "./modes/replace";
export * from "./normalize";
export * from "./renderer";
export * from "./streaming";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof applyPatchSchema;

type HashlineParams = typeof hashlineEditParamsSchema.infer;

type EditParams = ReplaceParams | PatchParams | HashlineParams | ApplyPatchParams;

type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	examples?: readonly ToolExample[];
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
	) => Promise<AgentToolResult<EditToolDetails, TInput>>;
};

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") {
		return undefined;
	}

	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) {
		throw new Error(`Invalid PI_EDIT_VARIANT: ${rawEditMode}`);
	}

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
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

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
	const dedup = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
	return enableLsp
		? createLspWritethrough(session.cwd, {
				enableFormat,
				enableDiagnostics,
				transformDiagnostics: dedup
					? (path, result) => getDiagnosticsLedger(session).reduce(path, result)
					: undefined,
			})
		: writethroughNoop;
}

/** Run apply_patch file operations and aggregate their multi-file result. */
async function executeApplyPatchPerFile(
	fileEntries: {
		path: string;
		run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>;
	}[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];

	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		const isLast = i === fileEntries.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			const details = result.details;
			perFileResults.push({
				path: details?.path ?? path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				move: details?.move,
				meta: details?.meta,
				oldText: details?.oldText,
				newText: details?.newText,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
		}

		// Emit partial result after each file so UI shows progressive completion
		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: [...perFileResults],
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		},
	};
}

async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	const contentTexts: string[] = [];
	const diffTexts: string[] = [];
	let firstChangedLine: number | undefined;
	let errorCount = 0;
	let metadataPath: string | undefined;
	let hasFirstOldText = false;
	let firstOldText: string | undefined;
	let hasLastNewText = false;
	let lastNewText: string | undefined;

	for (let i = 0; i < runs.length; i++) {
		const isLast = i === runs.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await runs[i](batchRequest);
			const details = result.details;
			if (details?.diff) diffTexts.push(details.diff);
			firstChangedLine ??= details?.firstChangedLine;
			if (details?.path) {
				metadataPath ??= details.path;
			}
			if (details && "oldText" in details && !hasFirstOldText) {
				firstOldText = details.oldText;
				hasFirstOldText = true;
			}
			if (details && "newText" in details) {
				lastNewText = details.newText;
				hasLastNewText = true;
			}
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			contentTexts.push(`Error editing ${path} (entry ${i + 1} of ${runs.length}): ${errorText}`);
			if (i > 0) {
				contentTexts.push(i === 1 ? `Entry 1 was already applied.` : `Entries 1-${i} were already applied.`);
			}
			if (i + 1 < runs.length) {
				contentTexts.push(
					(i + 2 === runs.length
						? `Entry ${runs.length} was NOT applied`
						: `Entries ${i + 2}-${runs.length} were NOT applied`) +
						`; re-read the file and re-issue only the failed and unapplied entries.`,
				);
			}
			errorCount++;
			// Stop at the first failure: later entries were authored against
			// line numbers/content that assumed this entry succeeded, and
			// applying them after a failure compounds the damage.
			break;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: diffTexts.join("\n"),
					firstChangedLine,
				},
				...(errorCount > 0 ? { isError: true } : {}),
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: diffTexts.join("\n"),
			firstChangedLine,
			path: metadataPath ?? path,
			...(hasFirstOldText ? { oldText: firstOldText } : {}),
			...(hasLastNewText ? { newText: lastNewText } : {}),
		},
		// Any per-entry failure marks the aggregate result as an error so the
		// renderer takes the error branch instead of falling through to the
		// streaming-edit preview (which displays the *proposed* diff and looks
		// indistinguishable from success).
		...(errorCount > 0 ? { isError: true } : {}),
	};
}

function extractApprovalPath(args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		const hashlineMatch = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(input);
		if (hashlineMatch?.[1]) return hashlineMatch[1];

		const applyPatchMatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(input);
		if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
	}

	const targetPath = record.path;
	return typeof targetPath === "string" && targetPath.length > 0 ? targetPath : "(unknown)";
}

export interface EditToolSurface {
	readonly grammar: EditGrammarSelection;
	/** When set, overrides session/settings edit mode resolution. */
	readonly runtimeMode: EditMode | undefined;
	readonly descriptionKind: EditGrammarSelection["descriptionKind"];
}

/** Profile-aware edit mode/schema selection (legacy when profile absent). */
export function resolveEditToolSurface(profile?: ResolvedToolProfile | null): EditToolSurface {
	const grammar = selectEditGrammar(profile);
	return Object.freeze({
		grammar,
		runtimeMode: resolveProfileEditRuntimeMode(profile),
		descriptionKind: grammar.descriptionKind,
	});
}

export class EditTool implements AgentTool<TInput> {
	readonly approval = (args: unknown) => {
		const targetPath = extractApprovalPath(args);
		return targetPath !== "(unknown)" && isInternalUrlPath(targetPath) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => [
		`File: ${truncateForPrompt(extractApprovalPath(args))}`,
	];
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #profileEditMode?: EditMode;
	readonly #toolProfile?: ResolvedToolProfile;
	readonly #editGrammar: EditGrammarSelection;
	readonly #dedupDiagnostics: boolean;
	readonly #pendingDeferredFetches = new Map<string, AbortController>();
	/** Fallback per-path mutation counter used only when the session does not expose
	 *  a shared one. Prefer `session.bumpFileMutationVersion` so write (and any other
	 *  tool) mutating the same file also invalidates pending late-diagnostics. */
	readonly #editVersionByPath = new Map<string, number>();

	constructor(session: ToolSession, toolProfile?: ResolvedToolProfile) {
		this.session = session;
		this.#toolProfile = toolProfile;
		const surface = resolveEditToolSurface(toolProfile);
		this.#editGrammar = surface.grammar;
		this.#profileEditMode = surface.runtimeMode;

		const {
			PI_EDIT_FUZZY: editFuzzy = "auto",
			PI_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			PI_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		this.#editMode = resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		this.#dedupDiagnostics =
			(session.enableLsp ?? true) &&
			session.settings.get("lsp.diagnosticsOnEdit") &&
			session.settings.get("lsp.diagnosticsDeduplicate");
		this.#writethrough = createEditWritethrough(session);
	}

	readonly session: ToolSession;

	get grammar(): EditGrammarSelection {
		return this.#editGrammar;
	}

	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		if (this.#profileEditMode) return this.#profileEditMode;
		if (this.#toolProfile && this.#editGrammar.descriptionKind === "none") {
			// Profile forbids mutation; fall back to replace schema only so the
			// tool remains constructible — callers should omit edit from the ceiling.
			return "replace";
		}
		return resolveEditMode(this.session);
	}

	get description(): string {
		if (this.#toolProfile && this.#editGrammar.descriptionKind === "none") {
			return prompt.render(replaceDescription) + "\n\nExisting-file mutation is disabled for this agent profile.";
		}
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	get examples(): readonly ToolExample[] | undefined {
		return this.#getModeDefinition().examples;
	}

	/**
	 * When in `apply_patch` mode, expose the Codex Lark grammar so providers
	 * that support OpenAI-style custom tools can emit a grammar-constrained
	 * variant. Providers that don't support custom tools ignore this field
	 * and fall back to emitting a JSON function tool from `parameters`.
	 */
	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		if (this.mode === "apply_patch") return { syntax: "lark", definition: applyPatchGrammar };
		if (this.mode === "hashline") return { syntax: "lark", definition: hashlineGrammar };
		return undefined;
	}

	/**
	 * Wire-level tool name used when the custom-tool variant is active. GPT-5+
	 * is trained on the literal name `apply_patch`; internally this is just a
	 * mode of the `edit` tool. The agent-loop dispatcher matches both the
	 * internal `name` and `customWireName`, so returned calls route correctly.
	 */
	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	/**
	 * Normalize streamed args into the source text this edit introduces, so
	 * stream matchers (TTSR rules) run against real file content instead of the
	 * mode-specific patch grammar.
	 */
	matcherDigest(args: unknown): string | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherDigest(args);
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		return modeDefinition.execute(this, params, signal, getLspBatchRequest(context?.toolCall), onUpdate);
	}

	#getModeDefinition(): EditModeDefinition {
		return {
			patch: {
				description: () => prompt.render(patchDescription),
				parameters: patchEditSchema,
				examples: [
					{
						caption: "Create",
						call: { path: "hello.txt", edits: [{ op: "create", diff: "Hello\n" }] },
					},
					{
						caption: "Update",
						call: {
							path: "src/app.py",
							edits: [
								{
									op: "update",
									diff: "@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n",
								},
							],
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
				] satisfies readonly ToolExample<PatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as PatchParams;
					const runs = (edits as PatchEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executePatchSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate);
				},
			},
			apply_patch: {
				description: () => prompt.render(applyPatchDescription),
				parameters: applyPatchSchema,
				examples: [
					{
						caption: "Apply a combined patch file",
						call: {
							input: '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n',
						},
					},
				] satisfies readonly ToolExample<ApplyPatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					const perFile = entries.map(entry => {
						const { path, ...patchParams } = entry;
						return {
							path,
							run: (br: LspBatchRequest | undefined) =>
								executePatchSingle({
									session: tool.session,
									path,
									params: patchParams,
									signal,
									batchRequest: br,
									allowFuzzy: tool.#allowFuzzy,
									fuzzyThreshold: tool.#fuzzyThreshold,
									writethrough: tool.#writethrough,
									beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
								}),
						};
					});
					return executeApplyPatchPerFile(perFile, batchRequest, onUpdate);
				},
			},
			hashline: {
				description: () => prompt.render(hashlineDescription),
				parameters: hashlineEditParamsSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { input } = params as HashlineParams;
					return executeHashlineSingle({
						session: tool.session,
						input,
						signal,
						batchRequest,
						writethrough: tool.#writethrough,
						beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
					});
				},
			},
			replace: {
				description: () => prompt.render(replaceDescription),
				parameters: replaceEditSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as ReplaceParams;
					const runs = (edits as ReplaceEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executeReplaceSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate);
				},
			},
		}[this.mode];
	}

	#beginDeferredDiagnosticsForPath(path: string): WritethroughDeferredHandle {
		const existingDeferred = this.#pendingDeferredFetches.get(path);
		if (existingDeferred) {
			existingDeferred.abort();
			this.#pendingDeferredFetches.delete(path);
		}

		const deferredController = new AbortController();
		const editVersion = this.#bumpFileVersion(path);
		return {
			onDeferredDiagnostics: (lateDiagnostics: FileDiagnosticsResult) => {
				this.#pendingDeferredFetches.delete(path);
				this.#injectLateDiagnostics(path, lateDiagnostics, editVersion);
			},
			signal: deferredController.signal,
			finalize: (diagnostics: FileDiagnosticsResult | undefined) => {
				if (!diagnostics) {
					this.#pendingDeferredFetches.set(path, deferredController);
				} else {
					deferredController.abort();
				}
			},
		};
	}

	#injectLateDiagnostics(path: string, diagnostics: FileDiagnosticsResult, editVersion: number): void {
		const effective = this.#dedupDiagnostics
			? getDiagnosticsLedger(this.session).reduce(path, diagnostics)
			: diagnostics;
		if (this.#dedupDiagnostics && effective.messages.length === 0) return;

		const entry: DeferredDiagnosticsEntry = {
			path,
			summary: effective.summary ?? "",
			messages: effective.messages ?? [],
			errored: effective.errored,
			// Drop at flush time if a later edit to the same file superseded this fetch.
			isStale: () => this.#fileVersion(path) !== editVersion,
		};
		this.session.queueDeferredDiagnostics?.(entry);
	}

	/** Bump the file's mutation counter (session-global when available). */
	#bumpFileVersion(path: string): number {
		if (this.session.bumpFileMutationVersion) return this.session.bumpFileMutationVersion(path);
		const next = (this.#editVersionByPath.get(path) ?? 0) + 1;
		this.#editVersionByPath.set(path, next);
		return next;
	}

	/** Read the file's current mutation counter (session-global when available). */
	#fileVersion(path: string): number {
		if (this.session.getFileMutationVersion) return this.session.getFileMutationVersion(path);
		return this.#editVersionByPath.get(path) ?? 0;
	}
}
