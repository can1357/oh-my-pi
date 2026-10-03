/**
 * What the model last saw of each window, and what a cell's input touched
 * since, so the cell can end with the state its input left behind.
 *
 * Every mutating helper returns nothing, so after an action the model spent a
 * whole call reading the window back, and after a refused action it spent one
 * re-reading the tree its refs came from. The ledger records the inputs a cell
 * sends; when the cell settles the worker re-reads each window they touched
 * and prints that tree once, marked against the tree the model last received.
 *
 * Tree text is the native `ax()` grammar (`crates/pi-natives/src/desktop/ax.rs`
 * `format_tree`): one node per line, two spaces of indent per depth, then
 * `- role "label" [ref=eN] …`.
 */
import type { DesktopDisplay, DesktopWindow, DiffRun } from "@oh-my-pi/pi-natives";

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

/** One window a settling cell sent input to. */
export interface TouchedWindow {
	id: string;
	/** Inputs sent to the window, in order: `press e5`, `type "abc"`. */
	labels: string[];
	/** The last failed call on the window, with its error; its refs need renewing. */
	failure?: string;
	/** Tree the model last received for this window, if any. */
	baseline?: string;
	/** Options of that read. */
	options: AxReadOptions;
	/** The model works this window from pixels, so the report repeats a screenshot (see `InputKind`). */
	screenshot: boolean;
}

/**
 * How an input addressed its target. Pixel input, or a displayed screenshot,
 * puts a window in pixel mode: its reports carry a fresh screenshot. An
 * element action in a cell that neither sent pixel input to the window nor
 * showed the model a screenshot of it takes the window out again. Keys leave
 * the mode as it is.
 */
export type InputKind = "pixel" | "element" | "key";

/** Pseudo-window that holds the pixel mode of desktop-root input. */
export const DESKTOP_WINDOW_ID = "desktop";

/** Everything one cell's input left for the settle to report. */
export interface PendingSettle {
	/** Windows whose post-input state the model has not read. */
	touched: TouchedWindow[];
	/** Processes the cell sent window input to; their new windows are reported. */
	pids: Set<number>;
	/**
	 * Inputs whose window is unknown (the roster could not be read, or no
	 * listed window was under the pointer). They are shown on the focused
	 * window, whose report carries them; a failure among them is the last entry.
	 */
	unattributed: string[];
	/** The cell sent input to the desktop root, which the model works from pixels: the report adds a desktop screenshot. */
	desktopScreenshot: boolean;
	/** Roster captured before the cell's first input; absent when it could not be read. */
	rosterBefore?: DesktopWindow[];
	/** When the last input returned (ms since epoch). */
	lastInputAt: number;
}

interface WindowRecord {
	pid?: number;
	/** Tree text the model last received. */
	shown?: string;
	options: AxReadOptions;
	/** Pixel mode (see `InputKind`). */
	pixels: boolean;
	/** This cell sent pixel input to the window or showed the model a screenshot of it. */
	pixelsThisCell: boolean;
}

/** Most refs remembered for mapping an element back to its window. */
const MAX_REFS = 20_000;
const ROW = /^((?: {2})*)[-+~] (\S+)/;
const REF = /^ \[ref=(e\d+)\]/;

/** Row structure of one tree line: where its ref token sits. */
interface ParsedRow {
	indent: number;
	role: string;
	/** Ref token span `[start, end)`, including its leading space. */
	refStart: number;
	refEnd: number;
	ref: string;
}

/** Index just past a quoted, backslash-escaped string starting at `from`, or -1. */
function quotedEnd(line: string, from: number): number {
	for (let index = from + 1; index < line.length; index++) {
		const char = line[index];
		if (char === "\\") index++;
		else if (char === '"') return index + 1;
	}
	return -1;
}

/** Parse a tree row; non-row lines (trailers, headers) return undefined. */
export function parseTreeRow(line: string): ParsedRow | undefined {
	const match = ROW.exec(line);
	if (!match) return undefined;
	let position = match[0].length;
	if (line.startsWith(' "', position)) {
		const end = quotedEnd(line, position + 1);
		if (end < 0) return undefined;
		position = end;
	}
	const ref = REF.exec(line.slice(position));
	if (!ref) return undefined;
	return {
		indent: match[1].length,
		role: match[2],
		refStart: position,
		refEnd: position + ref[0].length,
		ref: ref[1],
	};
}

/** Every ref a tree text names. */
export function treeRefs(text: string): string[] {
	const refs: string[] = [];
	for (const line of text.split("\n")) {
		const row = parseTreeRow(line);
		if (row) refs.push(row.ref);
	}
	return refs;
}

