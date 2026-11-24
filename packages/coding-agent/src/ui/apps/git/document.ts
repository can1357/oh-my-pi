/**
 * The aligned diff of one file the git diff pane shows: rows pairing old and
 * new lines (changed lines side by side with word-level emphasis, one-sided
 * additions and deletions), the tight hunks (3 context lines) with their
 * standalone patches for hunk staging, and the new side for the file view.
 *
 * Whitespace modes: `whitespace` aligns on trimmed lines (no patches: the
 * alignment no longer matches git's view); `formatting` aligns exactly but
 * demotes changed blocks that only move whitespace around, or only touch
 * import statements (ts/js, rust, go), to context.
 */
import { diffWords, type PatchHunk, structuredPatchHunks } from "@oh-my-pi/pi-natives";
import { replaceTabs, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { DiffBuildOptions, DiffDocument, HunkBlock } from "../../../cli/git-tui/model/diff-pane";
import { DIFF_CONTEXT_LINES } from "../../../cli/git-tui/model/state";

/** One aligned row of a {@link DiffDocument}. */
export type DiffRow = DiffDocument["rows"][number];
type RowKind = DiffRow["kind"];
type Marks = [number, number][];

/** Word-diff pairs computed per document at most (huge rewrites stay cheap). */
const INTRALINE_PAIR_LIMIT = 1_500;

/** A line as the pane draws it: control sequences stripped, tabs expanded. */
export function displayLine(line: string): string {
	return replaceTabs(sanitizeText(line));
}

/** Column ranges of the words that differ between two versions of a line. */
function wordMarks(oldLine: string, newLine: string): { old: Marks; new: Marks } {
	const marks = { old: [] as Marks, new: [] as Marks };
	let oldCol = 0;
	let newCol = 0;
	const add = (ranges: Marks, start: number, end: number): void => {
		if (end <= start) return;
		const last = ranges[ranges.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else ranges.push([start, end]);
	};
	for (const part of diffWords(oldLine, newLine)) {
		const width = visibleWidth(part.value);
		if (part.removed) {
			add(marks.old, oldCol, oldCol + width);
			oldCol += width;
		} else if (part.added) {
			add(marks.new, newCol, newCol + width);
			newCol += width;
		} else {
			oldCol += width;
			newCol += width;
		}
	}
	return marks;
}

type ImportLang = "ts" | "rust" | "go";

const IMPORT_LANG: Readonly<Record<string, ImportLang>> = {
	ts: "ts",
	tsx: "ts",
	mts: "ts",
	cts: "ts",
	js: "ts",
	jsx: "ts",
	mjs: "ts",
	cjs: "ts",
	rs: "rust",
	go: "go",
};

/**
 * Import statements per language: `starter` opens one, `continuation` admits
 * the inner and closing lines of a multi-line block, `removable` matches a
 * self-contained import line.
 */
const IMPORTS: Readonly<Record<ImportLang, { starter: RegExp; continuation: RegExp; removable: RegExp }>> = {
	ts: {
		starter: /^import\b|^export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']/,
		continuation:
			/^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?$|^\}\s*from\s*["'][^"']*["'](?:\s*with\s*\{[^}]*\})?\s*;?$/,
		removable:
			/^import\b[^"']*["'][^"']*["'][^"']*$|^export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']*["']\s*;?$|^\}\s*from\s*["'][^"']*["'](?:\s*with\s*\{[^}]*\})?\s*;?$/,
	},
	rust: {
		starter: /^(?:pub(?:\([^)]*\))?\s+)?use\b|^extern\s+crate\b/,
		continuation: /^[\w:*{},\s]+;?$/,
		removable: /^(?:pub(?:\([^)]*\))?\s+)?use\b[^;]*;$|^extern\s+crate\s+[^;]+;$/,
	},
	go: {
		starter: /^import\b/,
		continuation: /^(?:[\w.]+\s+)?"[^"]+"\s*,?$|^[()]$/,
		removable: /^import\b.*$|^(?:[\w.]+\s+)?"[^"]+"$|^\)$/,
	},
};

