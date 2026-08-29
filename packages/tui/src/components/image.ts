import { getKittyGraphics } from "../kitty-graphics";
import {
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Shared budget that caps how many inline images render as live graphics. */
	budget?: ImageBudget;
	/**
	 * Stable identity for the underlying image (e.g. `toolCallId:index`). Lets the
	 * budget hand back the same graphics id across component re-creations so a
	 * repaint replaces the placement instead of stacking a duplicate.
	 */
	imageKey?: string;
}

const EMPTY_IDS: readonly number[] = [];
const EMPTY_TRANSMITS: readonly string[] = [];
const EMPTY_STALE_EPOCHS: ReadonlyArray<{ imageId: number; lastEpoch: number }> = [];
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
// Direct placements reserve height with leading zero-width rows. Keep them
// non-plain so transcript blank-edge trimming does not collapse image-only blocks.
const RESERVED_IMAGE_ROW = "\x1b[0m";

/** Default count of inline images kept as live graphics before older ones fall back to text. */
export const DEFAULT_MAX_INLINE_IMAGES = 8;

/** Per-image direct-placement emit state tracked by {@link ImageBudget}. */
interface PlacementEmitState {
	widthPx: number;
	heightPx: number;
	/** Current placement-id (`p=`) generation. */
	epoch: number;
	/** First frame row the current epoch's last emit attached cells to. */
	lastAttachTopFrameRow: number | undefined;
	/**
	 * Whether any cell attached by the current epoch's last emit has entered
	 * native scrollback. Set by {@link ImageBudget.observeCommitWatermark}
	 * comparing each frame's raw commit target against the attach top —
	 * era-local comparisons, so a divergence recommit that rewinds and
	 * re-advances the ledger is detected the moment it re-crosses the attach
	 * top, and a stale pre-rewind peak can never re-trigger.
	 */
	cellsArchived: boolean;
}
let nextImageBudgetSeed = Math.floor(Math.random() * 0xffffff);
function nextImageIdSeed(): number {
	nextImageBudgetSeed = (nextImageBudgetSeed + 0x10000) & 0xffffff;
	return nextImageBudgetSeed || 1;
}
/**
 * Bounds how many inline images render as live terminal graphics at once.
 *
 * Terminal graphics protocols — Kitty especially — keep every transmitted image
 * in a per-terminal store and re-draw placements as content scrolls; text-clear
 * escapes (`CSI 2 J` / `CSI 3 J`) do not remove them. Unbounded, a session that
 * shows many images piles up placements plus store memory and leaves ghosts in
 * scrollback.
 *
 * The budget keeps the most recent `cap` images live and demotes older ones to
 * their text fallback. Demotion needs a full redraw (so off-screen rows are
 * rewritten) plus an explicit graphics purge of the demoted ids — {@link Image}
 * reports display order via {@link observe}, and the TUI drives the purge +
 * redraw on the frame after a new image pushes the count past the cap.
 *
 * `cap <= 0` disables budgeting: every image stays a live graphic.
 */
