/**
 * The terminal backend: an in-process TSP renderer.
 *
 * Each frame paints the surface's regions with the kind painters and hands
 * the writer a {@link FramePlan}: settled `main` blocks retire into terminal
 * history exactly once, in order (only when the live tail no longer fits; a
 * streaming block's stable head may go ahead of it), the rest of `main` plus
 * `dock` form the mutable viewport, and `layer` nodes composite over it (or
 * take the alternate screen when fullscreen). A live tail taller than the
 * room is allocated: every unsettled block keeps a row, the newest take the
 * rest, a summary row stands for what does not fit. Replays (a lost display,
 * a block inserted above history, a streaming head whose history rows no
 * longer match) rewrite the ledger under a fresh id; {@link TermBackend.flush}
 * writes everything into history at shutdown. The protocol, its invariants and
 * how they map here: docs/tui-core-renderer.md.
 *
 * The fullscreen presentation (`TermBackendOptions.presentation`) keeps all of
 * `main` on the alternate screen instead: it scrolls inside the program above
 * the dock pinned to the bottom (term/fullscreen.ts), and terminal history is
 * never written; display resets wait until the presentation turns inline.
 *
 * Input becomes the same events a Tern terminal sends: keys first offer
 * themselves to `onKey` handlers from the focused node up, then to the
 * focused kind's widget (an editor turns them into `edit` events); clicks
 * resolve through the last frame's hit regions (the fullscreen transcript's
 * wheel, scrollbar and selection come first).
 */
import type { FramePlan, InputEvent, MouseEvent, TerminalCapabilities, TerminalDriver } from "../driver/contract";
import { dropCutImages } from "../driver/images/anchor";
import { DEFAULT_CELL } from "../driver/images/fit";
import { bubbleEvent, bubbleKey, bubblePaste, keypathOf, pathTo } from "../dispatch";
import type { KeyEvent } from "../events";
import type { TranscriptScroller } from "../host";
import type { UiNode } from "../node";
import {
	type Accessor,
	batch,
	computed,
	createRoot,
	effect,
	type Reactive,
	read,
	type Signal,
	signal,
	untrack,
} from "../reactive";
import { isSettled, type Surface } from "../surface";
import type { Theme } from "../theme/contract";
import { padTo, truncate, visibleWidth } from "../text/width";
import {
	type Block,
	type Cell,
	createOwnedPaint,
	type PaintEnvironment,
	paintForMeasurement,
	type PaintImages,
	paintNode,
	type PointerHover,
} from "./paint";
import { FullscreenTranscript, type PlacedHit } from "./fullscreen";
import { type WidgetContext, widgetContext, widgetFor } from "./widgets";
import "./painters";

/** Tick of a block drawing smooth motion (a shimmer sweep), ms. */
const SMOOTH_TICK_MS = 1000 / 20;

/**
 * How the terminal backend draws `main`: flowing into terminal history, or scrolled inside the
 * program on the alternate screen.
 */
export type TermPresentation = "inline" | "fullscreen";
/**
 * A turn's outcome as its scrollbar mark shows it (`warning`: completed with tool failures;
 * `error`: errored or aborted).
 */
export type ScrollMarkKind = "running" | "success" | "warning" | "error";
/** A mark on the fullscreen transcript's marks lane, at a main node's first row. */
export interface ScrollMark {
	readonly node: UiNode;
	readonly kind: ScrollMarkKind;
}
/**
 * What the pointer does over the fullscreen transcript: `select` adds text selection to the
 * wheel and the scrollbar, `wheel` keeps only those (drags are ignored), `native` is for a
 * program that leaves the mouse to the terminal.
 */
export type TranscriptPointer = "select" | "wheel" | "native";
/** How a clipboard write ended: `unconfirmed-terminal` went to the terminal (OSC 52), which never confirms. */
export type SelectionClipboardResult = "success" | "unconfirmed-terminal" | "failed";

/** Options of a {@link TermBackend}. */
export interface TermBackendOptions {
	readonly surface: Surface;
	readonly driver: TerminalDriver;
	readonly theme: Accessor<Theme>;
	/**
	 * Blank rows between two consecutive non-empty `main` blocks (the
	 * transcript's separator; compact runs pack with 0). Default 1.
	 */
	readonly separator?: (above: UiNode, below: UiNode) => number;
	/** Keys nothing on the focus path consumed (global shortcuts). Return true when handled. */
	readonly onKey?: (key: KeyEvent) => boolean;
	/** Sees every decoded input event before routing; true consumes it. */
	readonly intercept?: (event: InputEvent) => boolean;
	/** Shortest gap between frames, ms (a frame-rate cap; may change at runtime). Default 16. */
	readonly frameInterval?: Reactive<number>;
	/** Force OSC 8 hyperlinks on or off; undefined follows the terminal's capability. */
	readonly hyperlinks?: Accessor<boolean | undefined>;
	/** Allow OSC 66 sized text (Markdown H1) where the terminal draws it. Default: never. */
	readonly textSizing?: Accessor<boolean>;
	/**
	 * The terminal clock painters read (tests script it). Default: the wall
	 * clock, advanced on every animation tick.
	 */
	readonly clock?: Accessor<number>;
	/** Animation tick for terminal-clocked kinds, ms. Default 80. */
	readonly tickInterval?: number;
	/**
	 * Inline images painters draw (the process driver's `TerminalImages`).
	 * Absent: `image` nodes show their text fallback. The frame loop settles
	 * the budget through `driver.images`. Fullscreen history measures images
	 * with `measure`, or measures the text fallback when it is unavailable.
	 */
	readonly images?: PaintImages;
	/**
	 * Draw `main` inline (default) or fullscreen: the transcript scrolls inside the program on
	 * the alternate screen above the pinned dock, and terminal history is never written (see
	 * term/fullscreen.ts). `null` holds all frames until startup resolves the presentation;
	 * keyboard and paste input still reach the focused node.
	 */
	readonly presentation?: Accessor<TermPresentation | null>;
	/** Marks on the fullscreen transcript's marks lane (main nodes, one per turn). */
	readonly marks?: Accessor<readonly ScrollMark[]>;
	/** What the pointer does over the fullscreen transcript. Default `select`. */
	readonly pointer?: Accessor<TranscriptPointer>;
	/** Copy a fullscreen selection when the drag ends. Default true. */
	readonly copyOnRelease?: Accessor<boolean>;
	/** Write selected transcript text to the clipboard; absent: copying is unavailable. */
	readonly copyText?: (text: string) => Promise<SelectionClipboardResult>;
	/** Display name of the copy key, named by copy-failure feedback (`Alt+C`). */
	readonly copyShortcutLabel?: Accessor<string | undefined>;
	/**
	 * Route fullscreen transcript clicks to their target before starting a selection (default false).
	 * An explicit false also disables the hits marked `optionalTarget` in their main or dock region.
	 */
	readonly activateTargets?: Accessor<boolean>;
}

