/**
 * Review tools - report_finding and submit_review
 *
 * Used by the reviewer agent to report findings in a structured way.
 * Both tools are hidden by default - only enabled when explicitly listed in agent's tools.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Theme } from "../../modes/interactive/theme/theme";

const PRIORITY_LABELS: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
};

const _PRIORITY_DESCRIPTIONS: Record<number, string> = {
	0: "Drop everything to fix. Blocking release, operations, or major usage.",
	1: "Urgent. Should be addressed in the next cycle.",
	2: "Normal. To be fixed eventually.",
	3: "Low. Nice to have.",
};

// report_finding schema
const ReportFindingParams = Type.Object({
	title: Type.String({
		description: "≤80 chars, imperative, prefixed with [P0-P3]. E.g., '[P1] Un-padding slices along wrong dimension'",
	}),
	body: Type.String({
		description: "Markdown explaining why this is a problem. One paragraph max.",
	}),
	priority: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
		description: "0=P0 (critical), 1=P1 (urgent), 2=P2 (normal), 3=P3 (low)",
	}),
	confidence: Type.Number({
		minimum: 0,
		maximum: 1,
		description: "Confidence score 0.0-1.0",
	}),
	file_path: Type.String({ description: "Absolute path to the file" }),
	line_start: Type.Number({ description: "Start line of the issue" }),
	line_end: Type.Number({ description: "End line of the issue" }),
});

interface ReportFindingDetails {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

export const reportFindingTool: AgentTool<typeof ReportFindingParams, ReportFindingDetails, Theme> = {
	name: "report_finding",
	label: "Report Finding",
	description: "Report a code review finding. Use this for each issue found. Call submit_review when done.",
	parameters: ReportFindingParams,
	hidden: true,

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { title, body, priority, confidence, file_path, line_start, line_end } = params;
		const location = `${file_path}:${line_start}${line_end !== line_start ? `-${line_end}` : ""}`;

		return {
			content: [
				{
					type: "text",
					text: `Finding recorded: ${PRIORITY_LABELS[priority]} ${title}\nLocation: ${location}\nConfidence: ${(confidence * 100).toFixed(0)}%`,
				},
			],
			details: { title, body, priority, confidence, file_path, line_start, line_end },
		};
	},

	renderCall(args, theme): Component {
		const priority = PRIORITY_LABELS[args.priority as number] ?? "P?";
		const color = args.priority === 0 ? "error" : args.priority === 1 ? "warning" : "muted";
		const titleText = String(args.title).replace(/^\[P\d\]\s*/, "");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("report_finding "))}${theme.fg(color, `[${priority}]`)} ${theme.fg("dim", titleText)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme): Component {
		const { details } = result;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}

		const priority = PRIORITY_LABELS[details.priority] ?? "P?";
		const color = details.priority === 0 ? "error" : details.priority === 1 ? "warning" : "muted";
		const location = `${details.file_path}:${details.line_start}${details.line_end !== details.line_start ? `-${details.line_end}` : ""}`;

		return new Text(
			`${theme.fg("success", "✓")} ${theme.fg(color, `[${priority}]`)} ${theme.fg("dim", location)}`,
			0,
			0,
		);
	},
};

// submit_review schema
const SubmitReviewParams = Type.Object({
	overall_correctness: Type.Union([Type.Literal("correct"), Type.Literal("incorrect")], {
		description: "Whether the patch is correct (no bugs, tests won't break)",
	}),
	explanation: Type.String({
		description: "1-3 sentence explanation justifying the verdict",
	}),
	confidence: Type.Number({
		minimum: 0,
		maximum: 1,
		description: "Overall confidence score 0.0-1.0",
	}),
});

interface SubmitReviewDetails {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

export const submitReviewTool: AgentTool<typeof SubmitReviewParams, SubmitReviewDetails, Theme> = {
	name: "submit_review",
	label: "Submit Review",
	description: "Submit the final review verdict. Call this after all findings have been reported.",
	parameters: SubmitReviewParams,
	hidden: true,

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { overall_correctness, explanation, confidence } = params;

		let summary = `## Review Summary\n\n`;
		summary += `**Verdict:** ${overall_correctness === "correct" ? "✓ Patch is correct" : "✗ Patch is incorrect"}\n`;
		summary += `**Confidence:** ${(confidence * 100).toFixed(0)}%\n\n`;
		summary += explanation;

		return {
			content: [{ type: "text", text: summary }],
			details: { overall_correctness, explanation, confidence },
		};
	},

