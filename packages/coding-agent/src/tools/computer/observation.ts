/**
 * What the model last saw of each window, and what a cell's input touched
 * since, so the cell can end with what its input changed. The ledger records
 * the inputs a cell sends; when the cell settles the worker re-reads each
 * window they touched and prints only how it differs from the tree the model
 * already holds: refs are stable across reads, so every unchanged row's ref
 * in that tree is still live.
 */
import type { DesktopDisplay, DesktopWindow } from "@oh-my-pi/pi-natives";

/** One `ax()` tree row: its indent and its ref token span `[refStart, refEnd)`, leading space included. */
export interface TreeRow {
	indent: number;
	ref: string;
	refStart: number;
	refEnd: number;
}

const ROW = /^((?: {2})*)- \S+/;
const REF = /^ \[ref=(e\d+)\]/;

/**
 * Read one row of the native tree grammar (`crates/pi-natives/src/desktop/ax.rs`
 * `format_tree`): pre-order, two spaces of indent per depth, then
 * `- role "label" [ref=eN]: "value" …`. Undefined for non-row lines (the walk's
 * trailers). The label is skipped as a quoted, backslash-escaped string, so a
 * label holding `[ref=e9]` cannot pass for the row's ref.
 */
export function parseTreeRow(line: string): TreeRow | undefined {
	const match = ROW.exec(line);
	if (!match) return undefined;
	let position = match[0].length;
	if (line.startsWith(' "', position)) {
		let index = position + 2;
		while (index < line.length && line[index] !== '"') index += line[index] === "\\" ? 2 : 1;
		if (index >= line.length) return undefined;
		position = index + 1;
	}
	const ref = REF.exec(line.slice(position));
	if (!ref) return undefined;
	return { indent: match[1].length, ref: ref[1], refStart: position, refEnd: position + ref[0].length };
}

/**
 * `"42" Code "main.ts"`: the id JSON-quoted, as `window()` takes it (ids are
 * opaque strings, not always digits), then app and title.
 */
function windowLabel(window: DesktopWindow): string {
	return `${JSON.stringify(window.id)} ${window.app} ${JSON.stringify(window.title)}`;
}

/** Options of the `ax()` read a window's baseline came from; re-reads reuse them so trees compare. */
export interface AxReadOptions {
	all?: boolean;
	maxDepth?: number;
}

/** A window an input addressed, as far as the worker knows it. */
export interface InputWindow {
	id: string;
	pid?: number;
}

/** One window a settling cell sent input to, or whose ref a call failed on. */
export interface TouchedWindow {
	id: string;
	/** Carries input whose window was unknown: shown because this window had focus at settle time. */
	focused?: boolean;
	/** Tree the model last received for this window, if any. */
	baseline?: string;
	/** Options of that read. */
	options: AxReadOptions;
}

/** Everything one cell's input left for the settle to report. */
export interface PendingSettle {
	/** Windows whose post-input state the model has not read. */
	touched: TouchedWindow[];
	/** Processes the cell sent window input to; their new windows are reported. */
	pids: Set<number>;
	/**
	 * Inputs whose window is unknown (the roster could not be read, or no
	 * listed window was under the pointer). They are shown on the focused window.
	 */
	unattributed: number;
	/** Roster captured before the cell's first input; absent when it could not be read. */
	rosterBefore?: DesktopWindow[];
}

interface WindowRecord {
	pid?: number;
	/** Tree text the model last received. */
	shown?: string;
	options: AxReadOptions;
}

interface CellRead {
	window: InputWindow;
	text: string;
	hash: number | bigint;
	options: AxReadOptions;
	sequence: number;
}

/** A cell's `ax()`/`observe()` reads of one window, bounded so a read loop cannot pile up trees. */
interface CellReads {
	/** The latest read before the window's last input, then reads since, newest last; only the latest while it has had none. */
	recent: CellRead[];
	recentChars: number;
	/** Hashes of texts read since the window's last input, including reads `recent` no longer holds. */
	since: Set<number | bigint>;
	/** Hashes of texts read before the window's last input. */
	before: Set<number | bigint>;
	/** A post-input read or a hash was dropped by the bounds: printed output cannot settle the window. */
	lost: boolean;
}

