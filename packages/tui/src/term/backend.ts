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
 * rest, a summary row stands for what does not fit. In the `fullscreen`
 * screen mode every frame is an alternate-screen frame instead: the dock is
 * pinned to the bottom and `main` scrolls above it in an app-owned window
 * (following its tail, or anchored to a block); nothing reaches history until
 * the shutdown flush. Replays (a lost display,
 * a block inserted above history, a streaming head whose history rows no
 * longer match) rewrite the ledger under a fresh id; {@link TermBackend.flush}
 * writes everything into history at shutdown. The protocol, its invariants and
 * how they map here: docs/tui-core-renderer.md.
 *
 * Input becomes the same events a Tern terminal sends: keys first offer
 * themselves to `onKey` handlers from the focused node up, then to the
 * focused kind's widget (an editor turns them into `edit` events); clicks
 * resolve through the last frame's hit regions.
 */
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import type {
	FramePlan,
	HistoryRowMark,
	InputEvent,
	MouseEvent,
	TerminalCapabilities,
	TerminalDriver,
} from "../driver/contract";
import { dropCutImages, holdsImage } from "../driver/images/anchor";
import { DEFAULT_CELL } from "../driver/images/fit";
import { KITTY_PLACEHOLDER } from "../driver/images/kitty";
import { clipViewportImages, maskOverlayImages } from "../driver/images/viewport";
import { bubbleEvent, bubbleKey, bubblePaste, keypathOf, pathTo } from "../dispatch";
import type { KeyEvent } from "../events";
import type { ScrollRequest, UiNode } from "../node";
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
import { padTo, sliceColumns, truncate, visibleWidth } from "../text/width";
import {
	type Block,
	type Cell,
	DEFAULT_SPINNER_INTERVAL_MS,
	type Hit,
	type PaintEnvironment,
	type PaintImages,
	paintNode,
	type PointerHover,
	releasePaintCache,
} from "./paint";
import { TranscriptSearch } from "./transcript-search";
import { type TranscriptDocument, type TranscriptIndex, transcriptIndex } from "./transcript-document";
import { TranscriptPointer } from "./transcript-pointer";
import { type WidgetContext, widgetContext, widgetFor } from "./widgets";
import "./painters";

/** Tick of a block drawing smooth motion (a shimmer sweep), ms. */
const SMOOTH_TICK_MS = 1000 / 20;

/**
 * Where a session draws: `inline` on the normal screen (settled blocks retire into terminal
 * history), or `fullscreen` on the alternate screen (`main` scrolls in an app-owned window above
 * the pinned dock; history is written only by the shutdown flush).
 */
export type ScreenMode = "inline" | "fullscreen";

/** Adjust the active transcript selection from the keyboard. */
export type SelectionMotion = "left" | "right" | "up" | "down" | "line-start" | "line-end" | "clear";

/** A terminal-only viewport action, not a native node scroll request. */
export type TranscriptScroll =
	| ScrollRequest["by"]
	| "half-up"
	| "half-down"
	| "previous-prompt"
	| "next-prompt"
	| number;

/** The top of the fullscreen transcript window: a `main` node and a row of its entry (separator rows first). */
interface ScrollAnchor {
	readonly node: UiNode;
	readonly row: number;
}

/** The fullscreen transcript window as the last frame drew it. */
interface SessionWindow {
	/** Its first row (the tail-following window's too, so scrolling starts from what is on screen). */
	readonly top: ScrollAnchor | undefined;
	/** Transcript rows on screen (the indicator row included). */
	readonly rows: number;
	readonly width: number;
	/** The wheel scrolls it: no modal sheet owns the pointer. */
	readonly wheel: boolean;
}

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
	/**
	 * Milliseconds per spinner frame (may change at runtime); 0 draws spinners still. The animation
	 * tick of terminal-clocked kinds runs at this interval when it is faster than
	 * {@link DEFAULT_SPINNER_INTERVAL_MS}, else at the default, so a slow or still spinner never slows
	 * other clock readers (pulses, strikes, progress slides). Default {@link DEFAULT_SPINNER_INTERVAL_MS}.
	 */
	readonly spinnerInterval?: Reactive<number>;
	/** Decorative motion off (blink, fade, pulse, sweeps): such kinds draw their still frame. Default false. */
	readonly reduceMotion?: Accessor<boolean>;
	/**
	 * Inline images painters draw (the process driver's `TerminalImages`).
	 * Absent: `image` nodes show their text fallback. The frame loop settles
	 * the budget through `driver.images`.
	 */
	readonly images?: PaintImages;
	/** Where the session draws (may change at runtime: frames follow it). Default `inline`. */
	readonly screen?: Accessor<ScreenMode>;
	/** Copy plain transcript text through the host's clipboard service. */
	readonly copySelection?: (text: string) => void;
	/** Copy non-empty fullscreen selections on release (default true). */
	readonly copyOnSelect?: Accessor<boolean>;
	/** Fullscreen wheel rows per report; 0 (default) follows the terminal's input velocity. */
	readonly wheelLines?: Accessor<number>;
	/** Reserve a fullscreen transcript column and show a scrollbar on overflow (default true). */
	readonly scrollbar?: Accessor<boolean>;
	/** Append the transcript to normal-screen history on a graceful fullscreen exit (default true). */
	readonly exitTranscript?: Accessor<boolean>;
	/** Whether a transcript node starts a semantic prompt. */
	readonly isPrompt?: (node: UiNode) => boolean;
}

