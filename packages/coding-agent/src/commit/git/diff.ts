import type { DiffHunk, FileDiff, FileHunks, NumstatEntry } from "../../commit/types";

export function parseNumstat(output: string): NumstatEntry[] {
	const entries: NumstatEntry[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const [addedRaw, deletedRaw, pathRaw] = parts;
		const additions = Number.parseInt(addedRaw, 10);
		const deletions = Number.parseInt(deletedRaw, 10);
		const path = extractPathFromRename(pathRaw);
		entries.push({
			path,
			additions: Number.isNaN(additions) ? 0 : additions,
			deletions: Number.isNaN(deletions) ? 0 : deletions,
		});
	}
	return entries;
}

export function parseFileDiffs(diff: string): FileDiff[] {
	const sections: FileDiff[] = [];
	// Split on a line-start lookahead so each block keeps its terminating
	// newline(s) verbatim. Consuming the delimiter would drop the blank line
	// that terminates a `GIT binary patch` block, corrupting binary diffs on
	// rebuild (issue #8899).
	const parts = diff.split(/^(?=diff --git )/m);
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (!part.trim()) continue;
		const lines = part.split("\n");
		const header = lines[0] ?? "";
		const match = header.match(/diff --git a\/(.+?) b\/(.+)$/);
		if (!match) continue;
		const filename = match[2];
		const content = part;
		const isBinary = lines.some(line => line.startsWith("Binary files "));
		let additions = 0;
		let deletions = 0;
		for (const line of lines) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+")) additions += 1;
			else if (line.startsWith("-")) deletions += 1;
		}
		sections.push({
			filename,
			content,
			additions,
			deletions,
			isBinary,
		});
	}
	return sections;
}

export function parseDiffHunks(diff: string): FileHunks[] {
	const files = parseFileDiffs(diff);
	return files.map(file => parseFileHunks(file));
}

export function parseFileHunks(fileDiff: FileDiff): FileHunks {
	if (fileDiff.isBinary) {
		return { filename: fileDiff.filename, isBinary: true, hunks: [] };
	}

	const lines = fileDiff.content.split("\n");
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;
	let buffer: string[] = [];
	let index = 0;

	for (const line of lines) {
		if (line.startsWith("@@")) {
			if (current) {
				current.content = buffer.join("\n");
				hunks.push(current);
			}
			const headerData = parseHunkHeader(line);
			current = {
				index,
				header: line,
				oldStart: headerData.oldStart,
				oldLines: headerData.oldLines,
				newStart: headerData.newStart,
				newLines: headerData.newLines,
				content: "",
			};
			buffer = [line];
			index += 1;
			continue;
		}
		if (current) {
			buffer.push(line);
		}
	}

	if (current) {
		current.content = buffer.join("\n");
		hunks.push(current);
	}

	return {
		filename: fileDiff.filename,
		isBinary: fileDiff.isBinary,
		hunks,
	};
}

function extractPathFromRename(pathPart: string): string {
	const braceStart = pathPart.indexOf("{");
	if (braceStart !== -1) {
		const arrowPos = pathPart.indexOf(" => ", braceStart);
		if (arrowPos !== -1) {
			const braceEnd = pathPart.indexOf("}", arrowPos);
			if (braceEnd !== -1) {
				const prefix = pathPart.slice(0, braceStart);
				const newName = pathPart.slice(arrowPos + 4, braceEnd).trim();
				return `${prefix}${newName}`;
			}
		}
	}

	if (pathPart.includes(" => ")) {
		const parts = pathPart.split(" => ");
		return parts[1]?.trim() ?? pathPart.trim();
	}

	return pathPart.trim();
}

function parseHunkHeader(line: string): {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
} {
	const match = line.match(/@@\s-([0-9]+)(?:,([0-9]+))?\s\+([0-9]+)(?:,([0-9]+))?\s@@/);
	if (!match) {
		return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
	}
	const oldStart = Number.parseInt(match[1] ?? "0", 10);
	const oldLines = Number.parseInt(match[2] ?? "1", 10);
	const newStart = Number.parseInt(match[3] ?? "0", 10);
	const newLines = Number.parseInt(match[4] ?? "1", 10);
	return {
		oldStart: Number.isNaN(oldStart) ? 0 : oldStart,
		oldLines: Number.isNaN(oldLines) ? 0 : oldLines,
		newStart: Number.isNaN(newStart) ? 0 : newStart,
		newLines: Number.isNaN(newLines) ? 0 : newLines,
	};
}
