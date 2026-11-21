/**
 * Line operations of a `magic` edit: how the apply model changes a file it was
 * shown with line numbers, without retyping what is already there.
 *
 * A reply is one JSON array per line, each an operation on original line
 * numbers: `["delete",12,14]`, `["sub",7,"old","new"]`,
 * `["move",20,41,"before",3]`, `["swap",20,49,51,74]`, `["dedent",13,17,2]`,
 * `["insert","after",15,"text"]`, `["replace",9,9,"text"]`. The reader accepts
 * the wrappings small models add (fences, an outer array, quoted numbers,
 * commentary after the operations) and the near-miss forms {@link normalize}
 * lists. The line number of a `sub` is a hint when only one shown line holds
 * its text, and several inserts at one place are one. Nothing else is guessed.
 *
 * All operations compile to one exact `replace` edit of the snapshot. Blank
 * lines between blocks are separators the compiler places itself, so a range
 * that is one blank line off gives the same result.
 */
import { detectIndentFromContent } from "../lsp/format-options";
import { blockEnd, type FileView, fileLines } from "./magic-view";
import type { ReplaceBatchParams } from "./schemas";

interface Splice {
	/** Half-open, zero-based indices into the original lines. */
	from: number;
	to: number;
	lines: readonly string[];
}

interface Shift {
	from: number;
	to: number;
	prefix: string;
	dedent: boolean;
}

/** Forms the operations take, quoted back to the model when one is malformed. */
const FORMS: Record<string, string> = {
	delete: '["delete", first, last]',
	replace: '["replace", first, last, "text"]',
	sub: '["sub", line or "all", "old", "new"]',
	insert: '["insert", "before" or "after", line, "text"]',
	move: '["move", first, last, "before" or "after", line]',
	swap: '["swap", first, last, first2, last2]',
	indent: '["indent", first, last, spaces or "tab"]',
	dedent: '["dedent", first, last, spaces or "tab"]',
};

const isText = (value: unknown): value is string => typeof value === "string" && !/[\r\0]/.test(value);
const isSide = (value: unknown): value is "before" | "after" => value === "before" || value === "after";

/** A line that leaves a block open: nothing separates it from the first line inside. */
const OPENS_BLOCK = /[[({:]\s*$/;
/** A line that closes a block: nothing separates it from the last line inside. */
const CLOSES_BLOCK = /^\s*[\])}]/;

/** Positions of each operation that hold line numbers or counts; some models quote them. */
const NUMBERS: Record<string, readonly number[]> = {
	delete: [1, 2],
	replace: [1, 2],
	sub: [1],
	insert: [2],
	move: [1, 2, 4],
	swap: [1, 2, 3, 4],
	indent: [1, 2, 3],
	dedent: [1, 2, 3],
};

/** `{` opening an operation written with braces, `{"sub", 4, …}`. */
const BRACED_OPERATION = /^\{\s*"[a-z]+"\s*,/;

/** Index of the bracket closing the one at `text[start]` (`[` or `{`), or -1 when it never closes. */
function bracketEnd(text: string, start: number): number {
	let depth = 0;
	let quoted = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (char === "\\") index++;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === "[" || char === "{") depth++;
		else if ((char === "]" || char === "}") && --depth === 0) return index;
	}
	return -1;
}

/**
 * The operations a reply holds. Code fences, one fence per operation, one
 * outer array, a leading `[]`, braces instead of brackets, quoted numbers and
 * commentary after the operations are all accepted. Operations after
 * commentary mean the model revised its answer: the reply is unusable
 * (`undefined`), as is an array that is not JSON or never closes.
 * `commented` tells that commentary follows the last operation.
 */