/** Most reads, and characters of tree text, kept per window since its last input. */
const MAX_RECENT_READS = 8;
const MAX_RECENT_CHARS = 1024 * 1024;
/** Most distinct tree hashes remembered per window in one cell. */
const MAX_READ_HASHES = 4096;

/** Most refs remembered for mapping an element back to its window. */
const MAX_REFS = 20_000;

/** Every ref a tree text names. */
export function treeRefs(text: string): string[] {
	const refs: string[] = [];
	for (const line of text.split("\n")) {
		const row = parseTreeRow(line);
		if (row) refs.push(row.ref);
	}
	return refs;
}

/**
 * A desktop-root pointer position (pixels of the desktop's or display's latest screenshot) in
 * desktop coordinates, through the display regions that screenshot reported;
 * undefined when it falls outside them. Native pointer input maps it the same way.
 */
export function desktopPoint(
	displays: readonly DesktopDisplay[],
	point: { x: number; y: number },
): { x: number; y: number } | undefined {
	const display = displays.find(
		candidate =>
			point.x >= candidate.pixelX &&
			point.x < candidate.pixelX + candidate.pixelWidth &&
			point.y >= candidate.pixelY &&
			point.y < candidate.pixelY + candidate.pixelHeight,
	);
	if (!display) return undefined;
	return {
		x: display.x + ((point.x - display.pixelX) * display.width) / display.pixelWidth,
		y: display.y + ((point.y - display.pixelY) * display.height) / display.pixelHeight,
	};
}

/**
 * The topmost listed window containing a desktop point (native window lists
 * run front to back). An unfocused window covering a whole display is passed
 * over: system overlays list above app windows (the macOS Dock keeps a
 * transparent one over each display) and never take focus, so such a window
 * does not tell where input went. A focused one is a full-screen app.
 */
export function windowAt(
	windows: readonly DesktopWindow[],
	displays: readonly DesktopDisplay[],
	point: { x: number; y: number },
): DesktopWindow | undefined {
	return windows.find(
		window =>
			point.x >= window.x &&
			point.x < window.x + window.width &&
			point.y >= window.y &&
			point.y < window.y + window.height &&
			(window.focused ||
				!displays.some(
					display =>
						window.x <= display.x &&
						window.y <= display.y &&
						window.x + window.width >= display.x + display.width &&
						window.y + window.height >= display.y + display.height,
				)),
	);
}

/**
 * Native object descriptions an AX value can print (`<AXUIElement 0x6000…>`,
 * `<__NSCFNumber 0x…>`): their addresses change on every read without the
 * window changing.
 */
const OBJECT_ADDRESS = /(<(?:AX|CF|NS|__NS)\w*[^<>]*?)0x[0-9a-f]+/gi;

interface DiffRow {
	line: string;
	indent: number;
	ref: string;
	/** Ref of the enclosing row; undefined for a root. */
	parent?: string;
	/** What is compared across reads: the line without its ref or native object addresses, indent included. */
	text: string;
}

/** A tree's rows in render order with their parents, and its non-row lines (the walk's trailers). */
function treeRows(text: string): { rows: DiffRow[]; other: string[] } {
	const rows: DiffRow[] = [];
	const other: string[] = [];
	const open: DiffRow[] = [];
	for (const line of text.split("\n")) {
		const row = parseTreeRow(line);
		if (!row) {
			if (line.trim() !== "") other.push(line);
			continue;
		}
		while (open.length > 0 && open[open.length - 1].indent >= row.indent) open.pop();
		const entry: DiffRow = {
			line,
			indent: row.indent,
			ref: row.ref,
			parent: open.at(-1)?.ref,
			text: (line.slice(0, row.refStart) + line.slice(row.refEnd)).replace(OBJECT_ADDRESS, "$10x…"),
		};
		rows.push(entry);
		open.push(entry);
	}
	return { rows, other };
}

