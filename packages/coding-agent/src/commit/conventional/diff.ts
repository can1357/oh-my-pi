import type { ConventionalGenerationConfig } from "./config";
import { codePointLength, sliceCodePoints } from "./text";

const DEFAULT_LOW_PRIORITY_EXTENSIONS = [
	"lock",
	"log",
	"md",
	"txt",
	"json",
	"yaml",
	"yml",
	"toml",
	"sum",
	"tmp",
	"bak",
];
const SOURCE_EXTENSIONS: Record<string, true> = {
	rs: true,
	go: true,
	py: true,
	js: true,
	ts: true,
	tsx: true,
	jsx: true,
	java: true,
	c: true,
	cpp: true,
	h: true,
	hpp: true,
};

const DIFF_HEADER_PREFIXES = [
	"index ",
	"new file",
	"deleted file",
	"rename ",
	"copy ",
	"similarity index",
	"dissimilarity index",
	"old mode",
	"new mode",
	"+++",
	"---",
];

const NONCONTENT_CHANGE_PREFIXES = ["Binary files", "rename from", "rename to", "copy from", "copy to"];

const PRIORITY = {
	binary: -100,
	test: 10,
	low: 20,
	default: 50,
	manifest: 70,
	script: 80,
	source: 100,
} satisfies Record<string, number>;

/** Per-file cap applied after long prompt lines are collapsed. */
export const MAX_PROMPT_FILE_BYTES = 100_000;
/** Long-line threshold above which machine payloads are collapsed. */
export const BLOB_LINE_THRESHOLD = 512;

/** One file section parsed from a unified diff for prompt preparation. */
export class ConventionalFileDiff {
	filename: string;
	header: string;
	content: string;
	additions: number;
	deletions: number;
	isBinary: boolean;
	status: "added" | "deleted" | "renamed" | "modified";

	constructor(
		filename: string,
		header: string,
		content = "",
		additions = 0,
		deletions = 0,
		isBinary = false,
		status: ConventionalFileDiff["status"] = "modified",
	) {
		this.filename = filename;
		this.header = header;
		this.content = content;
		this.additions = additions;
		this.deletions = deletions;
		this.isBinary = isBinary;
		this.status = status;
	}

	/** UTF-8 byte size used by prompt budgets. */
	get size(): number {
		return Buffer.byteLength(this.header) + Buffer.byteLength(this.content);
	}

	/** Deterministic four-character token estimate. */
	tokenEstimate(): number {
		return Math.max(1, Math.floor((codePointLength(this.header) + codePointLength(this.content)) / 4));
	}

	/** Context-retention priority; higher values survive truncation first. */
	priority(config?: ConventionalGenerationConfig): number {
		if (this.isBinary) return PRIORITY.binary;
		const lower = this.filename.toLowerCase();
		if (
			lower.endsWith("cargo.toml") ||
			lower.endsWith("package.json") ||
			lower.endsWith("go.mod") ||
			lower.endsWith("requirements.txt") ||
			lower.endsWith("pyproject.toml")
		) {
			return PRIORITY.manifest;
		}
		if (lower.includes("prompt") || lower.includes("system")) return PRIORITY.source;
		if (
			this.filename.includes("/test") ||
			this.filename.includes("test_") ||
			this.filename.includes("_test.") ||
			this.filename.includes(".test.")
		) {
			return PRIORITY.test;
		}
		const extension = this.filename.includes(".") ? (this.filename.split(".").at(-1) ?? "") : "";
		const lowPriority = config?.lowPriorityExtensions ?? DEFAULT_LOW_PRIORITY_EXTENSIONS;
		for (const item of lowPriority) {
			if (item.replace(/^\./, "") === extension) return PRIORITY.low;
		}
		if (SOURCE_EXTENSIONS[extension]) return PRIORITY.source;
		if (extension === "sql" || extension === "sh" || extension === "bash") return PRIORITY.script;
		return PRIORITY.default;
	}

