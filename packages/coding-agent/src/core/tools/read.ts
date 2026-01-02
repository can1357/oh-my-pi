import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "child_process";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { extname } from "path";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { resolveReadPath } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

// Document types convertible via markitdown
const CONVERTIBLE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".epub"]);

function convertWithMarkitdown(filePath: string): { content: string; ok: boolean; error?: string } {
	const cmd = Bun.which("markitdown");
	if (!cmd) {
		return { content: "", ok: false, error: "markitdown not found" };
	}

	const result = spawnSync(cmd, [filePath], {
		encoding: "utf-8",
		timeout: 60000,
		maxBuffer: 50 * 1024 * 1024,
	});

	if (result.status === 0 && result.stdout && result.stdout.length > 0) {
		return { content: result.stdout, ok: true };
	}

	return { content: "", ok: false, error: result.stderr || "Conversion failed" };
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export function createReadTool(cwd: string): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports:
- Text files (truncated to ${DEFAULT_MAX_LINES} lines or ${
			DEFAULT_MAX_BYTES / 1024
		}KB, use offset/limit for large files)
- Images (jpg, png, gif, webp) - sent as attachments
- Documents (pdf, docx, pptx, xlsx, epub, rtf) - converted to markdown via markitdown if available`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveReadPath(path, cwd);

			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
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

					// Perform the read operation
					(async () => {
						try {
							// Check if file exists
							await access(absolutePath, constants.R_OK);

							// Check if aborted before reading
							if (aborted) {
								return;
							}

							const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
							const ext = extname(absolutePath).toLowerCase();

							// Read the file based on type
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;

							if (mimeType) {
								// Read as image (binary)
								const buffer = await readFile(absolutePath);
								const base64 = buffer.toString("base64");

								content = [
									{ type: "text", text: `Read image file [${mimeType}]` },
									{ type: "image", data: base64, mimeType },
								];
							} else if (CONVERTIBLE_EXTENSIONS.has(ext)) {
								// Convert document via markitdown
								const result = convertWithMarkitdown(absolutePath);
								if (result.ok) {
									// Apply truncation to converted content
									const truncation = truncateHead(result.content);
									let outputText = truncation.content;

									if (truncation.truncated) {
										outputText += `\n\n[Document converted via markitdown. Output truncated to ${formatSize(
											DEFAULT_MAX_BYTES,
										)}]`;
										details = { truncation };
									}

									content = [{ type: "text", text: outputText }];
								} else {
									// markitdown not available or failed
									const errorMsg =
										result.error === "markitdown not found"
											? `markitdown not installed. Install with: pip install markitdown`
											: result.error || "conversion failed";
									content = [{ type: "text", text: `[Cannot read ${ext} file: ${errorMsg}]` }];
								}
							} else {
								// Read as text
								const textContent = await readFile(absolutePath, "utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;

								// Apply offset if specified (1-indexed to 0-indexed)
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1; // For display (1-indexed)

								// Check if offset is out of bounds
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}

								// If limit is specified by user, use it; otherwise we'll let truncateHead decide
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}

								// Apply truncation (respects both line and byte limits)
								const truncation = truncateHead(selectedContent);

								let outputText: string;

								if (truncation.firstLineExceedsLimit) {
									// First line at offset exceeds 30KB - tell model to use bash
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(
										DEFAULT_MAX_BYTES,
									)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred - build actionable notice
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;

									outputText = truncation.content;

									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(
											DEFAULT_MAX_BYTES,
										)} limit). Use offset=${nextOffset} to continue]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User specified limit, there's more content, but no truncation
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;

									outputText = truncation.content;
									outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
								} else {
									// No truncation, no user limit exceeded
									outputText = truncation.content;
								}

								content = [{ type: "text", text: outputText }];
							}

							// Check if aborted after reading
							if (aborted) {
								return;
							}

							// Clean up abort handler
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							resolve({ content, details });
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

/** Default read tool using process.cwd() - for backwards compatibility */
export const readTool = createReadTool(process.cwd());
