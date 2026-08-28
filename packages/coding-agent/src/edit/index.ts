import * as nodePath from "node:path";
import { MismatchError as HashlineMismatchError } from "@oh-my-pi/hashline";
import hashlineGrammar from "@oh-my-pi/hashline/grammar.lark" with { type: "text" };
import hashlineDescription from "@oh-my-pi/hashline/prompt.md" with { type: "text" };
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { isEnoent, isEnotdir, logger, prompt } from "@oh-my-pi/pi-utils";
import { createLspWritethrough, flushLspWritethroughBatch, type WritethroughCallback, writethroughNoop } from "../lsp";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import applyPatchDescription from "../prompts/tools/apply-patch.md" with { type: "text" };
import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/approval";
import { findUniqueWorkspaceSuffix, isInternalUrlPath, resolveFileWriteApprovalTier } from "../tools/path-utils";
import { resolvePlanPath } from "../tools/plan-mode-guard";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import { attemptEditAutoRepair, type EditAutoRepairOutcome } from "./auto-repair";
import {
	type AppliedEditObserver,
	type AppliedEditSnapshot,
	createEditBlackboxRecorder,
	introducedParseFailure,
} from "./blackbox";
import { executeHashlineSingle, hashlineEditParamsSchema } from "./hashline";
import { type ApplyPatchParams, applyPatchSchema, expandApplyPatchToEntries } from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import { executePatchSingle, type PatchEditEntry, type PatchParams, patchEditSchema } from "./modes/patch";
import { executeReplace, type ReplaceBatchParams, type ReplaceParams, replaceEditSchema } from "./modes/replace";
import { type EditToolDetails, type EditToolPerFileResult, getLspBatchRequest, type LspBatchRequest } from "./renderer";
import {
	createAggregateEditDetails,
	createAggregateEditToolResult,
	createFailedEditResult,
	getEditResultText,
	joinEditResultText,
	toEditPerFileResult,
} from "./result";
import {
	executeSloppy,
	type SloppyParams,
	type SloppySection,
	sloppyEditSchema,
	sloppyGrammar,
	sloppyVariant,
	splitSloppySections,
} from "./sloppy";
import { EDIT_MODE_STRATEGIES } from "./streaming";

export * from "@oh-my-pi/hashline";
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
export * from "./result";
export * from "./sloppy";
export * from "./snapshot-details";
export * from "./streaming";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof applyPatchSchema
	| typeof sloppyEditSchema;

type HashlineParams = typeof hashlineEditParamsSchema.infer;

type EditParams = ReplaceParams | ReplaceBatchParams | PatchParams | HashlineParams | ApplyPatchParams | SloppyParams;

type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	examples?: readonly ToolExample[];
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onApplied: AppliedEditObserver | undefined,
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