/** The `diff --git` header of a single-file patch. */
export function filePatchHeader(filePath: string): string {
	return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n`;
}

const splitLines = (text: string): string[] => (text.length === 0 ? [] : text.replace(/\n$/, "").split("\n"));

/** Build the aligned document of one file from its raw old/new texts (see the module docs). */
export function buildDiffDocument(
	oldRaw: string,
	newRaw: string,
	filePath: string,
	options: DiffBuildOptions = {},
): DiffDocument {
	const mode = options.whitespace ?? "off";
	const trimmed = mode === "whitespace";
	const formatting = mode === "formatting";
	const dot = filePath.lastIndexOf(".");
	const importLang = formatting && dot >= 0 ? IMPORT_LANG[filePath.slice(dot + 1).toLowerCase()] : undefined;
	const oldLines = splitLines(oldRaw);
	const newLines = splitLines(newRaw);
	const oldShown = oldLines.map(displayLine);
	const newShown = newLines.map(displayLine);
	const basis = (raw: string, lines: string[]): string =>
		trimmed ? lines.map(line => line.trim()).join("\n") + (raw.endsWith("\n") ? "\n" : "") : raw;
	const oldBasis = basis(oldRaw, oldLines);
	const newBasis = basis(newRaw, newLines);

	let additions = 0;
	let deletions = 0;
	let pairs = 0;
	let maxLineWidth = 0;
	const measure = (line: string | undefined): void => {
		if (line !== undefined && line.length > maxLineWidth) maxLineWidth = line.length;
	};

	const row = (kind: RowKind, oldIndex: number | undefined, newIndex: number | undefined): DiffRow => {
		const oldText = oldIndex === undefined ? "" : (oldShown[oldIndex] ?? "");
		const newText = newIndex === undefined ? "" : (newShown[newIndex] ?? "");
		let marks: { old: Marks; new: Marks } | undefined;
		if (kind === "change" && oldIndex !== undefined && newIndex !== undefined && pairs < INTRALINE_PAIR_LIMIT) {
			pairs++;
			marks = wordMarks(oldText, newText);
		}
		return {
			kind,
			oldNum: oldIndex === undefined ? undefined : oldIndex + 1,
			newNum: newIndex === undefined ? undefined : newIndex + 1,
			oldText,
			newText,
			oldWidth: oldIndex === undefined ? 0 : visibleWidth(oldText),
			newWidth: newIndex === undefined ? 0 : visibleWidth(newText),
			oldMarks: marks?.old,
			newMarks: marks?.new,
			oldRaw: oldIndex === undefined ? undefined : oldLines[oldIndex],
			newRaw: newIndex === undefined ? undefined : newLines[newIndex],
		};
	};

	/** Whether a changed block only reflows whitespace or touches imports (formatting mode). */
	const cosmetic = (dels: readonly number[], adds: readonly number[]): boolean => {
		if (!formatting) return false;
		const squeeze = (lines: string[], indices: readonly number[], skip?: RegExp): string => {
			let out = "";
			for (const index of indices) {
				const line = lines[index] ?? "";
				if (skip?.test(line.trim())) continue;
				out += line.replace(/\s+/g, "");
			}
			return out;
		};
		if (squeeze(oldLines, dels) === squeeze(newLines, adds)) return true;
		if (!importLang) return false;
		const rules = IMPORTS[importLang];
		let sawStarter = false;
		const onlyImports = (lines: string[], indices: readonly number[]): boolean =>
			indices.every(index => {
				const line = (lines[index] ?? "").trim();
				if (line.length === 0) return true;
				if (rules.starter.test(line)) {
					sawStarter = true;
					return true;
				}
				return rules.continuation.test(line);
			});
		if (onlyImports(oldLines, dels) && onlyImports(newLines, adds) && sawStarter) return true;
		return squeeze(oldLines, dels, rules.removable) === squeeze(newLines, adds, rules.removable);
	};

	/** Rows of one del/add block: paired changes, then the one-sided rest. */
	const block = (out: DiffRow[], dels: number[], adds: number[], count: boolean): void => {
		if (dels.length === 0 && adds.length === 0) return;
		const paired = Math.min(dels.length, adds.length);
		const demoted = cosmetic(dels, adds);
		if (!demoted && count) {
			deletions += dels.length;
			additions += adds.length;
		}
		for (let i = 0; i < paired; i++) out.push(row(demoted ? "context" : "change", dels[i], adds[i]));
		for (let i = paired; i < dels.length; i++) out.push(row(demoted ? "context" : "del", dels[i], undefined));
		for (let i = paired; i < adds.length; i++) out.push(row(demoted ? "context" : "add", undefined, adds[i]));
	};

	/** Aligned rows of one unified hunk. */
	const hunkRows = (hunk: PatchHunk, count: boolean): DiffRow[] => {
		const out: DiffRow[] = [];
		let oldIndex = hunk.oldStart - 1;
		let newIndex = hunk.newStart - 1;
		let dels: number[] = [];
		let adds: number[] = [];
		const flush = (): void => {
			block(out, dels, adds, count);
			dels = [];
			adds = [];
		};
		for (const line of hunk.lines) {
			const tag = line[0];
			if (tag === "\\") continue;
			if (tag === "-") {
				measure(oldShown[oldIndex]);
				dels.push(oldIndex++);
			} else if (tag === "+") {
				measure(newShown[newIndex]);
				adds.push(newIndex++);
			} else {
				flush();
				measure(oldShown[oldIndex]);
				measure(newShown[newIndex]);
				out.push(row("context", oldIndex++, newIndex++));
			}
		}
		flush();
		return out;
	};

	const streamed = trimmed ? undefined : options.streamResult;
	const rows: DiffRow[] = [];
	if (streamed) {
		let oldIndex = 0;
		let newIndex = 0;
		let dels: number[] = [];
		let adds: number[] = [];
		const flush = (): void => {
			block(rows, dels, adds, true);
			dels = [];
			adds = [];
		};
		for (const run of streamed.runs) {
			for (let i = 0; i < run.count; i++) {
				if (run.removed) {
					measure(oldShown[oldIndex]);
					dels.push(oldIndex++);
				} else if (run.added) {
					measure(newShown[newIndex]);
					adds.push(newIndex++);
				} else {
					if (i === 0) flush();
					measure(oldShown[oldIndex]);
					measure(newShown[newIndex]);
					rows.push(row("context", oldIndex++, newIndex++));
				}
			}
		}
		flush();
	} else {
		// One hunk spanning the whole file aligns every line.
		const whole = structuredPatchHunks(oldBasis, newBasis, oldLines.length + newLines.length + 1);
		for (const hunk of whole) rows.push(...hunkRows(hunk, true));
		if (whole.length === 0) {
			for (let i = 0; i < oldLines.length; i++) {
				measure(oldShown[i]);
				rows.push(row("context", i, i));
			}
		}
	}

	const canPatch = !trimmed;
	const tight = streamed?.hunks ?? structuredPatchHunks(oldBasis, newBasis, DIFF_CONTEXT_LINES);
	const header = canPatch && tight.length > 0 ? filePatchHeader(filePath) : "";
	let hunks: HunkBlock[] = tight.map(hunk => {
		const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
		return {
			header: range,
			patch: canPatch ? `${header}${range}\n${hunk.lines.join("\n")}\n` : "",
			rows: hunkRows(hunk, false),
		};
	});
	// Formatting mode: hunks left with only demoted blocks drop out of the hunk view.
	if (formatting) hunks = hunks.filter(hunk => hunk.rows.some(candidate => candidate.kind !== "context"));

	const rowIndexByNewLine = Array.from({ length: newLines.length + 1 }, () => -1);
	rows.forEach((candidate, index) => {
		if (candidate.newNum !== undefined && rowIndexByNewLine[candidate.newNum] === -1) {
			rowIndexByNewLine[candidate.newNum] = index;
		}
	});
	return {
		filePath,
		rows,
		hunks,
		fileLines: newShown.map(text => ({ text, width: visibleWidth(text) })),
		oldDisplayLines: oldShown,
		newDisplayLines: newShown,
		additions,
		deletions,
		gutterWidth: Math.max(3, String(Math.max(oldLines.length, newLines.length)).length),
		maxLineWidth,
		canPatch,
		rawOld: oldRaw,
		rawNew: newRaw,
		oldEndsNewline: oldRaw.endsWith("\n"),
		newEndsNewline: newRaw.endsWith("\n"),
		rowIndexByNewLine,
	};
}