/** How a re-read differs from the tree the model last saw. */
export interface TreeChange {
	/**
	 * Rows added (`+`) or changed (`~`), in tree order at their depth. A new or
	 * moved row whose parent is not listed names it (`(in e5)`); then one line
	 * per container whose children changed order, and trailers the old tree lacked.
	 */
	lines: string[];
	added: number;
	changed: number;
	/** Refs of rows the new tree no longer has, in the old tree's order. */
	removed: string[];
}

/**
 * Rows of `after` that `before` lacks or held differently, matched by ref: an
 * element keeps its ref across reads, and a relabelled one gets a new ref, so
 * it shows as one ref removed and one added. Unchanged rows are left out: the
 * model holds them, with live refs, in `before`.
 */
export function diffTree(before: string, after: string): TreeChange {
	const old = treeRows(before);
	const now = treeRows(after);
	const oldByRef = new Map(old.rows.map(row => [row.ref, row]));
	const nowRefs = new Set(now.rows.map(row => row.ref));
	const listed = new Set<string>();
	const lines: string[] = [];
	let added = 0;
	let changed = 0;
	for (const row of now.rows) {
		const previous = oldByRef.get(row.ref);
		const moved = previous !== undefined && previous.parent !== row.parent;
		if (previous && previous.text === row.text && !moved) continue;
		const mark = previous ? "~" : "+";
		if (previous) changed++;
		else added++;
		// Its parent locates a row the model cannot place from the old tree: one it has not seen, or one that moved.
		const anchor =
			row.parent !== undefined && !listed.has(row.parent) && (!previous || moved) ? ` (in ${row.parent})` : "";
		lines.push(`${row.line.slice(0, row.indent)}${mark}${row.line.slice(row.indent + 1)}${anchor}`);
		listed.add(row.ref);
	}
	// Children a container holds in both trees, in another order: a change no row shows.
	const childrenOf = (rows: DiffRow[]): Map<string, string[]> => {
		const children = new Map<string, string[]>();
		for (const row of rows) {
			if (row.parent === undefined) continue;
			const list = children.get(row.parent);
			if (list) list.push(row.ref);
			else children.set(row.parent, [row.ref]);
		}
		return children;
	};
	const oldChildren = childrenOf(old.rows);
	for (const [parent, current] of childrenOf(now.rows)) {
		const earlier = oldChildren.get(parent);
		if (!earlier) continue;
		const currentRefs = new Set(current);
		const kept = earlier.filter(ref => currentRefs.has(ref));
		const keptRefs = new Set(kept);
		if (kept.join(" ") !== current.filter(ref => keptRefs.has(ref)).join(" "))
			lines.push(`order of ${parent}'s children: ${current.join(" ")}`);
	}
	const oldOther = new Set(old.other);
	for (const line of now.other) if (!oldOther.has(line)) lines.push(line);
	const removed = old.rows.filter(row => !nowRefs.has(row.ref)).map(row => row.ref);
	return { lines, added, changed, removed };
}

/** `e7-e9, e12`: refs as runs of consecutive numbers, in the order given. */
export function refRuns(refs: readonly string[]): string {
	const runs: string[] = [];
	let start = -1;
	let end = -1;
	const flush = (): void => {
		if (start >= 0) runs.push(start === end ? `e${start}` : `e${start}-e${end}`);
	};
	for (const ref of refs) {
		const index = Number(ref.slice(1));
		if (start >= 0 && index === end + 1) {
			end = index;
			continue;
		}
		flush();
		start = end = index;
	}
	flush();
	return runs.join(", ");
}

/** Per-session record of what the model saw and what input touched since. */
export class ObservationLedger {
	readonly #windows = new Map<string, WindowRecord>();
	/** Ref → window id, for elements resolved without their window. Oldest first. */
	readonly #refs = new Map<string, string>();
	/** Windows input or a failure touched since the last settle, each with its latest touch's sequence number, which orders it against reads. */
	#touched = new Map<string, number>();
	/** `ax()`/`observe()` reads the cell made, per window; they count as shown once the cell's output carries them. */
	#reads = new Map<string, CellReads>();
	#sequence = 0;
	#pids = new Set<number>();
	#unattributed = 0;
	#inputs = 0;
	#rosterBefore?: DesktopWindow[];
	#rosterClaimed = false;