/** A history batch offered to the driver until it acknowledges the id. */
interface PendingBatch {
	readonly history: NonNullable<FramePlan["history"]>;
	/** Marks offered with this batch; they are spent only when the driver acknowledges it. */
	readonly marked?: ReadonlyMap<object, HistoryRowMark>;
	/** Live main nodes the batch writes whole (committed on acknowledgement). */
	readonly nodes: readonly UiNode[];
	/** The `main` list the batch was prepared from: a block added or removed prepares it again. */
	readonly main: readonly UiNode[];
	/**
	 * Live blocks painted to decide the batch, indexed from the commit frontier (`nodes` first): any
	 * repaint prepares it again, since a block that shrank or grew changes the pressure.
	 */
	readonly blocks: readonly (Block | undefined)[];
	/** Nodes whose own rows the batch writes (not only a separator): see {@link TermBackend.contentInHistory}. */
	readonly content: readonly UiNode[];
	/** A streaming node's stable head moved into history: its emitted rows after this batch. */
	readonly head?: { readonly node: UiNode; readonly rows: readonly string[]; readonly count: number };
	/** The last non-empty block whose rows this batch writes. */
	readonly last: UiNode | undefined;
	/** Columns the rows were painted at: a batch still unwritten at another width is prepared again. */
	readonly width: number;
	/** Rows the live tail had: a dock or screen height change prepares the batch again. */
	readonly capacity: number;
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

/**
 * The paint seam over a driver's image store: its rows, measured in the
 * terminal's reported cell size (a default until the terminal reports one).
 */
export function driverImages(images: Pick<PaintImages, "rows">, capabilities: () => TerminalCapabilities): PaintImages {
	return {
		rows: (source, request) => images.rows(source, request),
		cell: () => capabilities().cell ?? DEFAULT_CELL,
	};
}

const FULLSCREEN_KINDS: ReadonlySet<string> = new Set(["picker", "prefs"]);

function isFullscreen(node: UiNode): boolean {
	const props = node.props();
	if (node.kind === "picker") return !("modal" in props && props.modal === false);
	if (FULLSCREEN_KINDS.has(node.kind)) return true;
	return node.kind === "overlay" && "size" in props && props.size === "full";
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
function composite(
	rows: string[],
	block: Block,
	top: number,
	left: number,
	width: number,
	fullscreenSession: boolean,
): void {
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
			// Placeholder colors and diacritics are image coordinates, not decoration.
			after =
				fullscreenSession && full.includes(KITTY_PLACEHOLDER)
					? sliceColumns(full, afterStart, width)
					: sliceAfter(full, afterStart);
		}
		rows[target] = `${before}\x1b[0m${cell}\x1b[0m${after}`;
	}
}

