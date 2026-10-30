/**
 * Transcript rendering for the opt-in `muse` delegation tool.
 *
 * The tool result is a terminal answer plus sanitized counters. Raw JSONL
 * payloads never reach the renderer, so this view only formats the typed
 * summary and never parses stdout text.
 */
import { Text } from "../components/text";
import {
	formatDuration,
	formatExpandHint,
	formatNumber,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import { renderStatusLine } from "../render";
import { framedToolCard } from "../render/tool-card";
import type { Theme } from "../theme/theme";
import type { Component } from "../tui";
import type { RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

export interface MuseUsageRenderModel {
	model?: string;
	calls: number;
	inputTokens: number;
	outputTokens: number;
}

export interface MuseUsageRender {
	calls: number;
	completedCalls: number;
	failedCalls: number;
	cancelledCalls: number;
	models?: MuseUsageRenderModel[];
}

export interface MuseRenderDetails {
	status?: "completed" | "failed" | "incomplete" | "running";
	terminal?: string | null;
	reason?: string | null;
	records?: number;
	skippedRecords?: number;
	elapsedMs?: number;
	usage?: MuseUsageRender | null;
	tasks?: { total: number; failed: number; cancelled: number };
	answerChars?: number;
	answerTruncated?: boolean;
	workspace?: string;
}

export interface MuseRenderArgs {
	prompt?: string;
	max_model_steps?: number;
	timeout_seconds?: number;
}

function describeStatus(details: MuseRenderDetails | undefined): string {
	switch (details?.status) {
		case "running":
			return "running";
		case "failed":
			return details.terminal ? `terminal ${details.terminal}` : "failed";
		case "incomplete":
			return "no terminal record";
		case "completed":
			return "completed";
		default:
			return "delegating";
	}
}

function usageMeta(details: MuseRenderDetails): string[] {
	const meta: string[] = [];
	if (details.elapsedMs !== undefined) meta.push(formatDuration(details.elapsedMs));
	const usage = details.usage;
	if (usage) {
		meta.push(`${formatNumber(usage.calls)} call(s)`);
		const failed = usage.failedCalls + usage.cancelledCalls;
		if (failed > 0) meta.push(`${formatNumber(failed)} unsuccessful`);
	}
	const tasks = details.tasks;
	if (tasks && tasks.total > 0) {
		meta.push(`${formatNumber(tasks.total)} task(s), ${formatNumber(tasks.failed + tasks.cancelled)} not completed`);
	}
	if (details.records !== undefined) meta.push(`${formatNumber(details.records)} record(s)`);
	return meta;
}

function displayLine(line: string): string {
	return truncateToWidth(shortenEmbeddedPaths(replaceTabs(line)), TRUNCATE_LENGTHS.LONG);
}

function resultLines(text: string, expanded: boolean, theme: Theme): string[] {
	const limit = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	const lines = replaceTabs(text.trim()).split("\n").map(displayLine);
	return lines.length <= limit ? lines : [...lines.slice(0, limit), formatExpandHint(theme, expanded, true)];
}

export const museToolRenderer = {
	renderCall(args: MuseRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.max_model_steps !== undefined) meta.push(`${formatNumber(args.max_model_steps)} step cap`);
		if (args.timeout_seconds !== undefined) meta.push(`${formatNumber(args.timeout_seconds)}s timeout`);
		const description = args.prompt
			? truncateToWidth(replaceTabs(args.prompt.trim()).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.CONTENT)
			: undefined;
		return new Text(renderStatusLine({ icon: "pending", title: "Muse", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: ToolRenderResult<MuseRenderDetails>,
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: MuseRenderArgs,
	): Component {
		const details = result.details;
		const text = result.content?.find(block => block.type === "text")?.text ?? "";
		const status = describeStatus(details);
		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Muse", description: status }, uiTheme);
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [{ content: text.split("\n").map(displayLine) }],
				phase: "error",
				borderColor: "error",
			}));
		}
		const phase = details?.status === "running" ? "partial" : "success";
		const header = renderStatusLine(
			{
				icon: details?.status === "running" ? "pending" : "success",
				title: "Muse",
				description: details?.workspace ? shortenPath(details.workspace) : undefined,
				meta: usageMeta(details ?? {}),
			},
			uiTheme,
		);
		const lines = resultLines(text, options.expanded, uiTheme);
		if (details?.reason) lines.push(uiTheme.fg("warning", `Reason: ${displayLine(details.reason)}`));
		if (details?.answerTruncated) lines.push(uiTheme.fg("dim", "Answer truncated by the host"));
		return framedToolCard(uiTheme, () => ({ header, sections: [{ content: lines }], phase }));
	},
} satisfies ToolRenderer<MuseRenderArgs, MuseRenderDetails>;