async function resolveEditPath(
	session: ToolSession,
	authoredPath: string,
	options: { mustExist: boolean; signal?: AbortSignal },
): Promise<string> {
	if (!options.mustExist || isInternalUrlPath(authoredPath)) return authoredPath;

	try {
		await Bun.file(resolvePlanPath(session, authoredPath)).stat();
		return authoredPath;
	} catch (error) {
		if (!isEnoent(error) && !isEnotdir(error)) throw error;
	}

	const match = await findUniqueWorkspaceSuffix(authoredPath, session.cwd, options.signal);
	return match?.displayPath ?? authoredPath;
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
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];
	let hasError = false;

	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		const isLast = i === fileEntries.length - 1;
		// Per-file writes join the outer LSP write batch; only the last entry
		// flushes it, so cross-file writes coalesce into a single
		// format+diagnostics pass. The failure path below flushes explicitly
		// when the loop stops early.
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			perFileResults.push(toEditPerFileResult(result.details, path));
			const text = getEditResultText(result);
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push(createFailedEditResult(path, errorText, displayErrorText));
			contentTexts.push(`Error editing ${path}: ${errorText}`);
			hasError = true;
			// Later entries were authored assuming this file's post-state; a
			// partial cascade after failure typically compounds damage. Stop
			// here, report applied vs. skipped, and let the caller re-issue
			// only the failed and unapplied files. Matches
			// `executeSinglePathEntries` semantics.
			if (i > 0) {
				const appliedPaths = fileEntries
					.slice(0, i)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(`Files already applied: ${appliedPaths}.`);
			}
			if (i + 1 < fileEntries.length) {
				const skippedPaths = fileEntries
					.slice(i + 1)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(
					`Files NOT applied: ${skippedPaths}; re-read the affected files and re-issue only the failed and unapplied files.`,
				);
			}
			// Stopping early skips the last-entry flush above; finalize the
			// already-written files so an intervening failure cannot leave them
			// sitting in an unfinalized LSP write batch (mirrors the delete-path
			// flush in executePatchSingle).
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		// Emit partial result after each file so UI shows progressive completion
		if (!isLast && onUpdate) {
			onUpdate(
				createAggregateEditToolResult(
					joinEditResultText(contentTexts),
					createAggregateEditDetails({ perFileResults }),
				),
			);
		}
	}

	// Any per-file failure marks the aggregate result as an error so the agent
	// loop and renderer take the error branch instead of treating a mixed
	// partial application as a successful edit.
	return createAggregateEditToolResult(
		joinEditResultText(contentTexts),
		createAggregateEditDetails({ perFileResults }),
		hasError,
	);
}

async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate: ((partialResult: AgentToolResult<EditToolDetails, TInput>) => void) | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	const contentTexts: string[] = [];
	const diffTexts: string[] = [];
	let firstChangedLine: number | undefined;
	let hasError = false;
	let metadataPath: string | undefined;
	let hasFirstOldText = false;
	let firstOldText: string | undefined;
	let hasLastNewText = false;
	let lastNewText: string | undefined;
	// Any pruned child invalidates the aggregate snapshot: combining a kept
	// first-entry oldText with a pruned next entry's newText (or vice-versa)
	// would describe a transition the file never made. Suppress aggregate
	// snapshots and stamp the marker so ACP/downstream can degrade cleanly.
	let snapshotsPruned = false;

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
			if (details?.snapshotsPruned) snapshotsPruned = true;
			const text = getEditResultText(result);
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
			hasError = true;
			// Stop at the first failure: later entries were authored against
			// line numbers/content that assumed this entry succeeded, and
			// applying them after a failure compounds the damage.
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		if (!isLast && onUpdate) {
			onUpdate(
				createAggregateEditToolResult(
					joinEditResultText(contentTexts),
					createAggregateEditDetails({
						diff: diffTexts.join("\n"),
						firstChangedLine,
					}),
					hasError,
				),
			);
		}
	}

	// Any per-entry failure marks the aggregate result as an error so the
	// renderer takes the error branch instead of falling through to the
	// streaming-edit preview (which displays the *proposed* diff and looks
	// indistinguishable from success).
	return createAggregateEditToolResult(
		joinEditResultText(contentTexts),
		createAggregateEditDetails({
			diff: diffTexts.join("\n"),
			firstChangedLine,
			path: metadataPath ?? path,
			...(snapshotsPruned
				? { snapshotsPruned: true }
				: {
						...(hasFirstOldText ? { oldText: firstOldText } : {}),
						...(hasLastNewText ? { newText: lastNewText } : {}),
					}),
		}),
		hasError,
	);
}

/**
 * Every target path a payload will touch, for approval tiering and display.
 * Multi-file hashline / apply_patch / sloppy payloads report one entry per
 * section so a mixed internal+workspace call cannot be under-classified.
 */
function extractApprovalPaths(args: unknown, mode: EditMode): string[] {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input && mode === "sloppy") {
		const sloppyPaths = splitSloppySections(input)
			.map(section => section.path)
			.filter(path => path.length > 0);
		if (sloppyPaths.length > 0) return sloppyPaths;
	}
	if (input && mode === "hashline") {
		const hashlinePaths = [...input.matchAll(/^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/gm)]
			.map(match => match[1])
			.filter((path): path is string => typeof path === "string" && path.length > 0);
		if (hashlinePaths.length > 0) return hashlinePaths;
	}
	if (input && mode === "apply_patch") {
		const applyPatchPaths = [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)]
			.map(match => match[1]?.trim())
			.filter((path): path is string => typeof path === "string" && path.length > 0);
		if (applyPatchPaths.length > 0) return applyPatchPaths;
	}

	const targetPath = record.path;
	return typeof targetPath === "string" && targetPath.length > 0 ? [targetPath] : [];
}

