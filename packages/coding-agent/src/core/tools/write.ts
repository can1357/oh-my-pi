import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import type { FileDiagnosticsResult, FileFormatResult } from "./lsp/index.js";
import { resolveToCwd } from "./path-utils.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/** Options for creating the write tool */
export interface WriteToolOptions {
	/** Callback to format file using LSP after writing */
	formatOnWrite?: (absolutePath: string) => Promise<FileFormatResult>;
	/** Callback to get LSP diagnostics after writing a file */
	getDiagnostics?: (absolutePath: string) => Promise<FileDiagnosticsResult>;
}

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	/** Whether the file was formatted */
	wasFormatted: boolean;
	/** Format result (if available) */
	formatResult?: FileFormatResult;
	/** Whether LSP diagnostics were retrieved */
	hasDiagnostics: boolean;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
}

export function createWriteTool(
	cwd: string,
	options: WriteToolOptions = {},
): AgentTool<typeof writeSchema, WriteToolDetails> {
	return {
		name: "write",
		label: "Write",
		description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`,
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);

			return new Promise<{ content: Array<{ type: "text"; text: string }>; details: WriteToolDetails }>(
				(resolve, reject) => {
					// Check if already aborted
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}

					let aborted = false;

					// Set up abort handler
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};

					if (signal) {
						signal.addEventListener("abort", onAbort, { once: true });
					}

					// Perform the write operation
					(async () => {
						try {
							// Create parent directories if needed
							await mkdir(dir, { recursive: true });

							// Check if aborted before writing
							if (aborted) {
								return;
							}

							// Write the file
							await writeFile(absolutePath, content, "utf-8");

							// Check if aborted after writing
							if (aborted) {
								return;
							}

							// Clean up abort handler
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							// Format file if callback provided (before diagnostics)
							let formatResult: FileFormatResult | undefined;
							if (options.formatOnWrite) {
								try {
									formatResult = await options.formatOnWrite(absolutePath);
								} catch {
									// Ignore formatting errors - don't fail the write
								}
							}

							// Get LSP diagnostics if callback provided (after formatting)
							let diagnosticsResult: FileDiagnosticsResult | undefined;
							if (options.getDiagnostics) {
								try {
									diagnosticsResult = await options.getDiagnostics(absolutePath);
								} catch {
									// Ignore diagnostics errors - don't fail the write
								}
							}

							// Build result text
							let resultText = `Successfully wrote ${content.length} bytes to ${path}`;

							// Note if file was formatted
							if (formatResult?.formatted) {
								resultText += ` (formatted by ${formatResult.serverName})`;
							}

							// Append diagnostics if available and there are issues
							if (diagnosticsResult?.available && diagnosticsResult.diagnostics.length > 0) {
								resultText += `\n\nLSP Diagnostics (${diagnosticsResult.summary}):\n`;
								resultText += diagnosticsResult.diagnostics.map((d) => `  ${d}`).join("\n");
							}

							resolve({
								content: [{ type: "text", text: resultText }],
								details: {
									wasFormatted: formatResult?.formatted ?? false,
									formatResult,
									hasDiagnostics: diagnosticsResult?.available ?? false,
									diagnostics: diagnosticsResult,
								},
							});
						} catch (error: any) {
							// Clean up abort handler
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							if (!aborted) {
								reject(error);
							}
						}
					})();
				},
			);
		},
	};
}

/** Default write tool using process.cwd() - for backwards compatibility */
export const writeTool = createWriteTool(process.cwd());
