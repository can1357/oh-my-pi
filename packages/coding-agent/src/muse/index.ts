/**
 * Opt-in delegation to the installed Muse Code client.
 *
 * The tool is off unless `muse.enabled` is set. It uses the official
 * `muse exec --json` headless interface and the client's licensed provider;
 * it never selects a provider, disables approvals or the sandbox, or forwards
 * raw JSONL payloads to the model.
 */
import { promises as fs, type Stats } from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { $which } from "@oh-my-pi/pi-utils";
import museDescription from "../prompts/tools/muse.md" with { type: "text" };
import type { ToolSession } from "../tools/index";
import { clampTimeout } from "../tools/tool-timeouts";
import { cfgMuseEnabled, cfgMusePath, cfgToolsMaxTimeout } from "../tools/settings";
import { runMuseExec } from "./exec";
import {
	MUSE_MAX_EVENT_DELTA_BYTES,
	type MuseExecOutcome,
	type MuseExecRunStatus,
	type MuseExecUsage,
	sanitizeMuseText,
} from "./protocol";

const MUSE_PREVIEW_CHARS = 4_000;
const MUSE_PREVIEW_INTERVAL_MS = 250;

const museSchema = type({
	prompt: "1 <= string <= 200000",
	"max_model_steps?": "1 <= number.integer <= 100",
	"timeout_seconds?": "1 <= number.integer <= 3600",
});

export type MuseToolParams = typeof museSchema.infer;

/** Sanitized run summary shown in the transcript and logged with the result. */
export interface MuseToolDetails {
	status: MuseExecRunStatus;
	workspace: string;
	terminal?: string | null;
	reason?: string | null;
	records?: number;
	skippedRecords?: number;
	unknownPayloads?: number;
	elapsedMs?: number;
	exitCode?: number;
	usage?: MuseExecUsage | null;
	tasks?: MuseExecOutcome["tasks"];
	answerChars?: number;
	answerTruncated?: boolean;
	warnings?: string[];
}

function usageSummary(usage: MuseExecUsage | null): string {
	if (!usage) return "usage unavailable";
	const models = usage.models
		.filter(model => model.model)
		.map(model => `${model.model}: ${model.calls} call(s), ${model.inputTokens} in / ${model.outputTokens} out`);
	const detail = [
		`${usage.calls} call(s)`,
		`${usage.completedCalls} completed`,
		`${usage.failedCalls} failed`,
		`${usage.cancelledCalls} cancelled`,
	];
	if (models.length > 0) detail.push(models.join("; "));
	return detail.join(", ");
}

function resultText(outcome: MuseExecOutcome, elapsedMs: number, workspace: string): string {
	const lines: string[] = [outcome.answer.trim() || "Muse returned an empty answer."];
	const meta = [
		`Muse completed in ${(elapsedMs / 1000).toFixed(1)}s`,
		usageSummary(outcome.usage),
		`tasks ${outcome.tasks.total} (${outcome.tasks.failed} failed, ${outcome.tasks.cancelled} cancelled; activity only)`,
		`workspace ${workspace}`,
	];
	if (outcome.answerTruncated) meta.push("answer truncated by the host");
	lines.push("", meta.join("; "));
	return lines.join("\n");
}

function detailsFor(
	status: MuseExecRunStatus,
	workspace: string,
	outcome?: MuseExecOutcome,
	elapsedMs?: number,
	exitCode?: number,
): MuseToolDetails {
	if (!outcome) return { status, workspace };
	return {
		status,
		workspace,
		terminal: outcome.terminal,
		reason: outcome.reason,
		records: outcome.records,
		skippedRecords: outcome.skippedLines,
		unknownPayloads: outcome.unknownPayloads,
		elapsedMs,
		exitCode,
		usage: outcome.usage,
		tasks: outcome.tasks,
		answerChars: outcome.answer.length,
		answerTruncated: outcome.answerTruncated,
		warnings: outcome.warnings,
	};
}

/** Delegates one self-contained prompt to `muse exec` in the session workspace. */
export class MuseTool implements AgentTool<typeof museSchema, MuseToolDetails> {
	readonly name = "muse";
	readonly approval = "exec" as const;
	readonly concurrency = "exclusive";
	readonly label = "Muse Code";
	readonly loadMode = "discoverable";
	readonly summary = "Delegate a self-contained task to the installed Muse Code client";
	readonly description = museDescription.trim();
	readonly parameters = museSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: MuseToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<MuseToolDetails>,
	): Promise<AgentToolResult<MuseToolDetails>> {
		if (!cfgMuseEnabled.get(this.session.settings)) {
			throw new ToolError("Muse delegation is disabled. Enable muse.enabled before using the muse tool.");
		}
		const museBin = cfgMusePath.get(this.session.settings);
		if (!$which(museBin)) {
			throw new ToolError(
				`Muse Code client not found (${museBin}). Install it and ensure it is on PATH, set muse.path, or keep muse.enabled off.`,
			);
		}
		const workspace = path.resolve(this.session.cwd);
		let stats: Stats;
		try {
			stats = await fs.stat(workspace);
		} catch {
			throw new ToolError(`Muse workspace does not exist: ${workspace}`);
		}
		if (!stats.isDirectory()) throw new ToolError(`Muse workspace is not a directory: ${workspace}`);

		let preview = "";
		let lastPreviewAt = 0;
		const run = await runMuseExec({
			prompt: params.prompt,
			workspace,
			bin: museBin,
			timeoutMs: clampTimeout("muse", params.timeout_seconds, cfgToolsMaxTimeout.get(this.session.settings)) * 1000,
			signal,
			onEvent: event => {
				if (event.type !== "delta" || !onUpdate) return;
				const tail = `${preview}${event.text}`.slice(-MUSE_PREVIEW_CHARS);
				preview = sanitizeMuseText(tail, MUSE_MAX_EVENT_DELTA_BYTES).text;
				const now = performance.now();
				if (now - lastPreviewAt < MUSE_PREVIEW_INTERVAL_MS) return;
				lastPreviewAt = now;
				onUpdate({
					content: [{ type: "text", text: preview }],
					details: { status: "running", workspace },
				});
			},
		});
		return {
			content: [{ type: "text", text: resultText(run.outcome, run.elapsedMs, workspace) }],
			details: detailsFor(run.outcome.status, workspace, run.outcome, run.elapsedMs, run.exitCode),
		};
	}
}
