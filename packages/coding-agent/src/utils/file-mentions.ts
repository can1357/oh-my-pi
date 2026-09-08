/**
 * Auto-read file mentions from user prompts.
 *
 * When users reference files with @path syntax (e.g., "@src/foo.ts"),
 * we automatically inject the file contents as a FileMentionMessage
 * so the agent doesn't need to read them manually.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import type { EditStore } from "@oh-my-pi/pi-natives";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { formatAge, formatBytes, isProbablyBinary, readImageMetadata } from "@oh-my-pi/pi-utils";
import { formatHashlineHeader, formatNumberedLines, splitAddressableFileLines } from "../tools/hashline-format";
import { normalizeToLF } from "../edit/normalize";
import type { FileMentionMessage } from "../session/messages";
import {
	type ByteTruncationResult,
	DEFAULT_MAX_BYTES,
	formatHeadTruncationNotice,
	truncateHead,
	truncateHeadBytes,
} from "../session/streaming-output";
import {
	type LineRange,
	isSelectorTail,
	parseLineRanges,
	parseTailCount,
	resolveReadPath,
	splitPathAndSelPreferringLiteral,
} from "../tools/path-utils";
import { ToolError } from "../tools/tool-errors";
import { formatDimensionNote, resizeImage } from "./image-resize";
import {
	VideoError,
	buildVideoContactSheetPng,
	createVideoPreviewImage,
	formatVideoDetails,
	isVideoPath,
	probeVideo,
	videoMimeForPath,
} from "./video";

/** Regex to match @filepath patterns in text */
const FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;
const QUOTED_SELECTOR_TAIL_RE = /^:([^\s]+)/;
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

interface ResolvedMentionPath {
	displayPath: string;
	filePath: string;
	ranges?: [LineRange, ...LineRange[]];
	tailCount?: number;
	/** True when the mention carries any line selection (ranges or tail). */
	readonly lineSelected: boolean;
}

/** Line selection a mention selector resolves to: explicit ranges or a `-N` tail. */
type MentionSelection = { ranges: [LineRange, ...LineRange[]] } | { tailCount: number };

/**
 * Parse a mention selector into a line selection. Returns `undefined` for
 * absent or non-range selectors, or `null` for malformed bounds (`:0`,
 * `:3-1`, `:2+0`, `:-0`) so the caller drops the mention like any other
 * unresolved reference — a mistyped range degrades to prose instead of the
 * read tool's `ToolError` aborting prompt submission.
 */
function parseMentionSelection(sel: string | undefined): MentionSelection | undefined | null {
	if (!sel) return undefined;
	try {
		const ranges = parseLineRanges(normalizeMentionSelector(sel));
		if (ranges) return { ranges };
		const tailCount = parseTailCount(sel);
		if (tailCount !== null) return { tailCount };
		return undefined;
	} catch (error) {
		if (error instanceof ToolError) return null;
		throw error;
	}
}

async function resolveMention(filePath: string, cwd: string): Promise<ResolvedMentionPath | null> {
	const split = await splitPathAndSelPreferringLiteral(filePath, cwd);
	const resolvedPath = await resolveMentionPath(split.path, cwd);
	if (!resolvedPath) return null;
	const selection = parseMentionSelection(split.sel);
	if (selection === null) return null;
	if (!selection) return { displayPath: filePath, filePath: resolvedPath, lineSelected: false };
	if ("ranges" in selection) {
		return { displayPath: filePath, filePath: resolvedPath, ranges: selection.ranges, lineSelected: true };
	}
	return { displayPath: filePath, filePath: resolvedPath, tailCount: selection.tailCount, lineSelected: true };
}

interface SelectedText {
	/** Selected rows rendered as `N${separator}line`. */
	text: string;
	/** Original 1-indexed line numbers actually retained, ascending. */
	lineNumbers: number[];
	/** Total line count of the source file. */
	totalLines: number;
}

function formatSelectedLines(lines: readonly string[], lineNumbers: readonly number[], separator: string): string {
	return lineNumbers.map(number => `${number}${separator}${lines[number - 1] ?? ""}`).join("\n");
}

/**
 * Render the lines covered by `ranges`, numbered with their original
 * 1-indexed positions. Hashline mode passes ":" (the anchor format the edit
 * patcher expects under a `[path#tag]` header); plain mode keeps "|" so the
 * separator never collides with a content colon.
 */
function selectTextRanges(text: string, ranges: readonly LineRange[], separator: string): SelectedText {
	const lines = splitAddressableFileLines(text);
	const lineNumbers = ranges.flatMap(range => {
		if (range.startLine > lines.length) return [];
		const endLine = Math.min(range.endLine ?? lines.length, lines.length);
		return Array.from({ length: endLine - range.startLine + 1 }, (_, i) => range.startLine + i);
	});
	return {
		text: formatSelectedLines(lines, lineNumbers, separator),
		lineNumbers,
		totalLines: lines.length,
	};
}

