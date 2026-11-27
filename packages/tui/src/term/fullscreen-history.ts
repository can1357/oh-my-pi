/** The fullscreen document's geometry. Rows and image placements belong to the window, not the index. */
import type { UiNode } from "../node";
import { type Accessor, createRoot, effect, runWithOwner, signal } from "../reactive";
import { type Block, EMPTY_BLOCK } from "./paint";
import type { SelectionDocument } from "./selection";
import { blockText, type RenderedTextRow, type RenderedTextTail } from "./text-layout";

interface WindowPaint {
	readonly read: Accessor<Block>;
	readonly dispose: () => void;
}

export interface HistoryPaint {
	/** A cached paint owned by the window, independent of any inline/dock paint of the same node. */
	readonly paint: (node: UiNode, width: number) => WindowPaint;
	/** Paint through the same tree without caching rows, acquiring images or requesting animation ticks. */
	readonly measure: (node: UiNode, width: number) => Block;
	/** Blank rows between neighboring nonempty blocks; dynamic inputs must be reactive reads. */
	readonly separator: (above: UiNode, below: UiNode) => number;
}

// A leaf holds a block's height plus its leading separator; an internal span sums its two children.
// Replacing a leaf shares every unaffected subtree. Thus a pointer can still address the exact frame
// it saw while idle measurement changes thousands of other offsets. No snapshot copies an N-row table.
interface Span {
	readonly rows: number;
	readonly lead?: number;
	readonly left?: Span;
	readonly right?: Span;
}

const EMPTY: Span = { rows: 0 };
const ESTIMATE: Span = { rows: 1 };

function leaf(height: number, lead: number): Span {
	return lead ? { rows: height + lead, lead } : height === 0 ? EMPTY : height === 1 ? ESTIMATE : { rows: height };
}

function join(left: Span, right: Span): Span {
	return { rows: left.rows + right.rows, left, right };
}

function build(entries: readonly Entry[], lo: number, hi: number): Span {
	if (lo === hi) return EMPTY;
	if (hi - lo === 1) return leaf(entries[lo]!.height, entries[lo]!.lead);
	const mid = (lo + hi) >>> 1;
	return join(build(entries, lo, mid), build(entries, mid, hi));
}

function replace(span: Span, lo: number, hi: number, i: number, value: Span): Span {
	if (hi - lo === 1) return value;
	const mid = (lo + hi) >>> 1;
	return i < mid
		? join(replace(span.left!, lo, mid, i, value), span.right!)
		: join(span.left!, replace(span.right!, mid, hi, i, value));
}

/** An immutable coordinate system for a frame; unmeasured heights start at one row. No Blocks here. */
export class HistoryLayout {
	constructor(
		readonly nodes: readonly UiNode[],
		readonly index: ReadonlyMap<UiNode, number>,
		readonly width: number,
		private readonly span: Span,
	) {}

	get rows(): number {
		return this.span.rows;
	}

	/** Start of the node's separator, or the document end at nodes.length. */
	before(i: number): number {
		if (i >= this.nodes.length) return this.rows;
		let span = this.span;
		let lo = 0;
		let hi = this.nodes.length;
		let sum = 0;
		while (hi - lo > 1) {
			const mid = (lo + hi) >>> 1;
			if (i < mid) {
				span = span.left!;
				hi = mid;
			} else {
				sum += span.left!.rows;
				span = span.right!;
				lo = mid;
			}
		}
		return sum;
	}

	lead(i: number): number {
		let span = this.span;
		let lo = 0;
		let hi = this.nodes.length;
		while (hi - lo > 1) {
			const mid = (lo + hi) >>> 1;
			if (i < mid) {
				span = span.left!;
				hi = mid;
			} else {
				span = span.right!;
				lo = mid;
			}
		}
		return span.lead ?? 0;
	}

	top(i: number): number {
		return this.before(i) + this.lead(i);
	}

