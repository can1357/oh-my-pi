import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Subprocess } from "bun";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const astSchema = Type.Object({
	action: Type.Union([Type.Literal("search"), Type.Literal("preview"), Type.Literal("apply")], {
		description: "Action: search (find matches), preview (show proposed changes), apply (make changes)",
	}),
	pattern: Type.String({ description: "AST pattern to match (e.g., 'console.log($$$)')" }),
	replacement: Type.Optional(Type.String({ description: "Replacement pattern (required for preview/apply)" })),
	path: Type.Optional(Type.String({ description: "File or directory path (default: current directory)" })),
	lang: Type.Optional(Type.String({ description: "Language (rust, typescript, python, etc.)" })),
	max_results: Type.Optional(Type.Number({ description: "Limit results (default: 100)" })),
});

export interface AstToolDetails {
	truncation?: TruncationResult;
	matchCount?: number;
	fileCount?: number;
	mode?: "search" | "preview" | "apply";
	files?: string[];
	truncated?: boolean;
	error?: string;
}

export function createAstTool(cwd: string): AgentTool<typeof astSchema> {
	return {
		name: "ast",
		label: "ast",
		description: `AST-level structural search/replace using ast-grep.

Actions:
- search: Find matches (read-only)
- preview: Show proposed changes without applying (read-only)
- apply: Make changes to files (destructive)

Safety workflow: search → preview → apply

Pattern syntax:
- $NAME for single node wildcards (e.g., $FUNC, $ARG)
- $$$ for multiple nodes (variadic match)
- Examples: 'console.log($$$)', 'fn($A, $B)'

Output truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		parameters: astSchema,
		execute: async (
			_toolCallId: string,
			{
				action,
				pattern,
				replacement,
				path: targetPath,
				lang,
				max_results,
			}: {
				action: "search" | "preview" | "apply";
				pattern: string;
				replacement?: string;
				path?: string;
				lang?: string;
				max_results?: number;
			},
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const sgPath = await ensureTool("sg", true);
			if (!sgPath) {
				throw new Error("ast-grep (sg) is not available and could not be downloaded");
			}

			if ((action === "preview" || action === "apply") && !replacement) {
				throw new Error(`replacement parameter is required for ${action} action`);
			}

			const resolvedPath = targetPath ? resolveToCwd(targetPath, cwd) : cwd;
			const maxResults = Math.max(1, max_results ?? 100);

			const args: string[] = [];

			// Add pattern
			args.push("-p", pattern);

			// Add action-specific flags
			if (action === "apply") {
				args.push("-r", replacement!, "--update-all", "--json");
			} else if (action === "preview") {
				// Preview: rewrite flag but no --update-all
				args.push("-r", replacement!, "--json");
			} else {
				// search action
				args.push("--json");
			}

			// Add language if specified
			if (lang) {
				args.push("--lang", lang);
			}

			// Add path
			args.push(resolvedPath);

			const child: Subprocess = Bun.spawn([sgPath, ...args], {
				cwd: resolvedPath,
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

			// Read streams using Bun's ReadableStream API
			const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();

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

			const exitCode = await child.exited;

			// Cleanup
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}

			if (aborted) {
				throw new Error("Operation aborted");
			}

			// Exit code 1 = no matches (not an error), 0 = matches found
			if (exitCode !== 0 && exitCode !== 1 && stderr.trim()) {
				const errorMsg = stderr.trim() || `ast-grep exited with code ${exitCode}`;
				return {
					content: [{ type: "text", text: `Error: ${errorMsg}` }],
					details: { mode: action, error: errorMsg } as AstToolDetails,
				};
			}

			const output = stdout.trim();

			// Parse JSON lines (each line is a JSON object)
			const lines = output.split("\n").filter(Boolean);
			const files = new Set<string>();
			const matches: Array<{ file: string; line: number; text: string; replacement?: string }> = [];
			let matchCount = 0;

			for (const line of lines) {
				try {
					const obj = JSON.parse(line);
					const filePath = obj.file || obj.path;
					if (filePath) {
						const relPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
						files.add(relPath);
						matchCount++;
						if (matches.length < maxResults) {
							matches.push({
								file: relPath,
								line: obj.range?.start?.line ?? obj.start?.line ?? 0,
								text: obj.text || obj.matched || "",
								replacement: obj.replacement,
							});
						}
					}
				} catch {
					// Skip malformed lines
				}
			}

			const truncated = matchCount > maxResults;
			const fileCount = files.size;
			const details: AstToolDetails = {
				mode: action,
				matchCount,
				fileCount,
				files: Array.from(files).slice(0, 50),
				truncated,
			};

			if (matchCount === 0) {
				const noMatchMsg = action === "apply" ? "No changes made" : "No matches found";
				return {
					content: [{ type: "text", text: noMatchMsg }],
					details,
				};
			}

			// Format output based on action
			let formattedOutput: string;
			if (action === "apply") {
				formattedOutput = `Applied ${matchCount} replacement${matchCount !== 1 ? "s" : ""} in ${fileCount} file${
					fileCount !== 1 ? "s" : ""
				}:\n`;
				formattedOutput += Array.from(files).join("\n");
			} else if (action === "preview") {
				formattedOutput = `Preview of ${matchCount} replacement${matchCount !== 1 ? "s" : ""} in ${fileCount} file${
					fileCount !== 1 ? "s" : ""
				}:\n\n`;
				for (const m of matches) {
					formattedOutput += `${m.file}:${m.line}\n`;
					formattedOutput += `  - ${m.text}\n`;
					if (m.replacement !== undefined) {
						formattedOutput += `  + ${m.replacement}\n`;
					}
					formattedOutput += "\n";
				}
			} else {
				// search mode
				formattedOutput = `Found ${matchCount} match${matchCount !== 1 ? "es" : ""} in ${fileCount} file${
					fileCount !== 1 ? "s" : ""
				}:\n\n`;
				for (const m of matches) {
					formattedOutput += `${m.file}:${m.line}: ${m.text}\n`;
				}
			}

			if (truncated) {
				formattedOutput += `\n... truncated at ${maxResults} results (${matchCount} total)`;
			}

			// Apply truncation
			const truncation = truncateHead(formattedOutput);
			let finalOutput = truncation.content || formattedOutput;

			if (truncation.truncated) {
				details.truncation = truncation;

				const startLine = 1;
				const endLine = truncation.outputLines;

				if (truncation.truncatedBy === "lines") {
					finalOutput += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}]`;
				} else {
					finalOutput += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(
						DEFAULT_MAX_BYTES,
					)} limit)]`;
				}
			}

			return {
				content: [{ type: "text", text: finalOutput }],
				details,
			};
		},
	};
}

/** Default ast tool using process.cwd() - for backwards compatibility */
export const astTool = createAstTool(process.cwd());
