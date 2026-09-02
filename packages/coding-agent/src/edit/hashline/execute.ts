/**
 * Coding-agent runner that drives the hashline {@link Patcher} on behalf of
 * the `edit` tool. Converts an `{input}` tool-call payload into a
 * fully-applied patch, wraps the result in the agent's
 * {@link AgentToolResult} shape, and attaches LSP diagnostics + `outputMeta`
 * for the renderer.
 *
 * Multi-section patches are preflighted up front via {@link Patcher.prepare}
 * so a partial batch never lands; the commit loop then narrows the LSP
 * batch's `flush` flag to true only for the final write so diagnostics
 * round-trip once.
 */
import {
	type BlockResolution,
	type Clipboard,
	commitClipboard,
	forkClipboard,
	MismatchError as HashlineMismatchError,
	Patch,
	Patcher,
	type PatchSectionResult,
	type PreparedSection,
	startClipboardBatch,
} from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import type { AppliedEditObserver } from "../blackbox";
import { generateDiffString } from "../diff";
import { getEditClipboard } from "../edit-clipboard";
import { getFileSnapshotStore } from "../file-snapshot-store";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "../renderer";
import {
	createAggregateEditDetails,
	createAggregateEditToolResult,
	createEditResult,
	getEditResultText,
	joinEditResultText,
	toEditToolResult,
} from "../result";
import { nativeBlockResolver } from "./block-resolver";
import { HashlineFilesystem } from "./filesystem";
import { hashPatchInput, recordNoopEdit, resetNoopEdit } from "./noop-loop-guard";
import { type HashlineParams, hashlineEditParamsSchema } from "./params";

export interface ExecuteHashlineSingleOptions {
	session: ToolSession;
	input: string;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	/** Observes a committed content transition before result snapshots are pruned. */
	onApplied?: AppliedEditObserver;
}

function noChangeDiagnostic(path: string): string {
	// The patch parsed and applied cleanly but produced no change — the
	// `+TEXT` body rows matched the file content at the targeted lines
	// byte-for-byte. The model usually misreads this as "wrong anchor, try
	// again with a bigger payload" and starts duplicating content; the
	// message below names the cause directly so the next turn can re-read
	// instead of expanding the patch.
	return (
		`Edits to ${path} parsed and applied cleanly, but produced no change: ` +
		`your body row(s) are byte-identical to the file at the targeted lines. ` +
		`The bug is somewhere else — re-read the file before issuing another edit. ` +
		`Do NOT widen the payload or add lines; verify the anchor first.`
	);
}

/**
 * Escalated diagnostic surfaced once the same payload has no-op'd
 * {@link NOOP_HARD_LIMIT} times in a row on the same canonical path. Thrown as
 * a {@link ToolError} so the agent loop sees a tool *failure* — empirically
 * far more effective at breaking a no-op edit loop than the soft hint alone
 * (issue #2081 saw 182 byte-identical no-op results in 205 calls before the
 * user aborted).
 */
function noChangeLoopDiagnostic(path: string, count: number): string {
	return (
		`STOP. Edits to ${path} have been a byte-identical no-op ${count} times in a row — ` +
		`the patch body matches the file at the targeted lines and the soft hint did not break the cycle. ` +
		`Cease re-issuing this payload. Either the intended change is already on disk (move on), ` +
		`or your anchor is wrong (re-read the file with \`read\` to observe the current line numbers and ` +
		`tag, then author a different edit). This exact payload will keep being rejected until it changes.`
	);
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous !== undefined) {
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
			);
		}
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

function narrowBatchRequest(outer: LspBatchRequest | undefined, isLast: boolean): LspBatchRequest | undefined {
	if (!outer) return undefined;
	return { id: outer.id, flush: isLast && outer.flush };
}

interface RenderedSection {
	toolResult: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>;
	perFileResult: EditToolPerFileResult;
}

async function observeAppliedSection(
	observer: AppliedEditObserver | undefined,
	prepared: PreparedSection,
	result: PatchSectionResult,
): Promise<void> {
	if (!observer || !prepared.exists || result.op === "delete" || result.op === "noop") return;
	await observer({
		path: result.moveDest ?? result.path,
		prev: prepared.rawContent,
		next: result.written,
	});
}

const BLOCK_OP_LABELS: Record<BlockResolution["op"], string> = {
	replace: "PUT N*:",
	insert_after: "PUT >N*:",
	cut: "CUT N*",
	paste_after: "PUT >N*",
};

function formatBlockResolution(resolution: BlockResolution): string {
	const op = BLOCK_OP_LABELS[resolution.op].replace("N", String(resolution.anchorLine));
	const lines = resolution.end - resolution.start + 1;
	const span =
		resolution.start === resolution.end ? `line ${resolution.start}` : `lines ${resolution.start}-${resolution.end}`;
	const suffix =
		resolution.op === "insert_after"
			? `; body lands after line ${resolution.end}`
			: resolution.op === "paste_after"
				? `; clipboard lands after line ${resolution.end}`
				: "";
	return `${op} → resolved ${span} (${lines} line${lines === 1 ? "" : "s"})${suffix}`;
}