	/** Node containing the row, including its separator. Empty spans are skipped even across long runs. */
	at(row: number): number {
		if (row < 0 || row >= this.rows) return -1;
		let span = this.span;
		let lo = 0;
		let hi = this.nodes.length;
		while (hi - lo > 1) {
			const mid = (lo + hi) >>> 1;
			if (row < span.left!.rows) {
				span = span.left!;
				hi = mid;
			} else {
				row -= span.left!.rows;
				span = span.right!;
				lo = mid;
			}
		}
		return lo;
	}

	withMeasuredSpan(i: number, height: number, lead: number): HistoryLayout {
		const updated = replace(this.span, 0, this.nodes.length, i, leaf(height, lead));
		return new HistoryLayout(this.nodes, this.index, this.width, updated);
	}
}

interface Entry {
	readonly node: UiNode;
	i: number;
	height: number;
	lead: number;
	/** Height was observed at this width, rather than estimated or carried across a resize. */
	known: boolean;
	/** A new node in an existing document can produce unseen output on first measurement. */
	added: boolean;
	/** Length and prefix checksum per row at this width; no offscreen strings or paints. */
	ink?: Uint32Array;
	/** Last source position of each rolling preview in this block. */
	tails?: ReadonlyMap<number, RenderedTextTail>;
	/** The last paint while in the window, never retained offscreen. */
	painted?: Block;
	heightWatch?: () => void;
	gapWatch?: () => void;
	above?: UiNode;
}

/** The runs actually drawn, without borders, right padding, styling or clipped text. */
function rowContent(row: RenderedTextRow | undefined): string {
	if (!row) return "";
	if (!row.spans) return row.line.text.slice(row.start, row.end);
	let text = "";
	for (const span of row.spans) text += row.line.text.slice(span.start, span.end);
	return text;
}

/** Track exactly the reads that produced a measurement, not the rows. On the first change, enqueue
 * one new measurement and unsubscribe. A theme/clock write must not synchronously repaint history. */
function watchNumber(read: () => number, stale: () => void): { value: number; dispose: () => void } {
	// A detached root inherits its creator's owner. Do not keep an old frame's closure and full
	// FramePlan alive through the owner of an otherwise scalar, document-lifetime measurement.
	return runWithOwner(null, () =>
		createRoot(dispose => {
			let first = true;
			let value = 0;
			effect(() => {
				if (first) {
					first = false;
					value = read();
				} else stale();
			});
			return { value, dispose };
		}),
	);
}

const SMALL_HISTORY = 12;
const BATCH_BLOCKS = 16;
const BATCH_MS = 8;

export interface BlockPosition {
	readonly i: number;
	/** Negative in this node's leading separator. */
	readonly row: number;
}

export class FullscreenHistory {
	readonly #options: HistoryPaint;
	readonly #revision = signal(0);
	#entries: Entry[] = [];
	#layout = new HistoryLayout([], new Map(), 0, EMPTY);
	readonly #pending = new Set<Entry>();
	readonly #gaps = new Set<Entry>();
	readonly #paints = new Map<Entry, WindowPaint>();
	readonly #used = new Set<Entry>();
	#idle: NodeJS.Immediate | undefined;
	#paused = true;
	#ready = false;
	#windowIncomplete = false;
	#detached = false;
	/** Keep a block-relative position: measurement above it can move its document row. */
	#growth: { entry: Entry; row: number } | undefined;

	constructor(options: HistoryPaint) {
		this.#options = options;
	}

	get layout(): HistoryLayout {
		return this.#layout;
	}
	get ready(): boolean {
		return this.#ready;
	}
	/** Last document row that gained output, or -1. Cold height estimates and reflow do not count. */
	get grew(): number {
		return this.#growth ? this.#layout.top(this.#growth.entry.i) + this.#growth.row : -1;
	}