function readOperations(reply: string): { operations: unknown[]; commented: boolean } | undefined {
	const operations: unknown[] = [];
	let commented = false;
	let index = 0;
	while (index < reply.length) {
		const char = reply[index];
		if (/[\s,\]]/.test(char)) {
			index++;
			continue;
		}
		const braced = char === "{" && BRACED_OPERATION.test(reply.slice(index, index + 40));
		if (char !== "[" && !braced) {
			// A fence line, or commentary: neither holds an operation.
			if (!reply.startsWith("```", index) && operations.length > 0) commented = true;
			const lineEnd = reply.indexOf("\n", index);
			index = lineEnd === -1 ? reply.length : lineEnd + 1;
			continue;
		}
		const end = bracketEnd(reply, index);
		if (end === -1 || commented) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(`[${reply.slice(index + 1, end)}]`);
		} catch {
			// An outer array of braced operations: read its inside the same way, once (braces nest no deeper).
			const inner = reply[index] === "[" ? readOperations(reply.slice(index + 1, end)) : undefined;
			if (
				!inner ||
				inner.commented ||
				!reply
					.slice(index + 1, end)
					.trimStart()
					.startsWith("{")
			)
				return undefined;
			value = inner.operations;
		}
		const found = Array.isArray(value) && value.every(item => Array.isArray(item)) ? value : [value];
		for (const operation of found) {
			if (!Array.isArray(operation) || operation.length === 0) continue;
			for (const position of NUMBERS[operation[0]] ?? []) {
				if (typeof operation[position] === "string" && /^\d+$/.test(operation[position])) {
					operation[position] = Number(operation[position]);
				}
			}
			operations.push(operation);
		}
		index = end + 1;
	}
	return { operations, commented };
}

/**
 * Near-miss forms models write, rewritten in place to the form the compiler
 * takes: `remove` for `delete`; one number for a one-line `delete`; two line
 * numbers, or `a, b, b, a`, for a `swap` of two lines; a negative amount for
 * the opposite shift; and no amount for one step of the file's indentation.
 */
function normalize(operation: unknown[], content: string): void {
	if (operation[0] === "remove") operation[0] = "delete";
	const [name, a, b, c, d] = operation;
	if (name === "delete" && operation.length === 2) {
		operation.push(a);
	} else if (
		name === "swap" &&
		(operation.length === 3 || (operation.length === 5 && a === d && b === c && a !== b))
	) {
		operation.splice(1, operation.length - 1, a, a, b, b);
	} else if (name === "indent" || name === "dedent") {
		if (operation.length === 3) {
			const indent = detectIndentFromContent(content);
			const step = indent.insertSpaces === false ? "tab" : indent.tabSize;
			if (step !== undefined) operation.push(step);
		} else if (typeof c === "number" && c < 0) {
			operation[0] = name === "indent" ? "dedent" : "indent";
			operation[3] = -c;
		}
	}
}

/** Inclusive one-based line range. */
type Range = [first: number, last: number];

/**
 * Doubts about ranges that delete, move or swap whole lines: the range's
 * first line opens a block, and the range stops inside that block, or runs
 * past it into lines that are not whole blocks of their own (a comment or a
 * statement that follows the block).
 */
export function blockHints(content: string, ranges: readonly Range[], view: FileView): string {
	const lines = fileLines(content);
	const isBlank = (index: number) => lines[index].trim() === "";
	// Only a block that lies within one shown stretch can be named; an excerpt may hide where others end.
	const shownWith = (from: number, to: number) =>
		!view.partial || view.shown.some(([start, end]) => from >= start && to <= end);
	const hints: string[] = [];
	for (const [first, last] of ranges) {
		let start = first - 1;
		let stop = last - 1;
		while (start < stop && isBlank(start)) start++;
		while (stop > start && isBlank(stop)) stop--;
		// Blank lines open nothing.
		if (isBlank(start)) continue;
		const end = blockEnd(lines, start, lines.length);
		if (end === start || end === stop || !shownWith(start, end)) continue;
		// Unwrapping: the opening line goes alone, and another range takes the line that closes its block.
		if (start === stop && ranges.some(([from, to]) => from === end + 1 && to === end + 1)) continue;
		let whole = stop > end;
		for (let at = end + 1; whole && at <= stop; at++) {
			if (isBlank(at)) continue;
			const unit = blockEnd(lines, at, lines.length);
			whole = unit > at && unit <= stop && shownWith(at, unit);
			at = unit;
		}
		if (whole) continue;
		const text = lines[stop].trim();
		hints.push(
			`line ${start + 1} opens a block that ends on line ${end + 1}, but the range ends on line ${stop + 1} (\`${text.length > 60 ? `${text.slice(0, 60)}…` : text}\`)`,
		);
	}
	return hints.join("; ");
}