/** A history batch offered to the driver until it acknowledges the id. */
interface PendingBatch {
	readonly id: number;
	readonly rows: readonly string[];
	/** Live main nodes the batch writes whole (committed on acknowledgement). */
	readonly nodes: readonly UiNode[];
	/** The batch replaces history: the committed ledger, then whatever retired with it. */
	readonly replay: boolean;
	/** A streaming node's stable head moved into history: its emitted rows after this batch. */
	readonly head?: { readonly node: UiNode; readonly rows: readonly string[]; readonly count: number };
	/** The last non-empty block whose rows this batch writes. */
	readonly last: UiNode | undefined;
	/** Columns the rows were painted at: a batch still unwritten at another width is prepared again. */
	readonly width: number;
}

/**
 * The rows of a live node already in terminal history (a streaming head, a
 * settled block retired row by row): the first `count` of `rows`, painted at
 * `width`. Each frame checks the node still paints exactly those rows first;
 * a node that changed them anyway (a stable head that was not) replays
 * history. At another width the rows cannot match: the prefix is mapped by
 * its words instead ({@link remapEmitted}), and history keeps its old width.
 * The separator above the node went with the first write, even with no row.
 */
interface Emitted {
	readonly rows: readonly string[];
	readonly count: number;
	readonly width: number;
	/** The last block found to start with them. */
	verified: Block | undefined;
	/** At another width (a resize the driver does not replay, or not yet): the rows holding them there. */
	mapped?: { readonly width: number; readonly block: Block; readonly count: number };
}

/**
 * The inline viewport's place on screen at a size, as far as the backend can tell: `below` history
 * rows were written since the screen was last cleared or resized, and once those plus the viewport
 * reached the screen's height the viewport sits at its bottom (`bottom`), holding `rows` rows and
 * spanning `span` from its top (more when it shrank with no dock to pad it down).
 */
interface Pin {
	readonly width: number;
	readonly height: number;
	readonly below: number;
	readonly bottom: boolean;
	readonly rows: number;
	readonly span: number;
}

interface Placed {
	readonly block: Block;
	/** Viewport row of the block's first row. */
	readonly top: number;
	/** Viewport column of the block's first column. */
	readonly left: number;
}

/** A layer node a frame drew over the rest: its cells, and whether it is modal (owning the pointer everywhere). */
interface Sheet {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly height: number;
	readonly modal: boolean;
}

/**
 * The paint seam over a driver's image store: its rows, measured in the
 * terminal's reported cell size (a default until the terminal reports one).
 */
export function driverImages(
	images: Pick<PaintImages, "rows" | "measure">,
	capabilities: () => TerminalCapabilities,
): PaintImages {
	return {
		rows: (source, request) => images.rows(source, request),
		...(images.measure ? { measure: images.measure.bind(images) } : {}),
		cell: () => capabilities().cell ?? DEFAULT_CELL,
	};
}

const FULLSCREEN_KINDS: ReadonlySet<string> = new Set(["picker", "prefs"]);

function isFullscreen(node: UiNode): boolean {
	if (FULLSCREEN_KINDS.has(node.kind)) return true;
	return node.kind === "overlay" && (node.props() as { size?: string }).size === "full";
}

/**
 * Columns a non-fullscreen overlay takes: its `size` fraction of the screen,
 * or the terminal-only `term.width` (`"full"`, or a cell count) for sheets
 * whose terminal look spans the screen while Tern sizes them itself.
 */
function overlayWidth(node: UiNode, columns: number): number {
	const props = node.props() as { size?: "sm" | "md" | "lg"; term?: { width?: unknown } };
	const fixed = props.term?.width;
	if (fixed === "full") return columns;
	if (typeof fixed === "number") return Math.max(1, Math.min(columns, Math.floor(fixed)));
	const size = props.size ?? "md";
	const fraction = size === "sm" ? 0.5 : size === "lg" ? 0.9 : 0.7;
	return Math.max(1, Math.min(columns, Math.round(columns * fraction)));
}

/**
 * The screen edge a layer node holds to (`top`, `bottom`, else centered): its
 * `anchor`, or the terminal-only `term.anchor` for sheets whose terminal look
 * sits elsewhere than Tern puts them.
 */
function layerAnchor(node: UiNode): string {
	const props = node.props() as { anchor?: unknown; term?: { anchor?: unknown } };
	if (typeof props.term?.anchor === "string") return props.term.anchor;
	return typeof props.anchor === "string" ? props.anchor : "center";
}

/** Overlay `block` onto `rows` at (`top`, `left`), cutting the rows underneath. */
function composite(rows: string[], block: Block, top: number, left: number, width: number): void {
	for (let i = 0; i < block.rows.length; i++) {
		const target = top + i;
		if (target < 0 || target >= rows.length) continue;
		const base = padTo(rows[target] ?? "", width);
		const cell = block.rows[i]!;
		const cellWidth = visibleWidth(cell);
		const before = padTo(base, left);
		const afterStart = left + cellWidth;
		// The tail keeps the base row's cells right of the overlay.
		let after = "";
		if (afterStart < width) {
			const full = padTo(base, width);
			after = sliceAfter(full, afterStart);
		}
		rows[target] = `${before}\x1b[0m${cell}\x1b[0m${after}`;
	}
}

function sliceAfter(text: string, column: number): string {
	// Re-measured by the writer; styles of the cut prefix are reset above.
	let col = 0;
	let index = 0;
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(Bun.stripANSI(text))) {
		if (col >= column) break;
		col += Bun.stringWidth(segment);
		index += segment.length;
	}
	return Bun.stripANSI(text).slice(index);
}

/** Whether `batch` (never written) still writes the blocks right after the commit frontier `start`, in order. */
function heads(batch: PendingBatch, main: readonly UiNode[], start: number): boolean {
	for (let k = 0; k < batch.nodes.length; k++) if (main[start + k] !== batch.nodes[k]) return false;
	return !batch.head || main[start + batch.nodes.length] === batch.head.node;
}

/** Whether `rows` start with the `count` rows of `emitted` in history. */
function startsWith(rows: readonly string[], emitted: readonly string[], count: number): boolean {
	if (rows !== emitted) {
		for (let i = 0, n = Math.min(count, rows.length); i < n; i++) if (rows[i] !== emitted[i]) return false;
	}
	// The one row a head may take back: the separator after its stable blocks, once its tail draws nothing
	// (a reference definition).
	return rows.length >= count || (rows.length === count - 1 && Bun.stripANSI(emitted[count - 1]!).trim() === "");
}

/** The letters and digits of `row` (borders, bullets, padding and wrapping are not content). */
function content(row: string): string {
	return Bun.stripANSI(row).replace(NOT_CONTENT, "");
}

const NOT_CONTENT = /[^\p{L}\p{N}]+/gu;

/**
 * Rows of `rows` (a block painted at a new width) that hold the `count` rows of `emitted` in history
 * (painted at the width they were written at), compared by their letters and digits, so a word or a
 * URL the old width broke across rows still matches. `exact`: the rows end where history does; else
 * the last row holds content on both sides (a cut inside a paragraph) and stays live, repeating its
 * history part once.
 */
