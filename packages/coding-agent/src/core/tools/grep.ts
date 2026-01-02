import { readFileSync, type Stats, statSync } from "node:fs";
import nodePath from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Subprocess } from "bun";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

export function createGrepTool(cwd: string): AgentTool<typeof grepSchema> {
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const rgPath = await ensureTool("rg", true);
			if (!rgPath) {
				throw new Error("ripgrep (rg) is not available and could not be downloaded");
			}

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			let searchStat: Stats;
			try {
				searchStat = statSync(searchPath);
			} catch (_err) {
				throw new Error(`Path not found: ${searchPath}`);
			}

			const isDirectory = searchStat.isDirectory();
			const contextValue = context && context > 0 ? context : 0;
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

			const formatPath = (filePath: string): string => {
				if (isDirectory) {
					const relative = nodePath.relative(searchPath, filePath);
					if (relative && !relative.startsWith("..")) {
						return relative.replace(/\\/g, "/");
					}
				}
				return nodePath.basename(filePath);
			};

			const fileCache = new Map<string, string[]>();
			const getFileLines = (filePath: string): string[] => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					try {
						const content = readFileSync(filePath, "utf-8");
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];

			if (ignoreCase) {
				args.push("--ignore-case");
			}

			if (literal) {
				args.push("--fixed-strings");
			}

			if (glob) {
				args.push("--glob", glob);
			}

			args.push(pattern, searchPath);

			const child: Subprocess = Bun.spawn([rgPath, ...args], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			let stderr = "";
			let matchCount = 0;
			let matchLimitReached = false;
			let linesTruncated = false;
			let aborted = false;
			let killedDueToLimit = false;
			const outputLines: string[] = [];

			const stopChild = (dueToLimit: boolean = false) => {
				killedDueToLimit = dueToLimit;
				child.kill();
			};

			const onAbort = () => {
				aborted = true;
				stopChild();
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			const formatBlock = (filePath: string, lineNumber: number): string[] => {
				const relativePath = formatPath(filePath);
				const lines = getFileLines(filePath);
				if (!lines.length) {
					return [`${relativePath}:${lineNumber}: (unable to read file)`];
				}

				const block: string[] = [];
				const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
				const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;

				for (let current = start; current <= end; current++) {
					const lineText = lines[current - 1] ?? "";
					const sanitized = lineText.replace(/\r/g, "");
					const isMatchLine = current === lineNumber;

					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) {
						linesTruncated = true;
					}

					if (isMatchLine) {
						block.push(`${relativePath}:${current}: ${truncatedText}`);
					} else {
						block.push(`${relativePath}-${current}- ${truncatedText}`);
					}
				}

				return block;
			};

			const processLine = (line: string) => {
				if (!line.trim() || matchCount >= effectiveLimit) {
					return;
				}

				let event: { type: string; data?: { path?: { text?: string }; line_number?: number } };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "match") {
					matchCount++;
					const filePath = event.data?.path?.text;
					const lineNumber = event.data?.line_number;

					if (filePath && typeof lineNumber === "number") {
						outputLines.push(...formatBlock(filePath, lineNumber));
					}

					if (matchCount >= effectiveLimit) {
						matchLimitReached = true;
						stopChild(true);
					}
				}
			};

			// Read streams using Bun's ReadableStream API
			const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let stdoutBuffer = "";

			await Promise.all([
				// Process stdout line by line
				(async () => {
					while (true) {
						const { done, value } = await stdoutReader.read();
						if (done) break;

						stdoutBuffer += decoder.decode(value, { stream: true });
						const lines = stdoutBuffer.split("\n");
						// Keep the last incomplete line in the buffer
						stdoutBuffer = lines.pop() ?? "";

						for (const line of lines) {
							processLine(line);
						}
					}
					// Process any remaining content
					if (stdoutBuffer.trim()) {
						processLine(stdoutBuffer);
					}
				})(),
				// Collect stderr
				(async () => {
					while (true) {
						const { done, value } = await stderrReader.read();
						if (done) break;
						stderr += decoder.decode(value, { stream: true });
					}
				})(),
			]);

			const exitCode = await child.exited;

			// Cleanup
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}

			if (aborted) {
				throw new Error("Operation aborted");
			}

			if (!killedDueToLimit && exitCode !== 0 && exitCode !== 1) {
				const errorMsg = stderr.trim() || `ripgrep exited with code ${exitCode}`;
				throw new Error(errorMsg);
			}

			if (matchCount === 0) {
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			}

			// Apply byte truncation (no line limit since we already have match limit)
			const rawOutput = outputLines.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

			let output = truncation.content;
			const details: GrepToolDetails = {};

			// Build notices
			const notices: string[] = [];

			if (matchLimitReached) {
				notices.push(
					`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
				details.matchLimitReached = effectiveLimit;
			}

			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}

			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}

			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

/** Default grep tool using process.cwd() - for backwards compatibility */
export const grepTool = createGrepTool(process.cwd());