export class EditTool implements AgentTool<TInput> {
	readonly approval = (args: unknown) => {
		// Internal-resource edits (memory://, skill://, local://, …) are read-tier,
		// but a payload that also targets a real workspace file must stay write-tier
		// so the always-ask prompt still fires — `executeSloppy` writes every section
		// regardless of the first one's scheme (#9353 review).
		const targets = extractApprovalPaths(args, this.mode);
		return targets.length > 0 && targets.every(target => resolveFileWriteApprovalTier(target) === "read")
			? "read"
			: "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const targets = extractApprovalPaths(args, this.mode);
		if (targets.length === 0) return ["File: (unknown)"];
		return targets.map(target => `File: ${truncateForPrompt(target)}`);
	};
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

	/**
	 * `mode` pins the edit variant for this instance, for callers whose protocol
	 * fixes the shape of an edit. The Cursor `pi_edit` frame carries
	 * `old_string`/`new_string` args, which only `replace` accepts — under the
	 * default `hashline` mode those args do not match the schema at all. Left
	 * unset, the env/settings resolution applies as before.
	 */
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
		if (this.#editMode) return this.#editMode;
		return resolveEditMode(this.session);
	}

	get description(): string {
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
		if (this.mode === "sloppy") return { syntax: "lark", definition: sloppyGrammar };
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

	/**
	 * Project the streamed args onto their target file paths so path-scoped
	 * stream matchers (e.g. TTSR `tool:edit(*.ts)` globs) match hashline and
	 * apply_patch edits even though the path lives in the wire payload (a
	 * section header / envelope marker) rather than a top-level argument.
	 */
	matcherPaths(args: unknown): readonly string[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherPaths(args);
	}

	/**
	 * Per-file projection of the streamed args, splitting multi-section
	 * hashline / multi-hunk apply_patch payloads into one (path, digest) entry
	 * per touched file. Path-scoped stream matchers (TTSR) then evaluate each
	 * file in isolation, so a `tool:edit(*.ts)` rule never fires on text that
	 * actually belongs to a sibling Markdown hunk.
	 */
	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherEntries(args);
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		const record = createEditBlackboxRecorder(this.session, this.mode, params);
		const parseFailures = new Map<string, AppliedEditSnapshot>();
		const onApplied: AppliedEditObserver = async snapshot => {
			// Diagnostic only: the edit has already committed, so a guard failure
			// must never turn it into a reported edit failure.
			try {
				if (!introducedParseFailure(snapshot)) {
					// A later operation in the same call restored the parse.
					parseFailures.delete(snapshot.path);
					return;
				}
				parseFailures.set(snapshot.path, snapshot);
				await record?.(snapshot);
			} catch {
				// Parse probing is best-effort; skip the warning rather than fail.
			}
		};
		const result = await modeDefinition.execute(
			this,
			params,
			signal,
			getLspBatchRequest(context?.toolCall),
			onApplied,
			onUpdate,
		);
		if (parseFailures.size > 0) {
			const notes: string[] = [];
			for (const snapshot of parseFailures.values()) {
				const display = nodePath.relative(this.session.cwd, snapshot.path) || snapshot.path;
				let repaired: EditAutoRepairOutcome | undefined;
				try {
					repaired = await attemptEditAutoRepair({
						session: this.session,
						snapshot,
						writethrough: this.#writethrough,
						signal,
					});
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
			result.content = [...result.content, { type: "text", text: notes.join("\n\n") }];
		}
		return result;
	}

	#getModeDefinition(): EditModeDefinition {
		const definitions = {
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
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onApplied: AppliedEditObserver | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as PatchParams;
					const targetPath = await resolveEditPath(tool.session, path, {
						mustExist: (edits[0]?.op ?? "update") !== "create",
						signal,
					});
					const runs = (edits as PatchEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executePatchSingle({
								session: tool.session,
								path: targetPath,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								// The JSON grammar has no `*** Update File`; its `op: "create"`
								// doubles as the documented full-file overwrite (patch.md <avoid>).
								allowCreateOverwrite: true,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
								onApplied,
							}),
					);
					return executeSinglePathEntries(targetPath, runs, batchRequest, onUpdate, tool.session.cwd, signal);
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
					onApplied: AppliedEditObserver | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					// Resolve each authored path once per patch so paired hunks (e.g. delete
					// then re-add of the same file) share the same workspace target.
					const resolvedTargets = new Map<string, Promise<string>>();
					const resolveOnce = (path: string, mustExist: boolean): Promise<string> => {
						let pending = resolvedTargets.get(path);
						if (!pending) {
							pending = resolveEditPath(tool.session, path, { mustExist, signal });
							resolvedTargets.set(path, pending);
						}
						return pending;
					};
					const perFile = entries.map(entry => {
						const { path, ...patchParams } = entry;
						return {
							path,
							run: async (br: LspBatchRequest | undefined) => {
								const targetPath = await resolveOnce(path, patchParams.op !== "create");
								return executePatchSingle({
									session: tool.session,
									path: targetPath,
									params: patchParams,
									signal,
									batchRequest: br,
									allowFuzzy: tool.#allowFuzzy,
									fuzzyThreshold: tool.#fuzzyThreshold,
									writethrough: tool.#writethrough,
									beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
									onApplied,
								});
							},
						};
					});
					return executeApplyPatchPerFile(perFile, batchRequest, tool.session.cwd, signal, onUpdate);
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
					onApplied: AppliedEditObserver | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { input } = params as HashlineParams;
					return executeHashlineSingle({
						session: tool.session,
						input,
						signal,
						batchRequest,
						writethrough: tool.#writethrough,
						beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
						onApplied,
					});
				},
			},
			sloppy: {
				description: () => prompt.render(sloppyVariant.description),
				parameters: sloppyEditSchema,
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onApplied: AppliedEditObserver | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { input } = params as SloppyParams;
					// `[path]` headers open per-file sections; the first line MUST be one.
					const sections = splitSloppySections(input);
					if (sections.length === 0) {
						throw new Error("Missing file header: start the payload with `§relative/path.ts`.");
					}
					const resolved: SloppySection[] = [];
					for (const section of sections) {
						resolved.push({
							path: await resolveEditPath(tool.session, section.path, { mustExist: true, signal }),
							body: section.body,
						});
					}
					return executeSloppy({
						session: tool.session,
						sections: resolved,
						signal,
						batchRequest,
						writethrough: tool.#writethrough,
						beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
						onApplied,
					});
				},
			},
			replace: {
				description: () => prompt.render(replaceDescription),
				parameters: replaceEditSchema,
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onApplied: AppliedEditObserver | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					// `edits` is the internal `ReplaceBatchParams` form only the Cursor
					// exec bridge produces (multi-replacement `pi_edit` frames run as one
					// lifecycle); model calls always arrive in the single-edit schema shape.
					const replaceParams = params as ReplaceParams | ReplaceBatchParams;
					const entries =
						"edits" in replaceParams
							? replaceParams.edits
							: [
									{
										old_string: replaceParams.old_string,
										new_string: replaceParams.new_string,
										replace_all: replaceParams.replace_all,
									},
								];
					const targetPath = await resolveEditPath(tool.session, replaceParams.path, { mustExist: true, signal });
					const runs = entries.map(
						entry => (br: LspBatchRequest | undefined) =>
							executeReplace({
								session: tool.session,
								path: targetPath,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
								onApplied,
							}),
					);
					return executeSinglePathEntries(targetPath, runs, batchRequest, onUpdate, tool.session.cwd, signal);
				},
			},
		};
		return definitions[this.mode];
	}
}
