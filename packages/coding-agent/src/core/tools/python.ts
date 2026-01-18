import { relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate";
import type { Theme } from "../../modes/interactive/theme/theme";
import pythonDescription from "../../prompts/tools/python.md" with { type: "text" };
import type { RenderResultOptions } from "../custom-tools/types";
import { renderPromptTemplate } from "../prompt-templates";
import { executePython, getPreludeDocs, type PythonExecutorOptions } from "../python-executor";
import type { PreludeHelper } from "../python-kernel";
import type { ToolSession } from "./index";
import { resolveToCwd } from "./path-utils";
import { createToolUIKit, getTreeBranch, getTreeContinuePrefix } from "./render-utils";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateTail } from "./truncate";

export const PYTHON_DEFAULT_PREVIEW_LINES = 10;

type PreludeCategory = {
	name: string;
	functions: PreludeHelper[];
};

function groupPreludeHelpers(helpers: PreludeHelper[]): PreludeCategory[] {
	const categories: PreludeCategory[] = [];
	const byName = new Map<string, PreludeHelper[]>();
	for (const helper of helpers) {
		let bucket = byName.get(helper.category);
		if (!bucket) {
			bucket = [];
			byName.set(helper.category, bucket);
			categories.push({ name: helper.category, functions: bucket });
		}
		bucket.push(helper);
	}
	return categories;
}

export const pythonSchema = Type.Object({
	code: Type.String({ description: "Python code to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	workdir: Type.Optional(
		Type.String({ description: "Working directory for the command (default: current directory)" }),
	),
	reset: Type.Optional(Type.Boolean({ description: "Restart the kernel before executing this code" })),
});

export type PythonToolParams = { code: string; timeout?: number; workdir?: string; reset?: boolean };

export type PythonToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: PythonToolDetails | undefined;
};

export type PythonProxyExecutor = (params: PythonToolParams, signal?: AbortSignal) => Promise<PythonToolResult>;

export interface PythonToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	fullOutput?: string;
	jsonOutputs?: unknown[];
	images?: ImageContent[];
}

function formatJsonScalar(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (typeof value === "function") return "[function]";
	return "[object]";
}

function renderJsonTree(value: unknown, theme: Theme, expanded: boolean, maxDepth = expanded ? 6 : 2): string[] {
	const maxItems = expanded ? 20 : 5;

	const renderNode = (node: unknown, prefix: string, depth: number, isLast: boolean, label?: string): string[] => {
		const branch = getTreeBranch(isLast, theme);
		const displayLabel = label ? `${label}: ` : "";

		if (depth >= maxDepth || node === null || typeof node !== "object") {
			return [`${prefix}${branch} ${displayLabel}${formatJsonScalar(node)}`];
		}

		const isArray = Array.isArray(node);
		const entries = isArray
			? node.map((val, index) => [String(index), val] as const)
			: Object.entries(node as object);
		const header = `${prefix}${branch} ${displayLabel}${isArray ? `Array(${entries.length})` : `Object(${entries.length})`}`;
		const lines = [header];

		const childPrefix = prefix + getTreeContinuePrefix(isLast, theme);
		const visible = entries.slice(0, maxItems);
		for (let i = 0; i < visible.length; i++) {
			const [key, val] = visible[i];
			const childLast = i === visible.length - 1 && (expanded || entries.length <= maxItems);
			lines.push(...renderNode(val, childPrefix, depth + 1, childLast, isArray ? `[${key}]` : key));
		}
		if (!expanded && entries.length > maxItems) {
			const moreBranch = theme.tree.last;
			lines.push(`${childPrefix}${moreBranch} ${entries.length - maxItems} more item(s)`);
		}
		return lines;
	};

	return renderNode(value, "", 0, true);
}

export function getPythonToolDescription(): string {
	const helpers = getPreludeDocs();
	const categories = groupPreludeHelpers(helpers);
	return renderPromptTemplate(pythonDescription, { categories });
}

interface CreatePythonToolOptions {
	proxyExecutor?: PythonProxyExecutor;
}