/** Render the last `count` lines (`:-N` tail selector) with original numbers. */
function selectTailLines(text: string, count: number, separator: string): SelectedText {
	const lines = splitAddressableFileLines(text);
	const startLine = Math.max(1, lines.length - count + 1);
	const lineNumbers = Array.from({ length: lines.length - startLine + 1 }, (_, i) => startLine + i);
	return {
		text: formatSelectedLines(lines, lineNumbers, separator),
		lineNumbers,
		totalLines: lines.length,
	};
}

/** Hashline mode renders `N:line` rows (the edit-patcher anchor grammar under a `[path#tag]` header); plain mode keeps `N|line`. */
function mentionSeparator(snapshotStore: EditStore | undefined): string {
	return snapshotStore ? ":" : "|";
}

/** Build the partial-selection view for a mention, or `null` for whole-file. */
function selectMentionLines(
	normalized: string,
	resolved: ResolvedMentionPath,
	snapshotStore: EditStore | undefined,
): SelectedText | null {
	if (resolved.ranges) return selectTextRanges(normalized, resolved.ranges, mentionSeparator(snapshotStore));
	if (resolved.tailCount === undefined) return null;
	return selectTailLines(normalized, resolved.tailCount, mentionSeparator(snapshotStore));
}

function wholeFileDisplayText(normalized: string, snapshotStore: EditStore | undefined): string {
	return snapshotStore ? splitAddressableFileLines(normalized).join("\n") : normalized;
}

function buildMentionTextOutput(
	normalized: string,
	selection: SelectedText | null,
	snapshotStore: EditStore | undefined,
): { output: string; lineCount: number } {
	if (selection) {
		const textOutput = buildTextOutput(selection.text, {
			startLine: selection.lineNumbers[0] ?? 1,
			totalFileLines: selection.totalLines,
		});
		return { output: textOutput.output, lineCount: selection.lineNumbers.length };
	}
	const textOutput = buildTextOutput(wholeFileDisplayText(normalized, snapshotStore));
	return { output: textOutput.output, lineCount: textOutput.lineCount };
}

function hashlineBody(output: string, selection: SelectedText | null): string {
	return selection ? output : formatNumberedLines(output);
}

function withMentionSnapshot(
	snapshotStore: EditStore | undefined,
	absolutePath: string,
	resolved: ResolvedMentionPath,
	normalized: string,
	selection: SelectedText | null,
	output: string,
): string {
	if (!snapshotStore) return output;
	const tag = snapshotStore.recordSnapshot(absolutePath, normalized);
	// Partial views must record exactly the lines displayed so the patcher's
	// unseen-line guard rejects edits anchored to hidden lines.
	if (selection) snapshotStore.recordSeenLinesFromBody(absolutePath, tag, output);
	return `${formatHashlineHeader(resolved.filePath, tag)}\n${hashlineBody(output, selection)}`;
}

/**
 * Normalize bare line numbers (`15`) into closed single-line ranges (`15-15`)
 * before handing a mention selector to the shared read-tool parser. In the
 * read tool a bare `N` means "from N to EOF" (documented `:50` semantics), so
 * `1,5-8,15` would merge into `1-EOF` and inject the whole file. For mentions
 * the intuitive reading is exact lines; open-ended forms keep their explicit
 * dash (`15-`) when everything to EOF is wanted.
 */
function normalizeMentionSelector(sel: string): string {
	return sel
		.split(",")
		.map(chunk => {
			const bare = /^L?(\d+)$/i.exec(chunk);
			return bare ? `${bare[1]}-${bare[1]}` : chunk;
		})
		.join(",");
}

function formatOversizedFirstLine(startLine: number, firstLineBytes: number, snippet: ByteTruncationResult): string {
	const prefix = `[Line ${startLine} is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
		DEFAULT_MAX_BYTES,
	)} limit.`;
	if (snippet.text.length === 0) return `${prefix} Unable to display a valid UTF-8 snippet.]`;
	return `${snippet.text}\n\n${prefix} Showing first ${formatBytes(snippet.bytes)} of the line.]`;
}

function buildTextOutput(
	textContent: string,
	options?: { startLine?: number; totalFileLines?: number },
): { output: string; lineCount: number } {
	const allLines = textContent.split("\n");
	const totalFileLines = options?.totalFileLines ?? allLines.length;
	const startLine = options?.startLine ?? 1;
	const truncation = truncateHead(textContent);

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[0] ?? "";
		const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);
		const output = formatOversizedFirstLine(startLine, Buffer.byteLength(firstLine, "utf-8"), snippet);
		return { output, lineCount: totalFileLines };
	}

	let outputText = truncation.content;

	if (truncation.truncated) {
		outputText += formatHeadTruncationNotice(truncation, { startLine, totalFileLines });
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
	const mentions = [...text.matchAll(FILE_MENTION_REGEX)].flatMap(match => {
		if (!isMentionBoundary(text, match.index ?? 0)) return [];
		return [cleanMentionCapture(match, text)].filter((cleaned): cleaned is string => cleaned !== null);
	});
	return [...new Set(mentions)];
}