	begin(nodes: readonly UiNode[], width: number, detached: boolean): void {
		// Every new upstream frame watcher must subscribe, including scroll/dock-only frames.
		this.#revision();
		this.#paused = false;
		// Following never needs to inspect the live reply's lazy text on every token. At the
		// moment of detachment, take the baselines from the paints the reader actually saw.
		if (detached && !this.#detached && width === this.#layout.width) {
			for (const entry of this.#paints.keys()) {
				if (entry.painted) this.#content(entry, entry.painted);
			}
		}
		this.#detached = detached;
		this.#windowIncomplete = false;
		this.#used.clear();
		if (nodes !== this.#layout.nodes || width !== this.#layout.width) this.#reset(nodes, width, detached);
		// Small documents expose exact totals and marks in their first frame, just as inline does.
		if (nodes.length <= SMALL_HISTORY) {
			this.#work(Infinity, Infinity);
			this.#ready = true;
		}
	}

	#reset(nodes: readonly UiNode[], width: number, detached: boolean): void {
		const previous = this.#layout;
		const resized = width !== previous.width;
		const index = new Map<UiNode, number>();
		let retained = false;
		const entries = nodes.map((node, i) => {
			// A reused node can occur twice in a region. Its positions need distinct height entries;
			// the node index, as elsewhere in the backend, addresses the last occurrence.
			const old = index.has(node) ? undefined : previous.index.get(node);
			index.set(node, i);
			if (old !== undefined) retained = true;
			const entry: Entry =
				old === undefined
					? { node, i, height: 1, lead: 0, known: false, added: detached && !resized }
					: this.#entries[old]!;
			entry.i = i;
			if (resized || old === undefined) {
				entry.known = false;
				if (resized) entry.added = false;
				entry.heightWatch?.();
				delete entry.heightWatch;
				this.#pending.add(entry);
				this.#release(entry);
			}
			return entry;
		});
		for (const entry of this.#entries) {
			if (entries[entry.i] === entry) continue;
			entry.heightWatch?.();
			entry.gapWatch?.();
			this.#release(entry);
			this.#pending.delete(entry);
			this.#gaps.delete(entry);
		}
		// A separator belongs to its pair of *nonempty* neighbors, not an array index.
		let above: UiNode | undefined;
		for (const entry of entries) {
			if (entry.above !== above || resized) {
				entry.gapWatch?.();
				delete entry.gapWatch;
				delete entry.above;
				entry.lead = 0;
				if (entry.known && entry.height) this.#gaps.add(entry);
			}
			if (entry.height) above = entry.node;
		}
		this.#entries = entries;
		this.#layout = new HistoryLayout(nodes, index, width, build(entries, 0, entries.length));
		if (resized || !retained) this.#ready = false;
		if (resized || (this.#growth && entries[this.#growth.entry.i] !== this.#growth.entry)) this.#growth = undefined;
	}

	#release(entry: Entry): void {
		this.#paints.get(entry)?.dispose();
		this.#paints.delete(entry);
		delete entry.painted;
	}

	#grewAt(entry: Entry, row: number): void {
		const old = this.#growth;
		if (this.#detached && (!old || old.entry.i < entry.i || (old.entry === entry && old.row < row)))
			this.#growth = { entry, row };
	}

	/** Record enough to recognize an appended suffix on any row, even inside a partially visible
	 * block. A replacement (e.g. a wider spinner glyph) is not an append. Refresh only a newly
	 * measured or changed block and keep neither its text nor its image placements in the index. */
	#content(entry: Entry, block: Block): void {
		const rows = blockText(block);
		const size = rows.length * 2;
		const sameHeight = entry.ink?.length === size;
		const ink = sameHeight ? entry.ink! : (entry.ink = new Uint32Array(size));
		const compare = this.#detached && entry.known && sameHeight;
		let tails: Map<number, RenderedTextTail> | undefined;
		let grew = -1;
		for (let r = 0; r < rows.length; r++) {
			const row = rows[r];
			const text = rowContent(row);
			const tail = row?.tail;
			if (tail) (tails ??= new Map()).set(tail.source, tail);
			const at = r * 2;
			const length = ink[at]!;
			if (compare) {
				// A rolling pane replaces rows rather than extending them. Once it moved, the
				// old checksum at this position belongs to a different source row, even on shrink.
				const before = tail && entry.tails?.get(tail.source);
				const shift = tail && before && (tail.lines - before.lines || tail.lastLineRows - before.lastLineRows);
				if (tail && shift !== 0) {
					if (shift !== undefined && shift > 0) grew = r;
				} else if (
					text.length > length &&
					(length === 0 || Bun.hash.cityHash32(text.slice(0, length)) === ink[at + 1])
				)
					grew = r;
			}
			ink[at] = text.length;
			ink[at + 1] = text.length ? Bun.hash.cityHash32(text) : 0;
		}
		if (tails || entry.tails) entry.tails = tails;
		if (grew >= 0) this.#grewAt(entry, grew);
	}

