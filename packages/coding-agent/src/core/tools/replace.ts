import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Subprocess } from "bun";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";

const replaceSchema = Type.Object({
	pattern: Type.String({ description: "Regex pattern to find" }),
	replacement: Type.String({ description: "Replacement string" }),
	path: Type.Optional(Type.String({ description: "File or directory path (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Glob pattern to filter files (e.g., '*.ts', '**/*.tsx')" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string, not regex (default: false)" })),
	dry_run: Type.Optional(Type.Boolean({ description: "Preview changes without applying them (default: true)" })),
	max_results: Type.Optional(Type.Number({ description: "Limit number of files shown in output (default: 50)" })),
});

export interface ReplaceToolDetails {
	filesChanged: number;
	filesFailed: number;
	preview: boolean;
	changed: string[];
	failed: Array<{ file: string; error: string }>;
	truncated?: boolean;
}

/** Helper to run a command and collect output */
async function runCommand(
	cmd: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; aborted: boolean }> {
	const child: Subprocess = Bun.spawn([cmd, ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let stdout = "";
	let stderr = "";
	let aborted = false;

	const onAbort = () => {
		aborted = true;
		child.kill();
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();

	try {
		await Promise.all([
			(async () => {
				while (true) {
					const { done, value } = await stdoutReader.read();
					if (done) break;
					stdout += decoder.decode(value, { stream: true });
				}
			})(),
			(async () => {
				while (true) {
					const { done, value } = await stderrReader.read();
					if (done) break;
					stderr += decoder.decode(value, { stream: true });
				}
			})(),
		]);
	} finally {
		stdoutReader.releaseLock();
		stderrReader.releaseLock();
	}

	const exitCode = await child.exited;

	if (signal) {
		signal.removeEventListener("abort", onAbort);
	}

	return { stdout, stderr, exitCode: exitCode ?? -1, aborted };
}

export function createReplaceTool(cwd: string): AgentTool<typeof replaceSchema> {
	return {
		name: "replace",
		label: "replace",
		description:
			"Find-and-replace across files using sd. Supports regex patterns and glob filtering. Use dry_run=false to apply changes.",
		parameters: replaceSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				replacement,
				path: targetPath,
				glob,
				literal,
				dry_run,
				max_results,
			}: {
				pattern: string;
				replacement: string;
				path?: string;
				glob?: string;
				literal?: boolean;
				dry_run?: boolean;
				max_results?: number;
			},
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const sdPath = await ensureTool("sd", true);
			if (!sdPath) {
				throw new Error("sd is not available and could not be downloaded");
			}

			const resolvedPath = targetPath ? resolveToCwd(targetPath, cwd) : cwd;
			const preview = dry_run ?? true;
			const maxResults = Math.max(1, max_results ?? 50);

			// Build base sd args
			const sdBaseArgs: string[] = [];
			if (preview) {
				sdBaseArgs.push("-p"); // preview mode
			}
			if (literal) {
				sdBaseArgs.push("-s"); // string literal mode
			}
			sdBaseArgs.push(pattern, replacement);

			const changed: string[] = [];
			const failed: Array<{ file: string; error: string }> = [];
			let changedCount = 0;
			let failedCount = 0;
			const outputParts: string[] = [];

			if (glob) {
				// Use fd to find files, then process each file individually for error recovery
				const fdPath = await ensureTool("fd", true);
				if (!fdPath) {
					throw new Error("fd is required for glob filtering but is not available");
				}

				// Get file list
				const fdResult = await runCommand(fdPath, ["-g", glob, ".", resolvedPath, "-a"], resolvedPath, signal);

				if (fdResult.aborted) {
					throw new Error("Operation aborted");
				}

				if (fdResult.exitCode !== 0) {
					throw new Error(fdResult.stderr.trim() || `fd exited with code ${fdResult.exitCode}`);
				}

				const files = fdResult.stdout
					.trim()
					.split("\n")
					.filter((f) => f.length > 0);

				if (files.length === 0) {
					return {
						content: [{ type: "text", text: "No files matched the glob pattern" }],
						details: { filesChanged: 0, filesFailed: 0, preview, changed: [], failed: [] },
					};
				}

				// Process each file
				for (const file of files) {
					if (signal?.aborted) {
						throw new Error("Operation aborted");
					}

					const sdArgs = [...sdBaseArgs, file];
					const result = await runCommand(sdPath, sdArgs, resolvedPath, signal);

					if (result.aborted) {
						throw new Error("Operation aborted");
					}

					const relPath = file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;

					if (result.exitCode !== 0) {
						const errorMsg = result.stderr.trim() || `sd exited with code ${result.exitCode}`;
						failedCount++;
						if (failed.length < maxResults) {
							failed.push({ file: relPath, error: errorMsg });
						}
					} else {
						const output = result.stdout.trim();
						if (output) {
							changedCount++;
							if (changed.length < maxResults) {
								changed.push(relPath);
							}
							if (outputParts.length < maxResults) {
								outputParts.push(output);
							}
						}
					}
				}
			} else {
				// Single path (file or directory) - run sd directly
				const sdArgs = [...sdBaseArgs, resolvedPath];
				const result = await runCommand(sdPath, sdArgs, resolvedPath, signal);

				if (result.aborted) {
					throw new Error("Operation aborted");
				}

				if (result.exitCode !== 0) {
					const errorMsg =
						result.stderr.trim() || result.stdout.trim() || `sd exited with code ${result.exitCode}`;
					throw new Error(errorMsg);
				}

				const output = result.stdout.trim();
				if (output) {
					outputParts.push(output);
					// Extract changed files from output (sd prefixes lines with file paths)
					const fileMatches = output.match(/^[^\s:]+:/gm);
					if (fileMatches) {
						const seen = new Set<string>();
						for (const match of fileMatches) {
							const file = match.slice(0, -1); // Remove trailing colon
							if (!seen.has(file)) {
								seen.add(file);
								changedCount++;
								if (changed.length < maxResults) {
									changed.push(file);
								}
							}
						}
					}
				}
			}

			const truncated = changedCount > maxResults || failedCount > maxResults;
			const details: ReplaceToolDetails = {
				filesChanged: changedCount,
				filesFailed: failedCount,
				preview,
				changed,
				failed,
				truncated,
			};

			// Build output text
			let outputText: string;
			if (changedCount === 0 && failedCount === 0) {
				outputText = preview ? "No changes would be made" : "No changes made";
			} else {
				const parts: string[] = [];

				if (changedCount > 0) {
					const verb = preview ? "would change" : "changed";
					parts.push(`${verb} ${changedCount} file${changedCount !== 1 ? "s" : ""}`);
				}

				if (failedCount > 0) {
					parts.push(`${failedCount} file${failedCount !== 1 ? "s" : ""} failed`);
				}

				outputText = parts.join(", ");

				if (outputParts.length > 0) {
					outputText += `\n\n${outputParts.join("\n\n")}`;
				}

				if (failedCount > 0) {
					outputText += "\n\nErrors:\n";
					for (const f of failed) {
						outputText += `  ${f.file}: ${f.error}\n`;
					}
				}
				if (truncated) {
					outputText += `\n... showing first ${maxResults} files`;
				}
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	};
}

/** Default replace tool using process.cwd() - for backwards compatibility */
export const replaceTool = createReplaceTool(process.cwd());
