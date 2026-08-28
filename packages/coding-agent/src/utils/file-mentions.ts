/**
 * Auto-read file mentions from user prompts.
 *
 * When users reference files with @path syntax (e.g., "@src/foo.ts"),
 * we automatically inject the file contents as a FileMentionMessage
 * so the agent doesn't need to read them manually.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import {
	formatHashlineHeader,
	formatNumberedLines,
	type SnapshotStore,
	splitAddressableFileLines,
} from "@oh-my-pi/hashline";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { formatAge, formatBytes, isProbablyBinary, readImageMetadata } from "@oh-my-pi/pi-utils";
import { canonicalSnapshotKey } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { FileMentionMessage } from "../session/messages";
import {
	DEFAULT_MAX_BYTES,
	formatHeadTruncationNotice,
	truncateHead,
	truncateHeadBytes,
} from "../session/streaming-output";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, resizeImage } from "./image-resize";

/** Regex to match @filepath patterns in text */
const FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;
const DEFAULT_DIR_LIMIT = 500;

// Avoid OOM when users @mention very large files. Above these limits we skip
// auto-reading and only include the path in the message.
const MAX_AUTO_READ_TEXT_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_AUTO_READ_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB

function isMentionBoundary(text: string, index: number): boolean {
	if (index === 0) return true;
	return MENTION_BOUNDARY_REGEX.test(text[index - 1]);
}

function sanitizeMentionPath(rawPath: string): string | null {
	let cleaned = rawPath.trim();
	cleaned = cleaned.replace(LEADING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.replace(TRAILING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.trim();
	return cleaned.length > 0 ? cleaned : null;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await Bun.file(filePath).stat();
		return true;
	} catch {
		return false;
	}
}

async function resolveMentionPath(filePath: string, cwd: string): Promise<string | null> {
	// Exact resolution only. The TUI @-selector inserts the real, complete path, so a
	// mention that does not resolve to an existing file or directory is prose, not a file
	// reference. Fuzzy/prefix guessing here previously dragged in unrelated same-named
	// files; that disambiguation belongs to the selector's display, not post-send.
	const absolutePath = resolveReadPath(filePath, cwd);
	return (await pathExists(absolutePath)) ? filePath : null;
}

function buildTextOutput(textContent: string): { output: string; lineCount: number } {
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const truncation = truncateHead(textContent);

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[0] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);
		let outputText = snippet.text;

		if (outputText.length > 0) {
			outputText += `\n\n[Line 1 is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
				DEFAULT_MAX_BYTES,
			)} limit. Showing first ${formatBytes(snippet.bytes)} of the line.]`;
		} else {
			outputText = `[Line 1 is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
				DEFAULT_MAX_BYTES,
			)} limit. Unable to display a valid UTF-8 snippet.]`;
		}

		return { output: outputText, lineCount: totalFileLines };
	}

	let outputText = truncation.content;

	if (truncation.truncated) {
		outputText += formatHeadTruncationNotice(truncation, { startLine: 1, totalFileLines });
	}

	return { output: outputText, lineCount: totalFileLines };
}

async function buildDirectoryListing(absolutePath: string): Promise<{ output: string; lineCount: number }> {
	let entries: string[];
	try {
		entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: absolutePath, dot: true, onlyFiles: false }));
	} catch {
		return { output: "(empty directory)", lineCount: 1 };
	}

	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	const results: string[] = [];
	let entryLimitReached = false;

	for (const entry of entries) {
		if (results.length >= DEFAULT_DIR_LIMIT) {
			entryLimitReached = true;
			break;
		}

		const fullPath = path.join(absolutePath, entry);
		let suffix = "";
		let age = "";

		try {
			const stat = await Bun.file(fullPath).stat();
			if (stat.isDirectory()) {
				suffix = "/";
			}
			const ageSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
			age = formatAge(ageSeconds);
		} catch {
			continue;
		}

		const line = age ? `${entry}${suffix} (${age})` : `${entry}${suffix}`;
		results.push(line);
	}

	if (results.length === 0) {
		return { output: "(empty directory)", lineCount: 1 };
	}

	const rawOutput = results.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;

	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${DEFAULT_DIR_LIMIT} entries limit reached. Use limit=${DEFAULT_DIR_LIMIT * 2} for more`);
	}
	if (truncation.truncated) {
		notices.push(`${formatBytes(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}

	return { output, lineCount: output.split("\n").length };
}

