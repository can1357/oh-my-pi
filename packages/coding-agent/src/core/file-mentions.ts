/**
 * Auto-read file mentions from user prompts.
 *
 * When users reference files with @path syntax (e.g., "@src/foo.ts"),
 * we automatically inject the file contents as a FileMentionMessage
 * so the agent doesn't need to read them manually.
 */

import path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { FileMentionMessage } from "./messages";
import { resolveReadPath } from "./tools/path-utils";
import { formatAge } from "./tools/render-utils";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateStringToBytesFromStart } from "./tools/truncate";

/** Regex to match @filepath patterns in text */
const FILE_MENTION_REGEX = /@([^\s@]+)/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;
const DEFAULT_DIR_LIMIT = 500;

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

function buildTextOutput(textContent: string): { output: string; lineCount: number } {
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const truncation = truncateHead(textContent);

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[0] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const snippet = truncateStringToBytesFromStart(firstLine, DEFAULT_MAX_BYTES);
		let outputText = snippet.text;

		if (outputText.length > 0) {
			outputText += `\n\n[Line 1 is ${formatSize(firstLineBytes)}, exceeds ${formatSize(
				DEFAULT_MAX_BYTES,
			)} limit. Showing first ${formatSize(snippet.bytes)} of the line.]`;
		} else {
			outputText = `[Line 1 is ${formatSize(firstLineBytes)}, exceeds ${formatSize(
				DEFAULT_MAX_BYTES,
			)} limit. Unable to display a valid UTF-8 snippet.]`;
		}

		return { output: outputText, lineCount: totalFileLines };
	}

	let outputText = truncation.content;

	if (truncation.truncated) {
		const endLineDisplay = truncation.outputLines;
		const nextOffset = endLineDisplay + 1;

		if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines 1-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
		} else {
			outputText += `\n\n[Showing lines 1-${endLineDisplay} of ${totalFileLines} (${formatSize(
				DEFAULT_MAX_BYTES,
			)} limit). Use offset=${nextOffset} to continue]`;
		}
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
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
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

		const cleaned = sanitizeMentionPath(match[1]);
		if (!cleaned) continue;

		mentions.push(cleaned);
	}

	return [...new Set(mentions)];
}

/**
 * Generate a FileMentionMessage containing the contents of mentioned files.
 * Returns empty array if no files could be read.
 */
export async function generateFileMentionMessages(filePaths: string[], cwd: string): Promise<AgentMessage[]> {
	if (filePaths.length === 0) return [];

	const files: FileMentionMessage["files"] = [];

	for (const filePath of filePaths) {
		const absolutePath = resolveReadPath(filePath, cwd);

		try {
			const stat = await Bun.file(absolutePath).stat();
			if (stat.isDirectory()) {
				const { output, lineCount } = await buildDirectoryListing(absolutePath);
				files.push({ path: filePath, content: output, lineCount });
				continue;
			}

			const content = await Bun.file(absolutePath).text();
			const { output, lineCount } = buildTextOutput(content);
			files.push({ path: filePath, content: output, lineCount });
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
