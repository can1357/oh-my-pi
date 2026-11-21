import type { ReviewDiffFile, ReviewDiffRow } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { parseGitDiffSectionPaths } from "../../../../utils/git-diff-paths";

export interface ExcludedReviewFile {
	path: string;
	reason: string;
	linesAdded: number;
	linesRemoved: number;
}

export interface ReviewDiffSnapshot {
	/** Original 1-based section index, including files excluded from review. */
	files: (ReviewDiffFile & { diffIndex: number })[];
	excluded: ExcludedReviewFile[];
	totalAdded: number;
	totalRemoved: number;
}

/** Paths the review diff provider withholds from reviewers and the annotation view. */
const EXCLUDED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /flake\.lock$/, reason: "lock file" },
	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/;

interface ParsedRows {
	rows: ReviewDiffRow[];
	linesAdded: number;
	linesRemoved: number;
}

function splitFileDiffs(rawDiff: string): string[] {
	const starts: number[] = [];
	for (const match of rawDiff.matchAll(/^diff --git /gm)) starts.push(match.index!);
	return starts.map((start, index) => {
		const end = starts[index + 1] ?? rawDiff.length;
		const fileDiff = rawDiff.slice(start, end);
		return fileDiff.replace(/\r?\n$/, "");
	});
}

function parseRows(lines: readonly string[]): ParsedRows {
	const rows: ReviewDiffRow[] = [];
	let linesAdded = 0;
	let linesRemoved = 0;
	let oldLine = 0;
	let newLine = 0;
	let hunkHeader: string | undefined;
	for (const raw of lines) {
		const hunk = HUNK_HEADER_PATTERN.exec(raw);
		if (hunk !== null) {
			oldLine = Number.parseInt(hunk[1]!, 10);
			newLine = Number.parseInt(hunk[2]!, 10);
			hunkHeader = raw;
			rows.push({ kind: "hunk", raw, hunkHeader: raw });
			continue;
		}
		if (hunkHeader === undefined) continue;
		if (raw === "\\ No newline at end of file") {
			rows.push({ kind: "no-newline", raw, hunkHeader });
			continue;
		}
		if (raw.startsWith("+")) {
			rows.push({ kind: "added", raw, content: raw.slice(1), newLine, hunkHeader });
			newLine++;
			linesAdded++;
			continue;
		}
		if (raw.startsWith("-")) {
			rows.push({ kind: "removed", raw, content: raw.slice(1), oldLine, hunkHeader });
			oldLine++;
			linesRemoved++;
			continue;
		}
		if (raw.startsWith(" ")) {
			rows.push({ kind: "context", raw, content: raw.slice(1), oldLine, newLine, hunkHeader });
			oldLine++;
			newLine++;
		}
	}
	return { rows, linesAdded, linesRemoved };
}

/** Parses a frozen git-format patch into independently addressable file occurrences. */
export function parseReviewDiffSnapshot(rawDiff: string): ReviewDiffSnapshot {
	const files: ReviewDiffSnapshot["files"] = [];
	const excluded: ExcludedReviewFile[] = [];
	const occurrences = new Map<string, number>();
	let totalAdded = 0;
	let totalRemoved = 0;
	let diffIndex = 0;

	for (const rawFileDiff of splitFileDiffs(rawDiff)) {
		diffIndex++;
		const { oldPath, newPath } = parseGitDiffSectionPaths(rawFileDiff, { normalizeCrlf: true });
		const path = newPath ?? oldPath;
		if (path === undefined) continue;
		const lines = rawFileDiff.split(/\r?\n/);
		const parsed = parseRows(lines);
		const exclusionReason = EXCLUDED_PATTERNS.find(entry => entry.pattern.test(path))?.reason;
		if (exclusionReason !== undefined) {
			excluded.push({
				path,
				reason: exclusionReason,
				linesAdded: parsed.linesAdded,
				linesRemoved: parsed.linesRemoved,
			});
			continue;
		}
		const occurrence = (occurrences.get(path) ?? 0) + 1;
		occurrences.set(path, occurrence);
		files.push({
			path,
			diffIndex,
			oldPath,
			newPath,
			occurrence,
			rawDiff: rawFileDiff,
			rows: parsed.rows,
			linesAdded: parsed.linesAdded,
			linesRemoved: parsed.linesRemoved,
			isBinary: lines.some(line => line.startsWith("Binary files ") || line === "GIT binary patch"),
		});
		totalAdded += parsed.linesAdded;
		totalRemoved += parsed.linesRemoved;
	}
	return { files, excluded, totalAdded, totalRemoved };
}

export function getRecommendedReviewAgentCount(snapshot: ReviewDiffSnapshot): number {
	const totalLines = snapshot.totalAdded + snapshot.totalRemoved;
	const fileCount = snapshot.files.length;
	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

/** Returns content rows only, preserving the patch's original row ordering. */
export function getReviewDiffPreview(rawDiff: string, maxLines: number): string {
	const content: string[] = [];
	for (const line of rawDiff.split("\n")) {
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@")
		)
			continue;
		content.push(line);
		if (content.length >= maxLines) break;
	}
	return content.join("\n");
}