/**
 * Compile a line-operation reply into one `replace` edit of `content`, the LF
 * snapshot `view` was cut from. `cut` marks a reply that ran into the output
 * limit: it counts only when commentary shows its operations were finished.
 * `ranges` are the line ranges the reply deletes, moves or swaps, for
 * {@link blockHints}. `problem` is worded for the model: an unreadable reply,
 * a malformed or unknown operation, a line outside the file or the shown
 * excerpt, operations on the same lines, indentation that is not there to
 * remove, or no change.
 */
export function compileLineEdits(
	reply: string,
	content: string,
	view: FileView,
	cut = false,
): { edit: ReplaceBatchParams["edits"][number]; ranges: Range[] } | { problem: string } {
	const read = readOperations(reply);
	// A reply cut at the output limit counts only if commentary shows the model had finished its list.
	if (!read || read.operations.length === 0 || (cut && !read.commented)) {
		return { problem: "Output only JSON operation arrays, one per line, and nothing else." };
	}
	const parsed = read.operations;
	if (content === "") return { problem: "Cannot anchor an edit in an empty file; use write instead." };
	// A repeated operation is the same request twice.
	const seen = new Set<string>();
	const operations = parsed.filter(operation => {
		const key = JSON.stringify(operation);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const lines = fileLines(content);
	const visible = (from: number, to: number) =>
		!view.partial || view.shown.some(([start, end]) => from >= start && to <= end);
	const isLine = (value: unknown): value is number =>
		typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= lines.length;
	const splices: Splice[] = [];
	const shifts: Shift[] = [];
	/** Ranges whose lines leave their place: indentation must not shift them. */
	const moved: [number, number][] = [];
	/** Ranges the operations delete, move or swap, as numbered in the reply. */
	const ranges: Range[] = [];
	/** Per-line substitutions, applied in order to the original line. */
	const subs = new Map<number, string>();
	/** New lines per insertion point, in the order given: several inserts at one place are one. */
	const inserts = new Map<number, string[]>();
	// Blank lines separate blocks rather than belong to them. Only shown lines count:
	// a separator never reaches into lines the model did not see.
	const isBlank = (index: number) => lines[index].trim() === "" && visible(index, index);
	/** `[from, to)` without the blank lines at its ends. */
	const core = (from: number, to: number): [number, number] => {
		while (from < to && isBlank(from)) from++;
		while (to > from && isBlank(to - 1)) to--;
		return [from, to];
	};
	/**
	 * Lines that leave with `[from, to)`. A block set off on both sides takes one
	 * run of blank lines along, so one separator remains where it was: the
	 * shorter run when both sides have one, else the run on the side that has
	 * one, when the other side is the edge of the file or of the enclosing block
	 * (a line that opens it above, closes it below). `carried` counts them.
	 */
	const withSeparator = (from: number, to: number): { from: number; to: number; carried: number } => {
		if (from === to || isBlank(from) || isBlank(to - 1)) return { from, to, carried: 0 };
		let above = 0;
		while (from - above > 0 && isBlank(from - above - 1)) above++;
		let below = 0;
		while (to + below < lines.length && isBlank(to + below)) below++;
		const top = from - above === 0 || (above === 0 && OPENS_BLOCK.test(lines[from - 1]));
		const bottom = to + below === lines.length || (below === 0 && CLOSES_BLOCK.test(lines[to]));
		if (above > 0 && below > 0) {
			const carried = Math.min(above, below);
			return { from, to: to + carried, carried };
		}
		if (below > 0 && top) return { from, to: to + below, carried: below };
		if (above > 0 && bottom) return { from: from - above, to, carried: above };
		return { from, to, carried: 0 };
	};

	for (const [index, operation] of operations.entries()) {
		// Problems quote the operation as the model wrote it.
		const written = JSON.stringify(operation);
		const problem = (reason: string) => ({ problem: `Operation ${index + 1} (${written}): ${reason}` });
		if (!Array.isArray(operation)) return problem("expected an operation array.");
		normalize(operation, content);
		const [name] = operation;
		const form = typeof name === "string" ? FORMS[name] : undefined;
		if (!form) return problem(`unknown operation; use one of ${Object.keys(FORMS).join(", ")}.`);
		const malformed = () => problem(`expected ${form}.`);
		const range = (first: unknown, last: unknown): [number, number] | undefined => {
			if (!isLine(first) || !isLine(last) || first > last) return undefined;
			if (name === "delete" || name === "move" || name === "swap") ranges.push([first, last]);
			return [first - 1, last];
		};
		const hidden = (from: number, to: number) => !visible(from, to - 1);

		switch (name) {
			case "delete": {
				const span = operation.length === 3 ? range(operation[1], operation[2]) : undefined;
				if (!span) return malformed();
				if (hidden(...span)) return problem("range includes lines not shown.");
				const { from, to } = withSeparator(...span);
				splices.push({ from, to, lines: [] });
				break;
			}
			case "replace": {
				const span = operation.length === 4 ? range(operation[1], operation[2]) : undefined;
				if (!span || !isText(operation[3])) return malformed();
				if (hidden(...span)) return problem("range includes lines not shown.");
				splices.push({ from: span[0], to: span[1], lines: operation[3].split("\n") });
				break;
			}
			case "sub": {
				const [, line, old, replacement] = operation;
				if (
					operation.length !== 4 ||
					(line !== "all" && !isLine(line)) ||
					!isText(old) ||
					old === "" ||
					!isText(replacement)
				) {
					return malformed();
				}
				if (old.includes("\n") || replacement.includes("\n")) return problem("sub changes text within one line.");
				const current = (at: number) => subs.get(at) ?? lines[at];
				if (line === "all") {
					let found = false;
					for (let at = 0; at < lines.length; at++) {
						if (!current(at).includes(old)) continue;
						subs.set(at, current(at).replaceAll(old, replacement));
						found = true;
					}
					if (!found) return problem(`the file does not contain ${JSON.stringify(old)}.`);
					break;
				}
				if (hidden(line - 1, line)) return problem("line is not shown.");
				if (!current(line - 1).includes(old)) {
					const holders: number[] = [];
					for (let at = 0; at < lines.length; at++) {
						if (lines[at].includes(old) && visible(at, at)) holders.push(at);
					}
					// The line number is a hint: text that only one shown line holds is meant there.
					if (holders.length === 1) {
						subs.set(holders[0], current(holders[0]).replaceAll(old, replacement));
						break;
					}
					const gap = Math.min(...holders.map(at => Math.abs(at + 1 - line)));
					const nearest = holders.filter(at => Math.abs(at + 1 - line) === gap).map(at => at + 1);
					const where = nearest.length > 0 ? `; the nearest line that does is ${nearest.join(" or ")}` : "";
					return problem(`line ${line} does not contain ${JSON.stringify(old)}${where}.`);
				}
				subs.set(line - 1, current(line - 1).replaceAll(old, replacement));
				break;
			}
			case "insert": {
				const [, side, line, text] = operation;
				if (operation.length !== 4 || !isSide(side) || !isLine(line) || !isText(text)) return malformed();
				if (hidden(line - 1, line)) return problem("anchor line is not shown.");
				const at = side === "before" ? line - 1 : line;
				const added = inserts.get(at) ?? [];
				inserts.set(at, added);
				added.push(...text.split("\n"));
				break;
			}
			case "move": {
				const [, first, last, side, line] = operation;
				const span = operation.length === 5 && isSide(side) && isLine(line) ? range(first, last) : undefined;
				if (!span) return malformed();
				if (hidden(...span) || hidden(line - 1, line)) return problem("range or destination is not shown.");
				const block = core(...span);
				if (block[0] === block[1]) return problem("the range holds only blank lines.");
				const source = withSeparator(...block);
				const at = side === "before" ? line - 1 : line;
				if (at > source.from && at < source.to) return problem("the destination is inside the moved lines.");
				if (at === source.from || at === source.to) {
					return problem(
						`lines ${first}-${last} are already ${side} line ${line} (blank lines between blocks stay as separators), so nothing moves; to exchange two blocks, use swap.`,
					);
				}
				// A block that was set off by blank lines is set off again where it lands, except right inside a block.
				const pad = (neighbour: number, edge: RegExp) =>
					source.carried > 0 &&
					neighbour >= 0 &&
					neighbour < lines.length &&
					!isBlank(neighbour) &&
					!edge.test(lines[neighbour])
						? source.carried
						: 0;
				const moving: string[] = Array.from({ length: pad(at - 1, OPENS_BLOCK) }, () => "");
				moving.push(...lines.slice(...block));
				for (let after = pad(at, CLOSES_BLOCK); after > 0; after--) moving.push("");
				splices.push({ from: source.from, to: source.to, lines: [] }, { from: at, to: at, lines: moving });
				moved.push([source.from, source.to]);
				break;
			}
			case "swap": {
				const first = operation.length === 5 ? range(operation[1], operation[2]) : undefined;
				const second = operation.length === 5 ? range(operation[3], operation[4]) : undefined;
				if (!first || !second) return malformed();
				if (hidden(...first) || hidden(...second)) return problem("a range includes lines not shown.");
				// Blank lines at the edges are separators, not content: they stay in place.
				const [a, b] = [core(...first), core(...second)].sort((x, y) => x[0] - y[0]);
				if (a[0] === a[1] || b[0] === b[1]) return problem("a range holds only blank lines.");
				if (b[0] < a[1]) return problem("the two ranges overlap.");
				splices.push(
					{ from: a[0], to: a[1], lines: lines.slice(...b) },
					{ from: b[0], to: b[1], lines: lines.slice(...a) },
				);
				moved.push(a, b);
				break;
			}
			case "indent":
			case "dedent": {
				const [, first, last, amount] = operation;
				const span = operation.length === 4 ? range(first, last) : undefined;
				if (!span || (amount !== "tab" && (!Number.isInteger(amount) || amount < 1 || amount > 64))) {
					return malformed();
				}
				if (hidden(...span)) return problem("range includes lines not shown.");
				shifts.push({
					from: span[0],
					to: span[1],
					prefix: amount === "tab" ? "\t" : " ".repeat(amount),
					dedent: name === "dedent",
				});
				break;
			}
		}
	}
	for (const [line, text] of subs) splices.push({ from: line, to: line + 1, lines: [text] });
	for (const [at, added] of inserts) splices.push({ from: at, to: at, lines: added });

	splices.sort((a, b) => a.from - b.from || a.to - b.to);
	for (let i = 1; i < splices.length; i++) {
		const previous = splices[i - 1];
		const next = splices[i];
		if (next.from < previous.to || (next.from === next.to && previous.from === next.from)) {
			return {
				problem:
					"Two operations touch the same lines or insert at the same place. Give each line at most one operation, numbered against the original file.",
			};
		}
	}

	shifts.sort((a, b) => a.from - b.from);
	for (const [i, shift] of shifts.entries()) {
		if (i > 0 && shift.from < shifts[i - 1].to) return { problem: "Indentation ranges overlap." };
		if (moved.some(([from, to]) => from < shift.to && to > shift.from)) {
			return { problem: "Indentation ranges must not overlap lines that move or swap." };
		}
	}

	// Keep one neighbouring line at each end to anchor empty lines and insertions.
	// Fall back to the complete snapshot if that span occurs more than once.
	let from = Math.max(0, Math.min(splices[0]?.from ?? lines.length, shifts[0]?.from ?? lines.length) - 1);
	let to = Math.min(lines.length, Math.max(splices.at(-1)?.to ?? 0, shifts.at(-1)?.to ?? 0) + 1);
	const finalNewline = content.endsWith("\n");
	let old = lines.slice(from, to).join("\n") + (to < lines.length || finalNewline ? "\n" : "");
	if (!old || content.indexOf(old) !== content.lastIndexOf(old)) {
		from = 0;
		to = lines.length;
		old = content;
	}
	const replacement: string[] = [];
	let cursor = from;
	let shiftIndex = 0;
	splices.push({ from: to, to, lines: [] });
	for (const splice of splices) {
		while (cursor < splice.from) {
			const line = lines[cursor];
			while (shiftIndex < shifts.length && shifts[shiftIndex].to <= cursor) shiftIndex++;
			const shift = shifts[shiftIndex];
			if (shift === undefined || shift.from > cursor || line.trim() === "") replacement.push(line);
			else if (!shift.dedent) replacement.push(shift.prefix + line);
			else if (line.startsWith(shift.prefix)) replacement.push(line.slice(shift.prefix.length));
			else return { problem: `Line ${cursor + 1} does not have the specified indentation to remove.` };
			cursor++;
		}
		for (const line of splice.lines) replacement.push(line);
		cursor = splice.to;
	}
	const next = replacement.join("\n") + (replacement.length && (to < lines.length || finalNewline) ? "\n" : "");
	if (old === next) return { problem: "The operations produce no changes." };
	return { edit: { old_string: old, new_string: next }, ranges };
}
