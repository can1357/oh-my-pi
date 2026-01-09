import { homedir } from "node:os";
import path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import { CONFIG_DIR_NAME } from "../../config";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme";
import readDescription from "../../prompts/tools/read.md" with { type: "text" };
import { formatDimensionNote, resizeImage } from "../../utils/image-resize";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime";
import { ensureTool } from "../../utils/tools-manager";
import type { RenderResultOptions } from "../custom-tools/types";
import type { ToolSession } from "../sdk";
import { ScopeSignal, untilAborted } from "../utils";
import { createLsTool } from "./ls";
import { resolveReadPath, resolveToCwd } from "./path-utils";
import { replaceTabs, shortenPath, wrapBrackets } from "./render-utils";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	truncateStringToBytesFromStart,
} from "./truncate";

// Document types convertible via markitdown
const CONVERTIBLE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".epub"]);

// Remote mount path prefix (sshfs mounts) - skip fuzzy matching to avoid hangs
const REMOTE_MOUNT_PREFIX = path.join(homedir(), CONFIG_DIR_NAME, "remote") + path.sep;

function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(REMOTE_MOUNT_PREFIX);
}

// Maximum image file size (20MB) - larger images will be rejected to prevent OOM during serialization
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_FUZZY_RESULTS = 5;
const MAX_FUZZY_CANDIDATES = 20000;
const MIN_BASE_SIMILARITY = 0.5;
const MIN_FULL_SIMILARITY = 0.6;

function normalizePathForMatch(value: string): string {
	return value
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: string }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function isPathWithin(basePath: string, targetPath: string): boolean {
	const relativePath = path.relative(basePath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function findExistingDirectory(startDir: string, signal?: AbortSignal): Promise<string | null> {
	let current = startDir;
	const root = path.parse(startDir).root;

	while (true) {
		signal?.throwIfAborted();
		try {
			const stat = await Bun.file(current).stat();
			if (stat.isDirectory()) {
				return current;
			}
		} catch {
			// Keep walking up.
		}

		if (current === root) {
			break;
		}
		current = path.dirname(current);
	}

	return null;
}

function formatScopeLabel(searchRoot: string, cwd: string): string {
	const relative = path.relative(cwd, searchRoot).replace(/\\/g, "/");
	if (relative === "" || relative === ".") {
		return ".";
	}
	if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
		return relative;
	}
	return searchRoot;
}

function buildDisplayPath(searchRoot: string, cwd: string, relativePath: string): string {
	const scopeLabel = formatScopeLabel(searchRoot, cwd);
	const normalized = relativePath.replace(/\\/g, "/");
	if (scopeLabel === ".") {
		return normalized;
	}
	if (scopeLabel.startsWith("..") || path.isAbsolute(scopeLabel)) {
		return path.join(searchRoot, normalized).replace(/\\/g, "/");
	}
	return `${scopeLabel}/${normalized}`;
}

function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1;
			const insertion = curr[j - 1] + 1;
			const substitution = prev[j - 1] + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

function similarityScore(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) {
		return 1;
	}
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) {
		return 1;
	}
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLen;
}

