/**
 * The native `ax()` tree grammar (`crates/pi-natives/src/desktop/ax.rs`
 * `format_tree`): one node per line, pre-order, two spaces of indent per
 * depth, then `- role "label" [ref=eN]: "value" …`. A post-input report marks
 * rows added or changed since the model's last tree with a `+` or `~` bullet.
 */

export interface AxTreeElision {
	text: string;
	elidedRows: number;
}

/** One tree row, read in render order: role, label, ref. */
export interface TreeRow {
	indent: number;
	bullet: "-" | "+" | "~";
	role: string;
	labelled: boolean;
	/** Ref token span `[start, end)`, including its leading space. */
	refStart: number;
	refEnd: number;
	ref: string;
}

const ROW = /^((?: {2})*)([-+~]) (\S+)/;
const REF = /^ \[ref=(e\d+)\]/;
const QUOTE = '"';
const ESCAPE = "\\";

/**
 * Roles a dispatch lands on: the walk's own `interactable()` roles plus the
 * names other platforms' vocabularies give the same controls.
 */
const CONTROL_ROLES: Record<string, true> = {
	button: true,
	checkbox: true,
	radio: true,
	textfield: true,
	textarea: true,
	link: true,
	menuitem: true,
	menubaritem: true,
	tab: true,
	slider: true,
	combobox: true,
	popupbutton: true,
	listitem: true,
	outlineitem: true,
	cell: true,
	menubutton: true,
	searchfield: true,
	disclosuretriangle: true,
	incrementor: true,
	stepper: true,
	colorwell: true,
	datetimearea: true,
	switch: true,
	toggle: true,
};

interface Row {
	/** Index of this row's line in the source text. */
	line: number;
	depth: number;
	/** Row index of the parent, -1 for a depth-0 row. */
	parent: number;
	/** Row indices of the adjacent siblings, -1 at either end. */
	prev: number;
	next: number;
	/** Exclusive row index where this row's subtree ends. */
	subtreeEnd: number;
	/** Carries a label or a value. */
	text: boolean;
	control: boolean;
	marked: boolean;
	subtreeText: boolean;
	subtreeControl: boolean;
	subtreeMarked: boolean;
	/** Bytes this subtree currently renders to: surviving rows plus the placeholders among them. */
	rendered: number;
	/** Direct children not dropped yet. */
	liveChildren: number;
	dropped: boolean;
	/**
	 * Rows removed in the run of dropped siblings this row bounds. Valid only
	 * at a run's two ends, whose `runOther` points at each other.
	 */
	runRows: number;
	runOther: number;
}

/** Index just past a quoted, backslash-escaped string starting at `from`, or -1. */
function quotedEnd(line: string, from: number): number {
	for (let index = from + 1; index < line.length; index++) {
		const char = line[index];
		if (char === ESCAPE) index++;
		else if (char === QUOTE) return index + 1;
	}
	return -1;
}

/**
 * Parse a tree row; non-row lines (headers, the walk's trailers) return
 * undefined. Reading in render order keeps a label holding `[ref=e9]` or
 * `- button` from reading as structure.
 */
export function parseTreeRow(line: string): TreeRow | undefined {
	const match = ROW.exec(line);
	if (!match) return undefined;
	let position = match[0].length;
	const labelled = line.startsWith(' "', position);
	if (labelled) {
		const end = quotedEnd(line, position + 1);
		if (end < 0) return undefined;
		position = end;
	}
	const ref = REF.exec(line.slice(position));
	if (!ref) return undefined;
	return {
		indent: match[1].length,
		bullet: match[2] as TreeRow["bullet"],
		role: match[3],
		labelled,
		refStart: position,
		refEnd: position + ref[0].length,
		ref: ref[1],
	};
}

/** Whether a line is a row a report marked added or changed. */
export function isMarkedRow(line: string): boolean {
	const bullet = parseTreeRow(line)?.bullet;
	return bullet !== undefined && bullet !== "-";
}

function toElisionRow(line: string, index: number): Row | undefined {
	const parsed = parseTreeRow(line);
	if (!parsed) return undefined;
	const depth = parsed.indent / 2;
	// The root's `app=` runs to an unquoted app name, so its value cannot be
	// located reliably; the root is never dropped, so it need not be.
	const value = depth > 0 && line.startsWith(': "', parsed.refEnd);
	return {
		line: index,
		depth,
		parent: -1,
		prev: -1,
		next: -1,
		subtreeEnd: 0,
		text: parsed.labelled || value,
		control: CONTROL_ROLES[parsed.role] === true,
		marked: parsed.bullet !== "-",
		subtreeText: false,
		subtreeControl: false,
		subtreeMarked: false,
		rendered: 0,
		liveChildren: 0,
		dropped: false,
		runRows: 0,
		runOther: -1,
	};
}

/** Bytes a line occupies in the joined text, its newline included. */
function lineBytes(text: string): number {
	return Buffer.byteLength(text, "utf-8") + 1;
}

function placeholder(depth: number, rows: number): string {
	return `${"  ".repeat(depth)}… ${rows} row${rows === 1 ? "" : "s"} elided`;
}

/**
 * Elide ax() text to at most `budget` UTF-8 bytes by removing whole subtrees:
 * empty wrappers, then the deepest subtrees without a control, then those with
 * one, and marked rows last. A wrapper row with no label, value, control or
 * marker goes with its last child. Each run of removed siblings leaves one
 * `… N rows elided` line; the root and non-row lines stay. Undefined when the
 * text already fits, is not a tree (< 2 rows), or cannot be brought under budget.
 */