function remapEmitted(
	rows: readonly string[],
	emitted: readonly string[],
	count: number,
): { readonly count: number; readonly exact: boolean } {
	let history = "";
	for (let i = 0; i < count; i++) history += content(emitted[i]!);
	let matched = 0;
	let mapped = 0;
	for (let row = 0; row < rows.length && matched < history.length; row++) {
		const own = content(rows[row]!);
		if (!history.startsWith(own, matched)) break;
		matched += own.length;
		mapped = row + 1;
	}
	// Content-free rows that ended the old prefix (a separator, a border) went with it.
	let trailing = 0;
	while (trailing < count && content(emitted[count - 1 - trailing]!) === "") trailing++;
	while (trailing > 0 && mapped < rows.length && content(rows[mapped]!) === "") {
		mapped++;
		trailing--;
	}
	return { count: mapped, exact: matched === history.length };
}

/** The first index of ascending `values` holding at least `value`. */
function lowerBound(values: readonly number[], value: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid]! < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** See the module docs. */
export class TermBackend {
	readonly #surface: Surface;
	readonly #driver: TerminalDriver;
	readonly #options: TermBackendOptions;
	readonly #env: PaintEnvironment;
	// A content frame can absorb a tick in the same millisecond as the last sample. Clock readers
	// still have to run to renew their request for ticks, even if the wall time hasn't changed.
	readonly #clock: Signal<number> = signal(Date.now(), { equals: false });
	readonly #reduceMotion: Signal<boolean> = signal(false);
	/** The hit under the pointer, from the last mouse report. */
	readonly #hover: Signal<PointerHover | null> = signal<PointerHover | null>(null);
	readonly #hyperlinks: Signal<boolean>;
	readonly #textSizing: Signal<boolean>;
	#tick: Timer | undefined;
	#tickDelay = 0;
	#inTick = false;
	#frameRequested = false;
	#frame: Timer | undefined;
	#lastFrame = 0;
	/** Main nodes whose rows are in terminal history: always a prefix of `main` (the commit frontier). */
	#committed = new Set<UiNode>();
	/** The `main` list the frontier was last checked against. */
	#frontierChecked: readonly UiNode[] | undefined;
	#pending: PendingBatch | undefined;
	/** The last non-empty main block with rows in history (what the first live block is separated from). */
	#historyTail: UiNode | undefined;
	/** Rows of live main nodes already moved into history (streaming heads), not repainted in the viewport. */
	readonly #emitted = new Map<UiNode, Emitted>();
	/** The next frame is the shutdown flush (see {@link flush}). */
	#flushing = false;
	/**
	 * Where the inline viewport stands on screen since the last reset (a replay or a resize; a
	 * fullscreen frame leaves the normal screen as it was): see {@link Pin}. `#nextPin` is what the frame being presented makes of it.
	 */
	#pin: Pin | undefined;
	/** Blocks the retirement in the frame being composed moves into history (separators may ask). */
	readonly #retiring = new Set<UiNode>();
	#nextPin: Pin | undefined;
	#nextHistoryId = 1;
	#hits: PlacedHit[] = [];
	/** Layer stack these hits were painted for; queued reports cannot click through a newly opened modal. */
	#hitLayer: readonly UiNode[] | undefined;
	/** The driver lost history: the next frame replays the committed ledger. */
	#replay = false;
	/** Indices of the unsettled `main` nodes, ascending (recomputed when `main` or a settle mark changes). */
	readonly #unsettled: Accessor<readonly number[]>;
	#unsubscribe: (() => void)[] = [];
	/** Disposes the watcher of the last frame's reactive reads. */
	#disposeWatch: (() => void) | undefined;
	#running = false;
	/** The fullscreen presentation's transcript: scroll state, selection, pointer gestures. */
	readonly #transcript: FullscreenTranscript;
	/** The presentation the last frame was composed for. */
	#presentation: TermPresentation = "inline";
	/** A display reset asked for while fullscreen: it runs once the presentation turns inline. */
	#resetOwed = false;
	/** Sheets the last transcript frame drew over it (they keep their own pointer hits). */
	#sheets: readonly Sheet[] = [];