export class ImageBudget {
	#cap: number;
	#requestRender: () => void;
	#nextId = nextImageIdSeed();
	#keyToId = new Map<string, number>();
	#idToKey = new Map<number, string>();
	/** Display-order image ids observed during the in-flight pass. */
	#passIds: number[] = [];
	/**
	 * Suppress threshold reflected in the frame currently on the terminal: images
	 * at display indices `[0, #onTerminal)` are shown as text there.
	 */
	#onTerminal = 0;
	/** Suppress threshold the current/next render should apply. */
	#planned = 0;
	/**
	 * True while the in-flight pass applies a stricter threshold than the terminal
	 * shows — the demotion frame that must purge graphics and fully repaint.
	 */
	#applyingReset = false;
	#lastTotal = 0;
	#purgeIds: number[] = [];
	/** Image ids whose data is believed to be loaded in the terminal's store. */
	#transmitted = new Set<number>();
	/** Transmit sequences (full base64) to write once, before this frame's placements. */
	#pendingTransmits: string[] = [];
	// True while the in-flight pass is a partial/throwaway pass (the
	// non-multiplexer resize viewport fast path) that walks only the visible
	// tail, bottom-up. Such a pass cannot derive display order from observe()
	// call order, so its suppression decisions replay the committed split below.
	#stablePass = false;
	// Image ids shown as text in the frame currently on the terminal: the
	// display-order prefix [0, #onTerminal) of the last full pass, snapshotted by
	// id so a partial pass reproduces the on-screen live/text split without a
	// full, correctly-ordered walk.
	#suppressedIds = new Set<number>();
	/**
	 * Per-image direct-placement emit state: source pixel geometry for the
	 * renderer's clipped source rectangle, plus the placement-id epoch (see
	 * {@link resolvePlacementEmit}). Entries deliberately live as long as the
	 * terminal's own placement registry for the image — they are the ledger the
	 * destructive-clear sweep uses to delete every registry entry an image ever
	 * placed — and die with it on demotion purge (`d=I`) or full cleanup.
	 */
	#placementState = new Map<number, PlacementEmitState>();
	/**
	 * States with an un-archived live attach top — the only ones a frame's
	 * commit watermark can affect. {@link observeCommitWatermark} runs every
	 * rendered frame, so it scans this set (bounded by concurrently live
	 * placements) instead of every image ever registered.
	 */
	#watchedPlacements = new Set<PlacementEmitState>();

	constructor(cap: number = DEFAULT_MAX_INLINE_IMAGES, requestRender: () => void = () => {}) {
		this.#cap = normalizeCap(cap);
		this.#requestRender = requestRender;
	}

	get cap(): number {
		return this.#cap;
	}

	get enabled(): boolean {
		return this.#cap > 0;
	}

	setRequestRender(requestRender: () => void): void {
		this.#requestRender = requestRender;
	}