/** Extract all @filepath mentions from text */
export function extractFileMentions(text: string): string[] {
	const matches = [...text.matchAll(FILE_MENTION_REGEX)];
	const mentions: string[] = [];

	for (const match of matches) {
		const index = match.index ?? 0;
		if (!isMentionBoundary(text, index)) continue;

		const rawPath = match[1] ?? match[2] ?? match[3];
		if (!rawPath) continue;

		const cleaned = match[1] !== undefined || match[2] !== undefined ? rawPath.trim() : sanitizeMentionPath(rawPath);
		if (!cleaned) continue;

		mentions.push(cleaned);
	}

	return [...new Set(mentions)];
}

/**
 * Generate a FileMentionMessage containing the contents of mentioned files.
 * Returns empty array if no files could be read.
 */
export async function generateFileMentionMessages(
	filePaths: string[],
	cwd: string,
	options?: { autoResizeImages?: boolean; useHashLines?: boolean; snapshotStore?: SnapshotStore },
): Promise<AgentMessage[]> {
	if (filePaths.length === 0) return [];

	const autoResizeImages = options?.autoResizeImages ?? true;

	const files: FileMentionMessage["files"] = [];

	for (const filePath of filePaths) {
		const resolvedPath = await resolveMentionPath(filePath, cwd);
		if (!resolvedPath) {
			continue;
		}
		const absolutePath = resolveReadPath(resolvedPath, cwd);
		try {
			const stat = await Bun.file(absolutePath).stat();
			if (stat.isDirectory()) {
				const { output, lineCount } = await buildDirectoryListing(absolutePath);
				files.push({ path: resolvedPath, content: output, lineCount });
				continue;
			}

			const imageMetadata = await readImageMetadata(absolutePath);
			const mimeType = imageMetadata?.mimeType;
			if (mimeType) {
				if (stat.size > MAX_AUTO_READ_IMAGE_BYTES) {
					files.push({
						path: resolvedPath,
						content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
						byteSize: stat.size,
						skippedReason: "tooLarge",
					});
					continue;
				}
				const buffer = await fs.readFile(absolutePath);
				if (buffer.length === 0) {
					continue;
				}

				const base64Content = buffer.toBase64();
				let image: ImageContent = { type: "image", mimeType, data: base64Content };
				let dimensionNote: string | undefined;

				if (autoResizeImages) {
					try {
						const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
						dimensionNote = formatDimensionNote(resized);
						image = {
							type: "image",
							mimeType: resized.mimeType,
							data: resized.data,
						};
					} catch {
						image = { type: "image", mimeType, data: base64Content };
					}
				}

				files.push({ path: resolvedPath, content: dimensionNote ?? "", image });
				continue;
			}

			if (stat.size > MAX_AUTO_READ_TEXT_BYTES) {
				files.push({
					path: resolvedPath,
					content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "tooLarge",
				});
				continue;
			}
			if (await isProbablyBinary(absolutePath)) {
				files.push({
					path: resolvedPath,
					content: `(skipped auto-read: binary file, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "binary",
				});
				continue;
			}

			const content = await Bun.file(absolutePath).text();
			const snapshotStore = options?.useHashLines ? options.snapshotStore : undefined;
			const normalized = snapshotStore ? normalizeToLF(content) : content;
			const displayText = snapshotStore ? splitAddressableFileLines(normalized).join("\n") : normalized;
			let { output, lineCount } = buildTextOutput(displayText);
			if (snapshotStore) {
				const tag = snapshotStore.record(canonicalSnapshotKey(absolutePath), normalized);
				output = `${formatHashlineHeader(resolvedPath, tag)}\n${formatNumberedLines(output)}`;
			}
			files.push({ path: resolvedPath, content: output, lineCount });
		} catch {
			// File doesn't exist or isn't readable - skip silently
		}
	}

	if (files.length === 0) return [];

	const message: FileMentionMessage = {
		role: "fileMention",
		files,
		timestamp: Date.now(),
	};

	return [message];
}