	/** Truncate content in place while preserving metadata and useful edges. */
	truncate(maxSize: number): void {
		if (this.size <= maxSize) return;
		const suffix = "\n... (truncated)";
		const available = maxSize - Buffer.byteLength(this.header) - Buffer.byteLength(suffix);
		if (available < 50) {
			this.content = "... (truncated)";
			return;
		}
		const lines = splitLines(this.content);
		if (lines.length > 30) {
			const omitted = lines.length - 25;
			const content = [...lines.slice(0, 15), `... (truncated ${omitted} lines) ...`, ...lines.slice(-10)].join(
				"\n",
			);
			if (Buffer.byteLength(content) <= available) {
				this.content = content;
				return;
			}
			this.content = truncateUtf8(content, available) + suffix;
			return;
		}
		this.content = truncateUtf8(this.content, available) + suffix;
	}
}

/** Collapse blob-like diff lines while preserving recognizable head and tail text. */
export function collapseBlobLines(diff: string, threshold = BLOB_LINE_THRESHOLD): string {
	if (codePointLength(diff) <= threshold) return diff;
	const lines = diff.split("\n");
	let changed = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const lineLength = codePointLength(line);
		if (lineLength <= threshold) continue;
		const omitted = lineLength - 120 - 24;
		lines[index] =
			`${sliceCodePoints(line, 0, 120)}[..omitted ${formatOmittedSize(omitted)}..]${sliceCodePoints(line, lineLength - 24)}`;
		changed = true;
	}
	return changed ? lines.join("\n") : diff;
}

/** Keep the largest stat rows plus the totals line. */
export function condenseStat(stat: string, maxFiles = 0): string {
	const lines = splitLines(stat).filter(line => line.trim());
	const fileLines = lines.filter(line => line.includes("|"));
	if (fileLines.length <= maxFiles) return stat;
	const otherLines = lines.filter(line => !line.includes("|"));
	const sorted = [...fileLines].sort((left, right) => statChangeCount(right) - statChangeCount(left));
	const kept = new Set(sorted.slice(0, maxFiles));
	const condensed = fileLines.filter(line => kept.has(line));
	const omitted = fileLines.length - condensed.length;
	if (omitted > 0 && condensed.length > 0) condensed.push(` ... ${omitted} more files omitted ...`);
	return [...condensed, ...otherLines].join("\n");
}