	#height(entry: Entry, height: number): void {
		const before = entry.height;
		if ((entry.known && height > before) || (entry.added && height > 0)) this.#grewAt(entry, height - 1);
		entry.known = true;
		entry.added = false;
		if (height !== before) {
			entry.height = height;
			if (!height) {
				entry.gapWatch?.();
				delete entry.gapWatch;
				delete entry.above;
				entry.lead = 0;
			}
			this.#layout = this.#layout.withMeasuredSpan(entry.i, height, entry.lead);
			if (!height || !before) {
				const next = this.#layout.at(this.#layout.before(entry.i + 1));
				if (next >= 0 && this.#entries[next]!.known) this.#gap(this.#entries[next]!);
			}
		}
		this.#gap(entry);
	}

	#gap(entry: Entry): void {
		if (!entry.height) {
			this.#gaps.delete(entry);
			return;
		}
		const prev = this.#layout.at(this.#layout.before(entry.i) - 1);
		const above = this.#entries[prev]?.node;
		const dirty = this.#gaps.delete(entry);
		if (!dirty && entry.above === above) return;
		entry.gapWatch?.();
		delete entry.gapWatch;
		let lead = 0;
		if (above) {
			entry.above = above;
			const measured = watchNumber(
				() => Math.max(0, this.#options.separator(above, entry.node)),
				() => {
					this.#gaps.add(entry);
					this.#schedule();
				},
			);
			lead = measured.value;
			entry.gapWatch = measured.dispose;
		} else delete entry.above;
		if (lead === entry.lead) return;
		entry.lead = lead;
		this.#layout = this.#layout.withMeasuredSpan(entry.i, entry.height, lead);
	}

