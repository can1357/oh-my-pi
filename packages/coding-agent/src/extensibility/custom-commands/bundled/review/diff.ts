import type { ReviewDiffFile, ReviewDiffRow } from "@oh-my-pi/pi-tui/overlays/annotation-types";

export interface ExcludedReviewFile {
	path: string;
	reason: string;
	linesAdded: number;
	linesRemoved: number;
}

export interface ReviewDiffSnapshot {
	files: ReviewDiffFile[];
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

function decodeGitPath(token: string): string {
	if (!(token.startsWith('"') && token.endsWith('"'))) return token;
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	for (let index = 1; index < token.length - 1; index++) {
		const character = token[index]!;
		if (character !== "\\") {
			bytes.push(...encoder.encode(character));
			continue;
		}
		const escaped = token[++index];
		if (escaped === undefined) break;
		const escapes: Record<string, string> = {
			'"': '"',
			"\\": "\\",
			a: "\x07",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "\t",
			v: "\x0b",
		};
		const decoded = escapes[escaped];
		if (decoded !== undefined) {
			bytes.push(...encoder.encode(decoded));
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			while (octal.length < 3 && /[0-7]/.test(token[index + 1] ?? "")) octal += token[++index];
			bytes.push(Number.parseInt(octal, 8));
			continue;
		}
		bytes.push(...encoder.encode(escaped));
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

function readGitToken(input: string, offset: number): { token: string; next: number } | undefined {
	let index = offset;
	while (input[index] === " ") index++;
	if (index >= input.length) return undefined;
	if (input[index] !== '"') {
		const end = input.indexOf(" ", index);
		return end < 0
			? { token: input.slice(index), next: input.length }
			: { token: input.slice(index, end), next: end };
	}
	const start = index++;
	let escaped = false;
	while (index < input.length) {
		const character = input[index++];
		if (character === '"' && !escaped) break;
		if (character === "\\" && !escaped) escaped = true;
		else escaped = false;
	}
	return { token: input.slice(start, index), next: index };
}

function stripDiffPrefix(path: string): string {
	return /^[^/]+\//.test(path) ? path.slice(path.indexOf("/") + 1) : path;
}

function parseHeaderPaths(header: string): { oldPath?: string; newPath?: string } {
	const payload = header.slice("diff --git ".length);
	const oldToken = readGitToken(payload, 0);
	const newToken = oldToken === undefined ? undefined : readGitToken(payload, oldToken.next);
	return {
		oldPath: oldToken === undefined ? undefined : stripDiffPrefix(decodeGitPath(oldToken.token)),
		newPath: newToken === undefined ? undefined : stripDiffPrefix(decodeGitPath(newToken.token)),
	};
}

function parseMarkerPath(line: string): string | undefined {
	const payload = line.slice(4);
	const tab = payload.indexOf("\t");
	const token = payload.startsWith('"')
		? (readGitToken(payload, 0)?.token ?? "")
		: tab < 0
			? payload
			: payload.slice(0, tab);
	const path = decodeGitPath(token);
	return path === "/dev/null" ? undefined : stripDiffPrefix(path);
}

function splitFileDiffs(rawDiff: string): string[] {
	const starts: number[] = [];
	for (const match of rawDiff.matchAll(/^diff --git /gm)) starts.push(match.index!);
	return starts.map((start, index) => {
		const end = starts[index + 1] ?? rawDiff.length;
		const fileDiff = rawDiff.slice(start, end);
		return fileDiff.endsWith("\n") ? fileDiff.slice(0, -1) : fileDiff;
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
	const files: ReviewDiffFile[] = [];
	const excluded: ExcludedReviewFile[] = [];
	const occurrences = new Map<string, number>();
	let totalAdded = 0;
	let totalRemoved = 0;

	for (const rawFileDiff of splitFileDiffs(rawDiff)) {
		const lines = rawFileDiff.split("\n");
		let { oldPath, newPath } = parseHeaderPaths(lines[0] ?? "");
		for (const line of lines) {
			if (HUNK_HEADER_PATTERN.test(line)) break;
			if (line.startsWith("--- ")) oldPath = parseMarkerPath(line);
			else if (line.startsWith("+++ ")) newPath = parseMarkerPath(line);
			else if (line.startsWith("rename from ")) oldPath = decodeGitPath(line.slice("rename from ".length));
			else if (line.startsWith("rename to ")) newPath = decodeGitPath(line.slice("rename to ".length));
		}
		const path = newPath ?? oldPath;
		if (path === undefined) continue;
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