	constructor(options: TermBackendOptions) {
		this.#surface = options.surface;
		this.#driver = options.driver;
		this.#options = options;
		this.#hyperlinks = signal(options.driver.capabilities.hyperlinks);
		const terminalHyperlinks = this.#hyperlinks;
		const hyperlinks: Accessor<boolean> = options.hyperlinks
			? () => options.hyperlinks!() ?? terminalHyperlinks()
			: terminalHyperlinks;
		this.#unsettled = createRoot(() =>
			computed(() => {
				const main = options.surface.main();
				const out: number[] = [];
				for (let i = 0; i < main.length; i++) if (!isSettled(main[i]!)) out.push(i);
				return out;
			}),
		);
		this.#textSizing = signal(options.driver.capabilities.textSizing);
		const terminalTextSizing = this.#textSizing;
		const allowTextSizing = options.textSizing;
		const clock = options.clock ?? this.#clock;
		const images = options.images;
		const shared = {
			theme: options.theme,
			focus: options.surface.focused,
			reduceMotion: this.#reduceMotion,
			hover: this.#hover,
			hyperlinks,
			// Sized text (OSC 66) reaches into the rows below its own; the fullscreen window cuts and pads
			// rows (a heading on its last row would draw over the dock), so text draws at normal size there.
			...(allowTextSizing
				? {
						textSizing: () =>
							allowTextSizing() && terminalTextSizing() && options.presentation?.() !== "fullscreen",
					}
				: {}),
		};
		this.#env = {
			...shared,
			clock: smooth => {
				this.#scheduleTick(smooth === true);
				return clock();
			},
			...(images ? { images } : {}),
		};
		// An offscreen measurement snapshots the clock on first read, without subscribing or asking
		// for ticks. Only the store's geometry method is safe here: rows() would retain image data.
		let measuredAt: number | undefined;
		const measureEnv: PaintEnvironment = {
			...shared,
			clock: () => (measuredAt ??= untrack(clock)),
			...(images?.measure ? { images: { cell: () => images.cell(), rows: images.measure.bind(images) } } : {}),
		};
		this.#transcript = new FullscreenTranscript({
			theme: options.theme,
			paint: (node, width) => createOwnedPaint(node, width, this.#env),
			measure: (node, width) => {
				measuredAt = undefined;
				return paintForMeasurement(node, width, measureEnv);
			},
			separator: options.separator ?? (() => 1),
			...(options.marks ? { marks: options.marks } : {}),
			...(options.pointer ? { pointer: options.pointer } : {}),
			...(options.copyOnRelease ? { copyOnRelease: options.copyOnRelease } : {}),
			...(options.copyText ? { copyText: options.copyText } : {}),
			...(options.copyShortcutLabel ? { copyShortcutLabel: options.copyShortcutLabel } : {}),
			...(options.activateTargets ? { activateTargets: options.activateTargets } : {}),
			cellHeight: () => (this.#driver.capabilities.cell ?? DEFAULT_CELL).h,
			active: () => this.#presentationNow() === "fullscreen",
			requestRender: () => this.requestRender(),
		});
	}

	/** Fullscreen transcript reading controls (see {@link TranscriptScroller}). */
	get scroller(): TranscriptScroller {
		return this.#transcript.scroller;
	}

	/** Current presentation, without subscribing the caller; an absent option is inline. */
	#presentationNow(): TermPresentation | null {
		return this.#options.presentation ? untrack(this.#options.presentation) : "inline";
	}

	/** Start rendering and routing input on a started driver (the host owns the driver's lifecycle). */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#clock.set(Date.now());
		// Restarted (after a suspend): what the terminal holds is unknown, history is written again.
		if (this.#committed.size > 0 || this.#emitted.size > 0) this.#requestReplay();
		this.#unsubscribe.push(
			this.#driver.onInput(event => {
				if (!this.#options.intercept?.(event)) this.#onInput(event);
			}),
			this.#driver.onResize(() => this.requestRender()),
			this.#driver.onCapabilities(capabilities => {
				this.#hyperlinks.set(capabilities.hyperlinks);
				this.#textSizing.set(capabilities.textSizing);
				this.requestRender();
			}),
			this.#driver.onReplay(() => {
				// A batch still unwritten (a replay included) is prepared again for the new display.
				this.#replay = true;
				this.#pending = undefined;
				this.requestRender();
			}),
		);
		this.renderNow();
	}

	/** Stop rendering and routing input; the driver stays as it is. */
	stop(): void {
		if (!this.#running) return;
		this.#running = false;
		clearTimeout(this.#frame);
		clearTimeout(this.#tick);
		this.#frame = undefined;
		this.#tick = undefined;
		this.#frameRequested = false;
		for (const off of this.#unsubscribe.splice(0)) off();
		this.#disposeWatch?.();
		this.#disposeWatch = undefined;
		this.#transcript.stop();
	}

	/**
	 * Graceful shutdown: one last frame writes the whole transcript into
	 * terminal history (every live `main` block as it is now, settled or not,
	 * after the ledger a pending replay still owes) and keeps the dock as the
	 * viewport. A driver that cannot write inline yet (mid-resize) writes it
	 * when it stops. Call it last, right before {@link stop}. Fullscreen and a
	 * startup whose presentation has not resolved write nothing.
	 */
	flush(): void {
		if (!this.#running || this.#presentationNow() !== "inline") return;
		// An unwritten batch was never written: the flush batch takes its rows (a replay stays owed).
		this.#pending = undefined;
		this.#flushing = true;
		try {
			this.renderNow();
		} finally {
			this.#flushing = false;
		}
	}

	/** Whether `node` has rows in terminal history (retired whole, or a streaming head), or a batch writing them. */
	retired(node: UiNode): boolean {
		if (this.#committed.has(node) || this.#emitted.has(node) || this.#retiring.has(node)) return true;
		const pending = this.#pending;
		return pending !== undefined && (pending.head?.node === node || pending.nodes.includes(node));
	}

	/**
	 * Clear terminal history and the screen, then replay the committed ledger (the driver's
	 * `resetDisplay`). Outside inline presentation the shell's scrollback stays untouched:
	 * the reset is owed until the presentation turns inline.
	 */
	resetDisplay(): void {
		if (this.#presentationNow() !== "inline") {
			this.#resetOwed = true;
			return;
		}
		this.#resetOwed = false;
		this.#driver.resetDisplay();
	}

	/** Schedule a frame (coalesced, at most one per frame interval). */
	requestRender(): void {
		if (!this.#running || this.#frameRequested) return;
		this.#frameRequested = true;
		if (this.#inTick) return;
		const interval = untrack(() => read(this.#options.frameInterval ?? 16));
		const wait = Math.max(0, this.#lastFrame + interval - performance.now());
		this.#frame = setTimeout(() => this.renderNow(), wait);
	}

	/** Paint and present a frame now. */
	renderNow(): void {
		if (!this.#running) return;
		if (this.#tick !== undefined) {
			// This frame carries the animation too. Drop the old watcher before updating the clock:
			// only the *new* visible blocks should repaint and ask for the next tick.
			clearTimeout(this.#tick);
			this.#tick = undefined;
			this.#disposeWatch?.();
			this.#disposeWatch = undefined;
			this.#clock.set(Date.now());
		}
		this.#present();
	}

	#present(): void {
		// Inline again with a reset owed: it runs before this frame, which then carries the replay.
		if (this.#resetOwed && this.#presentationNow() === "inline") {
			this.#resetOwed = false;
			this.#driver.resetDisplay();
		}
		this.#frameRequested = false;
		clearTimeout(this.#frame);
		this.#frame = undefined;
		this.#lastFrame = performance.now();
		let plan: FramePlan | null;
		for (let pass = 0; ; pass++) {
			plan = this.#composeWatched();
			if (plan === null) return;
			// An image budget change after painting means the rows it painted are stale.
			if (pass === 3 || !this.#driver.images?.settle()) break;
		}
		const written = this.#driver.present(plan);
		// A frame whose history the driver did not write was not drawn inline either: the screen is as it was.
		if (!plan.history || written === plan.history.id) this.#pin = this.#nextPin;
		const pending = this.#pending;
		if (pending && written === pending.id) {
			for (const node of pending.nodes) {
				this.#committed.add(node);
				this.#emitted.delete(node);
			}
			const head = pending.head;
			if (head) {
				this.#emitted.set(head.node, {
					rows: head.rows,
					count: head.count,
					width: pending.width,
					verified: undefined,
				});
			}
			if (pending.replay || pending.last) this.#historyTail = pending.last;
			this.#pending = undefined;
			this.#frontierChecked = undefined;
			if (pending.replay) this.#replay = false;
			// What became eligible while the batch waited retires in the next frame.
			this.requestRender();
		}
		this.#transcript.publish();
	}

	/**
	 * Compose while recording every reactive read (regions, focus, painted
	 * blocks, options): the first change to any of them schedules the next
	 * frame. Each frame replaces the previous frame's watcher.
	 */
	#composeWatched(): FramePlan | null {
		this.#disposeWatch?.();
		let plan: FramePlan | null | undefined;
		createRoot(dispose => {
			this.#disposeWatch = dispose;
			effect(() => {
				if (plan !== undefined) untrack(() => this.requestRender());
				else plan = this.#compose();
			});
		});
		return plan ?? null;
	}

	#scheduleTick(smooth: boolean): void {
		if (!this.#running || this.#options.clock) return;
		const delay = smooth ? SMOOTH_TICK_MS : (this.#options.tickInterval ?? 80);
		if (this.#tick !== undefined) {
			if (this.#tickDelay <= delay) return;
			clearTimeout(this.#tick);
		}
		this.#tickDelay = delay;
		this.#tick = setTimeout(this.#onTick, delay);
	}

	readonly #onTick = (): void => {
		this.#tick = undefined;
		this.#inTick = true;
		try {
			// A clock read renews the tick even when equal output keeps the frame watcher clean.
			this.#clock.set(Date.now());
		} finally {
			this.#inTick = false;
		}
		if (this.#frameRequested) this.#present();
	};

	#paint(node: UiNode, width: number, height?: number): Block {
		return paintNode(this.#env, node, width, height);
	}

	/** History must be written again: the next frame prepares a replay (a batch not yet written is dropped). */
	#requestReplay(): void {
		this.#replay = true;
		this.#pending = undefined;
	}

	/**
	 * Committed blocks are a prefix of `main`. A block inserted above committed ones (or a reorder)
	 * breaks that: those become live again and history is replayed, so each is written once, in order.
	 */
	#checkFrontier(main: readonly UiNode[], start: number): void {
		if (main === this.#frontierChecked) return;
		this.#frontierChecked = main;
		let stray = false;
		for (let i = start; i < main.length; i++) if (this.#committed.delete(main[i]!)) stray = true;
		// History holds them in the order they were committed (the set's order).
		let i = 0;
		for (const node of this.#committed) if (main[i++] !== node) stray = true;
		if (stray) this.#requestReplay();
	}

	/**
	 * A streaming head must still paint the rows it put in history first. Another width (a resize
	 * without replay) or a stable head that changed after all means history does not hold what the
	 * viewport continues: it is replayed.
	 */
	#checkEmitted(main: readonly UiNode[], start: number, width: number, rowWise: boolean): void {
		for (const [node, emitted] of this.#emitted) {
			// Its rows in history follow the committed ones: anything else (removed, or a block inserted
			// above it) puts history out of order.
			if (main[start] !== node) {
				this.#requestReplay();
				return;
			}
			const block = this.#paint(node, width);
			if (block === emitted.verified) continue;
			if (emitted.width !== width) {
				// A resize the driver does not replay (or not yet): history keeps the width it was written at,
				// and the record stays the one of that width (a burst back to it maps nothing).
				if (emitted.mapped?.width === width && emitted.mapped.block === block) continue;
				const mapped = remapEmitted(block.rows, emitted.rows, emitted.count);
				// Whole blocks went to history when the driver keeps it at its width: they map exactly, or the
				// block changed and history no longer holds what the viewport continues.
				if (!mapped.exact && !rowWise) {
					this.#requestReplay();
					return;
				}
				emitted.mapped = { width, block, count: mapped.count };
				continue;
			}
			if (!startsWith(block.rows, emitted.rows, emitted.count)) {
				this.#requestReplay();
				return;
			}
			emitted.verified = block;
		}
	}

	/**
	 * Share `capacity` rows among the live blocks `main[first + i]` (`live <= i < count`) whose rows
	 * overflow it, into `shown`: every active (unsettled) block keeps at least one row, the newest take
	 * the rest, settled blocks only what is left. When active blocks outnumber the rows the newest
	 * `capacity - 1` keep one each under a summary row; returns how many blocks that row stands for.
	 */
	#allocate(
		main: readonly UiNode[],
		first: number,
		live: number,
		count: number,
		capacity: number,
		shownRows: (i: number) => number,
		shown: number[],
	): number {
		const unsettled = this.#unsettled();
		const lo = lowerBound(unsettled, first + live);
		const hi = lowerBound(unsettled, first + count);
		// Active blocks with rows, newest first; one more than fit is enough to know a summary is due.
		const active: number[] = [];
		for (let u = hi - 1; u >= lo && active.length <= capacity; u--) {
			const i = unsettled[u]! - first;
			if (shownRows(i) > 0) active.push(i);
		}
		let summary = 0;
		if (active.length > capacity) {
			// The blocks it stands for: the older active ones that draw something. Only the newest of them
			// are painted to tell (as many as the screen has rows, at least 16); older ones count as drawing.
			const oldest = active[capacity - 2] ?? count;
			active.length = capacity - 1;
			let u = lowerBound(unsettled, first + oldest) - 1;
			for (let painted = 0; u >= lo && painted < Math.max(capacity, 16); u--, painted++) {
				if (shownRows(unsettled[u]! - first) > 0) summary++;
			}
			summary += u - lo + 1;
		}
		let left = capacity - (summary > 0 ? 1 : 0);
		let owed = active.length;
		for (let i = count - 1, k = 0; i >= live && left > 0; i--) {
			const kept = k < active.length && active[k] === i;
			if (kept) {
				k++;
				owed--;
			}
			const room = left - owed;
			if (room <= 0) {
				// Only the rows owed to older active blocks are left: go straight to the next one.
				if (k >= active.length) break;
				i = active[k]! + 1;
				continue;
			}
			if (!kept && !isSettled(main[first + i]!)) continue;
			const rows = shownRows(i);
			if (rows === 0) continue;
			shown[i] = Math.min(rows, room);
			left -= shown[i]!;
		}
		return summary;
	}

	#compose(): FramePlan | null {
		const presentation = this.#options.presentation ? this.#options.presentation() : "inline";
		if (presentation === null) return null;
		const width = Math.max(1, this.#driver.columns);
		const height = Math.max(1, this.#driver.rows);
		const flush = this.#flushing;
		const hits: PlacedHit[] = [];
		let cursor: Cell | null = null;
		// The presentation may change at runtime: fullscreen starts at the tail; inline drops the selection.
		if (presentation !== this.#presentation) {
			this.#presentation = presentation;
			if (presentation === "fullscreen") this.#transcript.enter();
			else this.#transcript.leave();
		}

		// The shutdown flush writes the transcript inline: transient layers are no part of it.
		const layer = flush ? [] : this.#surface.layer();
		this.#hitLayer = layer;
		const sheets: Sheet[] = [];
		/** Draw a layer node over `rows` (centered, or at its `top`/`bottom` anchor). */
		const place = (rows: string[], node: UiNode): void => {
			// Modal sheets own the pointer everywhere, including their margins and non-interactive rows.
			const modal = node.kind === "overlay" && Boolean((node.props() as { modal?: boolean }).modal);
			if (modal) hits.length = 0;
			const overlayCols = node.kind === "overlay" ? overlayWidth(node, width) : width;
			const block = this.#paint(node, overlayCols);
			const anchor = layerAnchor(node);
			while (rows.length < Math.min(height, block.rows.length)) rows.unshift("");
			const top =
				anchor === "top"
					? 0
					: anchor === "bottom"
						? Math.max(0, rows.length - block.rows.length)
						: Math.max(0, Math.floor((rows.length - block.rows.length) / 2));
			const left = Math.max(0, Math.floor((width - overlayCols) / 2));
			composite(rows, block, top, left, width);
			if (block.cursor) cursor = { row: top + block.cursor.row, col: left + block.cursor.col };
			for (const hit of block.hits ?? []) hits.push({ hit, region: "layer", top, left });
			sheets.push({ top, left, width: overlayCols, height: block.rows.length, modal });
		};
		const fullscreenAt = layer.findLastIndex(isFullscreen);
		if (fullscreenAt !== -1) {
			this.#transcript.hide();
			const block = this.#paint(layer[fullscreenAt]!, width, height);
			const rows = block.rows.slice(0, height);
			while (rows.length < height) rows.push("");
			cursor = block.cursor ?? null;
			for (const hit of block.hits ?? []) hits.push({ hit, region: "layer", top: 0, left: 0 });
			// Sheets opened over a fullscreen layer (a help sheet over an app) draw on top of it.
			for (const node of layer.slice(fullscreenAt + 1)) place(rows, node);
			this.#hits = hits;
			// The normal screen stays as it was under the alternate one: the viewport keeps its place.
			this.#nextPin = this.#pin;
			return { viewport: [], cursor, fullscreen: rows };
		}

		const dock: Placed[] = [];
		let dockRows = 0;
		/** Dock rows drawn over the transcript (a completion popup): they take no room from `main`. */
		let covering = 0;
		for (const node of this.#surface.dock()) {
			const block = this.#paint(node, width);
			dock.push({ block, top: dockRows, left: 0 });
			dockRows += block.rows.length;
			covering += Math.min(block.covering ?? 0, block.rows.length);
		}

		if (presentation === "fullscreen") {
			// The transcript scrolls in the rows above the dock pinned to the bottom (covering rows draw
			// over its last ones); nothing goes to history, and the normal screen keeps its viewport.
			const area = Math.max(0, height - dockRows + covering);
			const transcript = this.#transcript.compose(
				this.#surface.main(),
				width,
				area,
				Math.max(0, Math.min(area, height - dockRows)),
				this.#surface.focused() !== null,
			);
			const rows = transcript.rows.slice(0, height);
			while (rows.length < height) rows.push("");
			cursor = transcript.cursor;
			hits.push(...transcript.hits);
			const dockTop = height - dockRows;
			for (const placed of dock) {
				const top = dockTop + placed.top;
				const block = placed.block;
				for (let i = 0; i < block.rows.length; i++) if (top + i >= 0) rows[top + i] = block.rows[i]!;
				if (block.cursor && top + block.cursor.row >= 0)
					cursor = { row: top + block.cursor.row, col: block.cursor.col };
				for (const hit of block.hits ?? []) hits.push({ hit, region: "dock", top, left: 0 });
			}
			for (const node of layer) place(rows, node);
			// A modal sheet owns the pointer everywhere: the transcript's gestures end under it.
			if (sheets.some(sheet => sheet.modal)) this.#transcript.disablePointer();
			this.#hits = hits;
			this.#sheets = sheets;
			this.#nextPin = this.#pin;
			return { viewport: [], cursor, fullscreen: rows };
		}
		this.#transcript.hide();

		// The committed prefix of main stays in history; the rest is live.
		const main = this.#surface.main();
		let start = 0;
		while (start < main.length && this.#committed.has(main[start]!)) start++;
		this.#checkFrontier(main, start);
		const separator = this.#options.separator ?? (() => 1);
		// Whether a resize replays history at its new width (else blocks leave history whole: see below).
		const rowWise = this.#driver.replaysOnResize?.() ?? true;
		this.#checkEmitted(main, start, width, rowWise);
		// A batch never written is prepared again when it no longer fits: another width, or blocks that
		// moved under it (a replay it was stays owed).
		const offered = this.#pending;
		if (offered && (offered.width !== width || !heads(offered, main, start))) this.#pending = undefined;
		// A lost display gets the committed ledger back under a fresh id, followed by whatever retires
		// in the same frame; streaming heads start over (their stable rows go out again under pressure).
		let ledger: string[] | undefined;
		let ledgerLast: UiNode | undefined;
		if (this.#replay && !this.#pending) {
			this.#emitted.clear();
			this.#committed = new Set(main.slice(0, start));
			ledger = [];
			for (let i = 0; i < start; i++) {
				const node = main[i]!;
				const block = this.#paint(node, width);
				if (block.rows.length === 0) continue;
				if (ledgerLast) for (let n = separator(ledgerLast, node); n > 0; n--) ledger.push("");
				for (const row of block.rows) ledger.push(row);
				ledgerLast = node;
			}
		}
		const pending = this.#pending;
		const pendingHead = pending?.head;
		const capacity = flush ? 0 : Math.max(0, height - dockRows + covering);
		// Live main nodes are `main[first + i]`, `i < count`. A batch still being written to history
		// is not live; the blocks it writes are what the first live block is separated from.
		let first = start;
		let aboveLive = ledger
			? ledgerLast
			: pending
				? (pending.last ?? (pending.replay ? undefined : this.#historyTail))
				: this.#historyTail;
		if (pending) {
			const retiring = new Set(pending.nodes);
			for (; first < main.length && retiring.has(main[first]!); first++) {
				if (this.#paint(main[first]!, width).rows.length > 0) aboveLive = main[first];
			}
		}
		const count = main.length - first;
		// Live blocks are painted (and so watched) only as the frame needs them: from the tail up
		// until the viewport is full, plus what retires. Blocks scrolled out of view above it cannot
		// change this frame (see the retirement note below), so their changes schedule none.
		const blocks: (Block | undefined)[] = [];
		const skips: (number | undefined)[] = [];
		const leads: (number | undefined)[] = [];
		const blockAt = (i: number): Block => (blocks[i] ??= this.#paint(main[first + i]!, width));
		// Rows of a live block already in history (a streaming head), not repainted in the viewport.
		const skipAt = (i: number): number => {
			let skip = skips[i];
			if (skip === undefined) {
				const node = main[first + i]!;
				const emitted = this.#emitted.get(node);
				skip = skips[i] =
					pendingHead?.node === node
						? pendingHead.count
						: !emitted
							? 0
							: emitted.width === width
								? emitted.count
								: (emitted.mapped?.count ?? emitted.count);
			}
			return skip;
		};
		// Blank rows separating a live block from the non-empty block above it (none once its head
		// is in history: that write carried them).
		const leadAt = (i: number): number => {
			let lead = leads[i];
			if (lead === undefined) {
				lead = 0;
				const node = main[first + i]!;
				const written = pendingHead?.node === node || this.#emitted.has(node);
				if (blockAt(i).rows.length > 0 && skipAt(i) === 0 && !written) {
					let above = aboveLive;
					for (let j = i - 1; j >= 0; j--) {
						if (blockAt(j).rows.length > 0) {
							above = main[first + j];
							break;
						}
					}
					if (above) lead = separator(above, main[first + i]!);
				}
				leads[i] = lead;
			}
			return lead;
		};
		/** Rows a live block adds to the viewport: its rows not in history, after its lead. */
		const shownRows = (i: number): number => {
			const shown = Math.max(0, blockAt(i).rows.length - skipAt(i));
			return shown > 0 ? shown + leadAt(i) : 0;
		};
		// `boundary`: the last live block whose rows and those of every block after it overflow the
		// viewport (-1 when the whole live tail fits). Rows from `i` to the end exceed the capacity
		// exactly when `i <= boundary`: retirement asks nothing else of the blocks above it.
		// The shutdown flush retires every live block, settled or not (frozen as it is now).
		let boundary = flush ? count - 1 : -1;
		for (let i = count - 1, rows = 0; !flush && i >= 0; i--) {
			rows += shownRows(i);
			if (rows > capacity) {
				boundary = i;
				break;
			}
		}
		// Retire the settled prefix only while the live tail does not fit.
		let live = 0;
		let history: FramePlan["history"];
		if (pending) {
			history = { id: pending.id, rows: pending.rows, ...(pending.replay ? { kind: "replay" as const } : {}) };
		} else if (boundary >= 0 || ledger) {
			const retired: UiNode[] = [];
			const rows: string[] = ledger ?? [];
			let last = ledgerLast;
			/** Move the rest of block `live` into history: it is committed with the batch. */
			const retireWhole = (): void => {
				const node = main[first + live]!;
				const block = blockAt(live);
				const skip = skipAt(live);
				retired.push(node);
				if (block.rows.length > skip) {
					// The separator may depend on whether the block above retires (it just did, in this batch).
					leads[live] = undefined;
					for (let i = leadAt(live); i > 0; i--) rows.push("");
					for (let i = skip; i < block.rows.length; i++) rows.push(block.rows[i]!);
				}
				if (block.rows.length > 0) last = node;
				this.#retiring.add(node);
				live++;
			};
			// Settled blocks whose every row must leave retire whole; the shutdown flush retires everything.
			while (live < count && (flush || (live < boundary && isSettled(main[first + live]!)))) retireWhole();
			leads[live] = undefined;
			// The block the room ends in gives up only the rows that would scroll away: all of a settled
			// block's rows are final, a streaming one offers its stable head. The rest stays live (a
			// settled block still repaints them: a tool card collapses below the rows already in history).
			// A driver that keeps history at its old width on a resize (`preserve`, in-place) gets whole
			// blocks and whole stable heads instead, which map exactly to the new width.
			let head: PendingBatch["head"];
			if (!flush && live < count && live <= boundary) {
				const node = main[first + live]!;
				const block = blockAt(live);
				const skip = skipAt(live);
				const settled = isSettled(node);
				const stable = settled ? block.rows.length : block.stable;
				if (stable !== undefined && stable > skip) {
					let liveRows = 0;
					for (let i = live; i < count; i++) liveRows += shownRows(i);
					// Only the pressure: the separator written with the first rows relieves it too (it may
					// alone; the block's rows then stay live).
					const lead = leadAt(live);
					const take = rowWise ? Math.min(stable - skip, Math.max(0, liveRows - capacity - lead)) : stable - skip;
					if (settled && skip + take >= block.rows.length) retireWhole();
					else if (take > 0 || lead > 0) {
						for (let i = lead; i > 0; i--) rows.push("");
						const stop = Math.min(skip + take, block.rows.length);
						for (let i = skip; i < stop; i++) rows.push(block.rows[i]!);
						head = { node, rows: block.rows, count: stop };
						skips[live] = stop;
						leads[live] = 0;
						last = node;
					}
				}
			}
			if (rows.length > 0 || ledger) {
				const id = this.#nextHistoryId++;
				const replay = ledger !== undefined;
				this.#pending = { id, rows, nodes: retired, replay, ...(head ? { head } : {}), last, width };
				history = { id, rows, ...(replay ? { kind: "replay" as const } : {}) };
			} else {
				// Nothing to write: the blocks stay live (committed with the next batch that has rows).
				leads[live] = undefined;
			}
			this.#retiring.clear();
		}

		// Rows each live block shows. A live tail that fits shows whole; a taller one is allocated.
		const shown: number[] = [];
		let summary = 0;
		if (capacity > 0 && live < count) {
			let from = count;
			let used = 0;
			while (from > live && used < capacity) used += shownRows(--from);
			if (used <= capacity && from === live) {
				for (let i = live; i < count; i++) shown[i] = shownRows(i);
			} else {
				summary = this.#allocate(main, first, live, count, capacity, shownRows, shown);
			}
		}
		const viewport: string[] = [];
		/** Viewport rows of a block whose head is in history right above the viewport: its images may reach up there. */
		let joinedEnd = 0;
		if (summary > 0) {
			const theme = this.#options.theme();
			viewport.push(truncate(theme.fg("dim", `⋯ ${summary} more running`), width, ""));
		}
		for (let i = live; i < count; i++) {
			const rows = shown[i] ?? 0;
			if (rows <= 0) continue;
			let block = blockAt(i);
			// The first block row shown: past the rows in history, and past what the allocation cuts.
			let from = skipAt(i);
			const content = block.rows.length - from;
			let lead = 0;
			if (rows >= content) lead = rows - content;
			else if (from === 0) {
				// Less room than the block takes: painted at that height (a tool's compact look), else its tail.
				block = this.#paint(main[first + i]!, width, rows);
				from = Math.max(0, block.rows.length - rows);
			} else from = block.rows.length - rows;
			for (; lead > 0; lead--) viewport.push("");
			const start = viewport.length;
			const top = start - from;
			for (let row = from; row < block.rows.length; row++) viewport.push(block.rows[row]!);
			// Block rows above `from` sit right above it only when they are in history and the block opens the
			// viewport; how many are still on screen is known once the viewport is placed (below).
			if (start === 0 && from === skipAt(i)) joinedEnd = viewport.length;
			else dropCutImages(viewport, start);
			if (block.cursor && block.cursor.row >= from && this.#surface.focused())
				cursor = { row: top + block.cursor.row, col: block.cursor.col };
			for (const hit of block.hits ?? []) if (hit.row >= from) hits.push({ hit, region: "main", top, left: 0 });
		}
		const clipped = Math.max(0, viewport.length - capacity);
		if (clipped > 0) {
			viewport.splice(0, clipped);
			dropCutImages(viewport, 0);
			joinedEnd = 0;
			if (cursor) cursor = cursor.row >= clipped ? { row: cursor.row - clipped, col: cursor.col } : null;
			for (const entry of hits) (entry as { top: number }).top -= clipped;
		}
		// Once the viewport reached the bottom of the screen it keeps its height there when its content
		// shrinks: blank rows between the live main rows and the dock (no live rows: retirement and
		// allocation never count them) hold the dock at the bottom.
		/** Screen rows under the viewport and its dock: a sheet anchors to the screen, so it may draw there. */
		let free = 0;
		if (!flush) {
			const pin = this.#pin;
			const fresh = !pin || pin.width !== width || pin.height !== height || history?.kind === "replay";
			const below = fresh ? 0 : pin.below;
			const written = history ? history.rows.length : 0;
			const natural = viewport.length + dockRows;
			const bottom = (fresh ? false : pin.bottom) || below + written + natural >= height;
			// History written under a viewport at the bottom scrolls it: the rows it covered shrink by as much.
			const hold = !fresh && pin.bottom ? Math.min(height, pin.rows - written) : 0;
			if (bottom && dockRows > 0) while (viewport.length + dockRows < hold) viewport.push("");
			if (!bottom) free = Math.max(0, height - (below + written) - (viewport.length + dockRows));
			// The rows from the viewport's top down: a shrunk viewport keeps its top (only a dock pads it down).
			const held = !fresh && pin.bottom ? Math.min(height, pin.span - written) : 0;
			const span = Math.max(viewport.length + dockRows, held);
			this.#nextPin = { width, height, below: below + written, bottom, rows: viewport.length + dockRows, span };
			// The screen rows above the viewport: everything written so far, or (at the bottom) what it leaves.
			const above = bottom ? Math.max(0, height - span) : below + written;
			if (joinedEnd > 0) dropCutImages(viewport, 0, joinedEnd, above);
		} else if (joinedEnd > 0) dropCutImages(viewport, 0, joinedEnd);
		const dockTop = viewport.length;
		for (const placed of dock) {
			viewport.push(...placed.block.rows);
			if (placed.block.cursor)
				cursor = { row: dockTop + placed.top + placed.block.cursor.row, col: placed.block.cursor.col };
			for (const hit of placed.block.hits ?? [])
				hits.push({ hit, region: "dock", top: dockTop + placed.top, left: 0 });
		}
		// Covering dock rows hide the live rows they draw over (still live: they come back when it closes).
		const hidden = covering > 0 ? Math.min(dockTop, viewport.length - height) : 0;
		if (hidden > 0) {
			viewport.splice(0, hidden);
			dropCutImages(viewport, 0, dockTop - hidden);
			if (cursor) cursor = cursor.row >= hidden ? { row: cursor.row - hidden, col: cursor.col } : null;
			for (const entry of hits) (entry as { top: number }).top -= hidden;
		}

		if (layer.length > 0) for (; free > 0; free--) viewport.push("");
		for (const node of layer) place(viewport, node);
		this.#hits = hits;
		return { ...(history ? { history } : {}), viewport, cursor };
	}

	#regions(): UiNode[] {
		return [...this.#surface.layer(), ...this.#surface.dock(), ...this.#surface.main()];
	}

	#widgetContext(path: readonly UiNode[]): WidgetContext {
		return widgetContext(path, {
			focus: next => this.#surface.focus(next),
			pageRows: Math.max(1, this.#driver.rows - 2),
		});
	}

	/** Route `event` as if the terminal sent it (no interception). */
	dispatch(event: InputEvent): void {
		this.#onInput(event);
	}

	#onInput(event: InputEvent): void {
		batch(() => {
			switch (event.type) {
				case "key":
					this.#onKey(event.key);
					break;
				case "paste": {
					const focused = this.#surface.focused();
					const path = focused ? pathTo(this.#regions(), focused) : [];
					if (bubblePaste(path, event.paste)) break;
					if (focused) widgetFor(focused)?.paste?.(focused, event.paste, this.#widgetContext(path));
					break;
				}
				case "mouse":
					this.#onMouse(event.mouse);
					break;
				default:
					break;
			}
		});
		this.requestRender();
	}

	#onKey(key: KeyEvent): void {
		const focused = this.#surface.focused();
		const path = focused ? pathTo(this.#regions(), focused) : [];
		if (bubbleKey(path, key)) return;
		if (focused && path.length > 0) {
			const widget = widgetFor(focused);
			if (widget?.key?.(focused, key, this.#widgetContext(path))) return;
		}
		this.#options.onKey?.(key);
	}

	#onMouse(mouse: MouseEvent): void {
		if (this.#surface.layer() !== this.#hitLayer) {
			this.clearHover();
			return;
		}
		const viewportRow = this.#driver.viewportRow ? this.#driver.viewportRow(mouse.row) : mouse.row;
		if (viewportRow === null) {
			this.clearHover();
			return;
		}
		this.#trackHover(viewportRow, mouse.col);
		// The fullscreen transcript's wheel, lanes and selection come first; sheets over it keep their hits.
		if (this.#presentation === "fullscreen") {
			const sheet = this.#sheets.some(
				sheet =>
					viewportRow >= sheet.top &&
					viewportRow < sheet.top + sheet.height &&
					mouse.col >= sheet.left &&
					mouse.col < sheet.left + sheet.width,
			);
			if (this.#transcript.mouse(mouse, viewportRow, sheet, () => this.#route(viewportRow, mouse))) return;
		}
		this.#route(viewportRow, mouse);
	}

	/** Widget coordinates at a frame cell, undefined outside the hit, null on a disabled shortcut that covers it. */
	#hitCell(entry: PlacedHit, row: number, col: number): Cell | null | undefined {
		const { hit, rows } = entry;
		if (rows && (row < rows[0] || row >= rows[1])) return undefined;
		const at = row - entry.top - hit.row;
		const column = col - entry.left - hit.col;
		if (at < 0 || column < 0 || at >= hit.height || column >= hit.width) return undefined;
		if (hit.optionalTarget === entry.region && this.#options.activateTargets?.() === false) return null;
		return { row: at + (hit.fieldRowOffset ?? 0), col: column };
	}

	/** Offer a pointer report to the last frame's hits, topmost first; true when one took it. */
	#route(viewportRow: number, mouse: MouseEvent): boolean {
		for (let i = this.#hits.length - 1; i >= 0; i--) {
			const entry = this.#hits[i]!;
			const at = this.#hitCell(entry, viewportRow, mouse.col);
			if (at === undefined) continue;
			if (at === null) return false;
			const hit = entry.hit;
			const path = pathTo(this.#regions(), hit.node);
			if (path.length === 0) continue;
			const widget = widgetFor(hit.node);
			if (widget?.mouse?.(hit.node, mouse, at, this.#widgetContext(path), hit)) return true;
			if (mouse.action === "press" && mouse.button === "left" && hit.act) {
				bubbleEvent(path, { type: "action", key: keypathOf(path), act: hit.act, mods: mouse.mods });
				return true;
			}
			if (mouse.action === "press" && mouse.button === "left" && hit.item !== undefined) {
				bubbleEvent(path, { type: "select", key: keypathOf(path), item: hit.item });
				return true;
			}
		}
		return false;
	}

	/** Point the hover state at the topmost hit under the pointer (painters band it via `cx.hovered`). */
	#trackHover(viewportRow: number, column: number): void {
		let next: PointerHover | null = null;
		for (let i = this.#hits.length - 1; i >= 0; i--) {
			const entry = this.#hits[i]!;
			const at = this.#hitCell(entry, viewportRow, column);
			if (at === undefined) continue;
			if (at === null) break;
			const hit = entry.hit;
			next = {
				node: hit.node,
				...(hit.item === undefined ? {} : { item: hit.item }),
				...(hit.act === undefined ? {} : { act: hit.act }),
			};
			break;
		}
		const current = this.#hover.peek();
		if (current?.node === next?.node && current?.item === next?.item && current?.act === next?.act) return;
		this.#hover.set(next);
	}

	/** Forget the hit under the pointer (pointer tracking went off: no report would ever clear it). */
	clearHover(): void {
		if (this.#hover.peek() !== null) this.#hover.set(null);
	}

	/** The paint environment (for previews rendering through the same caches). */
	get environment(): PaintEnvironment {
		return this.#env;
	}

	/** Set reduced motion (clocked kinds draw their still frame). */
	setReduceMotion(reduce: boolean): void {
		this.#reduceMotion.set(reduce);
	}
}
