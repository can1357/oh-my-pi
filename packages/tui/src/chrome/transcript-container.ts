import { type Component, Container, type HistoryBatch } from "../tui";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { popLoopPhase, pushLoopPhase } from "@oh-my-pi/pi-utils";
import { col } from "../native/describe";
import type { NativeNode } from "../native/node";
import { isNativeSettled, settleNative } from "../native/settle";
import { isUsageRowBlock } from "../overlays/usage-row";
import { isToolActivityComponent } from "./tool-activity";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
}

/** Presentation declaration captured permanently when a block is added. */
export type TranscriptBlockMode = "mutable" | "appendOnly";

/** Immutable width-independent identity for one stable semantic row. */
export interface TranscriptStableRow {
	readonly key: string;
}

/**
 * Explicit semantic-row contract for a block whose stable head may enter native
 * history before finalization. Every later array must extend the prior keys
 * exactly; each row renderer is deterministic for its width.
 * A publication that breaks these invariants (e.g. a mid-stream theme change
 * re-coloring already-emitted bytes) freezes further stable-row emission for
 * that block instead of failing the render — see {@link TranscriptContainer}.
 */
export interface AppendOnlyTranscriptBlock {
	readonly transcriptBlockMode: "appendOnly";
	getTranscriptStableRows(): readonly TranscriptStableRow[];
	/**
	 * Render the first `count` semantic rows at the requested current width.
	 * Counts are monotonic identities, not physical row counts; this output must
	 * prefix the block's full render at the same width.
	 */
	renderTranscriptStableRows(count: number, width: number): readonly string[];
	/**
	 * Discard every published stable row so the block re-renders its head from
	 * scratch. Called only alongside a destructive display reset (e.g. a
	 * thinking-visibility toggle) that clears the native scrollback those rows
	 * occupied — the sole context in which the append-only "published bytes never
	 * change" contract may be retracted. Optional: blocks whose stable-row
	 * presentation never changes may omit it.
	 */
	resetTranscriptStableRows?(): void;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	/** Render the row that must remain represented under emergency viewport pressure. */
	renderTranscriptBlockEmergencyRow?(width: number): string | undefined;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport until pressure.
 * - `committed`: logically retired; replay never rewinds this state.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
	mode: TranscriptBlockMode;
	stableRows: readonly TranscriptStableRow[];
	renderedStableByWidth: Map<number, readonly string[]>;
	/**
	 * Rendered row counts per `(width, snapshot count)`: lets the projected
	 * length skip the re-render when the same prefix was already rendered.
	 * Keyed on both dimensions because one snapshot commonly renders to
	 * multiple physical rows (Markdown wrap).
	 */
	stableRowCountByWidth: Map<number, Map<number, number>>;
	emitted: number;
	/**
	 * Set when a published stable row drifted (retraction, byte change within a
	 * width epoch, or no longer a render prefix). Rows already in native
	 * scrollback cannot be retracted, so the entry keeps its last good stable
	 * state for emitted-row slicing but never emits another mid-stream row.
	 */
	stableFrozen: boolean;
}

type RetirementPolicy = "pressure" | "flush";
type Offered =
	| { batch: HistoryBatch; kind: "append"; entry: number; emittedEnd: number }
	| { batch: HistoryBatch; kind: "commit"; end: number }
	| { batch: HistoryBatch; kind: "replay" };

/** Rows a progressive-append retirement offers, and the stable count they bring the head to. */
interface AppendBatch {
	rows: readonly string[];
	emittedEnd: number;
}

const MAX_LIVE_BLOCKS = 256;
/** Grace before a pressure-blocked frontier is reported; a streaming block may legitimately hold it briefly. */
const PINNED_FRONTIER_WARN_MS = 30_000;
/**
 * Wall-clock budget for composing one retirement batch. A resumed session
 * hands the container its whole ledger at once, and rendering all of it in the
 * frame that first paints it blocks the loop for as long as that render takes
 * (#12933). Retirement stops after the first block that crosses the budget;
 * the remainder follows on the next frames, which the TUI schedules through
 * timers, so terminal input runs between batches.
 */
const RETIREMENT_BUDGET_MS = 8;
const EMPTY_ROWS: readonly string[] = [];
const EMPTY_STABLE_ROWS: readonly TranscriptStableRow[] = [];

function isFinalized(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.isTranscriptBlockFinalized?.() ?? true;
}

function blockMode(component: Component): TranscriptBlockMode {
	return (component as Component & Partial<AppendOnlyTranscriptBlock>).transcriptBlockMode === "appendOnly"
		? "appendOnly"
		: "mutable";
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Whether `prefix` matches `rows` byte-for-byte from the top. */
export function isRowPrefix(prefix: readonly string[], rows: readonly string[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index] !== rows[index]) return false;
	}
	return true;
}

function isStablePrefix(prefix: readonly TranscriptStableRow[], rows: readonly TranscriptStableRow[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index]!.key !== rows[index]!.key) return false;
	}
	return true;
}

