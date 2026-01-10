import { relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate";
import type { Theme } from "../../modes/interactive/theme/theme";
import bashDescription from "../../prompts/tools/bash.md" with { type: "text" };
import { type BashExecutorOptions, executeBash, executeBashWithOperations } from "../bash-executor";
import type { RenderResultOptions } from "../custom-tools/types";
import { checkBashInterception, checkSimpleLsInterception } from "./bash-interceptor";
import type { ToolSession } from "./index";
import { resolveToCwd } from "./path-utils";
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

/**
 * Pluggable operations for bash execution.
 * Override to delegate command execution to remote systems.
 */
export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
}

export function createBashTool(session: ToolSession, options?: BashToolOptions): AgentTool<typeof bashSchema> {
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

			const commandCwd = workdir ? resolveToCwd(workdir, session.cwd) : session.cwd;
			let cwdStat: Awaited<ReturnType<Bun.BunFile["stat"]>>;
			try {
				cwdStat = await Bun.file(commandCwd).stat();
			} catch {
				throw new Error(`Working directory does not exist: ${commandCwd}`);
			}
			if (!cwdStat.isDirectory()) {
				throw new Error(`Working directory is not a directory: ${commandCwd}`);
			}

			// Track output for streaming updates
			let currentOutput = "";

			const executorOptions: BashExecutorOptions = {
				cwd: commandCwd,
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
			};

			// Use custom operations if provided, otherwise use default local executor
			const result = options?.operations
				? await executeBashWithOperations(command, commandCwd, options.operations, executorOptions)
				: await executeBash(command, executorOptions);

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
	/** Raw output text */
	output?: string;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
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
		const { renderContext } = options;
		const details = result.details;

		// Get output from context (preferred) or fall back to result content
		const output = renderContext?.output ?? (result.content?.find((c) => c.type === "text")?.text ?? "").trim();
		const expanded = renderContext?.expanded ?? options.expanded;
		const previewLines = renderContext?.previewLines ?? 5;

		// Build truncation warning lines (static, doesn't depend on width)
		const truncation = details?.truncation;
		const fullOutputPath = details?.fullOutputPath;
		let warningLine: string | undefined;
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
			warningLine = uiTheme.fg("warning", ui.wrapBrackets(warnings.join(". ")));
		}

		if (!output) {
			// No output - just show warning if any
			return new Text(warningLine ?? "", 0, 0);
		}

		if (expanded) {
			// Show all lines when expanded
			const styledOutput = output
				.split("\n")
				.map((line) => uiTheme.fg("toolOutput", line))
				.join("\n");
			const lines = warningLine ? [styledOutput, warningLine] : [styledOutput];
			return new Text(lines.join("\n"), 0, 0);
		}

		// Collapsed: use width-aware caching component
		const styledOutput = output
			.split("\n")
			.map((line) => uiTheme.fg("toolOutput", line))
			.join("\n");
		const textContent = `\n${styledOutput}`;

		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		let cachedSkipped: number | undefined;

		return {
			render: (width: number): string[] => {
				if (cachedLines === undefined || cachedWidth !== width) {
					const result = truncateToVisualLines(textContent, previewLines, width);
					cachedLines = result.visualLines;
					cachedSkipped = result.skippedCount;
					cachedWidth = width;
				}
				const outputLines: string[] = [];
				if (cachedSkipped && cachedSkipped > 0) {
					outputLines.push("");
					outputLines.push(
						uiTheme.fg(
							"dim",
							`${uiTheme.format.ellipsis} (${cachedSkipped} earlier lines, showing ${cachedLines.length} of ${cachedSkipped + cachedLines.length}) (ctrl+o to expand)`,
						),
					);
				}
				outputLines.push(...cachedLines);
				if (warningLine) {
					outputLines.push(warningLine);
				}
				return outputLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
				cachedSkipped = undefined;
			},
		};
	},
};