async function captureCommandOutput(
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; aborted: boolean }> {
	const child = Bun.spawn([command, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	using scope = new ScopeSignal(signal ? { signal } : undefined);
	scope.catch(() => {
		child.kill();
	});

	const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader();
	const stdoutDecoder = new TextDecoder();
	const stderrDecoder = new TextDecoder();
	let stdout = "";
	let stderr = "";

	await Promise.all([
		(async () => {
			while (true) {
				const { done, value } = await stdoutReader.read();
				if (done) break;
				stdout += stdoutDecoder.decode(value, { stream: true });
			}
			stdout += stdoutDecoder.decode();
		})(),
		(async () => {
			while (true) {
				const { done, value } = await stderrReader.read();
				if (done) break;
				stderr += stderrDecoder.decode(value, { stream: true });
			}
			stderr += stderrDecoder.decode();
		})(),
	]);

	const exitCode = await child.exited;

	return { stdout, stderr, exitCode, aborted: scope.aborted };
}

async function listCandidateFiles(
	searchRoot: string,
	signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean; error?: string }> {
	let fdPath: string | undefined;
	try {
		fdPath = await ensureTool("fd", true);
	} catch {
		return { files: [], truncated: false, error: "fd not available" };
	}

	if (!fdPath) {
		return { files: [], truncated: false, error: "fd not available" };
	}

	const args: string[] = ["--type", "f", "--color=never", "--hidden", "--max-results", String(MAX_FUZZY_CANDIDATES)];

	const gitignoreFiles = new Set<string>();
	const rootGitignore = path.join(searchRoot, ".gitignore");
	if (await Bun.file(rootGitignore).exists()) {
		gitignoreFiles.add(rootGitignore);
	}

	try {
		const gitignoreArgs = [
			"--type",
			"f",
			"--color=never",
			"--hidden",
			"--absolute-path",
			"--glob",
			".gitignore",
			"--exclude",
			"node_modules",
			"--exclude",
			".git",
			searchRoot,
		];
		const { stdout, aborted } = await captureCommandOutput(fdPath, gitignoreArgs, signal);
		if (aborted) {
			throw new Error("Operation aborted");
		}
		const output = stdout.trim();
		if (output) {
			const nestedGitignores = output
				.split("\n")
				.map((line) => line.replace(/\r$/, "").trim())
				.filter((line) => line.length > 0);
			for (const file of nestedGitignores) {
				const normalized = file.replace(/\\/g, "/");
				if (normalized.includes("/node_modules/") || normalized.includes("/.git/")) {
					continue;
				}
				gitignoreFiles.add(file);
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message === "Operation aborted") {
			throw error;
		}
		// Ignore gitignore scan errors.
	}

	for (const gitignorePath of gitignoreFiles) {
		args.push("--ignore-file", gitignorePath);
	}

	args.push(".", searchRoot);

	const { stdout, stderr, exitCode, aborted } = await captureCommandOutput(fdPath, args, signal);

	if (aborted) {
		throw new Error("Operation aborted");
	}

	const output = stdout.trim();

	if (exitCode !== 0 && !output) {
		const errorMsg = stderr.trim() || `fd exited with code ${exitCode ?? -1}`;
		return { files: [], truncated: false, error: errorMsg };
	}

	if (!output) {
		return { files: [], truncated: false };
	}

	const files = output
		.split("\n")
		.map((line) => line.replace(/\r$/, "").trim())
		.filter((line) => line.length > 0);

	return { files, truncated: files.length >= MAX_FUZZY_CANDIDATES };
}

async function findReadPathSuggestions(
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ suggestions: string[]; scopeLabel?: string; truncated?: boolean; error?: string } | null> {
	const resolvedPath = resolveToCwd(rawPath, cwd);
	const searchRoot = await findExistingDirectory(path.dirname(resolvedPath), signal);
	if (!searchRoot) {
		return null;
	}

	if (!isPathWithin(cwd, resolvedPath)) {
		const root = path.parse(searchRoot).root;
		if (searchRoot === root) {
			return null;
		}
	}

	const { files, truncated, error } = await listCandidateFiles(searchRoot, signal);
	const scopeLabel = formatScopeLabel(searchRoot, cwd);

	if (error && files.length === 0) {
		return { suggestions: [], scopeLabel, truncated, error };
	}

	if (files.length === 0) {
		return null;
	}

	const queryPath = (() => {
		if (path.isAbsolute(rawPath)) {
			const relative = path.relative(cwd, resolvedPath).replace(/\\/g, "/");
			if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
				return normalizePathForMatch(relative);
			}
		}
		return normalizePathForMatch(rawPath);
	})();
	const baseQuery = path.posix.basename(queryPath);

	const matches: Array<{ path: string; score: number; baseScore: number; fullScore: number }> = [];
	const seen = new Set<string>();

	for (const file of files) {
		signal?.throwIfAborted();
		const cleaned = file.replace(/\r$/, "").trim();
		if (!cleaned) continue;

		const relativePath = path.isAbsolute(cleaned)
			? cleaned.startsWith(searchRoot)
				? cleaned.slice(searchRoot.length + 1)
				: path.relative(searchRoot, cleaned)
			: cleaned;

		if (!relativePath || relativePath.startsWith("..")) {
			continue;
		}

		const displayPath = buildDisplayPath(searchRoot, cwd, relativePath);
		if (seen.has(displayPath)) {
			continue;
		}
		seen.add(displayPath);

		const normalizedDisplay = normalizePathForMatch(displayPath);
		const baseCandidate = path.posix.basename(normalizedDisplay);

		const fullScore = similarityScore(queryPath, normalizedDisplay);
		const baseScore = baseQuery ? similarityScore(baseQuery, baseCandidate) : 0;

		if (baseQuery) {
			if (baseScore < MIN_BASE_SIMILARITY && fullScore < MIN_FULL_SIMILARITY) {
				continue;
			}
		} else if (fullScore < MIN_FULL_SIMILARITY) {
			continue;
		}

		const score = baseQuery ? baseScore * 0.75 + fullScore * 0.25 : fullScore;
		matches.push({ path: displayPath, score, baseScore, fullScore });
	}

	if (matches.length === 0) {
		return { suggestions: [], scopeLabel, truncated };
	}

	matches.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
		return a.path.localeCompare(b.path);
	});

	const suggestions = matches.slice(0, MAX_FUZZY_RESULTS).map((match) => match.path);

	return { suggestions, scopeLabel, truncated };
}