/** Whether the cell's output carries this tree: every ref it names, or the whole text when it names none. */
function printedIn(printedRefs: ReadonlySet<string>, output: string, text: string): boolean {
	const refs = treeRefs(text);
	return refs.length > 0 ? refs.every(ref => printedRefs.has(ref)) : output.includes(text);
}

/**
 * A desktop-root pointer position (pixels of the latest desktop screenshot) in
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
 * run front to back). A window covering a whole display is passed over:
 * system overlays list above app windows (the macOS Dock keeps a transparent
 * one over each display), so such a window does not tell where input went.
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
			!displays.some(
				display =>
					window.x <= display.x &&
					window.y <= display.y &&
					window.x + window.width >= display.x + display.width &&
					window.y + window.height >= display.y + display.height,
			),
	);
}

/** A tree line without its ref: what stays equal when a re-read renews refs. */
function withoutRef(line: string): string {
	const row = parseTreeRow(line);
	return row ? line.slice(0, row.refStart) + line.slice(row.refEnd) : line;
}

/**
 * Native object descriptions an AX value can print (`<AXUIElement 0x6000…>`,
 * `<__NSCFNumber 0x…>`): their addresses change on every read without the
 * window changing.
 */
const OBJECT_ADDRESS = /(<(?:AX|CF|NS|__NS)\w*[^<>]*?)0x[0-9a-f]+/gi;

/** A tree line as compared across reads: without its ref or native object addresses. */
function comparable(line: string): string {
	return withoutRef(line).replace(OBJECT_ADDRESS, "$10x…");
}

/** A row as a short reader-facing descriptor: `button "Edit"`, `textfield: "x"`. */
function describeRow(line: string): string {
	const described = withoutRef(line).trimStart().slice(2);
	return described.length > 80 ? `${described.slice(0, 79)}…` : described;
}

/** How a re-read differs from the tree the model last saw. */
export interface TreeChange {
	/** The new tree, rows marked `+` (added) or `~` (changed, with what it was). */
	text: string;
	added: number;
	changed: number;
	/** Descriptors of rows the new tree no longer has. */
	removed: string[];
}

/**
 * Mark `after` against `before`. Refs are ignored: every read renews them. A
 * removed row and an added row of the same depth and role inside one change
 * are one row that changed.
 */
export function diffTree(
	before: string,
	after: string,
	diffLineRuns: (oldText: string, newText: string) => DiffRun[],
): TreeChange {
	const oldLines = before.split("\n");
	const newLines = after.split("\n");
	const runs = diffLineRuns(oldLines.map(comparable).join("\n"), newLines.map(comparable).join("\n"));
	const out: string[] = [];
	const removed: string[] = [];
	let added = 0;
	let changed = 0;
	let oldIndex = 0;
	let newIndex = 0;
	// Removed rows of the current change, waiting for an added row to pair with.
	let pending: string[] = [];
	const flush = (): void => {
		for (const line of pending) if (parseTreeRow(line)) removed.push(describeRow(line));
		pending = [];
	};
	for (const run of runs) {
		if (run.removed) {
			pending.push(...oldLines.slice(oldIndex, oldIndex + run.count));
			oldIndex += run.count;
			continue;
		}
		if (!run.added) {
			flush();
			out.push(...newLines.slice(newIndex, newIndex + run.count));
			oldIndex += run.count;
			newIndex += run.count;
			continue;
		}
		for (const line of newLines.slice(newIndex, newIndex + run.count)) {
			const row = parseTreeRow(line);
			if (!row) {
				out.push(line);
				continue;
			}
			const pair = pending.findIndex(candidate => {
				const old = parseTreeRow(candidate);
				return old !== undefined && old.indent === row.indent && old.role === row.role;
			});
			if (pair >= 0) {
				const [old] = pending.splice(pair, 1);
				out.push(`${line.slice(0, row.indent)}~${line.slice(row.indent + 1)} (was: ${describeRow(old!)})`);
				changed++;
			} else {
				out.push(`${line.slice(0, row.indent)}+${line.slice(row.indent + 1)}`);
				added++;
			}
		}
		newIndex += run.count;
	}
	flush();
	return { text: out.join("\n"), added, changed, removed };
}