/**
 * Resolve one mention capture to a path (selector included), or `null` when
 * the capture is not a usable mention.
 */
function cleanMentionCapture(match: RegExpMatchArray, text: string): string | null {
	const rawPath = match[1] ?? match[2] ?? match[3];
	if (!rawPath) return null;
	if (match[1] === undefined && match[2] === undefined) return sanitizeMentionPath(rawPath);
	const cleaned = rawPath.trim();
	if (!cleaned) return null;
	// The regex stops a quoted mention at its closing quote, so a typed
	// selector (`@"My Folder/app.ts":10-20`) lands outside the capture;
	// recover an immediately-following well-formed tail or the range is lost.
	const tail = QUOTED_SELECTOR_TAIL_RE.exec(text.slice((match.index ?? 0) + match[0].length));
	const sel = tail?.[1].replace(TRAILING_PUNCTUATION_REGEX, "");
	return tail && sel && isSelectorTail(sel) ? `${cleaned}:${sel}` : cleaned;
}

/**
 * Generate a FileMentionMessage containing the contents of mentioned files.
 * Returns empty array if no files could be read.
 */
export async function generateFileMentionMessages(
	filePaths: string[],
	cwd: string,
	options?: { autoResizeImages?: boolean; useHashLines?: boolean; snapshotStore?: EditStore },
): Promise<AgentMessage[]> {
	if (filePaths.length === 0) return [];

	const autoResizeImages = options?.autoResizeImages ?? true;

	const files: FileMentionMessage["files"] = [];

	for (const filePath of filePaths) {
		const resolved = await resolveMention(filePath, cwd);
		if (!resolved) {
			continue;
		}
		const absolutePath = resolveReadPath(resolved.filePath, cwd);
		try {
			const stat = await Bun.file(absolutePath).stat();
			// Range/tail selectors on a directory are a no-op: listings have
			// no line semantics to select from.
			if (stat.isDirectory() && resolved.lineSelected) continue;
			if (stat.isDirectory()) {
				const { output, lineCount } = await buildDirectoryListing(absolutePath);
				files.push({ path: resolved.displayPath, content: output, lineCount });
				continue;
			}

			const imageMetadata = await readImageMetadata(absolutePath);
			const mimeType = imageMetadata?.mimeType;
			if (mimeType) {
				if (stat.size > MAX_AUTO_READ_IMAGE_BYTES) {
					files.push({
						path: resolved.displayPath,
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

				files.push({ path: resolved.displayPath, content: dimensionNote ?? "", image });
				continue;
			}

			if (isVideoPath(absolutePath)) {
				try {
					const meta = await probeVideo(absolutePath);
					const sheet = await buildVideoContactSheetPng(absolutePath, meta);
					let image: ImageContent = { type: "image", data: sheet.png.data, mimeType: sheet.png.mimeType };
					let dimensionNote: string | undefined;
					if (autoResizeImages) {
						try {
							const resized = await resizeImage(image);
							dimensionNote = formatDimensionNote(resized);
							image = { type: "image", mimeType: resized.mimeType, data: resized.data };
						} catch {
							// Keep the extracted sheet when resize fails.
						}
					}
					const details = formatVideoDetails(
						resolved.displayPath,
						meta,
						stat.size,
						videoMimeForPath(absolutePath),
					);
					files.push({
						path: resolved.displayPath,
						content: `${details}\nPreview grid: ${sheet.thumbs} frames (${sheet.cols}x${sheet.rows})${dimensionNote ? `\n${dimensionNote}` : ""}`,
						image: createVideoPreviewImage(image, absolutePath),
					});
				} catch (error) {
					const reason = error instanceof VideoError ? error.message : "video preview failed";
					files.push({
						path: resolved.displayPath,
						content: `(skipped auto-read: ${reason})`,
						byteSize: stat.size,
						skippedReason: "binary",
					});
				}
				continue;
			}

			if (stat.size > MAX_AUTO_READ_TEXT_BYTES) {
				files.push({
					path: resolved.displayPath,
					content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "tooLarge",
				});
				continue;
			}
			if (await isProbablyBinary(absolutePath)) {
				files.push({
					path: resolved.displayPath,
					content: `(skipped auto-read: binary file, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "binary",
				});
				continue;
			}

			const content = await Bun.file(absolutePath).text();
			const snapshotStore = options?.useHashLines ? options.snapshotStore : undefined;
			const normalized = snapshotStore ? normalizeToLF(content) : content;
			const selection = selectMentionLines(normalized, resolved, snapshotStore);
			if (selection && selection.lineNumbers.length === 0) continue;
			const { output: selectedOutput, lineCount } = buildMentionTextOutput(normalized, selection, snapshotStore);
			const output = withMentionSnapshot(
				snapshotStore,
				absolutePath,
				resolved,
				normalized,
				selection,
				selectedOutput,
			);
			files.push({ path: resolved.displayPath, content: output, lineCount });
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