/** Parse a unified git diff into file-level prompt sections. */
export function parsePromptDiff(diff: string): ConventionalFileDiff[] {
	const files: ConventionalFileDiff[] = [];
	let current: ConventionalFileDiff | undefined;
	let headerLines: string[] = [];
	let contentLines: string[] = [];
	let inDiffHeader = false;
	const flush = (): void => {
		if (!current) return;
		current.header = headerLines.join("\n");
		current.content = contentLines.join("\n");
		files.push(current);
		headerLines = [];
		contentLines = [];
	};
	for (const line of splitLines(diff)) {
		if (line.startsWith("diff --git")) {
			flush();
			const parts = line.split(/\s+/);
			const filename = parts.length > 3 ? (parts[3] ?? "").replace(/^b\//, "") : "unknown";
			current = new ConventionalFileDiff(filename, "");
			headerLines.push(line);
			inDiffHeader = true;
			continue;
		}
		if (!current) continue;
		if (line.startsWith("Binary files")) {
			current.isBinary = true;
			headerLines.push(line);
		} else if (inDiffHeader && DIFF_HEADER_PREFIXES.some(prefix => line.startsWith(prefix))) {
			headerLines.push(line);
			if (line.startsWith("new file")) current.status = "added";
			else if (line.startsWith("deleted file")) current.status = "deleted";
			else if (line.startsWith("rename ")) current.status = "renamed";
		} else if (line.startsWith("@@")) {
			inDiffHeader = false;
			contentLines.push(line);
		} else if (!inDiffHeader) {
			contentLines.push(line);
			if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
			else if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
		} else {
			headerLines.push(line);
		}
	}
	flush();
	return files;
}

/** Reconstruct prompt text from parsed file sections. */
export function reconstructPromptDiff(files: readonly ConventionalFileDiff[]): string {
	return files.map(file => (file.content ? `${file.header}\n${file.content}` : file.header)).join("\n");
}

/** Collapse long payloads and cap any remaining oversized file section. */
export function scrubDiffForPrompt(diff: string, maxFileBytes = MAX_PROMPT_FILE_BYTES): string {
	const collapsed = collapseBlobLines(diff);
	if (Buffer.byteLength(collapsed) <= maxFileBytes) return collapsed;
	const files = parsePromptDiff(collapsed);
	if (!files.some(file => file.size > maxFileBytes)) return collapsed;
	for (const file of files) if (file.size > maxFileBytes) file.truncate(maxFileBytes);
	return reconstructPromptDiff(files);
}

/** Truncate a diff by file priority while retaining whole-file scope. */
export function smartTruncateDiff(diff: string, maxLength: number, config: ConventionalGenerationConfig): string {
	const files = parsePromptDiff(diff).filter(file => !isExcluded(file.filename, config));
	if (files.length === 0) return "No relevant files to analyze (only lock files or excluded files were changed)";
	files.sort((left, right) => right.priority(config) - left.priority(config));
	const totalSize = files.reduce((sum, file) => sum + file.size, 0);
	const totalTokens = files.reduce((sum, file) => sum + file.tokenEstimate(), 0);
	const effectiveMax = totalTokens > config.maxDiffTokens ? config.maxDiffTokens * 4 : maxLength;
	if (totalSize <= effectiveMax) return reconstructPromptDiff(files);

	const included: ConventionalFileDiff[] = [];
	const headerOnlySize = files.reduce((sum, file) => sum + Buffer.byteLength(file.header) + 20, 0);
	if (headerOnlySize <= effectiveMax) {
		const remaining = Math.max(0, effectiveMax - headerOnlySize);
		const perFile = files.length > 0 ? Math.floor(remaining / files.length) : 0;
		for (const file of files) {
			if (file.isBinary) {
				included.push(
					new ConventionalFileDiff(
						file.filename,
						file.header,
						"",
						file.additions,
						file.deletions,
						true,
						file.status,
					),
				);
				continue;
			}
			const targetSize = Buffer.byteLength(file.header) + perFile;
			if (file.size > targetSize) file.truncate(targetSize);
			included.push(file);
		}
	} else {
		let currentSize = 0;
		for (const file of files) {
			if (file.isBinary) continue;
			if (currentSize + file.size <= effectiveMax) {
				currentSize += file.size;
				included.push(file);
			} else if (currentSize < effectiveMax / 2 && file.priority(config) >= 50) {
				file.truncate(Math.max(0, effectiveMax - currentSize - 100));
				included.push(file);
				break;
			}
		}
	}
	if (included.length === 0) return "Error: Could not include any files in the diff";
	let result = reconstructPromptDiff(included);
	const excludedCount = files.length - included.length;
	if (excludedCount > 0) result += `\n\n... (${excludedCount} files omitted) ...`;
	return result;
}

/** Truncate to a line budget distributed by file priority. */
export function truncateDiffByLines(diff: string, maxLines: number, config: ConventionalGenerationConfig): string {
	const files = parsePromptDiff(diff);
	const totalLines = files.reduce(
		(sum, file) => sum + splitLines(file.header).length + splitLines(file.content).length,
		0,
	);
	if (totalLines <= maxLines) return diff;
	const totalPriority = files.reduce((sum, file) => sum + Math.max(1, file.priority(config)), 0) || 1;
	const result: string[] = [];
	for (const file of files) {
		result.push(...splitLines(file.header));
		const contentLines = splitLines(file.content);
		const allocated = Math.max(5, Math.trunc((maxLines * Math.max(1, file.priority(config))) / totalPriority));
		if (contentLines.length <= allocated) {
			result.push(...contentLines);
			if (contentLines.length === 0) result.push("");
			continue;
		}
		const keepStart = Math.floor(allocated / 2);
		const keepEnd = allocated - keepStart;
		const omitted = contentLines.length - keepStart - keepEnd;
		result.push(
			...contentLines.slice(0, keepStart),
			`[... ${omitted} lines omitted ...]`,
			...contentLines.slice(-keepEnd),
		);
	}
	return result.join("\n") + (result.length > 0 ? "\n" : "");
}

/** Classify file sections as whitespace-only or substantive. */
export function classifyDiffWhitespace(diff: string): {
	whitespaceOnlyFiles: string[];
	hasSubstantive: boolean;
	allWhitespace: boolean;
} {
	const sections = fileSections(diff).sections;
	const whitespaceOnlyFiles: string[] = [];
	let hasSubstantive = false;
	for (const [path, section] of sections) {
		if (sectionIsWhitespaceOnly(section)) whitespaceOnlyFiles.push(path);
		else hasSubstantive = true;
	}
	return {
		whitespaceOnlyFiles,
		hasSubstantive,
		allWhitespace: whitespaceOnlyFiles.length > 0 && !hasSubstantive,
	};
}

/** Remove whitespace-only file sections, returning `null` when nothing changes. */
export function stripWhitespaceOnlyFiles(diff: string): string | null {
	const { preamble, sections } = fileSections(diff);
	if (sections.length === 0) return null;
	const kept: string[] = [];
	let strippedAny = false;
	for (const [, section] of sections) {
		if (sectionIsWhitespaceOnly(section)) strippedAny = true;
		else kept.push(section);
	}
	if (!strippedAny || kept.length === 0) return null;
	return preamble + kept.join("");
}

function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

function formatOmittedSize(count: number): string {
	if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)}MB`;
	if (count >= 1024) return `${(count / 1024).toFixed(0)}KB`;
	return `${count}B`;
}

function statChangeCount(line: string): number {
	const tail = line.split("|").at(-1)?.trim() ?? "";
	const digits = tail.split(/\s+/, 1)[0] ?? "";
	return /^\d+$/.test(digits) ? Number.parseInt(digits, 10) : 0;
}

function isExcluded(filename: string, config: ConventionalGenerationConfig): boolean {
	return config.excludedFiles.some(pattern => filename.endsWith(pattern));
}

function fileSections(diff: string): { preamble: string; sections: Array<[string, string]> } {
	const starts: number[] = [];
	let searchFrom = 0;
	while (true) {
		const index = diff.indexOf("diff --git", searchFrom);
		if (index < 0) break;
		if (index === 0 || diff[index - 1] === "\n") starts.push(index);
		searchFrom = index + "diff --git".length;
	}
	if (starts.length === 0) return { preamble: diff, sections: [] };
	const sections: Array<[string, string]> = [];
	for (let index = 0; index < starts.length; index += 1) {
		const start = starts[index] ?? 0;
		const end = starts[index + 1] ?? diff.length;
		const section = diff.slice(start, end);
		const firstLine = splitLines(section)[0] ?? "";
		const parts = firstLine.split(/\s+/);
		sections.push([(parts[3] ?? "unknown").replace(/^b\//, ""), section]);
	}
	return { preamble: diff.slice(0, starts[0] ?? 0), sections };
}

function sectionIsWhitespaceOnly(section: string): boolean {
	const added: string[] = [];
	const removed: string[] = [];
	let hasChange = false;
	for (const line of splitLines(section)) {
		if (NONCONTENT_CHANGE_PREFIXES.some(prefix => line.startsWith(prefix))) {
			return false;
		}
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) {
			hasChange = true;
			for (const char of line.slice(1)) if (!/\s/.test(char)) added.push(char);
		} else if (line.startsWith("-")) {
			hasChange = true;
			for (const char of line.slice(1)) if (!/\s/.test(char)) removed.push(char);
		}
	}
	return hasChange && added.join("") === removed.join("");
}
function splitLines(text: string): string[] {
	if (!text) return [];
	const lines = text.split(/\r\n|\n|\r/);
	if (lines.at(-1) === "") lines.pop();
	return lines;
}