/** Per-session record of what the model saw and what input touched since. */
export class ObservationLedger {
	readonly #windows = new Map<string, WindowRecord>();
	/** Ref → window id, for elements resolved without their window. Oldest first. */
	readonly #refs = new Map<string, string>();
	/** Windows input or a failure touched since the last settle; `sequence` orders them against reads. */
	#touched = new Map<string, { labels: string[]; failure?: string; sequence: number }>();
	/** `ax()` reads the cell made, latest per window; they count as shown once the cell's output carries them. */
	#reads = new Map<string, { window: InputWindow; text: string; options: AxReadOptions; sequence: number }>();
	#sequence = 0;
	#pids = new Set<number>();
	#unattributed: string[] = [];
	#inputs = 0;
	/** Whether an input since the last settle went to the desktop root. */
	#rootInput = false;
	#rosterBefore?: DesktopWindow[];
	#rosterClaimed = false;
	#lastInputAt = 0;

	#record(id: string): WindowRecord {
		let record = this.#windows.get(id);
		if (!record) this.#windows.set(id, (record = { options: {}, pixels: false, pixelsThisCell: false }));
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
		this.#reads.set(window.id, { window, text, options: { ...options }, sequence: this.#sequence });
	}

	/**
	 * The model was shown a screenshot of the window (`desktop` for the root):
	 * its post-input state is known, and it works the window from pixels.
	 */
	recordCapture(window: InputWindow): void {
		const record = this.#record(window.id);
		if (window.pid !== undefined) record.pid = window.pid;
		record.pixels = true;
		record.pixelsThisCell = true;
		this.#touched.delete(window.id);
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
	 * An input is being sent. `window` is the window it reaches, undefined when
	 * that is unknown. `root` input was sent to the desktop root, whose pixel
	 * mode it sets or keeps (see `InputKind`) in place of the window's; an
	 * element action also ends the root's pixel mode unless this cell worked
	 * the root by pixels.
	 */
	noteInput(window: InputWindow | undefined, label: string, kind: InputKind, root = false): void {
		this.#inputs++;
		if (root) this.#rootInput = true;
		const target = this.#record(root || !window ? DESKTOP_WINDOW_ID : window.id);
		if (kind === "pixel") {
			target.pixels = true;
			target.pixelsThisCell = true;
		} else if (kind === "element") {
			for (const record of [target, this.#record(DESKTOP_WINDOW_ID)])
				if (!record.pixelsThisCell) record.pixels = false;
		}
		if (!window) {
			this.#unattributed.push(label);
			return;
		}
		const record = this.#record(window.id);
		const pid = window.pid ?? record.pid;
		if (pid !== undefined) {
			record.pid = pid;
			this.#pids.add(pid);
		}
		const touched = this.#touched.get(window.id);
		if (touched) {
			touched.labels.push(label);
			touched.sequence = ++this.#sequence;
		} else this.#touched.set(window.id, { labels: [label], sequence: ++this.#sequence });
	}

	/** An input returned or threw. */
	noteInputEnded(): void {
		this.#lastInputAt = Date.now();
	}

	/** A call failed: the settle prints its window's current tree so refs renew. */
	noteFailure(window: InputWindow | undefined, label: string, message: string): void {
		const failure = `${label} failed: ${message}`;
		if (!window) {
			this.#unattributed.push(failure);
			return;
		}
		const touched = this.#touched.get(window.id);
		if (touched) {
			touched.failure = failure;
			touched.sequence = ++this.#sequence;
		} else this.#touched.set(window.id, { labels: [], failure, sequence: ++this.#sequence });
	}

	/**
	 * Take what the cell left to settle, or undefined when it sent no input and
	 * nothing failed. First, each `ax()` read whose tree the cell's `output`
	 * carries becomes what the model saw, and settles its window unless input
	 * reached the window after the read.
	 */
	take(output: string): PendingSettle | undefined {
		// The cell is over, even one that sent no input: its screenshots no longer keep
		// pixel mode through the next cell's element input.
		for (const record of this.#windows.values()) record.pixelsThisCell = false;
		if (this.#reads.size > 0) {
			const printedRefs = new Set(Array.from(output.matchAll(/\[ref=(e\d+)\]/g), match => match[1]!));
			for (const read of this.#reads.values()) {
				if (!printedIn(printedRefs, output, read.text)) continue;
				const touched = this.#touched.get(read.window.id);
				this.recordShown(read.window, read.text, read.options);
				if (touched && touched.sequence > read.sequence) this.#touched.set(read.window.id, touched);
			}
			this.#reads.clear();
		}
		if (this.#inputs === 0 && this.#touched.size === 0 && this.#unattributed.length === 0) return undefined;
		const touched: TouchedWindow[] = [...this.#touched].map(([id, { labels, failure }]) => {
			const record = this.#windows.get(id);
			return {
				id,
				labels,
				failure,
				baseline: record?.shown,
				options: { ...record?.options },
				screenshot: record?.pixels === true,
			};
		});
		const pending: PendingSettle = {
			touched,
			pids: this.#pids,
			unattributed: this.#unattributed,
			desktopScreenshot: this.#rootInput && this.#windows.get(DESKTOP_WINDOW_ID)?.pixels === true,
			rosterBefore: this.#rosterBefore,
			lastInputAt: this.#lastInputAt,
		};
		this.#touched = new Map();
		this.#pids = new Set();
		this.#unattributed = [];
		this.#inputs = 0;
		this.#rootInput = false;
		this.#rosterBefore = undefined;
		this.#rosterClaimed = false;
		return pending;
	}

	/**
	 * The touched-window entry for the focused window, carrying the cell's
	 * unattributed inputs: merged into the window's own entry when the cell
	 * also addressed it.
	 */
	attributeToFocused(pending: PendingSettle, window: DesktopWindow): void {
		if (pending.unattributed.length === 0) return;
		const labels = [...pending.unattributed];
		labels[labels.length - 1] += " (its window is unknown; shown on the focused window)";
		const own = pending.touched.find(touched => touched.id === window.id);
		if (own) {
			own.labels.push(...labels);
			return;
		}
		const record = this.#windows.get(window.id);
		pending.touched.push({
			id: window.id,
			labels,
			baseline: record?.shown,
			options: { ...record?.options },
			screenshot: record?.pixels === true,
		});
	}
}

/** `window "42" Code "main.ts"`, or `window "42"` when the roster did not list it: the id as `window()` takes it. */
function windowName(window: DesktopWindow | undefined, id: string): string {
	return `window ${window ? windowLabel(window) : JSON.stringify(id)}`;
}

/** `press e5, type "abc"` — the inputs a read-back answers, then the failure that renewed it. */
function describeCause(touched: TouchedWindow): string {
	const inputs =
		touched.labels.length > 4
			? [...touched.labels.slice(0, 4), `+${touched.labels.length - 4} more`]
			: [...touched.labels];
	if (touched.failure !== undefined) inputs.push(touched.failure);
	return inputs.join(", ");
}

/** One touched window, re-read after the cell. */
export interface ReadBack {
	touched: TouchedWindow;
	/** The window as the roster lists it now; absent when the roster could not be read. */
	window?: DesktopWindow;
	/** The re-read tree. */
	text: string;
	/** Marks against the model's last tree of the window; absent when it had none. */
	change?: TreeChange;
	/** How long after the cell's last input the tree was read. */
	sinceInputMs: number;
}

/** Whether a re-read found nothing different from the model's last tree. */
function isUnchanged(change: TreeChange | undefined): boolean {
	return change !== undefined && change.added === 0 && change.changed === 0 && change.removed.length === 0;
}

/** The post-input section for one window: a header saying what changed, then its current tree. */
export function renderReadBack(readBack: ReadBack): string {
	const { touched, change } = readBack;
	const name = windowName(readBack.window, touched.id);
	let summary: string;
	// Without an input (a call failed on a stale ref) there is no input to have changed nothing.
	if (change === undefined || (isUnchanged(change) && touched.labels.length === 0)) summary = "current tree";
	else if (isUnchanged(change))
		summary = `no accessibility change visible ${(readBack.sinceInputMs / 1000).toFixed(1)} s after the input (the app may still be working); refs renewed`;
	else
		summary = `${change.changed} changed, ${change.added} added, ${change.removed.length} removed (rows marked ~ changed, + added)`;
	if (touched.screenshot) summary += "; screenshot below";
	const lines = [`${name} after ${describeCause(touched)} — ${summary}:`, change?.text ?? readBack.text];
	if (change && change.removed.length > 0) {
		const shown = change.removed.slice(0, 8).join("; ");
		const more = change.removed.length > 8 ? `; +${change.removed.length - 8} more` : "";
		lines.push(`removed: ${shown}${more}`);
	}
	return lines.join("\n");
}

/** A touched window whose tree could not be read back. */
export function renderUnreadable(touched: TouchedWindow, window: DesktopWindow | undefined, message: string): string {
	const screenshot = touched.screenshot ? "; screenshot below" : "";
	return `${windowName(window, touched.id)} after ${describeCause(touched)} — could not be read back through AX: ${message}${screenshot}`;
}

/** A touched window the roster no longer lists. */
export function renderGone(touched: TouchedWindow): string {
	return `${windowName(undefined, touched.id)} after ${describeCause(touched)} — gone from the window list (closed, minimized or off screen)`;
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