export function elideAxTree(text: string, budget: number): AxTreeElision | undefined {
	if (budget <= 0) return undefined;
	const lines = text.split("\n");
	const rows: Row[] = [];
	let bytes = -1; // the last line carries no newline
	for (const [index, line] of lines.entries()) {
		bytes += lineBytes(line);
		const row = toElisionRow(line, index);
		if (row) rows.push(row);
	}
	if (rows.length < 2 || bytes <= budget) return undefined;

	// Pre-order: a row's subtree runs until the next row at or above its own
	// depth, and the nearest open row shallower than it is its parent.
	const open: number[] = [];
	const lastChild: number[] = Array.from({ length: rows.length }, () => -1);
	let lastRoot = -1;
	for (const [index, row] of rows.entries()) {
		while (open.length && rows[open[open.length - 1]].depth >= row.depth) rows[open.pop()!].subtreeEnd = index;
		const parent = open.length ? open[open.length - 1] : -1;
		row.parent = parent;
		const prev = parent === -1 ? lastRoot : lastChild[parent];
		if (prev !== -1) {
			row.prev = prev;
			rows[prev].next = index;
		}
		if (parent === -1) lastRoot = index;
		else {
			lastChild[parent] = index;
			rows[parent].liveChildren++;
		}
		open.push(index);
	}
	for (const index of open) rows[index].subtreeEnd = rows.length;
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		row.subtreeText = row.text;
		row.subtreeControl = row.control;
		row.subtreeMarked = row.marked;
		row.rendered = lineBytes(lines[row.line]);
		// Direct children only: each carries its own subtree's verdict already.
		for (let child = index + 1; child < row.subtreeEnd; child = rows[child].subtreeEnd) {
			const inner = rows[child];
			row.subtreeText ||= inner.subtreeText;
			row.subtreeControl ||= inner.subtreeControl;
			row.subtreeMarked ||= inner.subtreeMarked;
			row.rendered += inner.rendered;
		}
	}

	let elidedRows = 0;

	/**
	 * Drop a subtree, merging it into the runs of dropped siblings on either
	 * side; a parent that is only a wrapper goes too once its last child has.
	 */
	const dropSubtree = (index: number): void => {
		const row = rows[index];
		const size = row.subtreeEnd - index;
		const left = row.prev !== -1 && rows[row.prev].dropped ? row.prev : -1;
		const right = row.next !== -1 && rows[row.next].dropped ? row.next : -1;
		const leftRows = left === -1 ? 0 : rows[left].runRows;
		const rightRows = right === -1 ? 0 : rows[right].runRows;
		const runRows = leftRows + size + rightRows;
		let delta = lineBytes(placeholder(row.depth, runRows)) - row.rendered;
		if (leftRows) delta -= lineBytes(placeholder(row.depth, leftRows));
		if (rightRows) delta -= lineBytes(placeholder(row.depth, rightRows));
		const start = left === -1 ? index : rows[left].runOther;
		const end = right === -1 ? index : rows[right].runOther;
		rows[start].runRows = runRows;
		rows[start].runOther = end;
		rows[end].runRows = runRows;
		rows[end].runOther = start;
		// Rows already inside a dropped descendant were counted when it went.
		for (let inner = index; inner < row.subtreeEnd; inner++) {
			if (rows[inner].dropped) continue;
			rows[inner].dropped = true;
			elidedRows++;
		}
		bytes += delta;
		for (let ancestor = row.parent; ancestor !== -1; ancestor = rows[ancestor].parent)
			rows[ancestor].rendered += delta;
		if (row.parent === -1) return;
		const parent = rows[row.parent];
		if (--parent.liveChildren === 0 && parent.depth > 0 && !(parent.text || parent.control || parent.marked))
			dropSubtree(row.parent);
	};

	// Pass 1: subtrees holding no label, no value and no control anywhere —
	// empty wrappers. Document order reaches the outermost one first, so each
	// goes whole under a single placeholder.
	for (let index = 0; index < rows.length && bytes > budget; index++) {
		const row = rows[index];
		if (row.depth === 0 || row.dropped) continue;
		if (!(row.subtreeText || row.subtreeControl || row.subtreeMarked)) dropSubtree(index);
	}

	// Passes 2-4: deepest subtrees first, largest first within a depth; those
	// without a control or a marker, then those with a control, and only once
	// nothing else is left, those holding the rows the model is waiting for.
	const tiers: Array<(row: Row) => boolean> = [
		row => !row.subtreeControl && !row.subtreeMarked,
		row => !row.subtreeMarked,
		() => true,
	];
	for (const tier of tiers) {
		if (bytes <= budget) break;
		const candidates: number[] = [];
		for (const [index, row] of rows.entries()) if (!row.dropped && row.depth > 0 && tier(row)) candidates.push(index);
		candidates.sort((left, right) => {
			if (rows[left].depth !== rows[right].depth) return rows[right].depth - rows[left].depth;
			return rows[right].subtreeEnd - right - (rows[left].subtreeEnd - left) || left - right;
		});
		for (const index of candidates) {
			if (bytes <= budget) break;
			if (!rows[index].dropped) dropSubtree(index);
		}
	}

	if (bytes > budget) return undefined;

	const out: string[] = [];
	let next = 0;
	for (const [index, line] of lines.entries()) {
		const row = rows[next]?.line === index ? rows[next++] : undefined;
		if (!row?.dropped) {
			out.push(line);
			continue;
		}
		// A run opens at a dropped row whose parent survives and whose previous
		// sibling does not; the rest of the run and every descendant are gone.
		const runStart = (row.parent === -1 || !rows[row.parent].dropped) && (row.prev === -1 || !rows[row.prev].dropped);
		if (runStart) out.push(placeholder(row.depth, row.runRows));
	}
	return { text: out.join("\n"), elidedRows };
}
