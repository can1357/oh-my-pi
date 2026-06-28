/**
 * Coding-agent runner that drives the hashline {@link Patcher} on behalf of
 * the `edit` tool. Converts a `{input}` tool-call payload into a
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
	buildCompactDiffPreview,
	MismatchError as HashlineMismatchError,
	Patch,
	Patcher,
	type PatchSectionResult,
	type PreparedSection,
} from "@pk-nerdsaver-ai/hashline";
import type { AgentToolResult } from "@pk-nerdsaver-ai/pi-agent-core";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { outputMeta } from "../../tools/output-meta";
import { ToolError } from "../../tools/tool-errors";
import { generateDiffString } from "../diff";
import { getFileSnapshotStore } from "../file-snapshot-store";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "../renderer";
import { nativeBlockResolver } from "./block-resolver";
import { HashlineFilesystem } from "./filesystem";
import { hashPatchInput, NOOP_HARD_LIMIT, recordNoopEdit, resetNoopEdit } from "./noop-loop-guard";
import { type HashlineParams, hashlineEditParamsSchema } from "./params";

export interface ExecuteHashlineSingleOptions {
	session: ToolSession;
	input: string;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

function noChangeDiagnostic(path: string): string {
	// The patch parsed and applied cleanly but produced no change — the
	// `|literal` body rows matched the file content at the targeted lines
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

function formatBlockResolution(resolution: BlockResolution): string {
	const op = resolution.op === "delete" ? "DEL.BLK" : resolution.op === "insert_after" ? "INS.BLK.POST" : "SWAP.BLK";
	const lines = resolution.end - resolution.start + 1;
	const span =
		resolution.start === resolution.end ? `line ${resolution.start}` : `lines ${resolution.start}-${resolution.end}`;
	const suffix = resolution.op === "insert_after" ? `; body lands after line ${resolution.end}` : "";
	return `${op} ${resolution.anchorLine} → resolved ${span} (${lines} line${lines === 1 ? "" : "s"})${suffix}`;
}

function renderSection(
	result: PatchSectionResult,
	diagnostics: FileDiagnosticsResult | undefined,
	sourcePath: string,
): RenderedSection {
	if (result.op === "delete") {
		const toolResult: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema> = {
			content: [{ type: "text", text: `Deleted ${result.path}` }],
			details: {
				diff: "",
				op: "delete",
				path: result.path,
				oldText: result.before,
				meta: outputMeta().get(),
			},
		};
		return {
			toolResult,
			perFileResult: { path: result.path, diff: "", op: "delete", oldText: result.before },
		};
	}

	if (result.op === "noop") {
		const toolResult: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema> = {
			content: [{ type: "text", text: noChangeDiagnostic(result.path) }],
			details: { diff: "", op: "update", meta: outputMeta().get() },
		};
		return {
			toolResult,
			perFileResult: { path: result.path, diff: "", op: "update" },
		};
	}

	const diff = generateDiffString(result.before, result.after, undefined, { path: result.path });
	const preview = buildCompactDiffPreview(diff.diff);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	const warningsBlock = result.warnings.length > 0 ? `\n\nWarnings:\n${result.warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n${preview.preview}` : "";
	const blockBlock =
		result.blockResolutions && result.blockResolutions.length > 0
			? `\n${result.blockResolutions.map(formatBlockResolution).join("\n")}`
			: "";
	const moveBlock = result.moveDest ? `\nMoved to ${result.moveDest}` : "";
	const firstChangedLine = result.firstChangedLine ?? diff.firstChangedLine;
	return {
		toolResult: {
			content: [
				{
					type: "text",
					text: `${result.header}${blockBlock}${moveBlock}${previewBlock}${warningsBlock}`,
				},
			],
			details: {
				diff: diff.diff,
				firstChangedLine,
				diagnostics,
				op: result.op,
				move: result.moveDest,
				path: result.moveDest ?? result.path,
				sourcePath: result.moveDest ? sourcePath : undefined,
				oldText: result.before,
				newText: result.after,
				meta,
			},
		},
		perFileResult: {
			path: result.moveDest ?? result.path,
			diff: diff.diff,
			firstChangedLine,
			diagnostics,
			op: result.op,
			move: result.moveDest,
			sourcePath: result.moveDest ? sourcePath : undefined,
			oldText: result.before,
			newText: result.after,
		},
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
	const patcher = new Patcher({ fs, snapshots, blockResolver: nativeBlockResolver });

	// Single-section fast path: prepare, commit, render.
	const inputHash = hashPatchInput(options.input);
	if (patch.sections.length === 1) {
		fs.setBatchRequest(narrowBatchRequest(options.batchRequest, true));
		const prepared = await patcher.prepare(patch.sections[0]);
		const sectionResult = await patcher.commit(prepared);
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
	// any write hits the filesystem.
	const prepared: PreparedSection[] = [];
	for (const section of patch.sections) prepared.push(await patcher.prepare(section));
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
		if (sectionResult.op === "noop") {
			const { count, escalate } = recordNoopEdit(options.session, sectionResult.canonicalPath, inputHash);
			throw escalate
				? new ToolError(noChangeLoopDiagnostic(sectionResult.path, count))
				: new ToolError(noChangeDiagnostic(sectionResult.path));
		}
		resetNoopEdit(options.session, sectionResult.canonicalPath);
		rendered.push(renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path), prepared[i].section.path));
	}

	return {
		content: [
			{
				type: "text",
				text: rendered
					.map(r => r.toolResult.content.map(part => (part.type === "text" ? part.text : "")).join("\n"))
					.join("\n\n"),
			},
		],
		details: {
			diff: rendered.map(r => r.toolResult.details?.diff ?? "").join("\n"),
			perFileResults: rendered.map(r => r.perFileResult),
		},
	};
}

export { HashlineMismatchError, type HashlineParams, hashlineEditParamsSchema };