	#record(id: string): WindowRecord {
		let record = this.#windows.get(id);
		if (!record) this.#windows.set(id, (record = { options: {} }));
		return record;
	}

	/** Remember which window these refs belong to. */
	recordRefs(windowId: string, refs: Iterable<string>): void {
		for (const ref of refs) {
			this.#refs.delete(ref);
			this.#refs.set(ref, windowId);
		}
		for (const ref of this.#refs.keys()) {
			if (this.#refs.size <= MAX_REFS) break;
			this.#refs.delete(ref);
		}
	}

	/** The window a ref was read from, when the session read it. */
	windowOf(ref: string): InputWindow | undefined {
		const id = this.#refs.get(ref);
		return id === undefined ? undefined : { id, pid: this.#windows.get(id)?.pid };
	}

	/**
	 * The model received this tree of the window: it is the baseline the next
	 * read-back is marked against, and the window's post-input state is known.
	 */
	recordShown(window: InputWindow, text: string, options: AxReadOptions): void {
		const record = this.#record(window.id);
		if (window.pid !== undefined) record.pid = window.pid;
		record.shown = text;
		record.options = { ...options };
		this.recordRefs(window.id, treeRefs(text));
		this.#touched.delete(window.id);
	}

	/**
	 * The cell's code read this tree of the window. Its refs map to the window
	 * at once; it becomes what the model saw only if the cell's output carries
	 * it (see `take`), since code can read a tree without printing it.
	 */
	recordRead(window: InputWindow, text: string, options: AxReadOptions): void {
		this.recordRefs(window.id, treeRefs(text));
		let reads = this.#reads.get(window.id);
		if (!reads) {
			reads = { recent: [], recentChars: 0, since: new Set(), before: new Set(), lost: false };
			this.#reads.set(window.id, reads);
		}
		const read: CellRead = { window, text, hash: Bun.hash(text), options: { ...options }, sequence: this.#sequence };
		reads.since.add(read.hash);
		if (reads.since.size > MAX_READ_HASHES) {
			reads.since.clear();
			reads.lost = true;
		}
		// Before any input to the window only the latest read matters: it is what the model saw if printed.
		const touched = this.#touched.get(window.id);
		if (touched === undefined) {
			reads.recent = [];
			reads.recentChars = 0;
		}
		reads.recent.push(read);
		reads.recentChars += text.length;
		while (
			reads.recent.length > 1 &&
			(reads.recent.length > MAX_RECENT_READS || reads.recentChars > MAX_RECENT_CHARS)
		) {
			const dropped = reads.recent.shift()!;
			reads.recentChars -= dropped.text.length;
			if (touched !== undefined && dropped.sequence >= touched) reads.lost = true;
		}
	}

	/** Input or a failure reached the window: everything it read so far was read before that input. */
	#readsBeforeInput(id: string): void {
		const reads = this.#reads.get(id);
		if (!reads) return;
		for (const hash of reads.since) reads.before.add(hash);
		if (reads.before.size > MAX_READ_HASHES) {
			reads.before.clear();
			reads.lost = true;
		}
		reads.since.clear();
		// The latest earlier read stays: printed, it is what the model saw before the input.
		reads.recent = reads.recent.slice(-1);
		reads.recentChars = reads.recent[0]?.text.length ?? 0;
	}

	/** Tree texts held for the current cell's reads, across windows. */
	get retainedReads(): number {
		let count = 0;
		for (const reads of this.#reads.values()) count += reads.recent.length;
		return count;
	}

	/** Whether no input since the last settle has claimed the roster-before read yet. */
	get wantsRoster(): boolean {
		return !this.#rosterClaimed;
	}

	/** Claim the roster-before read; resolve it with the roster, or undefined when it could not be read. */
	claimRoster(): { resolve(roster: DesktopWindow[] | undefined): void } {
		this.#rosterClaimed = true;
		return {
			resolve: roster => {
				this.#rosterBefore = roster;
			},
		};
	}

	/**
	 * An input is being sent. `window` is undefined when the target window is
	 * unknown (desktop-root input, elements found by position or focus).
	 * Returns the process it reaches, when known.
	 */
	noteInput(window: InputWindow | undefined): number | undefined {
		this.#inputs++;
		if (!window) {
			this.#unattributed++;
			return undefined;
		}
		const record = this.#record(window.id);
		const pid = window.pid ?? record.pid;
		if (pid !== undefined) {
			record.pid = pid;
			this.#pids.add(pid);
		}
		this.#touch(window.id);
		return pid;
	}

	/** A call failed on one of the window's refs: the settle reports the window, so the model has its current refs. */
	noteFailure(window: InputWindow | undefined): void {
		if (window) this.#touch(window.id);
	}

	/** Input or a failure reached the window: everything it read so far was read before that. */
	#touch(id: string): void {
		this.#readsBeforeInput(id);
		this.#touched.set(id, ++this.#sequence);
	}

	/**
	 * Take what the cell left to settle, or undefined when it sent no input and
	 * nothing failed. First, the latest `ax()` read of each window whose tree the
	 * cell's `output` carries becomes what the model saw, and settles its window
	 * only if it was read after the window's last input, its text was not also
	 * seen before that input (the printed copy could be the earlier one), and
	 * no read of the window was dropped by the bounds.
	 */
	take(output: string): PendingSettle | undefined {
		for (const [id, reads] of this.#reads) {
			// Printed verbatim, or JSON-escaped inside a `display(...)`. Refs alone do not tell:
			// an element keeps its ref across reads, so an earlier printed tree names them too.
			const printed = reads.recent.findLast(
				read =>
					read.text.trim() !== "" &&
					(output.includes(read.text) || output.includes(JSON.stringify(read.text).slice(1, -1))),
			);
			if (!printed) continue;
			const touched = this.#touched.get(id);
			const ambiguous =
				touched !== undefined &&
				(reads.lost || reads.before.has(printed.hash) || this.#windows.get(id)?.shown === printed.text);
			this.recordShown(printed.window, printed.text, printed.options);
			if (touched !== undefined && (touched > printed.sequence || ambiguous)) this.#touched.set(id, touched);
		}
		this.#reads.clear();
		if (this.#inputs === 0 && this.#touched.size === 0) return undefined;
		const touched: TouchedWindow[] = [...this.#touched.keys()].map(id => {
			const record = this.#windows.get(id);
			return { id, baseline: record?.shown, options: { ...record?.options } };
		});
		const pending: PendingSettle = {
			touched,
			pids: this.#pids,
			unattributed: this.#unattributed,
			rosterBefore: this.#rosterBefore,
		};
		this.#touched = new Map();
		this.#pids = new Set();
		this.#unattributed = 0;
		this.#inputs = 0;
		this.#rosterBefore = undefined;
		this.#rosterClaimed = false;
		return pending;
	}

	/**
	 * Show the cell's input whose window was unknown on the focused window:
	 * that window's own entry when the cell also addressed it, else a new one.
	 */
	attributeToFocused(pending: PendingSettle, window: DesktopWindow): void {
		if (pending.unattributed === 0) return;
		const own = pending.touched.find(touched => touched.id === window.id);
		if (own) {
			own.focused = true;
			return;
		}
		const record = this.#windows.get(window.id);
		pending.touched.push({
			id: window.id,
			focused: true,
			baseline: record?.shown,
			options: { ...record?.options },
		});
	}

	/**
	 * The model's context was rewritten (compacted, pruned, rewound): trees it
	 * received may be gone from it, so each window's next report prints in full.
	 */
	forgetShown(): void {
		for (const record of this.#windows.values()) {
			record.shown = undefined;
			record.options = {};
		}
	}
}

/**
 * `window "42" Code "main.ts"`, or `window "42"` when the roster did not list
 * it, then `(focused)` when input whose window was unknown is shown on it.
 */
function windowName(window: DesktopWindow | undefined, touched: TouchedWindow): string {
	return `window ${window ? windowLabel(window) : JSON.stringify(touched.id)}${touched.focused ? " (focused)" : ""}`;
}

/** One touched window, re-read after the cell. */
export interface ReadBack {
	touched: TouchedWindow;
	/** The window as the roster lists it now; absent when the roster could not be read. */
	window?: DesktopWindow;
	/** The re-read tree. */
	text: string;
	/** How it differs from the model's last tree of the window; absent when it had none. */
	change?: TreeChange;
	/** How long after the cell's last input the tree was read, when the app could not be watched going quiet. */
	unwatchedMs?: number;
}

/**
 * The post-input section for one window: what changed since the model's last
 * tree of it, a one-line verdict when nothing did, or the whole tree when the
 * model has none or the changes would not be shorter.
 */
export function renderReadBack(readBack: ReadBack): string {
	const { change, text } = readBack;
	const name = windowName(readBack.window, readBack.touched);
	if (!change) return `${name}:\n${text}`;
	const lines = change.removed.length > 0 ? [...change.lines, `removed: ${refRuns(change.removed)}`] : change.lines;
	if (lines.length === 0) {
		const after =
			readBack.unwatchedMs === undefined ? "" : `, ${(readBack.unwatchedMs / 1000).toFixed(1)} s after the input`;
		return `${name}: no change since your last tree${after}`;
	}
	const diff = lines.join("\n");
	if (diff.length >= text.length) return `${name}:\n${text}`;
	const count = change.lines.length + change.removed.length;
	return `${name}: ${count} ${count === 1 ? "change" : "changes"} since your last tree\n${diff}`;
}

/** A window the cell's input opened and focused: the model has no tree of it, so it gets all of it. */
export function renderNewWindow(window: DesktopWindow, text: string): string {
	return `new window ${windowLabel(window)} ${Math.round(window.width)}×${Math.round(window.height)} (focused):\n${text}`;
}

/** A web view's row in a tree: web content changes without accessibility notifications. */
export const WEB_AREA_ROW = /^\s*[-+~] webarea\b/m;

/**
 * Web views post no accessibility notification while a page waits on the
 * network or a timer (measured in Chrome: none for a fetch, a slow navigation
 * or a form post until it loads), so the quiet wait cannot cover them.
 */
export const WEB_CONTENT_NOTE =
	"web pages send no accessibility notification while they wait on the network or a timer, so this read may predate a load; the next report shows what lands later";

/** A touched window whose tree could not be read back. */
export function renderUnreadable(touched: TouchedWindow, window: DesktopWindow | undefined, message: string): string {
	return `${windowName(window, touched)} could not be read back through AX: ${message}`;
}

/** A touched window the roster no longer lists. */
export function renderGone(touched: TouchedWindow): string {
	return `${windowName(undefined, touched)} is gone from the window list (closed, minimized or off screen)`;
}

/**
 * Windows the cell's input opened, closed or focused: new and vanished
 * windows of the processes it sent window input to, and a new focused window
 * of any process. Windows with their own read-back section are skipped.
 */
export function describeRosterChanges(
	before: readonly DesktopWindow[],
	after: readonly DesktopWindow[],
	pids: ReadonlySet<number>,
	reported: ReadonlySet<string>,
): string[] {
	const beforeIds = new Set(before.map(window => window.id));
	const afterIds = new Set(after.map(window => window.id));
	const acted = (window: DesktopWindow): boolean => window.pid !== undefined && pids.has(window.pid);
	const lines: string[] = [];
	for (const window of after) {
		if (beforeIds.has(window.id) || reported.has(window.id) || !(acted(window) || window.focused)) continue;
		lines.push(
			`new window ${windowLabel(window)} ${Math.round(window.width)}×${Math.round(window.height)}${window.focused ? " (focused)" : ""}`,
		);
	}
	for (const window of before) {
		if (afterIds.has(window.id) || reported.has(window.id) || !acted(window)) continue;
		lines.push(`window ${windowLabel(window)} closed`);
	}
	const focusedBefore = before.find(window => window.focused);
	const focusedAfter = after.find(window => window.focused);
	if (focusedAfter && focusedAfter.id !== focusedBefore?.id && beforeIds.has(focusedAfter.id))
		lines.push(`focus moved to window ${windowLabel(focusedAfter)}`);
	return lines;
}
