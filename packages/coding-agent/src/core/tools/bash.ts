import { relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Theme } from "../../modes/interactive/theme/theme";
import bashDescription from "../../prompts/tools/bash.md" with { type: "text" };
import { executeBash } from "../bash-executor";
import type { RenderResultOptions } from "../custom-tools/types";
import { checkBashInterception, checkSimpleLsInterception } from "./bash-interceptor";
import type { ToolSession } from "./index";
import { createToolUIKit } from "./render-utils";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateTail } from "./truncate";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	workdir: Type.Optional(
		Type.String({ description: "Working directory for the command (default: current directory)" }),
	),
});

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export function createBashTool(session: ToolSession): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description: bashDescription,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout, workdir }: { command: string; timeout?: number; workdir?: string },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: AgentToolContext,
		) => {
			// Check interception if enabled and available tools are known
			if (session.settings?.getBashInterceptorEnabled()) {
				const rules = session.settings?.getBashInterceptorRules?.();
				const interception = checkBashInterception(command, ctx?.toolNames ?? [], rules);
				if (interception.block) {
					throw new Error(interception.message);
				}
				if (session.settings?.getBashInterceptorSimpleLsEnabled?.() !== false) {
					const lsInterception = checkSimpleLsInterception(command, ctx?.toolNames ?? []);
					if (lsInterception.block) {
						throw new Error(lsInterception.message);
					}
				}
			}

			// Track output for streaming updates
			let currentOutput = "";

			const result = await executeBash(command, {
				cwd: workdir ?? session.cwd,
				timeout: timeout ? timeout * 1000 : undefined, // Convert to milliseconds
				signal,
				onChunk: (chunk) => {
					currentOutput += chunk;
					if (onUpdate) {
						const truncation = truncateTail(currentOutput);
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
							},
						});
					}
				},
			});

			// Handle errors
			if (result.cancelled) {
				throw new Error(result.output || "Command aborted");
			}

			// Apply tail truncation for final output
			const truncation = truncateTail(result.output);
			let outputText = truncation.content || "(no output)";

			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: result.fullOutputPath,
				};

				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;

				if (truncation.lastLinePartial) {
					const lastLineSize = formatSize(Buffer.byteLength(result.output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${result.fullOutputPath}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${result.fullOutputPath}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${result.fullOutputPath}]`;
				}
			}

			if (result.exitCode !== 0 && result.exitCode !== undefined) {
				outputText += `\n\nCommand exited with code ${result.exitCode}`;
				throw new Error(outputText);
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface BashRenderArgs {
	command?: string;
	timeout?: number;
	workdir?: string;
}

interface BashRenderContext {
	/** Visual lines for truncated output (pre-computed by tool-execution) */
	visualLines?: string[];
	/** Number of lines skipped */
	skippedCount?: number;
	/** Total visual lines */
	totalVisualLines?: number;
}

export const bashToolRenderer = {
	renderCall(args: BashRenderArgs, uiTheme: Theme): Component {
		const ui = createToolUIKit(uiTheme);
		const command = args.command || uiTheme.format.ellipsis;
		const prompt = uiTheme.fg("accent", "$");
		const cwd = process.cwd();
		let displayWorkdir = args.workdir;

		if (displayWorkdir) {
			const resolvedCwd = resolve(cwd);
			const resolvedWorkdir = resolve(displayWorkdir);
			if (resolvedWorkdir === resolvedCwd) {
				displayWorkdir = undefined;
			} else {
				const relativePath = relative(resolvedCwd, resolvedWorkdir);
				const isWithinCwd = relativePath && !relativePath.startsWith("..") && !relativePath.startsWith(`..${sep}`);
				if (isWithinCwd) {
					displayWorkdir = relativePath;
				}
			}
		}

		const cmdText = displayWorkdir
			? `${prompt} ${uiTheme.fg("dim", `cd ${displayWorkdir} &&`)} ${command}`
			: `${prompt} ${command}`;
		const text = ui.title(cmdText);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: BashToolDetails;
		},
		options: RenderResultOptions & { renderContext?: BashRenderContext },
		uiTheme: Theme,
	): Component {
		const ui = createToolUIKit(uiTheme);
		const { expanded, renderContext } = options;
		const details = result.details;
		const lines: string[] = [];

		// Get output text
		const textContent = result.content?.find((c) => c.type === "text")?.text ?? "";
		const output = textContent.trim();

		if (output) {
			if (expanded) {
				// Show all lines when expanded
				const styledOutput = output
					.split("\n")
					.map((line) => uiTheme.fg("toolOutput", line))
					.join("\n");
				lines.push(styledOutput);
			} else if (renderContext?.visualLines) {
				// Use pre-computed visual lines from tool-execution
				const { visualLines, skippedCount = 0, totalVisualLines = visualLines.length } = renderContext;
				if (skippedCount > 0) {
					lines.push(
						uiTheme.fg(
							"dim",
							`${uiTheme.format.ellipsis} (${skippedCount} earlier lines, showing ${visualLines.length} of ${totalVisualLines}) (ctrl+o to expand)`,
						),
					);
				}
				lines.push(...visualLines);
			} else {
				// Fallback: show first few lines
				const outputLines = output.split("\n");
				const maxLines = 5;
				const displayLines = outputLines.slice(0, maxLines);
				const remaining = outputLines.length - maxLines;

				lines.push(...displayLines.map((line) => uiTheme.fg("toolOutput", line)));
				if (remaining > 0) {
					lines.push(uiTheme.fg("dim", `${uiTheme.format.ellipsis} (${remaining} more lines) (ctrl+o to expand)`));
				}
			}
		}

		// Truncation warnings
		const truncation = details?.truncation;
		const fullOutputPath = details?.fullOutputPath;
		if (truncation?.truncated || fullOutputPath) {
			const warnings: string[] = [];
			if (fullOutputPath) {
				warnings.push(`Full output: ${fullOutputPath}`);
			}
			if (truncation?.truncated) {
				if (truncation.truncatedBy === "lines") {
					warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
				} else {
					warnings.push(
						`Truncated: ${truncation.outputLines} lines shown (${ui.formatBytes(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
					);
				}
			}
			lines.push(uiTheme.fg("warning", ui.wrapBrackets(warnings.join(". "))));
		}

		return new Text(lines.join("\n"), 0, 0);
	},
};