	renderCall(args, theme): Component {
		const verdict = args.overall_correctness === "correct" ? "correct" : "incorrect";
		const color = args.overall_correctness === "correct" ? "success" : "error";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("submit_review "))}${theme.fg(color, verdict)} ${theme.fg("dim", `(${((args.confidence as number) * 100).toFixed(0)}%)`)}`,
			0,
			0,
		);
	},

	renderResult(result, { expanded }, theme): Component {
		const { details } = result;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}

		const container = new Container();
		const verdictColor = details.overall_correctness === "correct" ? "success" : "error";
		const verdictIcon = details.overall_correctness === "correct" ? "✓" : "✗";

		container.addChild(
			new Text(
				`${theme.fg(verdictColor, verdictIcon)} Patch is ${theme.fg(verdictColor, details.overall_correctness)} ${theme.fg("dim", `(${(details.confidence * 100).toFixed(0)}% confidence)`)}`,
				0,
				0,
			),
		);

		if (expanded) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", details.explanation), 0, 0));
		}

		return container;
	},
};

export function createReportFindingTool(): AgentTool<typeof ReportFindingParams, ReportFindingDetails, Theme> {
	return reportFindingTool;
}

export function createSubmitReviewTool(): AgentTool<typeof SubmitReviewParams, SubmitReviewDetails, Theme> {
	return submitReviewTool;
}

// Re-export types for external use
export type { ReportFindingDetails, SubmitReviewDetails };

// ─────────────────────────────────────────────────────────────────────────────
// Subprocess tool handlers - registered for extraction/rendering in task tool
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { subprocessToolRegistry } from "./task/subprocess-tool-registry";

// Register report_finding handler
subprocessToolRegistry.register<ReportFindingDetails>("report_finding", {
	extractData: (event) => event.result?.details as ReportFindingDetails | undefined,

	renderInline: (data, theme) => {
		const priority = PRIORITY_LABELS[data.priority] ?? "P?";
		const color = data.priority === 0 ? "error" : data.priority === 1 ? "warning" : "muted";
		const titleText = data.title.replace(/^\[P\d\]\s*/, "");
		const loc = `${path.basename(data.file_path)}:${data.line_start}`;
		return new Text(`${theme.fg(color, `[${priority}]`)} ${titleText} ${theme.fg("dim", loc)}`, 0, 0);
	},

	renderFinal: (allData, theme, expanded) => {
		const container = new Container();
		const displayCount = expanded ? allData.length : Math.min(3, allData.length);

		for (let i = 0; i < displayCount; i++) {
			const data = allData[i];
			const priority = PRIORITY_LABELS[data.priority] ?? "P?";
			const color = data.priority === 0 ? "error" : data.priority === 1 ? "warning" : "muted";
			const titleText = data.title.replace(/^\[P\d\]\s*/, "");
			const loc = `${path.basename(data.file_path)}:${data.line_start}`;

			container.addChild(
				new Text(`  ${theme.fg(color, `[${priority}]`)} ${titleText} ${theme.fg("dim", loc)}`, 0, 0),
			);

			if (expanded && data.body) {
				container.addChild(new Text(`    ${theme.fg("dim", data.body)}`, 0, 0));
			}
		}

		if (allData.length > displayCount) {
			container.addChild(new Text(theme.fg("dim", `  ... ${allData.length - displayCount} more findings`), 0, 0));
		}

		return container;
	},
});

// Register submit_review handler
subprocessToolRegistry.register<SubmitReviewDetails>("submit_review", {
	extractData: (event) => event.result?.details as SubmitReviewDetails | undefined,

	// Terminate subprocess after review is submitted
	shouldTerminate: () => true,

	renderInline: (data, theme) => {
		const verdictColor = data.overall_correctness === "correct" ? "success" : "error";
		const verdictIcon = data.overall_correctness === "correct" ? "✓" : "✗";
		return new Text(
			`${theme.fg(verdictColor, verdictIcon)} Review: ${theme.fg(verdictColor, data.overall_correctness)} (${(data.confidence * 100).toFixed(0)}%)`,
			0,
			0,
		);
	},

	// Note: renderFinal is NOT used for submit_review - we use the combined
	// renderReviewResult in render.ts to show verdict + findings together
});
