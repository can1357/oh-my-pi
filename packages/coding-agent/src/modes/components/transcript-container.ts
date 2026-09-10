import type { Component, HistoryBatch } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
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
	/** Temporary progress rows may cover history but must not retire it. */
	isTranscriptBlockTransient?(): boolean;
	/** Render the row that must remain represented under emergency viewport pressure. */
	renderTranscriptBlockEmergencyRow?(width: number): string | undefined;
	/** Number of leading raw rows whose bytes are final while the block remains active. */
	getTranscriptBlockSettledRows?(): number;
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
	emitted: number;
	/** Position in the last logical live viewport; independent of durable retirement. */
	viewportStart?: number;
	borrowed?: boolean;
	viewportOffset?: number;
	viewportExtent?: number;
	borrowedEnd?: number;
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

const MAX_LIVE_BLOCKS = 256;
/** Grace before a pressure-blocked frontier is reported; a streaming block may legitimately hold it briefly. */
const PINNED_FRONTIER_WARN_MS = 30_000;
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

	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#entries.push({
			component,
			state: "active",
			mode: blockMode(component),
			stableRows: EMPTY_STABLE_ROWS,
			renderedStableByWidth: new Map(),
			emitted: 0,
			stableFrozen: false,
		});
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
			entry.borrowed = false;
			entry.viewportStart = undefined;
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth = new Map();
			entry.stableFrozen = false;
			if (entry.mode === "appendOnly") {
				(entry.component as Component & AppendOnlyTranscriptBlock).resetTranscriptStableRows?.();
			}
		}
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) {
			for (const entry of this.#entries) entry.state = "settled";
			this.#frontier = 0;
		}
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0 || entry.borrowed) return false;
		if (this.#offered?.kind === "commit" && index < this.#offered.end) return false;
		if (this.#offered?.kind === "append" && index === this.#offered.entry) return false;
		return true;
	}

	/**
	 * Whether none of `component`'s rows have entered immutable transcript
	 * history. A never-rendered component is still safe to mutate.
	 */
	isBlockUncommitted(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return true;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0 || entry.borrowed) return false;
		if (this.#offered?.kind === "commit" && index < this.#offered.end) return false;
		if (this.#offered?.kind === "append" && index === this.#offered.entry) return false;
		return true;
	}

	/**
	 * Whether `component` still sits in the live (repaintable) region: at or
	 * after the retirement frontier. Long-lived finalized blocks use this seam
	 * to stop mutating once their rows become eligible for immutable history.
	 */
	isBlockInLiveRegion(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		return index >= 0 && index >= this.#frontier;
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

	/** Total rows the live, un-emitted tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const { entry, index } of this.#liveEntries()) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			const block = rendered.slice(this.#projectedEmitted(entry, index, width));
			if (block.length > 0) total += block.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Height contributed by temporary tool progress, including its separator. */
	transientRowCount(width: number): number {
		this.#syncEntries();
		let total = 0;
		let hasRows = false;
		for (const { entry, index } of this.#liveEntries()) {
			const rows = this.#renderEntry(entry, width).length - this.#projectedEmitted(entry, index, width);
			if (rows <= 0) continue;
			if ((entry.component as Component & FinalizableBlock).isTranscriptBlockTransient?.()) {
				total += rows + (hasRows ? 1 : 0);
			}
			hasRows = true;
		}
		return total;
	}

	/** Render the complete logical live transcript.
	 *
	 * Physical terminal height is deliberately not applied here. The TUI owns
	 * the physical window and scrollback; clipping semantic rows here makes them
	 * unreachable to both channels.
	 */
	renderViewport(width: number, _rows: number, frame: AnimationFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const output: string[] = [];
		let previous: TranscriptEntry | undefined;
		for (const { entry, index } of this.#liveEntries()) {
			entry.viewportStart = undefined;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, frame);
			const offset = this.#projectedEmitted(entry, index, width);
			const rendered = this.#renderEntry(entry, width).slice(offset);
			if (rendered.length === 0) continue;
			if (output.length > 0) {
				output.push("");
				if (previous) previous.viewportExtent = (previous.viewportExtent ?? 0) + 1;
			}
			entry.viewportStart = output.length;
			entry.viewportOffset = offset;
			entry.viewportExtent = rendered.length;
			previous = entry;
			output.push(...rendered);
		}
		return output;
	}

	/** Track immutable borrowed rows without advancing the canonical emission ledger. */
	setBorrowedViewportRows(rows: number): void {
		for (const { entry } of this.#liveEntries()) {
			const count =
				entry.viewportStart === undefined
					? 0
					: Math.max(0, Math.min(rows - entry.viewportStart, entry.viewportExtent ?? 0));
			entry.borrowed = count > 0;
			entry.borrowedEnd = count > 0 ? (entry.viewportOffset ?? 0) + count : 0;
		}
	}

	/** Leading current viewport rows still owned by previously borrowed entries. */
	borrowedViewportRowCount(): number {
		let count = 0;
		for (const { entry } of this.#liveEntries()) {
			if (entry.viewportStart === undefined) continue;
			if (entry.viewportStart !== count || !entry.borrowed) break;
			const extent = entry.viewportExtent ?? 0;
			const retained = Math.max(0, Math.min((entry.borrowedEnd ?? 0) - (entry.viewportOffset ?? 0), extent));
			count += retained;
			if (retained < extent) break;
		}
		return count;
	}

	/** Offers stable-head emission or the shortest finalized prefix needed under pressure. */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Returns only a prepared complete replay, never a normal retirement offer. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) {
			return this.#offered.kind === "replay" ? this.#offered.batch : undefined;
		}
		if (!this.#replayPending) return undefined;
		const rows = this.#renderReplay(width);
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
			rows = this.#renderRange(this.#frontier, offered.end, width, true);
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
		const replay = this.peekReplayBatch(width);
		if (replay !== undefined) return replay;

		this.#completeFullyEmittedHeads(width);
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const rendered: (readonly string[])[] = new Array(live.length);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			const candidate = live[index]!;
			this.#setAllocation(candidate.entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const renderedEntry = this.#renderEntry(candidate.entry, width);
			const rows = renderedEntry.slice(
				this.#renderStablePrefix(candidate.entry, candidate.entry.emitted, width).length,
			);
			rendered[index] = rows;
			heights[index] = rows.length;
			if (rows.length > 0) total += rows.length + (visible++ > 0 ? 1 : 0);
		}
		const overflowing = total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing) {
			this.#pinnedFrontier = undefined;
			return undefined;
		}

		const head = this.#entries[this.#frontier];
		const settledRows = Math.max(
			0,
			Math.trunc(
				(head?.component as (Component & FinalizableBlock) | undefined)?.getTranscriptBlockSettledRows?.() ?? 0,
			),
		);
		if (policy === "pressure" && total > room && head !== undefined && settledRows > head.emitted) {
			const raw = head.component.render(width);
			let leadingBlankRows = 0;
			while (leadingBlankRows < raw.length && isPlainBlank(raw[leadingBlankRows]!)) leadingBlankRows++;
			const renderedHead = this.#renderEntry(head, width);
			const emittedEnd = Math.min(
				renderedHead.length,
				Math.max(0, settledRows - leadingBlankRows),
				head.emitted + total - room,
			);
			if (emittedEnd > head.emitted) {
				const batch: HistoryBatch = {
					id: this.#nextBatchId++,
					rows: renderedHead.slice(head.emitted, emittedEnd),
					kind: "append",
				};
				this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
				this.#pinnedFrontier = undefined;
				return batch;
			}
		}
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted < head.stableRows.length
		) {
			const emittedEnd = head.emitted + 1;
			const before = this.#renderStablePrefix(head, head.emitted, width);
			const after = this.#renderStablePrefix(head, emittedEnd, width);
			if (!isRowPrefix(before, after) || after.length === before.length) {
				this.#freezeStableRows(head, EMPTY_ROWS, "semantic row render added no suffix");
				return undefined;
			}
			const batch: HistoryBatch = {
				id: this.#nextBatchId++,
				rows: after.slice(before.length),
				kind: "append",
			};
			this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
			this.#pinnedFrontier = undefined;
			return batch;
		}

		let end = this.#frontier;
		let freed = 0;
		let index = 0;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			if (
				policy === "pressure" &&
				total - freed <= room &&
				this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS
			)
				break;
			// A finalized block can still occupy most of the physical screen.
			// Do not retire its visible tail merely because its first rows overflow.
			if (
				policy === "pressure" &&
				!this.#entries[end]!.borrowed &&
				room > 0 &&
				total - freed - (heights[index]! > 0 ? heights[index]! + 1 : 0) < room &&
				this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS
			)
				break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.#frontier) {
			if (policy === "pressure") this.#notePinnedFrontier();
			return undefined;
		}
		this.#pinnedFrontier = undefined;
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows: this.#renderRange(this.#frontier, end, width, true),
			kind: "append",
		};
		this.#offered = { batch, end, kind: "commit" };
		return batch;
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (
				entry === undefined ||
				offered.entry !== this.#frontier ||
				offered.emittedEnd <= entry.emitted ||
				(entry.mode === "appendOnly" && offered.emittedEnd !== entry.emitted + 1)
			)
				return;
			entry.emitted = offered.emittedEnd;
		} else if (offered.kind === "commit") {
			for (let index = this.#frontier; index < offered.end; index++) {
				this.#entries[index]!.state = "committed";
				this.#entries[index]!.emitted = 0;
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
		if (entry.mode === "mutable" || entry.stableFrozen) return rendered;
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
		entry.renderedStableByWidth.set(width, stableRendered.slice());
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
		if (entry.mode === "mutable") return this.#renderEntry(entry, width).slice(0, count);
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		return appendOnly.renderTranscriptStableRows(Math.min(count, entry.stableRows.length), width);
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

	#renderRange(start: number, end: number, width: number, trailingBlank: boolean): readonly string[] {
		const rows: string[] = [];
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
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		if (trailingBlank && rows.length > 0) rows.push("");
		return rows;
	}

	#renderReplay(width: number): readonly string[] {
		const rows = Array.from(this.#renderRange(0, this.#frontier, width, true));
		const head = this.#entries[this.#frontier];
		if (head !== undefined && head.emitted > 0) {
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
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			if (entry.emitted !== entry.stableRows.length) return;
			if (this.#renderStablePrefix(entry, entry.emitted, width).length !== rendered.length) return;
			entry.state = "committed";
			entry.emitted = 0;
			this.#frontier++;
		}
	}

	#startReplay(): void {
		const head = this.#entries[this.#frontier];
		this.#replayPending = this.#frontier > 0 || (head !== undefined && head.emitted > 0);
		this.#replayRequested = false;
	}

	#projectedEmitted(entry: TranscriptEntry, index: number, width: number): number {
		const offered = this.#offered;
		const count = offered?.kind === "append" && offered.entry === index ? offered.emittedEnd : entry.emitted;
		return this.#renderStablePrefix(entry, count, width).length;
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	#settleFinalized(): void {
		for (const entry of this.#entries) {
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

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(
			component =>
				existing.get(component) ?? {
					component,
					state: "active",
					mode: blockMode(component),
					stableRows: EMPTY_STABLE_ROWS,
					renderedStableByWidth: new Map(),
					emitted: 0,
					stableFrozen: false,
				},
		);
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one conservative mutable semantic transcript block. */
export class TranscriptBlock extends Container {}