async function convertWithMarkitdown(
	filePath: string,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean; error?: string }> {
	const cmd = await ensureTool("markitdown", true);
	if (!cmd) {
		return { content: "", ok: false, error: "markitdown not found (uv/pip unavailable)" };
	}

	const { stdout, stderr, exitCode, aborted } = await captureCommandOutput(cmd, [filePath], signal);

	if (aborted) {
		throw new Error("Operation aborted");
	}

	if (exitCode === 0 && stdout.length > 0) {
		return { content: stdout, ok: true };
	}

	return { content: "", ok: false, error: stderr.trim() || "Conversion failed" };
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export interface ReadToolDetails {
	truncation?: TruncationResult;
	redirectedTo?: "ls";
}

export function createReadTool(session: ToolSession): AgentTool<typeof readSchema> {
	const autoResizeImages = session.settings?.getImageAutoResize() ?? true;
	const lsTool = createLsTool(session);
	return {
		name: "read",
		label: "Read",
		description: readDescription.replace("{{DEFAULT_MAX_LINES}}", String(DEFAULT_MAX_LINES)),
		parameters: readSchema,
		execute: async (
			toolCallId: string,
			{ path: readPath, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveReadPath(readPath, session.cwd);

			return untilAborted(signal, async () => {
				let isDirectory = false;
				let fileSize = 0;
				try {
					const stat = await Bun.file(absolutePath).stat();
					fileSize = stat.size;
					isDirectory = stat.isDirectory();
				} catch (error) {
					if (isNotFoundError(error)) {
						let message = `File not found: ${readPath}`;

						// Skip fuzzy matching for remote mounts (sshfs) to avoid hangs
						if (!isRemoteMountPath(absolutePath)) {
							const suggestions = await findReadPathSuggestions(readPath, session.cwd, signal);

							if (suggestions?.suggestions.length) {
								const scopeLabel = suggestions.scopeLabel ? ` in ${suggestions.scopeLabel}` : "";
								message += `\n\nClosest matches${scopeLabel}:\n${suggestions.suggestions.map((match) => `- ${match}`).join("\n")}`;
								if (suggestions.truncated) {
									message += `\n[Search truncated to first ${MAX_FUZZY_CANDIDATES} paths. Refine the path if the match isn't listed.]`;
								}
							} else if (suggestions?.error) {
								message += `\n\nFuzzy match failed: ${suggestions.error}`;
							} else if (suggestions?.scopeLabel) {
								message += `\n\nNo similar paths found in ${suggestions.scopeLabel}.`;
							}
						}

						throw new Error(message);
					}
					throw error;
				}

				if (isDirectory) {
					const lsResult = await lsTool.execute(toolCallId, { path: readPath, limit }, signal);
					return {
						content: lsResult.content,
						details: { redirectedTo: "ls", truncation: lsResult.details?.truncation },
					};
				}

				const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
				const ext = path.extname(absolutePath).toLowerCase();

				// Read the file based on type
				let content: (TextContent | ImageContent)[];
				let details: ReadToolDetails | undefined;

				if (mimeType) {
					if (fileSize > MAX_IMAGE_SIZE) {
						const sizeStr = formatSize(fileSize);
						const maxStr = formatSize(MAX_IMAGE_SIZE);
						content = [
							{
								type: "text",
								text: `[Image file too large: ${sizeStr} exceeds ${maxStr} limit. Use an image viewer or resize the image.]`,
							},
						];
					} else {
						// Read as image (binary)
						const file = Bun.file(absolutePath);
						const buffer = await file.arrayBuffer();

						// Check actual buffer size after reading to prevent OOM during serialization
						if (buffer.byteLength > MAX_IMAGE_SIZE) {
							const sizeStr = formatSize(buffer.byteLength);
							const maxStr = formatSize(MAX_IMAGE_SIZE);
							content = [
								{
									type: "text",
									text: `[Image file too large: ${sizeStr} exceeds ${maxStr} limit. Use an image viewer or resize the image.]`,
								},
							];
						} else {
							const base64 = Buffer.from(buffer).toString("base64");

							if (autoResizeImages) {
								// Resize image if needed
								const resized = await resizeImage({ type: "image", data: base64, mimeType });
								const dimensionNote = formatDimensionNote(resized);

								let textNote = `Read image file [${resized.mimeType}]`;
								if (dimensionNote) {
									textNote += `\n${dimensionNote}`;
								}

								content = [
									{ type: "text", text: textNote },
									{ type: "image", data: resized.data, mimeType: resized.mimeType },
								];
							} else {
								content = [
									{ type: "text", text: `Read image file [${mimeType}]` },
									{ type: "image", data: base64, mimeType },
								];
							}
						}
					}
				} else if (CONVERTIBLE_EXTENSIONS.has(ext)) {
					// Convert document via markitdown
					const result = await convertWithMarkitdown(absolutePath, signal);
					if (result.ok) {
						// Apply truncation to converted content
						const truncation = truncateHead(result.content);
						let outputText = truncation.content;

						if (truncation.truncated) {
							outputText += `\n\n[Document converted via markitdown. Output truncated to ${formatSize(DEFAULT_MAX_BYTES)}]`;
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
					const file = Bun.file(absolutePath);
					const textContent = await file.text();
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
						const firstLine = allLines[startLine] ?? "";
						const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
						const snippet = truncateStringToBytesFromStart(firstLine, DEFAULT_MAX_BYTES);
						const shownSize = formatSize(snippet.bytes);

						outputText = snippet.text;
						if (outputText.length > 0) {
							outputText += `\n\n[Line ${startLineDisplay} is ${formatSize(
								firstLineBytes,
							)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Showing first ${shownSize} of the line.]`;
						} else {
							outputText = `[Line ${startLineDisplay} is ${formatSize(
								firstLineBytes,
							)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Unable to display a valid UTF-8 snippet.]`;
						}
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

				return { content, details };
			});
		},
	};
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface ReadRenderArgs {
	path?: string;
	file_path?: string;
	offset?: number;
	limit?: number;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff"]);
const BINARY_EXTENSIONS = new Set(["pdf", "zip", "tar", "gz", "exe", "dll", "so", "dylib", "wasm"]);

function getFileType(filePath: string): "image" | "binary" | "text" {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return "text";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (BINARY_EXTENSIONS.has(ext)) return "binary";
	return "text";
}

export const readToolRenderer = {
	renderCall(args: ReadRenderArgs, uiTheme: Theme): Component {
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const offset = args.offset;
		const limit = args.limit;

		let pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", uiTheme.format.ellipsis);
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			pathDisplay += uiTheme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
		}

		const text = `${uiTheme.fg("toolTitle", uiTheme.bold("Read"))} ${pathDisplay}`;
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails },
		{ expanded }: RenderResultOptions,
		uiTheme: Theme,
		args?: ReadRenderArgs,
	): Component {
		const rawPath = args?.file_path || args?.path || "";
		const fileType = getFileType(rawPath);
		const details = result.details;
		const lines: string[] = [];

		const output = result.content?.find((c) => c.type === "text")?.text ?? "";

		if (fileType === "image") {
			lines.push(uiTheme.fg("muted", "Image rendered below"));
		} else if (fileType === "binary") {
			// Binary files just show the header from renderCall
		} else {
			// Text file
			const lang = getLanguageFromPath(rawPath);
			const contentLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");

			if (expanded) {
				lines.push(
					...contentLines.map((line: string) =>
						lang ? replaceTabs(line) : uiTheme.fg("toolOutput", replaceTabs(line)),
					),
				);
			} else {
				lines.push(uiTheme.fg("dim", `${uiTheme.nav.expand} Ctrl+O to show content`));
			}

			// Truncation warning
			const truncation = details?.truncation;
			if (truncation?.truncated) {
				let warning: string;
				if (truncation.firstLineExceedsLimit) {
					warning = `First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`;
				} else if (truncation.truncatedBy === "lines") {
					warning = `Truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)`;
				} else {
					warning = `Truncated: ${truncation.outputLines} lines (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`;
				}
				lines.push(uiTheme.fg("warning", wrapBrackets(warning, uiTheme)));
			}
		}

		return new Text(lines.join("\n"), 0, 0);
	},
};
