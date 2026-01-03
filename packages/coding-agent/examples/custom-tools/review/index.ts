/**
 * Review Tools - report_finding and submit_review
 *
 * Used by code review agents to report findings in a structured way.
 * Both tools are hidden by default - only enabled when explicitly listed in agent's tools.
 *
 * - report_finding: Accumulates findings in session state
 * - submit_review: Collects all findings and renders final verdict
 */

import type {
	CustomTool,
	CustomToolContext,
	CustomToolFactory,
	CustomToolSessionEvent,
} from "@oh-my-pi/pi-coding-agent";

interface Finding {
	title: string;
	body: string;
	priority: 0 | 1 | 2 | 3;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

interface FindingDetails {
	finding: Finding;
	findings: Finding[];
}

interface SubmitDetails {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
	findings: Finding[];
}

const PRIORITY_LABELS: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
};

const PRIORITY_DESCRIPTIONS: Record<number, string> = {
	0: "Drop everything to fix. Blocking release, operations, or major usage.",
	1: "Urgent. Should be addressed in the next cycle.",
	2: "Normal. To be fixed eventually.",
	3: "Low. Nice to have.",
};

const factory: CustomToolFactory = (pi) => {
	const { Type } = pi.typebox;
	const { Text, Container, Spacer, Markdown, StringEnum } = pi.pi;

	// In-memory state (reconstructed from session on load)
	let findings: Finding[] = [];

	const reconstructState = (_event: CustomToolSessionEvent, ctx: CustomToolContext) => {
		findings = [];

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;

			if (msg.toolName === "report_finding") {
				const details = msg.details as FindingDetails | undefined;
				if (details?.findings) {
					findings = details.findings;
				}
			} else if (msg.toolName === "submit_review") {
				// After submit_review, findings are cleared for next review
				findings = [];
			}
		}
	};

	// report_finding tool
	const FindingParams = Type.Object({
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

	const reportFinding: CustomTool<typeof FindingParams, FindingDetails> = {
		name: "report_finding",
		label: "Report Finding",
		description:
			"Report a code review finding. Use this for each issue found. Call submit_review when done reviewing.",
		parameters: FindingParams,
		hidden: true,
		onSession: reconstructState,

		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const finding: Finding = {
				title: params.title,
				body: params.body,
				priority: params.priority,
				confidence: params.confidence,
				file_path: params.file_path,
				line_start: params.line_start,
				line_end: params.line_end,
			};
			findings.push(finding);

			return {
				content: [
					{
						type: "text",
						text: `Finding recorded: ${finding.title} (${findings.length} total)`,
					},
				],
				details: { finding, findings: [...findings] },
			};
		},

		renderCall(args, theme) {
			const priority = PRIORITY_LABELS[args.priority] ?? "P?";
			const color = args.priority === 0 ? "error" : args.priority === 1 ? "warning" : "muted";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("report_finding "))}${theme.fg(color, `[${priority}]`)} ${theme.fg("dim", args.title.replace(/^\[P\d\]\s*/, ""))}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const { details } = result;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const { finding } = details;
			const priority = PRIORITY_LABELS[finding.priority] ?? "P?";
			const color = finding.priority === 0 ? "error" : finding.priority === 1 ? "warning" : "muted";
			const location = `${finding.file_path}:${finding.line_start}${finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""}`;

			return new Text(
				`${theme.fg("success", "✓")} ${theme.fg(color, `[${priority}]`)} ${theme.fg("dim", location)}`,
				0,
				0,
			);
		},
	};

	// submit_review tool
	const SubmitParams = Type.Object({
		overall_correctness: StringEnum(["correct", "incorrect"] as const, {
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

	const submitReview: CustomTool<typeof SubmitParams, SubmitDetails> = {
		name: "submit_review",
		label: "Submit Review",
		description:
			"Submit the final review verdict. Call this after all findings have been reported. Summarizes all findings and provides overall assessment.",
		parameters: SubmitParams,
		hidden: true,
		onSession: reconstructState,

		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const result: SubmitDetails = {
				overall_correctness: params.overall_correctness as "correct" | "incorrect",
				explanation: params.explanation,
				confidence: params.confidence,
				findings: [...findings],
			};

			// Group findings by priority
			const byPriority = findings.reduce(
				(acc, f) => {
					acc[f.priority] = acc[f.priority] || [];
					acc[f.priority].push(f);
					return acc;
				},
				{} as Record<number, Finding[]>,
			);

			let summary = `## Review Summary\n\n`;
			summary += `**Verdict:** ${params.overall_correctness === "correct" ? "✓ Patch is correct" : "✗ Patch is incorrect"}\n`;
			summary += `**Confidence:** ${(params.confidence * 100).toFixed(0)}%\n\n`;
			summary += `${params.explanation}\n\n`;

			if (findings.length > 0) {
				summary += `### Findings (${findings.length})\n\n`;
				for (const priority of [0, 1, 2, 3]) {
					const group = byPriority[priority];
					if (!group || group.length === 0) continue;
					summary += `#### ${PRIORITY_LABELS[priority]} - ${PRIORITY_DESCRIPTIONS[priority]}\n\n`;
					for (const f of group) {
						const location = `${f.file_path}:${f.line_start}${f.line_end !== f.line_start ? `-${f.line_end}` : ""}`;
						summary += `- **${f.title}** (${location})\n  ${f.body}\n\n`;
					}
				}
			} else {
				summary += `No findings reported.\n`;
			}

			// Clear findings for next review
			const savedFindings = [...findings];
			findings = [];

			return {
				content: [{ type: "text", text: summary }],
				details: { ...result, findings: savedFindings },
			};
		},

		renderCall(args, theme) {
			const verdict = args.overall_correctness === "correct" ? "correct" : "incorrect";
			const color = args.overall_correctness === "correct" ? "success" : "error";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("submit_review "))}${theme.fg(color, verdict)} ${theme.fg("dim", `(${(args.confidence * 100).toFixed(0)}%)`)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
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

			if (details.findings.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("muted", `${details.findings.length} finding(s) reported`), 0, 0),
				);
			}

			if (expanded && details.findings.length > 0) {
				container.addChild(new Spacer(1));
				for (const f of details.findings) {
					const priority = PRIORITY_LABELS[f.priority] ?? "P?";
					const color = f.priority === 0 ? "error" : f.priority === 1 ? "warning" : "dim";
					const location = `${f.file_path}:${f.line_start}`;
					container.addChild(
						new Text(`  ${theme.fg(color, `[${priority}]`)} ${theme.fg("dim", location)}`, 0, 0),
					);
				}
			}

			return container;
		},
	};

	return [reportFinding, submitReview];
};

export default factory;