function sliceAfter(text: string, column: number): string {
	// Re-measured by the writer; styles of the cut prefix are reset above.
	let col = 0;
	let index = 0;
	for (const { segment } of segmentGraphemes(Bun.stripANSI(text))) {
		if (col >= column) break;
		col += Bun.stringWidth(segment);
		index += segment.length;
	}
	return Bun.stripANSI(text).slice(index);
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

/** Drop a covering block's caches together with the child blocks it composes. */
function releasePaintTree(node: UiNode): void {
	releasePaintCache(node);
	for (const child of node.children()) releasePaintTree(child);
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
	/** Written marks stay spent even if a resize or transcript edit replays their rows. */
	readonly #marked = new WeakSet<object>();
	/** The last non-empty main block with rows in history (what the first live block is separated from). */
	#historyTail: UiNode | undefined;
	/** Rows of live main nodes already moved into history (streaming heads), not repainted in the viewport. */
	readonly #emitted = new Map<UiNode, Emitted>();
	/** Main nodes with rows of their own in terminal history: a separator alone does not count. */
	readonly #withContent = new Set<UiNode>();
	/** The height each covering dock node was last composed at (`undefined`: its natural height). */
	readonly #dockFit = new WeakMap<UiNode, number | undefined>();
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
	#hits: { readonly hit: Hit; readonly top: number; readonly left: number }[] = [];
	/** Layer stack these hits were painted for; queued reports cannot click through a newly opened modal. */
	#hitLayer: readonly UiNode[] | undefined;
	/** The driver lost history: the next frame replays the committed ledger. */
	#replay = false;
	/** Fullscreen transcript window top; undefined while it follows the tail. */
	#anchor: ScrollAnchor | undefined;
	#search: TranscriptSearch | undefined;
	/** The fullscreen transcript window the last frame drew; undefined when none is on screen. */
	#window: SessionWindow | undefined;
	#index: TranscriptIndex | undefined;
	#pointer: TranscriptPointer | undefined;
	#pointerFocused = true;
	/** Nonmodal sheets and toasts cover transcript cells even where they have no widget hit. */
	readonly #pointerCovers: { top: number; bottom: number; left: number; right: number; firstHit: number }[] = [];
	/** Indices of the unsettled `main` nodes, ascending (recomputed when `main` or a settle mark changes). */
	readonly #unsettled: Accessor<readonly number[]>;
	#unsubscribe: (() => void)[] = [];
	/** Disposes the watcher of the last frame's reactive reads. */
	#disposeWatch: (() => void) | undefined;
	#running = false;

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
		this.#env = {
			theme: options.theme,
			clock: smooth => {
				this.#scheduleTick(smooth === true);
				return (options.clock ?? this.#clock)();
			},
			focus: options.surface.focused,
			reduceMotion: options.reduceMotion ?? (() => false),
			spinnerInterval: () => read(options.spinnerInterval ?? DEFAULT_SPINNER_INTERVAL_MS),
			hover: this.#hover,
			hyperlinks,
			...(allowTextSizing ? { textSizing: () => allowTextSizing() && terminalTextSizing() } : {}),
			...(options.images ? { images: options.images } : {}),
		};
	}

	/** Start rendering and routing input on a started driver (the host owns the driver's lifecycle). */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#pointerFocused = true;
		this.#clock.set(Date.now());
		// Restarted (after a suspend): what the terminal holds is unknown, history is written again.
		if (this.#committed.size > 0 || this.#emitted.size > 0) this.#requestReplay();
		this.#unsubscribe.push(
			this.#driver.onInput(event => this.#routeInput(event, true)),
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
		this.#leavePointerWindow();
		this.#closeSearch();
		clearTimeout(this.#frame);
		clearTimeout(this.#tick);
		this.#frame = undefined;
		this.#tick = undefined;
		this.#frameRequested = false;
		for (const off of this.#unsubscribe.splice(0)) off();
		this.#disposeWatch?.();
		this.#disposeWatch = undefined;
	}

	/**
	 * Graceful shutdown: one last frame writes the whole transcript into
	 * terminal history (every live `main` block as it is now, settled or not,
	 * after the ledger a pending replay still owes) and keeps the dock as the
	 * viewport. A driver that cannot write inline yet (mid-resize) writes it
	 * when it stops. Call it last, right before {@link stop}.
	 */
	flush(): void {
		if (!this.#running) return;
		if (this.#options.screen?.() === "fullscreen" && this.#options.exitTranscript?.() === false) return;
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

	/** Whether the driver acknowledged rows of `node`'s own content in history, not only the separator above it. */
	contentInHistory(node: UiNode): boolean {
		return this.#withContent.has(node);
	}

	/**
	 * Scroll the fullscreen transcript window: by `by` (a page is the window less one row), or by a
	 * row count (negative: up). Scrolling to the end follows the tail again. False when no window is
	 * on screen (inline mode, a fullscreen layer up): the caller's key goes elsewhere.
	 */
	scroll(by: TranscriptScroll): boolean {
		const view = this.#window;
		if (!this.#running || !view) return false;
		const page = Math.max(1, view.rows - 1);
		if (by === "previous-prompt" || by === "next-prompt") {
			const main = untrack(() => this.#surface.main());
			const top = this.#anchor ?? view.top;
			if (!top || !this.#options.isPrompt) return false;
			const step = by === "next-prompt" ? 1 : -1;
			let index = main.indexOf(top.node);
			if (step > 0 || top.row === 0) index += step;
			for (; index >= 0 && index < main.length; index += step) {
				const node = main[index]!;
				if (!this.#options.isPrompt(node)) continue;
				this.#anchor = { node, row: 0 };
				this.requestRender();
				break;
			}
			return true;
		}
		if (by === "half-up" || by === "half-down")
			by = (by === "half-up" ? -1 : 1) * Math.max(1, Math.floor(view.rows / 2));
		const delta =
			typeof by === "number"
				? by
				: by === "page-up"
					? -page
					: by === "page-down"
						? page
						: by === "line-up"
							? -1
							: by === "line-down"
								? 1
								: 0;
		const doc = this.#index!.read();
		const maxTop = Math.max(0, doc.rows - view.rows);
		const origin = this.#anchor && doc.entry(this.#anchor.node);
		const from = origin ? origin.top + Math.min(this.#anchor!.row, origin.size - 1) : maxTop;
		this.#seek(by === "start" ? 0 : by === "end" ? maxTop : from + delta, doc);
		return true;
	}

	/** Open a terminal-local transcript search without moving focus or editing the composer's draft. */
	openSearch(): boolean {
		if (!this.#running || !this.#window || !this.#searchable()) return false;
		if (!this.#search) {
			this.#pointer?.reset();
			this.#search = new TranscriptSearch(this.#anchor, this.#surface.focused(), this.#env, field =>
				this.#widgetContext([field]),
			);
			this.requestRender();
		}
		return true;
	}

	#searchable(): boolean {
		if (this.#options.screen?.() !== "fullscreen") return false;
		if (this.#search && this.#search.owner !== this.#surface.focused()) return false;
		return !this.#surface
			.layer()
			.some(
				node =>
					isFullscreen(node) || (node.kind === "overlay" && (node.props() as { modal?: boolean }).modal === true),
			);
	}

	#closeSearch(accept = false): void {
		const search = this.#search;
		if (!search) return;
		this.#anchor = (accept ? search.selectedAnchor : undefined) ?? search.savedAnchor;
		search.dispose();
		this.#search = undefined;
	}

	#searchInput(event: InputEvent): boolean {
		const search = this.#search;
		if (!search) return false;
		if (!this.#searchable()) {
			this.#closeSearch();
			this.requestRender();
			return false;
		}
		if (
			event.type === "mouse" &&
			event.mouse.action === "press" &&
			event.mouse.row < (this.#window?.rows ?? 0) &&
			(event.mouse.button === "wheel-up" || event.mouse.button === "wheel-down")
		) {
			search.browse();
			this.#pointer?.input(event.mouse, event.mouse.row);
			return true;
		}
		if (
			event.type === "key" &&
			event.key.kind !== "release" &&
			(event.key.id === "pageUp" || event.key.id === "pageDown")
		) {
			search.browse();
			return this.scroll(event.key.id === "pageUp" ? "page-up" : "page-down");
		}
		const action = search.input(event);
		if (!action) return false;
		if (action !== "handled") {
			// The terminal may deliver the query, navigation and accept before a coalesced frame.
			if (action === "accept" && this.#frameRequested) this.renderNow();
			this.#closeSearch(action === "accept");
		}
		this.requestRender();
		return true;
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
		this.#frameRequested = false;
		clearTimeout(this.#frame);
		this.#frame = undefined;
		this.#lastFrame = performance.now();
		let plan = this.#composeWatched();
		// An image budget change after painting means the rows it painted are stale.
		for (let pass = 0; pass < 3 && this.#driver.images?.settle(); pass++) plan = this.#composeWatched();
		const written = this.#driver.present(plan);
		// A frame whose history the driver did not write was not drawn inline either: the screen is as it was.
		if (!plan.history || written === plan.history.id) this.#pin = this.#nextPin;
		const pending = this.#pending;
		if (pending && written === pending.history.id) {
			const replay = pending.history.kind === "replay";
			if (pending.marked) for (const key of pending.marked.keys()) this.#marked.add(key);
			if (replay) this.#withContent.clear();
			for (const node of pending.content) this.#withContent.add(node);
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
			if (replay || pending.last) this.#historyTail = pending.last;
			this.#pending = undefined;
			this.#frontierChecked = undefined;
			if (replay) this.#replay = false;
			// What became eligible while the batch waited retires in the next frame.
			this.requestRender();
		}
	}

	/**
	 * Compose while recording every reactive read (regions, focus, painted
	 * blocks, options): the first change to any of them schedules the next
	 * frame. Each frame replaces the previous frame's watcher.
	 */
	#composeWatched(): FramePlan {
		this.#disposeWatch?.();
		let plan: FramePlan | undefined;
		createRoot(dispose => {
			this.#disposeWatch = dispose;
			effect(() => {
				if (plan) untrack(() => this.requestRender());
				else plan = this.#compose();
			});
		});
		return plan!;
	}

	#scheduleTick(smooth: boolean): void {
		if (!this.#running || this.#options.clock) return;
		const delay = smooth
			? SMOOTH_TICK_MS
			: Math.min(untrack(this.#env.spinnerInterval) || DEFAULT_SPINNER_INTERVAL_MS, DEFAULT_SPINNER_INTERVAL_MS);
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

	/**
	 * The dock's blocks at `width`, first painted at their remembered fit heights. Each covering
	 * block gets the rows every other block actually takes, so earlier covers shrink first. A
	 * changed budget repaints its subtree so its last paint describes the block composed on screen.
	 */
	#paintDock(width: number, height: number): Block[] {
		const nodes = this.#surface.dock();
		const blocks = nodes.map(node => this.#paint(node, width, this.#dockFit.get(node)));
		let total = blocks.reduce((sum, block) => sum + block.rows.length, 0);
		for (let i = 0; i < blocks.length; i++) {
			const node = nodes[i]!;
			const block = blocks[i]!;
			if (!block.covering) continue;
			const budget = Math.max(1, height - (total - block.rows.length));
			if (budget !== this.#dockFit.get(node)) {
				releasePaintTree(node);
				const fitted = this.#paint(node, width, budget);
				total += fitted.rows.length - block.rows.length;
				blocks[i] = fitted;
				this.#dockFit.set(node, budget);
			}
		}
		return blocks;
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

	#compose(): FramePlan {
		const width = Math.max(1, this.#driver.columns);
		const height = Math.max(1, this.#driver.rows);
		const flush = this.#flushing;
		const hits: { hit: Hit; top: number; left: number }[] = [];
		let cursor: Cell | null = null;

		// The shutdown flush writes the transcript inline: transient layers are no part of it.
		const layer = flush ? [] : this.#surface.layer();
		if (this.#hitLayer !== layer) this.#pointer?.blur();
		this.#pointerCovers.length = 0;
		this.#hitLayer = layer;
		/** Draw a layer node over `rows` (centered, or at its `top`/`bottom` anchor). */
		const place = (rows: string[], node: UiNode): void => {
			// Modal sheets own the pointer everywhere, including their margins and non-interactive rows.
			if (node.kind === "overlay" && (node.props() as { modal?: boolean }).modal) hits.length = 0;
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
			if (this.#window)
				this.#pointerCovers.push({
					top,
					bottom: top + block.rows.length,
					left,
					right: left + overlayCols,
					firstHit: hits.length,
				});
			const fullscreenSession = !flush && screen === "fullscreen";
			const restore =
				fullscreenSession && this.#options.images
					? maskOverlayImages(rows, top, block.rows.length, left, overlayCols, this.#options.images.cell().w)
					: undefined;
			composite(rows, block, top, left, width, fullscreenSession);
			restore?.();
			if (block.cursor) cursor = { row: top + block.cursor.row, col: left + block.cursor.col };
			for (const hit of block.hits ?? []) hits.push({ hit, top, left });
		};
		const fullscreenAt = layer.findLastIndex(isFullscreen);
		const screen = this.#options.screen?.() ?? "inline";
		if (this.#search && (flush || !this.#searchable())) this.#closeSearch();
		if (fullscreenAt !== -1) {
			this.#leavePointerWindow();
			const block = this.#paint(layer[fullscreenAt]!, width, height);
			const rows = block.rows.slice(0, height);
			while (rows.length < height) rows.push("");
			cursor = block.cursor ?? null;
			for (const hit of block.hits ?? []) hits.push({ hit, top: 0, left: 0 });
			// Sheets opened over a fullscreen layer (a help sheet over an app) draw on top of it.
			for (const node of layer.slice(fullscreenAt + 1)) place(rows, node);
			this.#hits = hits;
			// The normal screen stays as it was under the alternate one: the viewport keeps its place.
			this.#nextPin = this.#pin;
			return { viewport: [], cursor, fullscreen: rows };
		}
		if (screen === "fullscreen" && !flush) {
			const modal = layer.some(
				node => node.kind === "overlay" && (node.props() as { modal?: boolean }).modal === true,
			);
			if (modal) this.#pointer?.blur();
			const session = this.#composeSession(width, height, hits, !modal);
			cursor = session.cursor;
			for (const node of layer) place(session.rows, node);
			this.#hits = hits;
			// The normal screen stays as it was under the alternate one.
			this.#nextPin = this.#pin;
			return { viewport: [], cursor, fullscreen: session.rows };
		}
		if (this.#window) this.#leavePointerWindow();
		if (!flush) this.#anchor = undefined;

		const dock: Placed[] = [];
		let dockRows = 0;
		/** Dock rows drawn over the transcript (a completion popup): they take no room from `main`. */
		let covering = 0;
		for (const block of this.#paintDock(width, height)) {
			dock.push({ block, top: dockRows, left: 0 });
			dockRows += block.rows.length;
			covering += Math.min(block.covering ?? 0, block.rows.length);
		}

		// The committed prefix of main stays in history; the rest is live.
		const main = this.#surface.main();
		let start = 0;
		while (start < main.length && this.#committed.has(main[start]!)) start++;
		this.#checkFrontier(main, start);
		const separator = this.#options.separator ?? (() => 1);
		// Whether a resize replays history at its new width (else blocks leave history whole: see below).
		const rowWise = this.#driver.replaysOnResize?.() ?? true;
		this.#checkEmitted(main, start, width, rowWise);
		const capacity = flush ? 0 : Math.max(0, height - dockRows + covering);
		// An unwritten batch is prepared again when anything that decided it changed: the geometry, the
		// blocks in `main`, or the rows of a block it painted (a replay it was stays owed).
		const offered = this.#pending;
		if (
			offered &&
			(offered.width !== width ||
				offered.capacity !== capacity ||
				offered.main !== main ||
				offered.blocks.some(
					(block, i) => block !== undefined && this.#paint(main[start + i]!, width).rows !== block.rows,
				))
		) {
			this.#pending = undefined;
		}
		// A lost display gets the committed ledger back under a fresh id, followed by whatever retires
		// in the same frame; streaming heads start over (their stable rows go out again under pressure).
		let ledger: string[] | undefined;
		let ledgerLast: UiNode | undefined;
		const ledgerContent: UiNode[] = [];
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
				ledgerContent.push(node);
				ledgerLast = node;
			}
		}
		const pending = this.#pending;
		const pendingHead = pending?.head;
		// Live main nodes are `main[first + i]`, `i < count`. A batch still being written to history
		// is not live; the blocks it writes are what the first live block is separated from.
		let first = start;
		let aboveLive = ledger
			? ledgerLast
			: pending
				? (pending.last ?? (pending.history.kind === "replay" ? undefined : this.#historyTail))
				: this.#historyTail;
		if (pending) {
			for (let i = 0; i < pending.nodes.length; i++) {
				if (pending.blocks[i]!.rows.length > 0) aboveLive = pending.nodes[i];
			}
			first += pending.nodes.length;
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
			history = pending.history;
		} else if (boundary >= 0 || ledger) {
			const retired: UiNode[] = [];
			const content = ledgerContent;
			const rows: string[] = ledger ?? [];
			let last = ledgerLast;
			let marked: Map<object, HistoryRowMark> | undefined;
			const appendRows = (block: Block, from: number, to: number): void => {
				const mark = block.historyMark;
				if (mark && mark.row >= from && mark.row < to && !this.#marked.has(mark.key) && !marked?.has(mark.key)) {
					(marked ??= new Map()).set(mark.key, {
						row: rows.length + mark.row - from,
						before: mark.before,
						after: mark.after,
					});
				}
				for (let i = from; i < to; i++) rows.push(block.rows[i]!);
			};
			/** Move the rest of block `live` into history: it is committed with the batch. */
			const retireWhole = (): void => {
				const node = main[first + live]!;
				const block = blockAt(live);
				const skip = skipAt(live);
				retired.push(node);
				if (block.rows.length > skip) {
					content.push(node);
					// The separator may depend on whether the block above retires (it just did, in this batch).
					leads[live] = undefined;
					for (let i = leadAt(live); i > 0; i--) rows.push("");
					appendRows(block, skip, block.rows.length);
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
			// blocks and whole stable heads when content overflows, which map exactly to the new width.
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
					const overflow = Math.max(0, liveRows - capacity - lead);
					const take = overflow === 0 ? 0 : rowWise ? Math.min(stable - skip, overflow) : stable - skip;
					if (settled && skip + take >= block.rows.length) retireWhole();
					else if (take > 0 || lead > 0) {
						for (let i = lead; i > 0; i--) rows.push("");
						const stop = Math.min(skip + take, block.rows.length);
						appendRows(block, skip, stop);
						if (stop > skip) content.push(node);
						head = { node, rows: block.rows, count: stop };
						skips[live] = stop;
						leads[live] = 0;
						last = node;
					}
				}
			}
			if (rows.length > 0 || ledger) {
				history = {
					id: this.#nextHistoryId++,
					rows,
					...(ledger ? { kind: "replay" } : {}),
					...(marked ? { marks: [...marked.values()] } : {}),
				};
				this.#pending = {
					history,
					nodes: retired,
					main,
					blocks,
					content,
					...(marked ? { marked } : {}),
					...(head ? { head } : {}),
					last,
					width,
					capacity,
				};
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
			for (const hit of block.hits ?? []) if (hit.row >= from) hits.push({ hit, top, left: 0 });
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
			for (const hit of placed.block.hits ?? []) hits.push({ hit, top: dockTop + placed.top, left: 0 });
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

	/** Copy selected fullscreen transcript text. False leaves the key available to the focused widget. */
	copySelection(): boolean {
		return this.#pointer?.copy() ?? false;
	}

	/** Adjust an existing selection without stealing navigation from the composer when none is active. */
	extendSelection(direction: SelectionMotion): boolean {
		if (!this.#pointer?.adjust(direction)) return false;
		this.requestRender();
		return true;
	}

	#leavePointerWindow(): void {
		this.#window = undefined;
		this.#pointer?.reset();
		this.#pointer = undefined;
		this.#index?.dispose();
		this.#index = undefined;
	}
	#seek(offset: number, doc = this.#index?.read()): void {
		if (!doc || !this.#window) return;
		const target = Math.max(0, Math.trunc(offset));
		const entry = target < doc.rows - this.#window.rows ? doc.at(target) : undefined;
		this.#anchor = entry ? { node: entry.node, row: target - entry.top } : undefined;
		this.requestRender();
	}

	#sessionPointer(): TranscriptPointer {
		const options = this.#options;
		return (this.#pointer ??= new TranscriptPointer({
			available: () =>
				this.#running &&
				this.#pointerFocused &&
				!!this.#window?.wheel &&
				!this.#search &&
				this.#surface.layer() === this.#hitLayer &&
				this.#searchable(),
			document: () => this.#index!.read(),
			scroll: delta => this.scroll(delta),
			scrollTo: offset => this.#seek(offset),
			now: options.clock ?? (() => performance.now()),
			wheelLines: options.wheelLines ?? (() => 0),
			copyOnSelect: options.copyOnSelect ?? (() => true),
			copy: options.copySelection,
		}));
	}

	#document(width: number): TranscriptDocument {
		if (this.#index?.width !== width) {
			this.#index?.dispose();
			this.#index = transcriptIndex(
				width,
				this.#surface.main,
				node => this.#paint(node, width).rows,
				this.#options.separator ?? (() => 1),
			);
		}
		return this.#index.read();
	}

	/**
	 * The fullscreen session frame (before layers): the transcript window over the dock pinned to the
	 * bottom row. The window follows the tail, or starts at {@link #anchor} (clamped to the
	 * transcript; one that reaches the tail follows it again) with a row counting what is below it.
	 */
	#composeSession(
		screenWidth: number,
		height: number,
		hits: { hit: Hit; top: number; left: number }[],
		wheel: boolean,
	): { rows: string[]; cursor: Cell | null } {
		let cursor: Cell | null = null;
		const search = this.#search;
		const dock: Placed[] = [];
		let dockRows = search ? 1 : 0;
		for (const block of search ? [] : this.#paintDock(screenWidth, height)) {
			// Inline dock painters include breathing room between the ledger and controls.
			// On the fixed screen give leading, purely decorative blank rows back to the transcript.
			let skip = 0;
			if (!dockRows && block.rows[0] === "" && !block.covering && !block.rows.some(holdsImage)) {
				while (
					block.rows[skip] === "" &&
					block.cursor?.row !== skip &&
					!block.hits?.some(hit => hit.row <= skip && skip < hit.row + hit.height)
				)
					skip++;
			}
			dock.push({ block, top: dockRows - skip, left: 0 });
			dockRows += block.rows.length - skip;
		}
		const room = Math.max(0, height - dockRows);
		const main = this.#surface.main();
		const lane = screenWidth > 1 && (this.#options.scrollbar?.() ?? true);
		const width = lane ? screenWidth - 1 : screenWidth;
		const doc = this.#document(width);
		const size = (i: number): number => doc.entry(main[i]!)?.size ?? 0;

		if (search) {
			this.#anchor = search.reveal(main, i => this.#paint(main[i]!, width).rows, size, this.#anchor, room);
		}

		const maxTop = Math.max(0, doc.rows - room);
		const anchored = this.#anchor && doc.entry(this.#anchor.node);
		const offset =
			room && anchored ? Math.min(maxTop, anchored.top + Math.min(this.#anchor!.row, anchored.size - 1)) : maxTop;
		const first = doc.at(offset);
		const index = first?.index ?? main.length;
		const skip = first ? offset - first.top : 0;
		const below = offset < maxTop ? maxTop - offset + 1 : 0; // The indicator replaces the last content row.
		this.#anchor = below && first ? { node: first.node, row: skip } : undefined;

		// The window: entry rows from the top down, the indicator taking its last row while anchored.
		const indicator = below > 0 && !lane && room > 1;
		const content = indicator ? room - 1 : room;
		const window: string[] = [];
		for (let i = index; i < main.length && window.length < content; i++) {
			const rows = size(i);
			if (rows === 0) continue;
			const node = main[i]!;
			const block = this.#paint(node, width);
			const lead = rows - block.rows.length;
			// Window row of the block's first row (negative: cut above the window).
			const top = window.length + lead - (i === index ? skip : 0);
			for (let r = i === index ? skip : 0; r < rows && window.length < content; r++) {
				const raw = r < lead ? "" : block.rows[r - lead]!;
				window.push(search ? search.highlight(node, r, raw) : raw);
			}
			if (this.#options.images) {
				const from = Math.max(0, -top);
				const to = Math.min(block.rows.length, content - top);
				clipViewportImages(window, top + from, block.rows, from, to, this.#options.images.cell().h);
			}
			if (block.cursor && this.#surface.focused()) {
				const row = top + block.cursor.row;
				if (row >= 0 && row < window.length) cursor = { row, col: block.cursor.col };
			}
			for (const hit of block.hits ?? []) {
				if (top + hit.row >= 0 && top + hit.row + hit.height <= window.length) hits.push({ hit, top, left: 0 });
			}
		}
		dropCutImages(window, 0);
		if (indicator) {
			const theme = this.#options.theme();
			window.push(truncate(theme.fg("dim", `↓ ${below} ${below === 1 ? "line" : "lines"} below`), width, ""));
		}
		while (window.length < room) window.push("");
		this.#window = {
			top: index < main.length ? { node: main[index]!, row: skip } : undefined,
			rows: room,
			width,
			wheel,
		};

		this.#sessionPointer().update(
			{
				doc,
				top: offset,
				rows: room,
				content: Math.min(content, doc.rows - offset),
				width,
				scrollbar: lane && room > 0 && doc.rows > room,
			},
			window,
			this.#options.theme(),
		);
		const rows = window;
		if (search) {
			const bar = search.bar(this.#driver.columns, room);
			rows.push(bar.text);
			return { rows, cursor: { row: room, col: bar.col } };
		}
		const dockTop = rows.length;
		for (const placed of dock) {
			for (let row = Math.max(0, -placed.top); row < placed.block.rows.length; row++)
				rows.push(placed.block.rows[row]!);
			if (placed.block.cursor)
				cursor = { row: dockTop + placed.top + placed.block.cursor.row, col: placed.block.cursor.col };
			for (const hit of placed.block.hits ?? []) hits.push({ hit, top: dockTop + placed.top, left: 0 });
		}
		// A dock taller than the screen keeps its bottom rows (the editor).
		const over = rows.length - height;
		if (over > 0) {
			rows.splice(0, over);
			dropCutImages(rows, 0);
			if (cursor) cursor = cursor.row >= over ? { row: cursor.row - over, col: cursor.col } : null;
			for (const entry of hits) entry.top -= over;
		}
		return { rows, cursor };
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
		this.#routeInput(event, false);
	}

	#routeInput(event: InputEvent, intercept: boolean): void {
		if (!this.#running && this.#options.screen?.() === "fullscreen") return;
		if (event.type === "focus") {
			// A focus-in can arrive over a page or during a live screen-mode switch.
			this.#pointerFocused = event.focused;
			if (!event.focused && this.#window) this.clearHover();
		} else if (
			event.type === "mouse" &&
			this.#window &&
			(!this.#pointerFocused || this.#options.screen?.() !== "fullscreen")
		)
			return;
		if (!this.#searchInput(event) && !(intercept && this.#options.intercept?.(event))) this.#onInput(event);
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
		const pointer =
			this.#window?.wheel && (!this.#hitLayer?.length || this.#searchable()) ? this.#pointer : undefined;
		if (pointer?.capture(mouse, viewportRow)) return;
		const cover =
			pointer &&
			this.#pointerCovers.findLast(
				rect =>
					viewportRow >= rect.top && viewportRow < rect.bottom && mouse.col >= rect.left && mouse.col < rect.right,
			);
		const firstHit = cover ? cover.firstHit : 0;
		this.#trackHover(viewportRow, mouse.col, firstHit);
		for (let i = this.#hits.length - 1; i >= firstHit; i--) {
			const { hit, top, left } = this.#hits[i]!;
			const row = viewportRow - top - hit.row;
			const col = mouse.col - left - hit.col;
			if (row < 0 || col < 0 || row >= hit.height || col >= hit.width) continue;
			const path = pathTo(this.#regions(), hit.node);
			if (path.length === 0) continue;
			const widget = widgetFor(hit.node);
			if (widget?.mouse?.(hit.node, mouse, { row, col }, this.#widgetContext(path), hit)) {
				if (mouse.action === "press" && mouse.button === "left") pointer?.reset();
				return;
			}
			if (mouse.action === "press" && mouse.button === "left" && hit.act) {
				pointer?.reset();
				bubbleEvent(path, { type: "action", key: keypathOf(path), act: hit.act, mods: mouse.mods });
				return;
			}
			if (mouse.action === "press" && mouse.button === "left" && hit.item !== undefined) {
				pointer?.reset();
				bubbleEvent(path, { type: "select", key: keypathOf(path), item: hit.item });
				return;
			}
		}
		if (pointer && !cover) {
			pointer.input(mouse, viewportRow);
		}
	}

	/** Point the hover state at the topmost hit under the pointer (painters band it via `cx.hovered`). */
	#trackHover(viewportRow: number, column: number, firstHit: number): void {
		let next: PointerHover | null = null;
		for (let i = this.#hits.length - 1; i >= firstHit; i--) {
			const { hit, top, left } = this.#hits[i]!;
			const row = viewportRow - top - hit.row;
			const col = column - left - hit.col;
			if (row < 0 || col < 0 || row >= hit.height || col >= hit.width) continue;
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
		if (this.#pointer?.blur()) this.requestRender();
		if (this.#hover.peek() !== null) this.#hover.set(null);
	}

	/** The paint environment (for previews rendering through the same caches). */
	get environment(): PaintEnvironment {
		return this.#env;
	}

	/** Whether any `main` rows reached terminal history (committed blocks or a streaming head). */
	get wroteHistory(): boolean {
		return this.#committed.size > 0 || this.#emitted.size > 0;
	}

	/** Whether a fullscreen transcript window is on screen and follows the tail (false while scrolled back). */
	get following(): boolean {
		return this.#window !== undefined && this.#anchor === undefined;
	}
}