/** Strip leading/trailing all-blank rows; the viewport allocator measures blocks by this trimmed height. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** One live block's row span in the last `renderViewport` output (half-open `[start, end)`). */
export interface TranscriptViewportSpan {
	component: Component;
	start: number;
	end: number;
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: Offered | undefined;
	#replayPending = false;
	#replayRequested = false;
	#toolActivityVisible = true;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };
	// Start rows from the last full render(), keyed by child component (transcript deep-links).
	#childStartRows = new Map<Component, number>();
	// Watchdog for the wedge where an unfinalized frontier block pins pressure
	// retirement: everything behind it stays live and degrades to one-line
	// allocations. Logs once per pinned episode after a grace period.
	#pinnedFrontier: { index: number; since: number; logged: boolean } | undefined;
	/** Block spans of the last `renderViewport` output, for click hit-testing. */
	#lastViewportSpans: TranscriptViewportSpan[] = [];
	/**
	 * The composed frame {@link beginFrame} opened; `undefined` outside one.
	 * {@link renderViewport} closes it, so it never outlives the synchronous
	 * composition that opened it.
	 */
	#openFrame: AnimationFrame | undefined;
	/**
	 * Full-allocation blank-trimmed renders of the blocks measured during the
	 * open frame, keyed by entry at {@link #frameRowsWidth}. A retirement peek
	 * and the viewport measure the same live blocks back to back inside one
	 * composition, with no block mutation possible in between; replaying the
	 * first measurement spares every block its second render per frame.
	 */
	#frameRows = new Map<TranscriptEntry, readonly string[]>();
	#frameRowsWidth = 0;
	/** The `children` array `#entries` last mirrored; see {@link #syncEntries}. */
	#syncedChildren: Component[] | undefined;
	/** Forces the next {@link #syncEntries} to compare every entry, not just the live tail. */
	#entriesUnverified = false;
	/** Block list handed to the native frame provider, reused while the children are unchanged. */
	#nativeBlocks: readonly Component[] = [];
	#nativeNode: NativeNode | undefined;
	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#entries.push({
			component,
			state: "active",
			mode: blockMode(component),
			stableRows: EMPTY_STABLE_ROWS,
			renderedStableByWidth: new Map(),
			stableRowCountByWidth: new Map(),
			emitted: 0,
			stableFrozen: false,
		});
		// Callers may splice a just-added block into place (insert after an
		// anchor); re-check the whole list once instead of trusting positions.
		this.#entriesUnverified = true;
	}

	override removeChild(component: Component): void {
		if (this.children.indexOf(component) < 0 || !this.canRemoveBlock(component)) return;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
		this.#childStartRows.delete(component);
	}

	override clear(): void {
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#childStartRows.clear();
		this.#pinnedFrontier = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#lastViewportSpans = [];
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	/**
	 * Forget the append-only emission ledger — emitted counts, published stable
	 * rows, per-width render cache, and freeze state — for every block, and ask
	 * each append-only block to drop its own published rows. The next replay then
	 * re-renders each block from its current {@link Component.render}, applying a
	 * changed presentation (e.g. a thinking-visibility toggle) to rows that were
	 * already emitted as stable heads while streaming (#10177).
	 *
	 * Callers MUST pair this with a scrollback-clearing {@link resetDisplay}: the
	 * emitted rows it forgets still sit in native history until that clear
	 * rewrites them, so unpaired use would duplicate them on the next retirement.
	 */
	resetStableEmission(): void {
		this.#syncEntries();
		if (this.#offered?.kind === "append") this.#offered = undefined;
		for (const entry of this.#entries) {
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth = new Map();
			entry.stableRowCountByWidth = new Map();
			entry.stableFrozen = false;
			if (entry.mode === "appendOnly") {
				(entry.component as Component & AppendOnlyTranscriptBlock).resetTranscriptStableRows?.();
			}
		}
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0) return false;
		if (this.#offered?.kind === "commit" && index < this.#offered.end) return false;
		if (this.#offered?.kind === "append" && index === this.#offered.entry) return false;
		return true;
	}

	/**
	 * Whether a superseded snapshot block (a repeated `wait` poll) may be
	 * replaced by its successor. Beyond {@link canRemoveBlock}, a block directly
	 * above a usage row stays: that row describes the turn the block belongs to,
	 * and removing the block would leave a usage-only turn (#12248).
	 */
	canDisplaceBlock(component: Component): boolean {
		if (!this.canRemoveBlock(component)) return false;
		const next = this.children[this.children.indexOf(component) + 1];
		return next === undefined || !isUsageRowBlock(next);
	}

	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Permanently captured presentation mode per block (diagnostics and tests). */
	blockModes(): readonly TranscriptBlockMode[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.mode);
	}

	/** Emitted stable semantic-row counts in transcript order. */
	emittedStableRows(): readonly number[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.emitted);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Prepares one atomic replay of the committed ledger and an emitted active-head prefix. */
	beginReplay(): void {
		this.#syncEntries();
		if (this.#offered !== undefined) {
			this.#replayRequested = true;
			return;
		}
		this.#startReplay();
	}
	/**
	 * Drop a not-yet-offered replay so a shutdown flush emits only un-retired
	 * rows. The terminal already holds the committed ledger; re-streaming it at
	 * quit is pure write volume. An already offered replay batch stays valid.
	 */
	cancelReplay(): void {
		this.#replayPending = false;
		this.#replayRequested = false;
	}

	/**
	 * Open one composed frame: every live-block measurement until this frame's
	 * {@link renderViewport} returns renders against `frame` and is taken once,
	 * so the retirement peek and the viewport share each block's render.
	 *
	 * Callers MUST call {@link renderViewport} with the same `frame` in the same
	 * synchronous composition, without mutating any transcript block in
	 * between: the shared rows are only as fresh as that first measurement.
	 */
	beginFrame(frame: AnimationFrame): void {
		this.#lastFrame = frame;
		this.#frameRows.clear();
		this.#openFrame = frame;
	}

	/**
	 * Total rows the live, un-emitted tail occupies at `width`.
	 *
	 * `limit` stops the walk once the total passes it: measuring a resumed
	 * session's whole ledger costs one full render per block, and callers only
	 * compare the height against a viewport budget. Past `limit` the result is
	 * a lower bound, guaranteed only to be greater than `limit`.
	 */
	liveRowCount(width: number, limit = Number.POSITIVE_INFINITY): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const { entry, index } of this.#liveEntries()) {
			const block = this.#liveBlockRows(entry, index, width);
			if (block.length > 0) total += block.length + (total > 0 ? 1 : 0);
			if (total > limit) break;
		}
		return total;
	}

	/** One live block's un-emitted rows at `width`, rendered against its full-height allocation. */
	#liveBlockRows(entry: TranscriptEntry, index: number, width: number): readonly string[] {
		const rows = this.#measuredRows(entry, width);
		const emitted = this.#projectedEmittedRowCount(entry, index, width);
		return emitted === 0 ? rows : rows.slice(emitted);
	}

	/**
	 * One block's blank-trimmed render at its full-height allocation. Inside an
	 * open frame the first measurement of each block is replayed to later ones.
	 */
	#measuredRows(entry: TranscriptEntry, width: number): readonly string[] {
		this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
		if (this.#openFrame === undefined) return this.#renderEntry(entry, width);
		if (this.#frameRowsWidth !== width) {
			this.#frameRows.clear();
			this.#frameRowsWidth = width;
		}
		let rows = this.#frameRows.get(entry);
		if (rows === undefined) {
			rows = this.#renderEntry(entry, width);
			this.#frameRows.set(entry, rows);
		}
		return rows;
	}

	#closeFrame(): void {
		this.#openFrame = undefined;
		this.#frameRows.clear();
	}

	/** Block spans of the last `renderViewport` output, in output coordinates. Empty when the tail is empty. */
	getLastViewportSpans(): readonly TranscriptViewportSpan[] {
		return this.#lastViewportSpans;
	}

	/** Collapse a per-line owner list into run-length block spans, clamped to `length`. */
	#commitViewportSpans(owners: readonly (Component | undefined)[], length: number = owners.length): void {
		const spans: TranscriptViewportSpan[] = [];
		let index = 0;
		while (index < length) {
			const component = owners[index];
			if (component === undefined) {
				index++;
				continue;
			}
			let end = index + 1;
			while (end < length && owners[end] === component) end++;
			spans.push({ component, start: index, end });
			index = end;
		}
		this.#lastViewportSpans = spans;
	}

	/**
	 * Render the live tail, constrained to the supplied transcript height.
	 * Closes the frame {@link beginFrame} opened; a different `frame` discards
	 * its measurements first.
	 */
	renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		if (frame !== this.#openFrame) this.#closeFrame();
		this.#lastFrame = frame;
		try {
			return this.#composeViewport(width, rows, frame);
		} finally {
			this.#closeFrame();
		}
	}

	#composeViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) {
			this.#lastViewportSpans = [];
			return EMPTY_ROWS;
		}

		// Collect newest-first and stop one block past what the viewport can
		// hold: beyond that the emergency layout is already certain, and every
		// further block would cost a full render to produce rows no frame can
		// show — the whole ledger on a resumed session's first paint (#12933).
		const shown: Array<{ entry: TranscriptEntry; index: number }> = [];
		const blocks: (readonly string[])[] = [];
		let unrendered = 0;
		for (let cursor = live.length - 1; cursor >= 0; cursor--) {
			if (shown.length > capacity) {
				unrendered = cursor + 1;
				break;
			}
			const candidate = live[cursor]!;
			const block = this.#liveBlockRows(candidate.entry, candidate.index, width);
			if (block.length === 0) continue;
			shown.push(candidate);
			blocks.push(block);
		}
		shown.reverse();
		blocks.reverse();
		let total = 0;
		for (const block of blocks) total += block.length + (total > 0 ? 1 : 0);
		if (shown.length === 0) {
			this.#lastViewportSpans = [];
			return EMPTY_ROWS;
		}
		if (shown.length > capacity) {
			// Blocks the walk never reached are still transcript state: the
			// emergency layout consults them only where it must.
			return this.#renderEmergency(shown, live.slice(0, unrendered), width, capacity, frame);
		}
		if (total <= capacity) {
			const output: string[] = [];
			const owners: (Component | undefined)[] = [];
			for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
				if (output.length > 0) {
					output.push("");
					owners.push(undefined);
				}
				const component = shown[blockIndex]!.entry.component;
				for (const line of blocks[blockIndex]!) {
					output.push(line);
					owners.push(component);
				}
			}
			this.#commitViewportSpans(owners, output.length);
			return output;
		}

		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const allocation: number[] = new Array(shown.length).fill(1);
		let surplus = capacity - shown.length;
		// Surplus rows favor ordinary transcript blocks over dynamic tool-activity
		// cards (newest-first within each class), so a growing tool card collapses to
		// its compact form instead of clipping already-visible assistant text (#9718).
		const order: number[] = [];
		for (let index = shown.length - 1; index >= 0; index--) {
			if (!isToolActivityComponent(shown[index]!.entry.component)) order.push(index);
		}
		for (let index = shown.length - 1; index >= 0; index--) {
			if (isToolActivityComponent(shown[index]!.entry.component)) order.push(index);
		}
		for (const index of order) {
			if (surplus <= 0) break;
			const extra = Math.min(Math.max(0, blocks[index]!.length - 1), surplus);
			allocation[index] += extra;
			surplus -= extra;
		}
		const output: string[] = [];
		const owners: (Component | undefined)[] = [];
		for (let index = 0; index < shown.length; index++) {
			const candidate = shown[index]!;
			const allocated = allocation[index]!;
			this.#setAllocation(candidate.entry.component, allocated, frame);
			const rendered = this.#renderEntry(candidate.entry, width).slice(
				this.#projectedEmittedRowCount(candidate.entry, candidate.index, width),
			);
			const visible = rendered.length <= allocated ? rendered : rendered.slice(rendered.length - allocated);
			for (const line of visible) {
				output.push(line);
				owners.push(candidate.entry.component);
			}
		}
		const drop = Math.max(0, output.length - capacity);
		this.#commitViewportSpans(owners.slice(drop), output.length - drop);
		return drop > 0 ? output.slice(drop) : output;
	}

	/** Offers stable-head emission or the shortest finalized prefix needed under pressure. */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Returns only a prepared complete replay, never a normal retirement offer. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		return this.#peekReplayBatch(width);
	}

	#peekReplayBatch(width: number): HistoryBatch | undefined {
		if (this.#offered !== undefined) {
			return this.#offered.kind === "replay" ? this.#offered.batch : undefined;
		}
		if (!this.#replayPending) return undefined;
		// The one path that must compose the whole ledger in a single frame; the
		// phase label attributes any watchdog block here instead of "unknown".
		pushLoopPhase("ui.transcript-replay");
		let rows: readonly string[];
		try {
			rows = this.#renderReplay(width);
		} finally {
			popLoopPhase();
		}
		this.#replayPending = false;
		if (rows.length === 0) return undefined;
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "replay" };
		this.#offered = { batch, kind: "replay" };
		return batch;
	}

	/** Offers the complete currently eligible prefix for graceful shutdown. */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		return this.#peekBatch(width, 0, "flush");
	}

	/** Recompose the unacknowledged batch so a discarded TUI frame can be rendered again. */
	rerenderOfferedBatch(width: number): HistoryBatch | undefined {
		const offered = this.#offered;
		if (offered === undefined) return undefined;
		let rows: readonly string[];
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined) return undefined;
			const before = this.#renderStablePrefix(entry, entry.emitted, width);
			const after = this.#renderStablePrefix(entry, offered.emittedEnd, width);
			rows = after.slice(before.length);
		} else if (offered.kind === "commit") {
			rows = this.#renderRange(this.#frontier, offered.end, width, true).rows;
		} else {
			rows = this.#renderReplay(width);
		}
		offered.batch = { id: offered.batch.id, rows, kind: offered.batch.kind };
		return offered.batch;
	}

	#peekBatch(width: number, capacity: number, policy: RetirementPolicy): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		const replay = this.#peekReplayBatch(width);
		if (replay !== undefined) return replay;

		this.#completeFullyEmittedHeads(width);
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;

		// Only a render publishes a block's stable rows, so the head renders
		// before its progressive-append eligibility is read.
		const head = this.#entries[this.#frontier];
		if (head !== undefined) this.#measuredRows(head, width);
		const appendHead =
			policy === "pressure" &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted < head.stableRows.length
				? head
				: undefined;

		// Measure the live tail newest-first and stop at the first block that
		// does not fit: `keep` counts the leading blocks bound for scrollback,
		// and everything behind them stays unmeasured. Measuring the whole live
		// region costs one full render per block, which on a resumed session's
		// first paint is every message it ever had (#12933). The progressive
		// append path below needs the exact live height to size its emission,
		// and only runs while a streaming head pins retirement.
		let tailRows = 0;
		let liveRows = 0;
		let keep = 0;
		let fits = true;
		for (let cursor = live.length - 1; cursor >= 0; cursor--) {
			const candidate = live[cursor]!;
			const height = this.#liveBlockRows(candidate.entry, candidate.index, width).length;
			if (height > 0) liveRows += height + (liveRows > 0 ? 1 : 0);
			if (fits) {
				const next = height > 0 ? tailRows + height + (tailRows > 0 ? 1 : 0) : tailRows;
				if (next > room) {
					fits = false;
					keep = cursor + 1;
				} else {
					tailRows = next;
				}
			}
			if (!fits && appendHead === undefined) break;
		}
		const overflowing = keep > 0 || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing) {
			this.#pinnedFrontier = undefined;
			return undefined;
		}

		if (appendHead !== undefined && keep > 0) {
			// Emit as many finished rows as the overflow needs, in one batch. A
			// fast stream adds finished rows quicker than one per pressure cycle,
			// and the live region has to fall back under `room` to stay readable:
			// rows left behind here are rows dropped from the top of the viewport.
			// `liveRows` is exact here: the append path measured every live block.
			const overflow = liveRows - room;
			const { rows, emittedEnd } =
				this.#measuredAppendBatch(appendHead, width, overflow) ??
				this.#renderedAppendBatch(appendHead, width, overflow);
			if (emittedEnd > appendHead.emitted) {
				const batch: HistoryBatch = {
					id: this.#nextBatchId++,
					rows,
					kind: "append",
				};
				this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
				this.#pinnedFrontier = undefined;
				return batch;
			}
		}

		// Shutdown retires everything eligible; pressure retires exactly the
		// blocks that no longer fit, plus whatever the live-block cap demands.
		let limit = this.#frontier + keep;
		if (this.#liveCount() >= MAX_LIVE_BLOCKS) {
			limit = Math.max(limit, this.#frontier + (this.#liveCount() - (MAX_LIVE_BLOCKS - 1)));
		}
		if (policy === "flush") limit = this.#entries.length;
		let end = this.#frontier;
		while (end < limit && end < this.#entries.length && this.#entries[end]!.state === "settled") end++;
		if (end === this.#frontier) {
			if (policy === "pressure") this.#notePinnedFrontier();
			return undefined;
		}
		this.#pinnedFrontier = undefined;
		pushLoopPhase("ui.transcript-retire");
		let retirement: { rows: readonly string[]; end: number };
		try {
			// Shutdown must hand over the full prefix; a live frame stops at the
			// budget and offers the rest on the next frames.
			retirement = this.#renderRange(
				this.#frontier,
				end,
				width,
				true,
				policy === "flush" ? undefined : RETIREMENT_BUDGET_MS,
			);
		} finally {
			popLoopPhase();
		}
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows: retirement.rows,
			kind: "append",
		};
		this.#offered = { batch, end: retirement.end, kind: "commit" };
		return batch;
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			// The offered end must still extend this entry's emitted prefix: a
			// stale offer (already-advanced entry) or a retraction (entry reset to
			// zero with the offer still live) must not move it backwards.
			if (entry === undefined || offered.entry !== this.#frontier || offered.emittedEnd <= entry.emitted) return;
			entry.emitted = offered.emittedEnd;
		} else if (offered.kind === "commit") {
			for (let index = this.#frontier; index < offered.end; index++) {
				this.#retireEntry(this.#entries[index]!);
			}
			this.#frontier = offered.end;
		}
		this.#offered = undefined;
		if (this.#replayRequested) this.#startReplay();
	}

	/**
	 * Render only the trailing `maxRows` semantic rows, walking blocks bottom-up.
	 * Used by the transient resize-buffer repaint, which needs one viewport of
	 * tail rows per resize event — never the full committed ledger.
	 */
	renderTail(width: number, maxRows: number): readonly string[] {
		this.#syncEntries();
		const cap = Math.max(0, Math.trunc(maxRows));
		if (cap === 0) return EMPTY_ROWS;
		const rows: string[] = [];
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.unshift("");
			rows.unshift(...block);
			if (rows.length >= cap) break;
		}
		return rows.length > cap ? rows.slice(rows.length - cap) : rows;
	}

	/**
	 * The transcript's blocks for a native (TSP) surface, one component per
	 * `main` child in transcript order; ids follow component identity, so
	 * inserts, removals (rewind, displacement) and reorders become targeted ops.
	 * Finalized blocks are settled as a hint; they stay editable, so a later
	 * expansion, late result or reaction still reaches them wherever they sit.
	 * No retirement happens on this path: the whole transcript is one document.
	 * Returns the same array while the block list is unchanged.
	 */
	nativeBlocks(): readonly Component[] {
		this.#syncEntries();
		const children = this.children;
		for (const child of children) {
			if (!isNativeSettled(child) && isFinalized(child)) settleNative(child);
		}
		const previous = this.#nativeBlocks;
		if (previous.length === children.length && previous.every((child, index) => child === children[index])) {
			return previous;
		}
		this.#nativeBlocks = children.slice();
		this.#nativeNode = undefined;
		return this.#nativeBlocks;
	}

	/** Embedded as a child (transcript viewers): a stack of the {@link nativeBlocks}. */
	override describe(): NativeNode {
		const blocks = this.nativeBlocks();
		this.#nativeNode ??= col(blocks, { role: "omp.transcript" });
		return this.#nativeNode;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		this.#childStartRows.clear();
		const rows: string[] = [];
		for (const entry of this.#entries) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = this.#renderEntry(entry, width);
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			this.#childStartRows.set(entry.component, rows.length);
			rows.push(...block);
		}
		return rows;
	}

	/** Rendered row where a child's block begins in the last full render() (transcript deep-links). */
	getChildStartRow(child: Component): number | undefined {
		return this.#childStartRows.get(child);
	}

	#renderEntry(entry: TranscriptEntry, width: number): readonly string[] {
		const rendered = trimBlankEdges(entry.component.render(width));
		if (entry.state === "committed" || entry.mode === "mutable" || entry.stableFrozen) return rendered;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		const stable = appendOnly.getTranscriptStableRows();
		if (!isStablePrefix(entry.stableRows, stable)) {
			return this.#freezeStableRows(entry, rendered, "publication retracted the published prefix");
		}
		if (entry.emitted > stable.length) {
			return this.#freezeStableRows(entry, rendered, "publication retracted emitted history");
		}
		const published =
			stable.length > entry.stableRows.length
				? [...entry.stableRows, ...stable.slice(entry.stableRows.length)]
				: entry.stableRows;
		const stableRendered = appendOnly.renderTranscriptStableRows(published.length, width);
		if (!isRowPrefix(stableRendered, rendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows no longer render as a prefix of the block");
		}
		const priorRender = entry.renderedStableByWidth.get(width);
		if (priorRender && !isRowPrefix(priorRender, stableRendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows changed within a width epoch");
		}
		entry.stableRows = published;
		// The prefix check above proves equal-length rows are byte-identical.
		// Reuse our snapshot then; copy new rows so mutable renderer buffers
		// cannot change the bytes checked on the next frame.
		if (priorRender === undefined || priorRender.length !== stableRendered.length) {
			entry.renderedStableByWidth.set(width, stableRendered.slice());
		}
		let perCount = entry.stableRowCountByWidth.get(width);
		if (perCount === undefined) {
			perCount = new Map();
			entry.stableRowCountByWidth.set(width, perCount);
		}
		perCount.set(published.length, stableRendered.length);
		return rendered;
	}

	/**
	 * Demote a drifting append-only publication: rows already written to native
	 * scrollback cannot be retracted, so keep the last good stable state for
	 * emitted-row slicing and stop mid-stream emission for this block. The block
	 * still renders and retires whole on finalization; worst case is the old
	 * finalize-time behavior plus a possible stale-byte seam in scrollback.
	 */
	#freezeStableRows(entry: TranscriptEntry, rendered: readonly string[], reason: string): readonly string[] {
		entry.stableFrozen = true;
		logger.warn("Append-only transcript block frozen", { reason, emitted: entry.emitted });
		return rendered;
	}

	#renderStablePrefix(entry: TranscriptEntry, count: number, width: number): readonly string[] {
		if (count === 0) return EMPTY_ROWS;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		return appendOnly.renderTranscriptStableRows(Math.min(count, entry.stableRows.length), width);
	}

	/**
	 * Length-only variant of `#renderStablePrefix`: answers the projected
	 * emitted row count without re-rendering the prefix. The container only
	 * needs the length for slicing; the render call it replaced existed
	 * purely to read `.length` off the result.
	 */
	#projectedEmittedRowCount(entry: TranscriptEntry, index: number, width: number): number {
		const offered = this.#offered;
		const count = offered?.kind === "append" && offered.entry === index ? offered.emittedEnd : entry.emitted;
		if (count === 0) return 0;
		const perCount = entry.stableRowCountByWidth.get(width);
		const memo = perCount?.get(Math.min(count, entry.stableRows.length));
		if (memo !== undefined) return memo;
		return this.#renderStablePrefix(entry, count, width).length;
	}

	/**
	 * Size a progressive-append batch from the stable renders `#renderEntry`
	 * recorded at this width, without rendering any prefix. Each recorded count
	 * was checked to render as a byte prefix of every later one, and
	 * `renderedStableByWidth` holds the newest, so each count's rows are a
	 * prefix of it and the batch is one slice. Undefined when a count the walk
	 * needs was never recorded here (published between renders, or before a
	 * resize); the rendered walk then decides.
	 */
	#measuredAppendBatch(entry: TranscriptEntry, width: number, overflow: number): AppendBatch | undefined {
		const counts = entry.stableRowCountByWidth.get(width);
		const newest = entry.renderedStableByWidth.get(width);
		const target = entry.stableRows.length;
		if (counts === undefined || newest === undefined || counts.get(target) !== newest.length) return undefined;
		const start = entry.emitted === 0 ? 0 : counts.get(entry.emitted);
		if (start === undefined) return undefined;
		let emittedEnd = entry.emitted;
		let end = start;
		while (emittedEnd < target && end - start < overflow) {
			const next = counts.get(emittedEnd + 1);
			if (next === undefined) return undefined;
			if (next <= start) {
				if (emittedEnd === entry.emitted) {
					this.#freezeStableRows(entry, EMPTY_ROWS, "semantic row render added no suffix");
				}
				break;
			}
			end = next;
			emittedEnd += 1;
		}
		return { rows: emittedEnd > entry.emitted ? newest.slice(start, end) : EMPTY_ROWS, emittedEnd };
	}

	/**
	 * Size a progressive-append batch by rendering each further stable prefix:
	 * extend the emitted prefix until its new rows cover `overflow`, stopping
	 * at the first prefix that adds no row or stops extending the emitted one
	 * (freezing the block when that is the very next prefix).
	 */
	#renderedAppendBatch(entry: TranscriptEntry, width: number, overflow: number): AppendBatch {
		const before = this.#renderStablePrefix(entry, entry.emitted, width);
		let emittedEnd = entry.emitted;
		let after = before;
		while (emittedEnd < entry.stableRows.length && after.length - before.length < overflow) {
			const next = this.#renderStablePrefix(entry, emittedEnd + 1, width);
			if (!isRowPrefix(before, next) || next.length === before.length) {
				if (emittedEnd === entry.emitted) {
					this.#freezeStableRows(entry, EMPTY_ROWS, "semantic row render added no suffix");
				}
				break;
			}
			after = next;
			emittedEnd += 1;
		}
		return { rows: emittedEnd > entry.emitted ? after.slice(before.length) : EMPTY_ROWS, emittedEnd };
	}

	/**
	 * Record that pressure retirement is blocked behind a not-yet-settled
	 * frontier block, and log its identity once the episode outlives the grace
	 * period. A block that never finalizes (a dropped terminal event) pins the
	 * whole live region here with no visible symptom other than degraded
	 * one-line layout, so the log line is the only forensic trail.
	 */
	#notePinnedFrontier(): void {
		const entry = this.#entries[this.#frontier];
		if (entry === undefined) return;
		const now = Date.now();
		if (this.#pinnedFrontier?.index !== this.#frontier) {
			this.#pinnedFrontier = { index: this.#frontier, since: now, logged: false };
			return;
		}
		if (this.#pinnedFrontier.logged || now - this.#pinnedFrontier.since < PINNED_FRONTIER_WARN_MS) return;
		this.#pinnedFrontier.logged = true;
		logger.warn("Transcript retirement pinned by unfinalized frontier block", {
			component: entry.component.constructor.name,
			state: entry.state,
			mode: entry.mode,
			liveBlocks: this.#liveCount(),
		});
	}

	/**
	 * Compose entries `[start, end)` as one ordered retirement payload.
	 *
	 * `budgetMs` stops the walk after the first block that crosses it — always
	 * at least one block — and reports the index actually reached, so a single
	 * frame never renders more of a resumed ledger than it can afford (#12933).
	 * Callers that must emit a whole prefix (replay, shutdown flush, recompose
	 * of an already offered batch) omit it.
	 */
	#renderRange(
		start: number,
		end: number,
		width: number,
		trailingBlank: boolean,
		budgetMs?: number,
	): { rows: readonly string[]; end: number } {
		const rows: string[] = [];
		const startedAt = budgetMs === undefined ? 0 : performance.now();
		let reached = start;
		for (let index = start; index < end; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			// Only the range head is sliced by its emitted stable prefix; every other
			// entry renders whole, so the append-only verification pass (a second
			// full render of the block's stable prefix) is skipped for them. This
			// keeps a complete-ledger replay at one render per block.
			const rendered =
				index === start ? this.#renderEntry(entry, width) : trimBlankEdges(entry.component.render(width));
			const emittedRows = index === start ? this.#renderStablePrefix(entry, entry.emitted, width).length : 0;
			const block = rendered.slice(emittedRows);
			reached = index + 1;
			if (block.length > 0) {
				if (rows.length > 0) rows.push("");
				rows.push(...block);
			}
			if (budgetMs !== undefined && performance.now() - startedAt >= budgetMs) break;
		}
		if (trailingBlank && rows.length > 0) rows.push("");
		return { rows, end: reached };
	}

	#renderReplay(width: number): readonly string[] {
		const rows = Array.from(this.#renderRange(0, this.#frontier, width, true).rows);
		const head = this.#entries[this.#frontier];
		if (head?.mode === "appendOnly" && head.emitted > 0) {
			this.#setAllocation(head.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			this.#renderEntry(head, width);
			rows.push(...this.#renderStablePrefix(head, head.emitted, width));
		}
		return rows;
	}

	#completeFullyEmittedHeads(width: number): void {
		while (this.#frontier < this.#entries.length) {
			const entry = this.#entries[this.#frontier]!;
			if (entry.mode !== "appendOnly" || entry.state !== "settled") return;
			const rendered = this.#measuredRows(entry, width);
			if (entry.emitted !== entry.stableRows.length) return;
			if (this.#renderStablePrefix(entry, entry.emitted, width).length !== rendered.length) return;
			this.#retireEntry(entry);
			this.#frontier++;
		}
	}

	#retireEntry(entry: TranscriptEntry): void {
		entry.state = "committed";
		entry.emitted = 0;
		entry.stableRows = EMPTY_STABLE_ROWS;
		entry.renderedStableByWidth = new Map();
		entry.stableRowCountByWidth = new Map();
	}

	#startReplay(): void {
		const head = this.#entries[this.#frontier];
		this.#replayPending = this.#frontier > 0 || (head?.mode === "appendOnly" && head.emitted > 0);
		this.#replayRequested = false;
	}

	/**
	 * One-row-per-block fallback for a live region that cannot fit the viewport.
	 * `behind` holds the older live blocks `renderViewport` deliberately left
	 * unrendered. Only its active blocks (few) and the newest settled block
	 * offering an emergency row are rendered, so the summary count and the
	 * surviving emergency row match a full walk without rendering the ledger.
	 */
	#renderEmergency(
		shown: readonly { entry: TranscriptEntry; index: number }[],
		behind: readonly { entry: TranscriptEntry; index: number }[],
		width: number,
		rows: number,
		frame: AnimationFrame,
	): readonly string[] {
		let hiddenBelow = 0;
		for (const candidate of behind) {
			if (candidate.entry.state !== "active") continue;
			if (this.#liveBlockRows(candidate.entry, candidate.index, width).length > 0) hiddenBelow++;
		}
		let behindEmergency: { candidate: { entry: TranscriptEntry; index: number }; row: string } | null | undefined;
		const findBehindEmergency = () => {
			if (behindEmergency !== undefined) return behindEmergency;
			behindEmergency = null;
			for (let index = behind.length - 1; index >= 0; index--) {
				const candidate = behind[index]!;
				if (candidate.entry.state !== "settled") continue;
				const block = candidate.entry.component as Component & FinalizableBlock;
				if (block.renderTranscriptBlockEmergencyRow === undefined) continue;
				if (this.#liveBlockRows(candidate.entry, candidate.index, width).length === 0) continue;
				const row = block.renderTranscriptBlockEmergencyRow(width);
				if (row === undefined) continue;
				behindEmergency = { candidate, row };
				break;
			}
			return behindEmergency;
		};
		let visibleRows = rows;
		let visible: { entry: TranscriptEntry; index: number }[] = [];
		let emergencyCandidate: { entry: TranscriptEntry; index: number } | undefined;
		let emergencyRow: string | undefined;
		let hiddenActive = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			visible = visibleRows > 0 ? shown.slice(-visibleRows) : [];
			emergencyCandidate = undefined;
			emergencyRow = undefined;
			const visibleStart = shown.length - visibleRows;
			for (let index = visibleStart - 1; index >= 0; index--) {
				const candidate = shown[index]!;
				const block = candidate.entry.component as Component & FinalizableBlock;
				const row =
					candidate.entry.state === "settled" ? block.renderTranscriptBlockEmergencyRow?.(width) : undefined;
				if (row === undefined) continue;
				emergencyCandidate = candidate;
				emergencyRow = row;
				visible = [candidate, ...visible.slice(1)];
				break;
			}
			if (emergencyCandidate === undefined) {
				const found = findBehindEmergency();
				if (found !== null) {
					emergencyCandidate = found.candidate;
					emergencyRow = found.row;
					visible = [found.candidate, ...visible.slice(1)];
				}
			}

			let activeTotal = hiddenBelow;
			for (const candidate of shown) {
				if (candidate.entry.state === "active") activeTotal++;
			}
			hiddenActive = activeTotal;
			for (const candidate of visible) {
				if (candidate.entry.state === "active") hiddenActive--;
			}
			// The summary row itself represents the newest active block when no
			// active row fits beside it; report only the additional backlog.
			if (hiddenActive === activeTotal && hiddenActive > 0) hiddenActive--;
			if (attempt === 0 && hiddenActive > 0) {
				visibleRows = Math.max(0, rows - 1);
				continue;
			}
			break;
		}

		const output = hiddenActive > 0 ? [`${hiddenActive} more transcript blocks active`] : [];
		const owners: (Component | undefined)[] = hiddenActive > 0 ? [undefined] : [];
		for (const candidate of visible) {
			if (candidate === emergencyCandidate) {
				output.push(emergencyRow ?? "");
				owners.push(candidate.entry.component);
				continue;
			}
			this.#setAllocation(candidate.entry.component, 1, frame);
			const rendered = this.#renderEntry(candidate.entry, width).slice(
				this.#projectedEmittedRowCount(candidate.entry, candidate.index, width),
			);
			output.push(rendered[0] ?? "");
			owners.push(candidate.entry.component);
		}
		const visibleOutput = output.slice(0, rows);
		this.#commitViewportSpans(owners, visibleOutput.length);
		return visibleOutput;
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	#settleFinalized(): void {
		for (let index = this.#frontier; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	#liveEntries(): Array<{ entry: TranscriptEntry; index: number }> {
		const start = this.#offered?.kind === "commit" ? this.#offered.end : this.#frontier;
		const live: Array<{ entry: TranscriptEntry; index: number }> = [];
		for (let index = start; index < this.#entries.length; index++) live.push({ entry: this.#entries[index]!, index });
		return live;
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	/**
	 * Mirror `children` into `#entries`. The container's own add/remove/clear
	 * keep the two aligned, so the per-frame check stays off the committed
	 * ledger: external edits to the public `children` array are caught by array
	 * identity (replacement), length (push, removing splices), and an identity
	 * scan of the live tail (in-place reorders and index writes). Committed
	 * blocks are immutable history nothing reorders, and the scan skipping
	 * them keeps this proportional to the live tail rather than the session.
	 */
	#syncEntries(): void {
		const children = this.children;
		if (
			!this.#entriesUnverified &&
			children === this.#syncedChildren &&
			this.#entriesMatch(children, this.#frontier)
		) {
			return;
		}
		this.#entriesUnverified = false;
		this.#syncedChildren = children;
		if (this.#entriesMatch(children, 0)) return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(
			component =>
				existing.get(component) ?? {
					component,
					state: "active",
					mode: blockMode(component),
					stableRows: EMPTY_STABLE_ROWS,
					renderedStableByWidth: new Map(),
					stableRowCountByWidth: new Map(),
					emitted: 0,
					stableFrozen: false,
				},
		);
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}

	/** Whether `#entries` has `children`'s length and components from `start` on. */
	#entriesMatch(children: readonly Component[], start: number): boolean {
		const entries = this.#entries;
		if (entries.length !== children.length) return false;
		for (let index = start; index < entries.length; index++) {
			if (entries[index]!.component !== children[index]) return false;
		}
		return true;
	}
}

/** Groups sibling rows into one conservative mutable semantic transcript block. */
export class TranscriptBlock extends Container {}
