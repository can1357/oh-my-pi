/**
 * Git patches from whole-content snapshots, for staging exact file contents into an index.
 *
 * The selective commit flow knows the content it wants committed per path (HEAD plus the
 * selected change lines), so it renders a patch from HEAD content to that content instead of
 * editing hunks of a worktree diff: no offsets to recount, no context drift.
 */
import { changedRegions } from "./attribution";
import type { FileState } from "./draft";

/** Context lines around each change, as `git diff` emits by default. */
const CONTEXT = 3;
/** Comparison key suffix marking a final line without a newline terminator. */
const NO_EOL = "\u0000no-eol";
const NO_EOL_MARKER = "\\ No newline at end of file";

/** Lines of `text` with the unterminated final line (if any) keyed apart from a terminated one. */
function patchLines(text: string | null): string[] {
	if (text === null || text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	else lines[lines.length - 1] += NO_EOL;
	return lines;
}

function renderLine(prefix: string, key: string): string {
	return key.endsWith(NO_EOL) ? `${prefix}${key.slice(0, -NO_EOL.length)}\n${NO_EOL_MARKER}\n` : `${prefix}${key}\n`;
}

/** `start,count` of a unified hunk range; a zero-length range names the line before it. */
function hunkRange(start: number, count: number): string {
	return `${count === 0 ? start : start + 1},${count}`;
}

/**
 * Unified git patch turning `before` into `after` at repo-relative `path`; `null` = file absent.
 * Returns `""` when content and mode are equal.
 */
export function formatTextPatch(path: string, before: FileState | null, after: FileState | null): string {
	if (before?.text === after?.text && before?.mode === after?.mode) return "";
	const oldLines = patchLines(before?.text ?? null);
	const newLines = patchLines(after?.text ?? null);
	let out = `diff --git a/${path} b/${path}\n`;
	if (!before && after) out += `new file mode ${after.mode}\n`;
	else if (before && !after) out += `deleted file mode ${before.mode}\n`;
	else if (before && after && before.mode !== after.mode) out += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
	const regions = changedRegions(oldLines, newLines);
	if (regions.length === 0) return out;
	out += `--- ${before === null ? "/dev/null" : `a/${path}`}\n`;
	out += `+++ ${after === null ? "/dev/null" : `b/${path}`}\n`;
	let first = 0;
	while (first < regions.length) {
		let last = first;
		while (last + 1 < regions.length && regions[last + 1].i1 - regions[last].i2 <= 2 * CONTEXT) last++;
		const oldStart = Math.max(0, regions[first].i1 - CONTEXT);
		const oldEnd = Math.min(oldLines.length, regions[last].i2 + CONTEXT);
		const newStart = regions[first].j1 - (regions[first].i1 - oldStart);
		const newEnd = regions[last].j2 + (oldEnd - regions[last].i2);
		out += `@@ -${hunkRange(oldStart, oldEnd - oldStart)} +${hunkRange(newStart, newEnd - newStart)} @@\n`;
		let cursor = oldStart;
		for (let index = first; index <= last; index++) {
			const region = regions[index];
			for (; cursor < region.i1; cursor++) out += renderLine(" ", oldLines[cursor]);
			for (let n = region.i1; n < region.i2; n++) out += renderLine("-", oldLines[n]);
			for (let n = region.j1; n < region.j2; n++) out += renderLine("+", newLines[n]);
			cursor = region.i2;
		}
		for (; cursor < oldEnd; cursor++) out += renderLine(" ", oldLines[cursor]);
		first = last + 1;
	}
	return out;
}