	/** Refresh this block's measurements. Nested reactive reads subscribe here, not on the backend's frame. */
	#measure(entry: Entry): void {
		this.#pending.delete(entry);
		entry.heightWatch?.();
		const width = this.#layout.width;
		const measured = watchNumber(
			() => {
				const block = this.#options.measure(entry.node, width);
				this.#content(entry, block);
				return block.rows.length;
			},
			() => {
				this.#pending.add(entry);
				this.#schedule();
			},
		);
		entry.heightWatch = measured.dispose;
		this.#height(entry, measured.value);
	}

	height(i: number): number {
		const entry = this.#entries[i]!;
		if (this.#pending.has(entry)) this.#measure(entry);
		return entry.height;
	}

	/** Read the live block inside this frame, so equal-output suppression and cursor-only changes
	 * still go through the backend's paint computation. Keep its rows only while it is in the window. */
	show(i: number): Block {
		const entry = this.#entries[i]!;
		let paint = this.#paints.get(entry);
		if (paint && this.#used.has(entry)) return paint.read();
		if (!paint) {
			paint = runWithOwner(null, () => this.#options.paint(entry.node, this.#layout.width));
			this.#paints.set(entry, paint);
		}
		this.#used.add(entry);
		entry.heightWatch?.();
		delete entry.heightWatch;
		this.#pending.delete(entry);
		const block = paint.read();
		if (this.#detached && entry.painted !== block) this.#content(entry, block);
		entry.painted = block;
		this.#height(entry, block.rows.length);
		return block;
	}

	/** Discover a real window from its anchor, or backwards from the tail. Even a long run of cold
	 * empty blocks yields: only discovered rows can be drawn; the idle index finishes that run. */
	cover(position: BlockPosition | undefined, body: number): boolean {
		let room = body;
		let i = position?.i ?? this.#layout.at(this.#layout.rows - 1);
		let below: Entry | undefined;
		const limit = Math.max(BATCH_BLOCKS, body * 2);
		for (let steps = 0; i >= 0 && room > 0 && steps < limit; steps++) {
			const entry = this.#entries[i]!;
			// If only the separator would be visible, confirm the neighbor's height without placing it.
			if (below && below.lead >= room && this.height(i) && below.lead >= room) return false;
			if (
				position &&
				i !== position.i &&
				this.#layout.lead(i) >= room &&
				this.height(i) &&
				this.#layout.lead(i) >= room
			)
				return false;
			const height = this.show(i).rows.length;
			if (height) {
				if (position) room -= height - (i === position.i ? position.row : -entry.lead);
				else {
					room -= height + (below?.lead ?? 0);
					below = entry;
				}
			}
			i = position ? this.#layout.at(this.#layout.before(i + 1)) : this.#layout.at(this.#layout.before(i) - 1);
		}
		if (i >= 0 && room > 0) this.#windowIncomplete = true;
		return i < 0 && room >= 0;
	}

	/** Frame-local block identities, also used by the pointer until the next presentation. */
	frameBlocks(offset: number, body: number): ReadonlyMap<UiNode, Block> {
		const out = new Map<UiNode, Block>();
		const end = Math.min(this.#layout.rows, offset + body);
		for (let row = offset; row < end;) {
			const i = this.#layout.at(row);
			const entry = this.#entries[i]!;
			if (this.#used.has(entry) && this.#layout.top(i) < end) out.set(entry.node, this.#paints.get(entry)!.read());
			row = this.#layout.before(i + 1);
		}
		return out;
	}

	finish(blocks: ReadonlyMap<UiNode, Block>): void {
		for (const entry of this.#paints.keys()) {
			if (this.#used.has(entry) && blocks.has(entry.node)) continue;
			this.#release(entry);
			this.#pending.add(entry); // re-arm offscreen observation now that the frame no longer watches it
		}
		this.#growth = undefined;
		if (!this.#pending.size && !this.#gaps.size) this.#ready = true;
		this.#schedule();
	}

	/** First actual nonempty node past `i`, skipping indexed empty spans in O(log N). Used for
	 * relative gestures only: an estimated predecessor must never count as one row of wheel motion. */
	adjacent(i: number, direction: -1 | 1): number {
		for (;;) {
			const next =
				direction < 0 ? this.#layout.at(this.#layout.before(i) - 1) : this.#layout.at(this.#layout.before(i + 1));
			if (next < 0 || this.height(next) > 0) return next;
			i = next;
		}
	}

	walk(start: BlockPosition, delta: number): BlockPosition | undefined {
		let { i, row } = start;
		while (delta) {
			const height = this.height(i);
			if (delta < 0) {
				if (row + delta >= 0) return { i, row: row + delta };
				const prev = this.adjacent(i, -1);
				if (prev < 0) return { i, row: 0 };
				const lead = this.#entries[i]!.lead;
				if (row + delta >= -lead) return { i, row: row + delta };
				delta += row + lead + 1;
				i = prev;
				row = this.height(i) - 1;
			} else {
				if (row + delta < height) return { i, row: row + delta };
				delta -= height - row;
				i = this.adjacent(i, 1);
				if (i < 0) return undefined;
				row = -this.#entries[i]!.lead;
			}
		}
		return { i, row };
	}

	document(
		layout: HistoryLayout,
		blocks: ReadonlyMap<UiNode, Block>,
		offset: number,
		body: number,
	): SelectionDocument {
		return {
			nodes: layout.nodes,
			rows: layout.rows,
			block: node =>
				blocks.get(node) ?? (layout.index.has(node) ? this.#options.measure(node, layout.width) : EMPTY_BLOCK),
			top: node => {
				const i = layout.index.get(node);
				return i === undefined ? undefined : layout.top(i);
			},
			at: row => {
				const cell = cellAt(layout, row);
				return cell && (row < offset || row >= offset + body || blocks.has(cell.node)) ? cell : undefined;
			},
		};
	}

	/** A copy can cross an entirely unvisited interval. Resolve its blocks in order, correcting their
	 * heights and separators before each top lookup, without materializing their predecessors or
	 * acquiring their image placements. Keep only the block currently being copied. */
	copyDocument(blocks: ReadonlyMap<UiNode, Block>): SelectionDocument {
		const history = this;
		let last: UiNode | undefined;
		let block = EMPTY_BLOCK;
		const read = (node: UiNode): Block => {
			if (node === last) return block;
			last = node;
			const i = history.layout.index.get(node);
			if (i === undefined) return (block = EMPTY_BLOCK);
			block = blocks.get(node) ?? this.#options.measure(node, history.layout.width);
			const entry = this.#entries[i]!;
			if (this.#detached && entry.painted !== block) this.#content(entry, block);
			this.#height(entry, block.rows.length);
			return block;
		};
		return {
			nodes: this.#layout.nodes,
			get rows() {
				return history.layout.rows;
			},
			block: read,
			top: node => {
				const i = history.layout.index.get(node);
				if (i === undefined) return undefined;
				read(node);
				return history.layout.top(i);
			},
			at: row => cellAt(history.layout, row),
		};
	}

	#work(limit: number, deadline: number): void {
		let count = 0;
		for (const entry of this.#gaps) {
			this.#gap(entry);
			if (++count >= limit || performance.now() >= deadline) return;
		}
		for (const entry of this.#pending) {
			this.#measure(entry);
			if (++count >= limit || performance.now() >= deadline) return;
		}
	}

	#schedule(): void {
		if (this.#paused || this.#idle || (!this.#pending.size && !this.#gaps.size)) return;
		// A quiet terminal may have no other pending events. Keep this finite job referenced so
		// that measured offsets and metricsReady are published without a keypress to wake Bun.
		this.#idle = setImmediate(() => {
			this.#idle = undefined;
			const previous = this.#layout;
			const ready = this.#ready;
			const grew = this.#growth;
			this.#work(BATCH_BLOCKS, performance.now() + BATCH_MS);
			if (!this.#pending.size && !this.#gaps.size) this.#ready = true;
			// Actual text can grow without moving a single row. Wake a detached reader even when
			// the index geometry didn't change, but not for a spinner or other non-growing repaint.
			if (this.#layout !== previous || this.#ready !== ready || this.#growth !== grew || this.#windowIncomplete) {
				this.#windowIncomplete = false;
				this.#revision.update(n => n + 1);
			}
			this.#schedule();
		});
	}

	pause(): void {
		this.#paused = true;
		clearImmediate(this.#idle);
		this.#idle = undefined;
		for (const entry of this.#paints.keys()) {
			this.#release(entry);
			this.#pending.add(entry);
		}
	}

	dispose(): void {
		this.pause();
		this.#reset([], 0, false);
		this.#used.clear();
	}
}

function cellAt(layout: HistoryLayout, row: number): { node: UiNode; row: number } | undefined {
	const i = layout.at(row);
	if (i < 0) return undefined;
	const local = row - layout.top(i);
	return local < 0 ? undefined : { node: layout.nodes[i]!, row: local };
}