export function createPythonTool(
	session: ToolSession | null,
	options?: CreatePythonToolOptions,
): AgentTool<typeof pythonSchema> {
	const { proxyExecutor } = options ?? {};

	return {
		name: "python",
		label: "Python",
		description: getPythonToolDescription(),
		parameters: pythonSchema,
		execute: async (
			_toolCallId: string,
			params: PythonToolParams,
			signal?: AbortSignal,
			onUpdate?,
			_ctx?: AgentToolContext,
		) => {
			if (proxyExecutor) {
				return proxyExecutor(params, signal);
			}

			if (!session) {
				throw new Error("Python tool requires a session when not using proxy executor");
			}

			const { code, timeout, workdir, reset } = params;
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				if (signal?.aborted) {
					throw new Error("Aborted");
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

				const maxTailBytes = DEFAULT_MAX_BYTES * 2;
				const tailChunks: Array<{ text: string; bytes: number }> = [];
				let tailBytes = 0;
				const jsonOutputs: unknown[] = [];
				const images: ImageContent[] = [];

				const executorOptions: PythonExecutorOptions = {
					cwd: commandCwd,
					timeout: timeout ? timeout * 1000 : undefined,
					signal: controller.signal,
					sessionId: session.getSessionFile?.() ?? `cwd:${session.cwd}`,
					kernelMode: session.settings?.getPythonKernelMode?.() ?? "session",
					reset,
					onChunk: (chunk) => {
						const chunkBytes = Buffer.byteLength(chunk, "utf-8");
						tailChunks.push({ text: chunk, bytes: chunkBytes });
						tailBytes += chunkBytes;
						while (tailBytes > maxTailBytes && tailChunks.length > 1) {
							const removed = tailChunks.shift();
							if (removed) {
								tailBytes -= removed.bytes;
							}
						}
						if (onUpdate) {
							const tailText = tailChunks.map((entry) => entry.text).join("");
							const truncation = truncateTail(tailText);
							onUpdate({
								content: [{ type: "text", text: truncation.content || "" }],
								details: truncation.truncated ? { truncation } : undefined,
							});
						}
					},
				};

				const result = await executePython(code, executorOptions);

				for (const output of result.displayOutputs) {
					if (output.type === "json") {
						jsonOutputs.push(output.data);
					}
					if (output.type === "image") {
						images.push({ type: "image", data: output.data, mimeType: output.mimeType });
					}
				}

				if (result.cancelled) {
					throw new Error(result.output || "Command aborted");
				}

				const truncation = truncateTail(result.output);
				let outputText =
					truncation.content || (jsonOutputs.length > 0 || images.length > 0 ? "(no text output)" : "(no output)");
				let details: PythonToolDetails | undefined;

				if (truncation.truncated) {
					const fullOutputSuffix = result.fullOutputPath ? ` Full output: ${result.fullOutputPath}` : "";
					details = {
						truncation,
						fullOutputPath: result.fullOutputPath,
						jsonOutputs: jsonOutputs,
						images,
					};

					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;

					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(Buffer.byteLength(result.output.split("\n").pop() || "", "utf-8"));
						outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize})${fullOutputSuffix}]`;
					} else if (truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${fullOutputSuffix}]`;
					} else {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit)${fullOutputSuffix}]`;
					}
				}

				if (!details && (jsonOutputs.length > 0 || images.length > 0)) {
					details = { jsonOutputs: jsonOutputs, images };
				}

				if (result.exitCode !== 0 && result.exitCode !== undefined) {
					outputText += `\n\nCommand exited with code ${result.exitCode}`;
					throw new Error(outputText);
				}

				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

interface PythonRenderArgs {
	code?: string;
	timeout?: number;
	workdir?: string;
}

interface PythonRenderContext {
	output?: string;
	expanded?: boolean;
	previewLines?: number;
	timeout?: number;
}

export const pythonToolRenderer = {
	renderCall(args: PythonRenderArgs, uiTheme: Theme): Component {
		const ui = createToolUIKit(uiTheme);
		const code = args.code || uiTheme.format.ellipsis;
		const prompt = uiTheme.fg("accent", ">>>");
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
			? `${prompt} ${uiTheme.fg("dim", `cd ${displayWorkdir} &&`)} ${code}`
			: `${prompt} ${code}`;
		const text = ui.title(cmdText);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: PythonToolDetails },
		options: RenderResultOptions & { renderContext?: PythonRenderContext },
		uiTheme: Theme,
	): Component {
		const ui = createToolUIKit(uiTheme);
		const { renderContext } = options;
		const details = result.details;

		const expanded = renderContext?.expanded ?? options.expanded;
		const previewLines = renderContext?.previewLines ?? PYTHON_DEFAULT_PREVIEW_LINES;
		const output = renderContext?.output ?? (result.content?.find((c) => c.type === "text")?.text ?? "").trim();
		const fullOutput = details?.fullOutput;
		const displayOutput = expanded ? (fullOutput ?? output) : output;
		const showingFullOutput = expanded && fullOutput !== undefined;

		const jsonOutputs = details?.jsonOutputs ?? [];
		const jsonLines = jsonOutputs.flatMap((value, index) => {
			const header = `JSON output ${index + 1}`;
			const treeLines = renderJsonTree(value, uiTheme, expanded);
			return [header, ...treeLines];
		});
		const combinedOutput = [displayOutput, ...jsonLines].filter(Boolean).join("\n");

		const truncation = details?.truncation;
		const fullOutputPath = details?.fullOutputPath;
		const timeoutSeconds = renderContext?.timeout;
		const timeoutLine =
			typeof timeoutSeconds === "number"
				? uiTheme.fg("dim", ui.wrapBrackets(`Timeout: ${timeoutSeconds}s`))
				: undefined;
		let warningLine: string | undefined;
		if (fullOutputPath || (truncation?.truncated && !showingFullOutput)) {
			const warnings: string[] = [];
			if (fullOutputPath) {
				warnings.push(`Full output: ${fullOutputPath}`);
			}
			if (truncation?.truncated && !showingFullOutput) {
				if (truncation.truncatedBy === "lines") {
					warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
				} else {
					warnings.push(
						`Truncated: ${truncation.outputLines} lines shown (${ui.formatBytes(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
					);
				}
			}
			if (warnings.length > 0) {
				warningLine = uiTheme.fg("warning", ui.wrapBrackets(warnings.join(". ")));
			}
		}

		if (!combinedOutput) {
			const lines = [timeoutLine, warningLine].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (expanded) {
			const styledOutput = combinedOutput
				.split("\n")
				.map((line) => uiTheme.fg("toolOutput", line))
				.join("\n");
			const lines = [styledOutput, timeoutLine, warningLine].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		const styledOutput = combinedOutput
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
					const skippedLine = uiTheme.fg(
						"dim",
						`${uiTheme.format.ellipsis} (${cachedSkipped} earlier lines, showing ${cachedLines.length} of ${cachedSkipped + cachedLines.length}) (ctrl+o to expand)`,
					);
					outputLines.push(truncateToWidth(skippedLine, width, uiTheme.fg("dim", uiTheme.format.ellipsis)));
				}
				outputLines.push(...cachedLines);
				if (timeoutLine) {
					outputLines.push(truncateToWidth(timeoutLine, width, uiTheme.fg("dim", uiTheme.format.ellipsis)));
				}
				if (warningLine) {
					outputLines.push(truncateToWidth(warningLine, width, uiTheme.fg("warning", uiTheme.format.ellipsis)));
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
