import { existsSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { globSync } from "glob";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files (default: false)" })),
	sortByMtime: Type.Optional(
		Type.Boolean({ description: "Sort results by modification time, most recent first (default: false)" }),
	),
	type: Type.Optional(
		Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("all")], {
			description:
				"Filter by type: 'file' for files only, 'dir' for directories only, 'all' for both (default: 'all')",
		}),
	),
});

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	// Fields for TUI rendering
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
}

export function createFindTool(cwd: string): AgentTool<typeof findSchema> {
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${
			DEFAULT_MAX_BYTES / 1024
		}KB (whichever is hit first).`,
		parameters: findSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path: searchDir,
				limit,
				hidden,
				sortByMtime,
				type,
			}: {
				pattern: string;
				path?: string;
				limit?: number;
				hidden?: boolean;
				sortByMtime?: boolean;
				type?: "file" | "dir" | "all";
			},
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						// Ensure fd is available
						const fdPath = await ensureTool("fd", true);
						if (!fdPath) {
							reject(new Error("fd is not available and could not be downloaded"));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const effectiveType = type ?? "all";
						const includeHidden = hidden ?? false;
						const shouldSortByMtime = sortByMtime ?? false;

						// Build fd arguments
						const args: string[] = [
							"--glob", // Use glob pattern
							"--color=never", // No ANSI colors
							"--max-results",
							String(effectiveLimit),
						];

						if (includeHidden) {
							args.push("--hidden");
						}

						// Add type filter
						if (effectiveType === "file") {
							args.push("--type", "f");
						} else if (effectiveType === "dir") {
							args.push("--type", "d");
						}

						// Include .gitignore files (root + nested) so fd respects them even outside git repos
						const gitignoreFiles = new Set<string>();
						const rootGitignore = path.join(searchPath, ".gitignore");
						if (existsSync(rootGitignore)) {
							gitignoreFiles.add(rootGitignore);
						}

						try {
							const nestedGitignores = globSync("**/.gitignore", {
								cwd: searchPath,
								dot: true,
								absolute: true,
								ignore: ["**/node_modules/**", "**/.git/**"],
							});
							for (const file of nestedGitignores) {
								gitignoreFiles.add(file);
							}
						} catch {
							// Ignore glob errors
						}

						for (const gitignorePath of gitignoreFiles) {
							args.push("--ignore-file", gitignorePath);
						}

						// Pattern and path
						args.push(pattern, searchPath);

						// Run fd
						const result = Bun.spawnSync([fdPath, ...args], {
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
						});

						signal?.removeEventListener("abort", onAbort);

						const output = result.stdout.toString().trim();

						if (result.exitCode !== 0) {
							const errorMsg = result.stderr.toString().trim() || `fd exited with code ${result.exitCode}`;
							// fd returns non-zero for some errors but may still have partial output
							if (!output) {
								reject(new Error(errorMsg));
								return;
							}
						}

						if (!output) {
							resolve({
								content: [{ type: "text", text: "No files found matching pattern" }],
								details: { fileCount: 0, files: [], truncated: false },
							});
							return;
						}

						const lines = output.split("\n");
						const relativized: string[] = [];
						const mtimes: number[] = [];

						for (const rawLine of lines) {
							const line = rawLine.replace(/\r$/, "").trim();
							if (!line) {
								continue;
							}

							const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
							let relativePath = line;
							if (line.startsWith(searchPath)) {
								relativePath = line.slice(searchPath.length + 1); // +1 for the /
							} else {
								relativePath = path.relative(searchPath, line);
							}

							if (hadTrailingSlash && !relativePath.endsWith("/")) {
								relativePath += "/";
							}

							relativized.push(relativePath);

							// Collect mtime if sorting is requested
							if (shouldSortByMtime) {
								try {
									const fullPath = path.join(searchPath, relativePath);
									const stat: Stats = statSync(fullPath);
									mtimes.push(stat.mtimeMs);
								} catch {
									mtimes.push(0);
								}
							}
						}

						// Sort by mtime if requested (most recent first)
						if (shouldSortByMtime && relativized.length > 0) {
							const indexed = relativized.map((path, idx) => ({ path, mtime: mtimes[idx] || 0 }));
							indexed.sort((a, b) => b.mtime - a.mtime);
							relativized.length = 0;
							relativized.push(...indexed.map((item) => item.path));
						}

						// Check if we hit the result limit
						const resultLimitReached = relativized.length >= effectiveLimit;

						// Apply byte truncation (no line limit since we already have result limit)
						const rawOutput = relativized.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

						let resultOutput = truncation.content;
						const details: FindToolDetails = {
							fileCount: relativized.length,
							files: relativized.slice(0, 50),
							truncated: resultLimitReached || truncation.truncated,
						};

						// Build notices
						const notices: string[] = [];

						if (resultLimitReached) {
							notices.push(
								`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
							);
							details.resultLimitReached = effectiveLimit;
						}

						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}

						if (notices.length > 0) {
							resultOutput += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: resultOutput }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
	};
}

/** Default find tool using process.cwd() - for backwards compatibility */
export const findTool = createFindTool(process.cwd());