	setCap(cap: number): void {
		const next = normalizeCap(cap);
		if (next === this.#cap) return;
		this.#cap = next;
		this.#reconcile(this.#lastTotal);
	}

	/**
	 * Stable graphics id for a logical image. A non-empty `key` maps to the same
	 * id across re-creations (so repaints replace the placement); a missing key
	 * gets a fresh id every call.
	 */
	acquireId(key?: string): number {
		if (key) {
			const existing = this.#keyToId.get(key);
			if (existing !== undefined) return existing;
			const id = this.#nextId;
			this.#nextId = (this.#nextId + 1) & 0xffffff || 1;
			this.#keyToId.set(key, id);
			this.#idToKey.set(id, key);
			return id;
		}
		const id = this.#nextId;
		this.#nextId = (this.#nextId + 1) & 0xffffff || 1;
		return id;
	}

	/**
	 * Begin a render pass. Called by the renderer before composing the frame.
	 * Pass `stable: true` for a partial/throwaway pass that does not walk the
	 * whole tree in display order (the resize viewport fast path): {@link observe}
	 * then replays the last committed per-id decision instead of one derived from
	 * call order, and the pass must NOT be closed with {@link endPass}.
	 */
	beginPass(stable = false): void {
		this.#passIds.length = 0;
		this.#stablePass = stable;
		this.#applyingReset = !stable && this.#cap > 0 && this.#planned > this.#onTerminal;
	}

	/**
	 * Record an image in display order and report whether it must render its text
	 * fallback this frame. Called by every {@link Image} during render — including
	 * on a cache hit, so the image keeps its display-order slot.
	 *
	 * During a `stable` pass ({@link beginPass}) the call order and visible subset
	 * are not authoritative, so the decision is the committed on-terminal split
	 * (`#suppressedIds`) keyed by id — order- and partiality-independent.
	 */
	observe(imageId: number): boolean {
		if (this.#stablePass) {
			const suppressed = this.#cap > 0 && this.#suppressedIds.has(imageId);
			if (suppressed) this.#forgetKeyForId(imageId);
			return suppressed;
		}
		const index = this.#passIds.length;
		this.#passIds.push(imageId);
		const suppressed = this.#cap > 0 && index < this.#planned;
		if (suppressed) this.#forgetKeyForId(imageId);
		return suppressed;
	}

	/**
	 * End a render pass. Returns true when this frame must purge graphics and
	 * fully repaint to apply a stricter budget; read the ids via
	 * {@link takePurgeIds}.
	 */
	endPass(): boolean {
		const total = this.#passIds.length;
		this.#lastTotal = total;
		let reset = false;
		if (this.#applyingReset) {
			for (let i = this.#onTerminal; i < this.#planned && i < total; i++) {
				const id = this.#passIds[i];
				this.#purgeIds.push(id);
				// d=I frees the data too, so the image must re-transmit if it returns.
				this.#transmitted.delete(id);
				this.#deletePlacementState(id);
				this.#forgetKeyForId(id);
			}
			this.#onTerminal = this.#planned;
			this.#applyingReset = false;
			reset = true;
		}
		this.#reconcile(total);
		// Snapshot the committed display-order suppression by id: the prefix
		// [0, #onTerminal) is what the terminal currently shows as text. Partial
		// passes replay this per id (see #stablePass) instead of re-deriving it
		// from a reversed, tail-only walk.
		this.#suppressedIds = new Set(this.#passIds.slice(0, this.#onTerminal));
		return reset;
	}

	/** Image ids to delete from the terminal this frame; clears the pending set. */
	takePurgeIds(): readonly number[] {
		if (this.#purgeIds.length === 0) return EMPTY_IDS;
		const ids = this.#purgeIds;
		this.#purgeIds = [];
		return ids;
	}

	/** All image ids believed to be loaded in the terminal store; clears tracking. */
	takeAllTransmittedIds(): readonly number[] {
		if (this.#transmitted.size === 0) return EMPTY_IDS;
		const ids = [...this.#transmitted];
		this.#transmitted.clear();
		this.#purgeIds = [];
		this.#pendingTransmits = [];
		this.#keyToId.clear();
		this.#idToKey.clear();
		this.#placementState.clear();
		this.#watchedPlacements.clear();
		return ids;
	}

	/** Whether `imageId`'s data still needs to be transmitted to the terminal. */
	shouldTransmit(imageId: number): boolean {
		return !this.#transmitted.has(imageId);
	}

	/**
	 * Record a direct-placement image's source pixel geometry so the renderer
	 * can clip its placement to the visible slice at write time; cleared when
	 * the image is purged from the terminal store.
	 */
	registerPlacementGeometry(imageId: number, widthPx: number, heightPx: number): void {
		const state = this.#placementState.get(imageId);
		if (state) {
			state.widthPx = widthPx;
			state.heightPx = heightPx;
			return;
		}
		this.#placementState.set(imageId, {
			widthPx,
			heightPx,
			epoch: 1,
			lastAttachTopFrameRow: undefined,
			cellsArchived: false,
		});
	}

	/**
	 * Record this frame's native-scrollback commit target (the frame-row count
	 * that is committed once the frame's writes land). Called once per rendered
	 * frame — including frames that emit no placements — so an epoch whose rows
	 * commit while its line is never rewritten is still flagged before the next
	 * re-emission.
	 */
	observeCommitWatermark(committedTo: number): void {
		if (committedTo < 0 || this.#watchedPlacements.size === 0) return;
		for (const state of this.#watchedPlacements) {
			if (state.lastAttachTopFrameRow !== undefined && committedTo > state.lastAttachTopFrameRow) {
				// Latched: the flag only clears when the next emit consumes it,
				// so the state needs no further per-frame scans until then.
				state.cellsArchived = true;
				this.#watchedPlacements.delete(state);
			}
		}
	}

	/**
	 * End the physical-row coordinate epoch after observing its final commit
	 * watermark. Placement ids and latched archive state survive, but attachment
	 * rows do not: the next placement emit records them in the new-width frame.
	 */
	beginPlacementCoordinateEpoch(): void {
		for (const state of this.#placementState.values()) state.lastAttachTopFrameRow = undefined;
		this.#watchedPlacements.clear();
	}

	/**
	 * Resolve the placement id and geometry for a direct-placement emit whose
	 * topmost attached cell sits at `attachTopFrameRow` — the first frame row
	 * the placement covers, i.e. the block's first *visible* row, not its
	 * origin (-1 when the writer has no frame-space position: alt-screen,
	 * resize, ConPTY-truncated replays). `committedTo` is this frame's commit
	 * target in the same frame-row space (-1 when unknown).
	 *
	 * Invariant: a placement id may be re-used (Kitty replace strips that id's
	 * cells everywhere, scrollback included) only while none of the cells it
	 * attached have entered native scrollback. The epoch — the `p=` id —
	 * advances exactly when the archived flag says otherwise; rewrites with no
	 * commit progression keep replacing the same id in place.
	 */
	resolvePlacementEmit(
		imageId: number,
		attachTopFrameRow: number,
		committedTo: number,
	): { placementId: number; widthPx: number; heightPx: number } | null {
		const state = this.#placementState.get(imageId);
		if (!state) return null;
		// Frames that commit as they write (seam/full-paint chunk passes) pass
		// their own commit target; fold it in before deciding, so a commit that
		// lands in the same frame as the re-emission still advances the epoch.
		if (committedTo >= 0 && state.lastAttachTopFrameRow !== undefined && committedTo > state.lastAttachTopFrameRow) {
			state.cellsArchived = true;
			this.#watchedPlacements.delete(state);
		}
		if (state.cellsArchived) {
			state.epoch += 1;
			state.cellsArchived = false;
			state.lastAttachTopFrameRow = undefined;
		}
		if (attachTopFrameRow >= 0) {
			state.lastAttachTopFrameRow = attachTopFrameRow;
			this.#watchedPlacements.add(state);
		}
		return { placementId: state.epoch, widthPx: state.widthPx, heightPx: state.heightPx };
	}

	/**
	 * Restart every placement epoch after a destructive history clear (`CSI 3 J`
	 * full paint). The clear destroys all placement cells — scrollback rows are
	 * gone and the replay rewrites the viewport — so no archive remains to
	 * protect. Reverting to epoch 1 lets the replay recreate every visible
	 * placement after the terminal-wide cleanup.
	 */
	resetPlacementEpochs(): ReadonlyArray<{ imageId: number; lastEpoch: number }> {
		let stale: Array<{ imageId: number; lastEpoch: number }> | undefined;
		for (const [imageId, state] of this.#placementState) {
			stale ??= [];
			stale.push({ imageId, lastEpoch: state.epoch });
			state.epoch = 1;
			state.lastAttachTopFrameRow = undefined;
			state.cellsArchived = false;
		}
		this.#watchedPlacements.clear();
		return stale ?? EMPTY_STALE_EPOCHS;
	}

	#deletePlacementState(imageId: number): void {
		const state = this.#placementState.get(imageId);
		if (!state) return;
		this.#watchedPlacements.delete(state);
		this.#placementState.delete(imageId);
	}

	/**
	 * Queue a one-time transmit for `imageId`. No-op if already transmitted, so a
	 * repeated call (e.g. a width-change re-render) never re-sends the data.
	 */
	enqueueTransmit(imageId: number, sequence: string): void {
		if (this.#transmitted.has(imageId)) return;
		this.#transmitted.add(imageId);
		this.#pendingTransmits.push(sequence);
	}

	/** Whether a frame has image data queued but not yet written to the terminal. */
	hasPendingTransmits(): boolean {
		return this.#pendingTransmits.length > 0;
	}

	/**
	 * True when the budget has nothing in flight: no live images observed on
	 * the last pass, no queued transmits, no pending purges, and no stricter
	 * threshold left to apply. A component-scoped frame may skip the observe
	 * pass only then — a partial tree walk would under-count display order.
	 */
	get quiescent(): boolean {
		return (
			this.#lastTotal === 0 &&
			this.#pendingTransmits.length === 0 &&
			this.#purgeIds.length === 0 &&
			this.#planned === this.#onTerminal
		);
	}

	/** Transmit sequences to write before this frame's placements; clears the queue. */
	takeTransmits(): readonly string[] {
		if (this.#pendingTransmits.length === 0) return EMPTY_TRANSMITS;
		const sequences = this.#pendingTransmits;
		this.#pendingTransmits = [];
		return sequences;
	}

	/**
	 * Drop transmit tracking so every still-live image re-enqueues its data
	 * (`a=t`) on the next render. Recovers when the terminal dropped the original
	 * transmit — e.g. Ghostty discarding graphics sent during its post-startup
	 * window — where a placement-only replay can never bind a Unicode placeholder.
	 * Pair with a component invalidate + forced repaint so the data and placement
	 * re-emit together; keeps no base64 in budget state (the transmit-once design).
	 */
	forgetTransmitted(): void {
		if (this.#transmitted.size === 0 && this.#pendingTransmits.length === 0) return;
		this.#transmitted.clear();
		this.#pendingTransmits = [];
	}

	#forgetKeyForId(id: number): void {
		const key = this.#idToKey.get(id);
		if (key === undefined) return;
		this.#idToKey.delete(id);
		if (this.#keyToId.get(key) === id) this.#keyToId.delete(key);
	}

	#reconcile(total: number): void {
		const desired = this.#cap > 0 ? Math.max(0, total - this.#cap) : 0;
		if (desired === this.#planned) {
			// Budget relaxed without a stricter frame (cap raised or images
			// removed): surviving graphics are untouched and re-exposed rows
			// repaint normally, so just track the looser threshold.
			if (this.#planned < this.#onTerminal) this.#onTerminal = this.#planned;
			return;
		}
		this.#planned = desired;
		// More images must be demoted than the terminal shows: schedule the purge +
		// full-redraw frame. Fewer: no ghosts to clear, so just catch the tracking
		// up — a normal repaint re-exposes the un-demoted images. Either way a
		// render is needed to apply the new threshold.
		if (desired <= this.#onTerminal) this.#onTerminal = desired;
		this.#requestRender();
	}
}

function normalizeCap(cap: number): number {
	if (!Number.isFinite(cap)) return 0;
	return Math.max(0, Math.trunc(cap));
}

export class Image implements Component {
	#base64Data: string;
	#mimeType: string;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;
	#budget?: ImageBudget;
	#imageId?: number;

	#cachedLines?: string[];
	#cachedWidth?: number;
	#cachedSuppressed = false;
	#cachedImageProtocol: typeof TERMINAL.imageProtocol = null;
	#cachedCellWidthPx = 0;
	#cachedCellHeightPx = 0;
	#cachedKittyUnicodePlaceholders = false;
	// Tallest graphic placement this image has rendered. The text fallback
	// pads itself to this height so a budget demotion never shrinks the block
	// (its rows may already be committed to native scrollback).
	#renderedGraphicRows = 0;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#base64Data = base64Data;
		this.#mimeType = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.#budget = options.budget;
		this.#imageId = options.budget ? options.budget.acquireId(options.imageKey) : undefined;
	}
	/** Return source metadata without exposing the encoded image buffer. */
	debugState(): Record<string, unknown> {
		return {
			mimeType: this.#mimeType,
			widthPx: this.#dimensions.widthPx,
			heightPx: this.#dimensions.heightPx,
			filename: this.#options.filename ?? null,
			imageId: this.#imageId ?? null,
			suppressed: this.#cachedSuppressed,
		};
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#cachedWidth = undefined;
	}

	render(width: number): readonly string[] {
		const imageProtocol = TERMINAL.imageProtocol;
		const hasProtocol = imageProtocol != null;
		const cellDimensions = getCellDimensions();
		const kittyUnicodePlaceholders = getKittyGraphics().unicodePlaceholders;
		// observe() must run on every pass — even a cache hit — so the image keeps
		// its display-order slot in the budget. Only graphics-capable frames count
		// toward (and are demoted by) the budget; without a protocol every image is
		// already text.
		const suppressed = hasProtocol && this.#budget !== undefined ? this.#budget.observe(this.#imageId ?? 0) : false;

		if (
			this.#cachedLines &&
			this.#cachedWidth === width &&
			this.#cachedSuppressed === suppressed &&
			this.#cachedImageProtocol === imageProtocol &&
			this.#cachedCellWidthPx === cellDimensions.widthPx &&
			this.#cachedCellHeightPx === cellDimensions.heightPx &&
			this.#cachedKittyUnicodePlaceholders === kittyUnicodePlaceholders &&
			(this.#imageId == null || this.#budget?.shouldTransmit(this.#imageId) !== true)
		) {
			return this.#cachedLines;
		}

		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(width - 2, cap) : width - 2;

		let lines: string[];

		if (hasProtocol && !suppressed) {
			// Transmit the data once (keyed by id); thereafter renderImage returns
			// just the placement, so repaints never re-send the base64.
			const needsTransmit = this.#imageId != null && (this.#budget?.shouldTransmit(this.#imageId) ?? false);
			const result = renderImage(this.#base64Data, this.#dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: this.#options.maxHeightCells,
				imageId: this.#imageId,
				includeTransmit: needsTransmit,
			});

			if (result?.transmit && this.#imageId != null && this.#budget !== undefined) {
				this.#budget.enqueueTransmit(this.#imageId, result.transmit);
			}

			if (result?.lines) {
				// Unicode placeholders: the image is already a block of real text-cell
				// lines (line 0 carries the virtual-placement APC). No cursor moves.
				lines = result.lines;
			} else if (result) {
				// Direct placement: return `rows` lines so TUI accounts for image
				// height. First (rows-1) lines are empty (TUI clears them); the last
				// saves the final-row cursor, moves up to the image origin, emits the
				// image sequence, then restores the final-row cursor. When the block
				// straddles the viewport top, the renderer rewrites this line to the
				// visible slice (encodeKittyPlacementLine) from the geometry
				// registered below.
				if (this.#imageId != null && this.#budget !== undefined) {
					this.#budget.registerPlacementGeometry(
						this.#imageId,
						this.#dimensions.widthPx,
						this.#dimensions.heightPx,
					);
				}
				lines = [];
				for (let i = 0; i < result.rows - 1; i++) {
					lines.push(RESERVED_IMAGE_ROW);
				}
				const cursorRows = result.rows - 1;
				const moveUp = cursorRows > 0 ? `\x1b[${cursorRows}A` : "";
				const placement = moveUp + (result.sequence ?? "");
				lines.push(cursorRows > 0 ? SAVE_CURSOR + placement + RESTORE_CURSOR : placement);
			} else {
				lines = this.#fallbackLines();
			}
			this.#renderedGraphicRows = Math.max(this.#renderedGraphicRows, lines.length);
		} else {
			lines = this.#fallbackLines();
		}

		this.#cachedLines = lines;
		this.#cachedWidth = width;
		this.#cachedSuppressed = suppressed;
		this.#cachedImageProtocol = imageProtocol;
		this.#cachedCellWidthPx = cellDimensions.widthPx;
		this.#cachedCellHeightPx = cellDimensions.heightPx;
		this.#cachedKittyUnicodePlaceholders = kittyUnicodePlaceholders;

		return lines;
	}

	/**
	 * Text fallback, height-preserving once a graphic has rendered: a demoted
	 * image must keep occupying the rows its placement used, because those
	 * rows may already be committed to native scrollback — shrinking the block
	 * would shift everything below it and force the renderer's commit-resync
	 * (stale band + recommit). Reserved rows stay non-plain so blank-edge
	 * trimming cannot collapse the block either.
	 */
	#fallbackLines(): string[] {
		const fallback = this.#theme.fallbackColor(
			imageFallback(this.#mimeType, this.#dimensions, this.#options.filename),
		);
		if (this.#renderedGraphicRows <= 1) return [fallback];
		const lines: string[] = [];
		for (let i = 0; i < this.#renderedGraphicRows - 1; i++) {
			lines.push(RESERVED_IMAGE_ROW);
		}
		lines.push(fallback);
		return lines;
	}
}