function renderSection(
	result: PatchSectionResult,
	diagnostics: FileDiagnosticsResult | undefined,
	sourcePath: string,
): RenderedSection {
	if (result.op === "delete") {
		const editResult = createEditResult({
			displayPath: result.path,
			resultPath: result.path,
			diff: "",
			op: "delete",
			oldText: result.before,
		});
		return {
			toolResult: toEditToolResult(editResult),
			perFileResult: editResult.perFileResult,
		};
	}

	if (result.op === "noop") {
		const editResult = createEditResult({
			displayPath: result.path,
			diff: "",
			op: "update",
			text: noChangeDiagnostic(result.path),
		});
		return {
			toolResult: toEditToolResult(editResult),
			perFileResult: editResult.perFileResult,
		};
	}

	const diff = generateDiffString(result.before, result.after, undefined, { path: result.path });
	const firstChangedLine = result.firstChangedLine ?? diff.firstChangedLine;
	const editResult = createEditResult({
		displayPath: result.moveDest ?? result.path,
		resultPath: result.moveDest ?? result.path,
		header: result.header,
		diff: diff.diff,
		firstChangedLine,
		diagnostics,
		op: result.op,
		move: result.moveDest,
		sourcePath: result.moveDest ? sourcePath : undefined,
		oldText: result.before,
		newText: result.after,
		beforePreview: result.blockResolutions?.map(formatBlockResolution),
		warnings: result.warnings,
	});
	return {
		toolResult: toEditToolResult(editResult),
		perFileResult: editResult.perFileResult,
	};
}

export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const patch = Patch.parse(options.input, { cwd: options.session.cwd });
	if (patch.sections.length === 0) {
		throw new Error("No hashline sections found in input.");
	}

	const fs = new HashlineFilesystem({
		session: options.session,
		writethrough: options.writethrough,
		beginDeferredDiagnosticsForPath: options.beginDeferredDiagnosticsForPath,
		signal: options.signal,
		batchRequest: options.batchRequest,
	});
	const snapshots = getFileSnapshotStore(options.session);
	const enforceSeenLines = options.session.settings.get("edit.enforceSeenLines");
	const patcher = new Patcher({ fs, snapshots, blockResolver: nativeBlockResolver, enforceSeenLines });

	// Named registers persist across edit calls; the anonymous register is
	// batch-local. Each batch starts without anonymous state and publishes
	// named registers only after writes land.
	const sessionClipboard = getEditClipboard(options.session);
	const clipboard = startClipboardBatch(sessionClipboard);

	// Single-section fast path: prepare, commit, render.
	const inputHash = hashPatchInput(options.input);
	if (patch.sections.length === 1) {
		fs.setBatchRequest(narrowBatchRequest(options.batchRequest, true));
		const prepared = await patcher.prepare(patch.sections[0], clipboard);
		const sectionResult = await patcher.commit(prepared);
		await observeAppliedSection(options.onApplied, prepared, sectionResult);
		commitClipboard(clipboard, sessionClipboard);
		if (sectionResult.op === "noop") {
			const { count, escalate } = recordNoopEdit(options.session, sectionResult.canonicalPath, inputHash);
			if (escalate) {
				throw new ToolError(noChangeLoopDiagnostic(sectionResult.path, count));
			}
			return renderSection(sectionResult, undefined, prepared.section.path).toolResult;
		}
		resetNoopEdit(options.session, sectionResult.canonicalPath);
		return renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path), prepared.section.path).toolResult;
	}

	// Multi-section: prepare every section up front so we fail fast before
	// any write hits the filesystem. One batch-local register spans the batch,
	// so `CUT` in one section feeds a register-backed `PUT` in a later one.
	const prepared: PreparedSection[] = [];
	// Register state after each section's prepare. Commits are non-atomic: a
	// mid-batch write failure leaves earlier sections on disk, so the session
	// register must reflect exactly the landed prefix — content a landed CUT
	// deleted would otherwise be lost.
	const sectionStates: Clipboard[] = [];
	for (const section of patch.sections) {
		prepared.push(await patcher.prepare(section, clipboard));
		sectionStates.push(forkClipboard(clipboard));
	}
	assertUniqueCanonicalPaths(prepared);
	for (const entry of prepared) {
		if (entry.isNoop) {
			const { count, escalate } = recordNoopEdit(options.session, entry.canonicalPath, inputHash);
			throw escalate
				? new ToolError(noChangeLoopDiagnostic(entry.section.path, count))
				: new ToolError(noChangeDiagnostic(entry.section.path));
		}
	}
	// Then commit each one, narrowing the LSP batch flush flag to the final
	// section only. A no-op apply mid-batch is treated as a hard failure —
	// the model authored anchors that match the current file content.
	const rendered: RenderedSection[] = [];
	for (let i = 0; i < prepared.length; i++) {
		const isLast = i === prepared.length - 1;
		fs.setBatchRequest(narrowBatchRequest(options.batchRequest, isLast));
		const sectionResult = await patcher.commit(prepared[i]);
		await observeAppliedSection(options.onApplied, prepared[i], sectionResult);
		commitClipboard(sectionStates[i], sessionClipboard);
		if (sectionResult.op === "noop") {
			const { count, escalate } = recordNoopEdit(options.session, sectionResult.canonicalPath, inputHash);
			throw escalate
				? new ToolError(noChangeLoopDiagnostic(sectionResult.path, count))
				: new ToolError(noChangeDiagnostic(sectionResult.path));
		}
		resetNoopEdit(options.session, sectionResult.canonicalPath);
		rendered.push(renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path), prepared[i].section.path));
	}
	return createAggregateEditToolResult(
		joinEditResultText(rendered.map(entry => getEditResultText(entry.toolResult))),
		createAggregateEditDetails({ perFileResults: rendered.map(entry => entry.perFileResult) }),
	);
}

export { HashlineMismatchError, type HashlineParams, hashlineEditParamsSchema };
