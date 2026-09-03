/**
 * Minimal TUI implementation with explicit history batches.
 *
 * Two output channels: a product-owned {@link TerminalFrameProvider} returns,
 * per frame, an optional immutable {@link HistoryBatch} (finalized or naturally
 * emitted stable rows, or one complete replay, gated by a monotonic id and
 * acknowledgement) plus the complete mutable viewport. The writer anchors the
 * viewport directly below whatever history remains visible, diffs
 * viewport-only frames, and never infers finality from a row's position.
 * Destructive clears (ED3) happen through explicit user gestures or configured
 * settled-width rebuilds. Hosts without a
 * provider paint their composed children as a bounded viewport and never
 * touch history. See `docs/tui-core-renderer.md`.
 */
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { $flag, getDebugLogPath, logger, postmortem } from "@oh-my-pi/pi-utils";
import { DEFAULT_MAX_INLINE_IMAGES, ImageBudget } from "./components/image";
import { TuiDebugServer } from "./debug-server";
import { isKeyRelease, matchesKey } from "./keys";
import { LoopWatchdog } from "./loop-watchdog";
import { STDOUT_BACKLOG_CLEAR_BYTES, setAltScreenActive, type Terminal } from "./terminal";
import {
	encodeKittyDeleteAllImages,
	encodeKittyDeleteImage,
	encodeKittyPlacementLine,
	ImageProtocol,
	isImageProtocolForced,
	isInsideHerdr,
	isInsideTerminalMultiplexer,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	setTerminalImageProtocol,
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
	TERMINAL,
} from "./terminal-capabilities";
import {
	Ellipsis,
	extractSegments,
	isOsc66Line,
	normalizeTerminalOutput,
	osc66MaxScale,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "./utils";

const SEGMENT_RESET = "\x1b[0m";
/**
 * Per-line terminator written after every non-image content row. It closes both
 * SGR state and any in-flight OSC 8 hyperlink so styles/links cannot bleed
 * across lines in scrollback. Kept out of the diff/width cache because reset
 * bytes are deterministic write framing, not content.
 */
const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
const ERASE_LINE = "\x1b[2K";
const ERASE_TO_END_OF_LINE = "\x1b[K";
// Keep the common short-row path out of native width/truncation. Longer rows
// are fit by visible cells, not source code units, so zero-width-heavy prefixes
// cannot hide visible suffix text that still belongs in the viewport.
const LINE_FIT_MIN_SOURCE_CODE_UNITS = 4096;
const LINE_FIT_MAX_SOURCE_CODE_UNITS = 65536;
const LINE_FIT_SOURCE_WIDTH_MULTIPLIER = 64;
// Hide the hardware cursor before each paint/move write. Ghostty-style bar
// cursors can otherwise leave visual afterimages while the TUI repaints the
// row under a visible cursor. Paint writes also disable terminal autowrap:
// several terminals keep a "pending wrap" flag after an exact-width row, so a
// following cursor move can first wrap to the next row and produce staircase
// trails. The TUI emits explicit CRLFs and restores autowrap before leaving the
// paint. Synchronized output can be disabled for terminals with broken DEC 2026
// implementations; autowrap discipline stays on either way.
const HIDE_CURSOR = "\x1b[?25l";
const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const PAINT_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`;
const PAINT_END = `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}`;
const PAINT_BEGIN_NO_SYNC = `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
const PAINT_END_NO_SYNC = ENABLE_AUTOWRAP;
// Mouse reporting is scoped to fullscreen overlays that opt into pointer
// interaction. 1000h = button click tracking, 1003h = any-motion tracking for
// hover targets, and 1006h = SGR extended coordinates past column/row 223.
// Selection-first overlays leave these modes disabled so the terminal retains
// native text selection.
const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type StartListener = () => void;

export interface RenderTimer {
	cancel(): void;
}

export interface RenderScheduler {
	now(): number;
	scheduleImmediate(callback: () => void): void;
	scheduleRender(callback: () => void, delayMs: number): RenderTimer;
}

export interface TUIOptions {
	renderScheduler?: RenderScheduler;
}
/** Physical terminal dimensions supplied to a frame provider. */
export interface ViewportSize {
	readonly columns: number;
	readonly rows: number;
}

/** Immutable append or complete replay offered until the terminal accepts this identifier. */
export interface HistoryBatch {
	readonly id: number;
	readonly rows: readonly string[];
	/**
	 * `append` (the default) adds finalized or naturally emitted rows. `replay`
	 * is the complete logical ledger; the writer bottom-splits it against the
	 * leading blank viewport and serializes the remainder plus final viewport in
	 * one synchronous terminal write.
	 */
	readonly kind?: "append" | "replay";
}

/** One history append or complete replay plus the mutable viewport for a terminal frame. */
export interface TerminalFramePlan {
	readonly history?: HistoryBatch;
	readonly viewport: readonly string[];
}

/** Produces bounded terminal frames and retires acknowledged history batches. */
export interface TerminalFrameProvider {
	renderFrame(viewport: ViewportSize): TerminalFramePlan;
	acknowledgeHistory(id: number): void;
	/** Full semantic viewport used only on the transient resize buffer. */
	renderResizeFrame?(viewport: ViewportSize): readonly string[];
	/** Re-offer finalized history after a display reset or resize replay. */
	beginHistoryReplay?(): void;
	/** Force every currently eligible finalized prefix to retire before stop. */
	beginHistoryFlush?(): void;
}

export interface TUIStartOptions {
	/** Clear saved native scrollback before the first paint. */
	clearScrollback?: boolean;
	/**
	 * Paint without owning stdin: the terminal stays in cooked mode (kernel
	 * echo + line editing at the hardware cursor) until {@link TUI.enableInput}
	 * switches to raw input and replays the kernel-buffered keystrokes.
	 */
	deferInput?: boolean;
}

const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => {
		setImmediate(callback);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return {
			cancel: () => {
				clearTimeout(timer);
			},
		};
	},
};

/**
 * Component interface - all components must implement this
 *
 * Render contract: the returned array (and its rows) belongs to the component.
 * Callers MUST NOT mutate it — components are allowed to return a cached array
 * and will return the exact same reference for as long as their rendered
 * content is unchanged. Conversely, a component MUST return a fresh array
 * reference whenever its content changed; reference equality across two
 * render() calls is the engine's proof that the rows are byte-identical
 * (containers memoize their concatenation on it, and the TUI derives the
 * frame's stable prefix from it). A component that mutates a previously
 * returned array in place must implement {@link RenderStablePrefix} to declare
 * which leading rows survived.
 */
export interface Component {
	/** Stable identifier surfaced in the debug tree as kind#id. */
	debugId?: string;
	/** Override for the tree node kind (default: constructor.name). */
	debugKind?: string;
	/** Widget state for the debug `values`/`tree` ops. JSON-serializable. */
	debugState?(): Record<string, unknown>;
	/** Children for the debug tree when not already exposed as a public `children` array. */
	debugChildren?: readonly Component[];

	/**
	 * Render the component to an array of physical rows at the given width.
	 * The result is component-owned and `readonly` to the caller; an unchanged
	 * component may (and should) return the same array reference it returned
	 * last time.
	 */
	render(width: number): readonly string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Optional hook to invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate?(): void;
	/**
	 * Optional hook to set whether this component ignores tight layout mode.
	 */
	setIgnoreTight?(ignore: boolean): any;

	/**
	 * Optional teardown. Called when the component is permanently removed from
	 * the live tree (e.g. a transcript reset). Release timers, intervals, and
	 * subscriptions here. Must be idempotent. Containers propagate dispose to
	 * their children; leaf components without resources may omit it.
	 */
	dispose?(): void;
}

/** Lets an overlay root delegate keyboard focus to components it owns. */
export interface OverlayFocusOwner {
	/** Returns true when `component` is a focus target inside this overlay. */
	ownsOverlayFocusTarget(component: Component): boolean;
}

function isOverlayFocusTarget(owner: Component, component: Component | null): boolean {
	if (component === owner) return true;
	if (!component) return false;
	const candidate = owner as Component & Partial<OverlayFocusOwner>;
	return candidate.ownsOverlayFocusTarget?.(component) === true;
}

/**
 * Interface for components that can receive focus and display a cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 *
 * Components that can switch between terminal-cursor and software-cursor
 * rendering expose `setUseTerminalCursor`; TUI keeps that mode in sync with
 * its resolved hardware-cursor preference whenever focus or the preference
 * changes.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
	/** Set by TUI when hardware cursor rendering is enabled or disabled. */
	setUseTerminalCursor?(useTerminalCursor: boolean): void;
}

/** Options for scheduling a TUI render. */
export interface RenderRequestOptions {
	/** Clear terminal scrollback for intentional transcript replacement. */
	clearScrollback?: boolean;
}
/**
 * Controls how a settled terminal resize refreshes native history.
 *
 * `append` replays the current transcript below retained history, `rebuild`
 * clears history before replaying it, and `preserve` repaints only the viewport.
 */
export type ResizeScrollbackMode = "append" | "rebuild" | "preserve";

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;

	// === Fullscreen ===
	/**
	 * Borrow the terminal's alternate screen buffer for this overlay's lifetime
	 * (vim/less idiom). While the topmost visible overlay sets this, the engine
	 * paints only the modal on the alt screen and emits no ED3 / scrollback
	 * bytes, so the transcript on the normal screen stays untouched and is not
	 * scrollable behind the modal. Defaults off — all other overlays are
	 * unchanged and still draw over the transcript on the normal screen.
	 */
	fullscreen?: boolean;
	/**
	 * Enable terminal mouse reporting while fullscreen. Defaults on; disable it
	 * when native terminal text selection takes precedence over pointer events.
	 */
	mouseTracking?: boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	// Memoized concatenation of the children's latest renders. Children are
	// still rendered every frame (renders carry side effects: image placement
	// registration); the memo only skips rebuilding the concatenated array when
	// every child returned the exact same array reference at the same width —
	// which, per the Component render contract, proves the rows are
	// byte-identical. Cleared on any child-list change and on invalidate().
	#memoLines: string[] | undefined;
	#memoChildLines: (readonly string[])[] = [];
	#memoWidth = -1;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		for (const child of this.children) {
			child.setIgnoreTight?.(ignore);
		}
		this.invalidate();
		return this;
	}

	addChild(component: Component): void {
		this.children.push(component);
		if (this.#ignoreTight) {
			component.setIgnoreTight?.(true);
		}
		this.#memoLines = undefined;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#memoLines = undefined;
		}
	}

	clear(): void {
		this.children = [];
		this.#memoLines = undefined;
	}

	/** Dispose every child, then detach it from this container. */
	disposeChildren(): void {
		this.dispose();
		this.clear();
	}

	invalidate(): void {
		this.#memoLines = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/**
	 * Propagate teardown to children. Call when the container's children are
	 * being permanently discarded (not when they are detached for reuse — use
	 * {@link clear} for that). Idempotent per child via each child's own dispose.
	 */
	dispose(): void {
		for (const child of this.children) {
			child.dispose?.();
		}
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const children = this.children;
		const count = children.length;
		let refs = this.#memoChildLines;
		let unchanged = this.#memoLines !== undefined && this.#memoWidth === width && refs.length === count;
		if (refs.length !== count) {
			// oxlint-disable-next-line unicorn/no-new-array -- render-frame length preallocation
			refs = new Array(count);
			this.#memoChildLines = refs;
		}
		for (let i = 0; i < count; i++) {
			const childLines = children[i]!.render(width);
			if (refs[i] !== childLines) {
				unchanged = false;
				refs[i] = childLines;
			}
		}
		this.#memoWidth = width;
		if (unchanged) return this.#memoLines!;
		const lines: string[] = [];
		for (let i = 0; i < count; i++) {
			const childLines = refs[i]!;
			for (let j = 0; j < childLines.length; j++) lines.push(childLines[j]!);
		}
		this.#memoLines = lines;
		return lines;
	}
}

interface HardwareCursorState {
	row: number;
	col: number;
	visible: boolean;
}

interface PreparedLine {
	raw: string;
	width: number;
	line: string;
}

// SGR coalescing. The renderer's component tree emits a styled span as
// `<set-color>text<reset>`, so adjacent spans produce runs of byte-adjacent
// SGR sequences (e.g. a `CSI 39 m` fg-reset immediately followed by the next
// span's `CSI 38;2;r;g;b m`). Two byte-adjacent SGR sequences are semantically
// identical to one SGR carrying both parameter lists (SGR params apply
// left-to-right), so merging the run into a single `CSI … m` is
// behavior-preserving: it drops the redundant `ESC[`/`m` framing and lets the
// terminal dispatch one SGR instead of several. On a real transcript ~40% of
// all SGR sequences are collapsible this way, which meaningfully cuts the
// per-frame byte volume and SGR-dispatch count a slow (xterm.js/WebGL) terminal
// must process. On by default; `PI_NO_SGR_COALESCE=1` disables it.
const SGR_COALESCE_ENABLED = !$flag("PI_NO_SGR_COALESCE");
const CC_ESC = 0x1b;
const CC_BRACKET = 0x5b; // [
const CC_M = 0x6d; // m
const CC_SEMI = 0x3b; // ;
const CC_COLON = 0x3a; // :
// Max parameter tokens per emitted merged SGR. Kept well under xterm.js's
// 32-param cap (and the tighter limits of some real terminals) so a long
// adjacent run is split into several valid CSIs instead of overflowing one.
const MERGE_TOKEN_CAP = 16;

function isSgrParamByte(c: number): boolean {
	return (c >= 0x30 && c <= 0x39) || c === CC_SEMI || c === CC_COLON;
}

// True when a parameter list ends mid extended-color spec in the ambiguous
// semicolon form: `38/48/58;2` with fewer than three channel values, or
// `38/48/58;5` with no palette index. Concatenating another list after such a
// run would let the next code be absorbed as the missing channel/index (e.g.
// `38;2;255;0` + `31` → `38;2;255;0;31`, where `31` becomes blue instead of a
// standalone fg-red), changing the rendered color. The self-delimiting colon
// form (`38:2::r:g:b`) is unambiguous — its tokens never equal a bare `38`, so
// the scan treats it as a complete unit and merging stays safe.
function endsWithIncompleteExtendedColor(params: string): boolean {
	const t = params.split(";");
	let i = 0;
	while (i < t.length) {
		const tok = t[i];
		if (tok === "38" || tok === "48" || tok === "58") {
			const mode = t[i + 1];
			if (mode === undefined) return true; // introducer with no mode
			if (mode === "2") {
				if (i + 4 >= t.length) return true; // missing r/g/b
				i += 5;
				continue;
			}
			if (mode === "5") {
				if (i + 2 >= t.length) return true; // missing index
				i += 3;
				continue;
			}
		}
		i += 1;
	}
	return false;
}

/**
 * Merge runs of byte-adjacent SGR sequences (`CSI [0-9;:]* m`) into one. Only
 * CSI-SGR sequences are touched; text, cursor moves, OSC, hyperlinks and image
 * payloads pass through verbatim. Returns the original reference when nothing
 * merges, so SGR-light lines incur only a single `indexOf` scan.
 */
export function coalesceAdjacentSgr(line: string): string {
	if (!SGR_COALESCE_ENABLED || line.indexOf("\x1b[") === -1) return line;
	const n = line.length;
	let out = "";
	let copiedUpto = 0;
	let i = 0;
	while (i < n) {
		if (line.charCodeAt(i) !== CC_ESC || line.charCodeAt(i + 1) !== CC_BRACKET) {
			i++;
			continue;
		}
		// Scan a candidate SGR sequence: ESC [ <params> m.
		let j = i + 2;
		while (j < n && isSgrParamByte(line.charCodeAt(j))) j++;
		if (j >= n || line.charCodeAt(j) !== CC_M) {
			// Not an SGR (e.g. cursor move); leave it in the pending region.
			i = j;
			continue;
		}
		// Collect the run of adjacent SGR sequences starting here.
		const params: string[] = [line.slice(i + 2, j)];
		let k = j + 1;
		while (k < n && line.charCodeAt(k) === CC_ESC && line.charCodeAt(k + 1) === CC_BRACKET) {
			let p = k + 2;
			while (p < n && isSgrParamByte(line.charCodeAt(p))) p++;
			if (p >= n || line.charCodeAt(p) !== CC_M) break;
			params.push(line.slice(k + 2, p));
			k = p + 1;
		}
		if (params.length > 1) {
			out += line.slice(copiedUpto, i);
			// Emit the merged run, but flush the current group before appending a
			// list when (a) the previous list ended mid extended-color, so the
			// next code cannot be absorbed as its missing channel/index, or (b)
			// the token count would exceed MERGE_TOKEN_CAP. SGR params apply
			// left-to-right regardless of how they are grouped across adjacent
			// CSIs, so a capped/guarded split stays behavior-preserving — while a
			// single unbounded merge would overflow a terminal's CSI parameter
			// buffer (xterm.js caps at 32 and silently truncates the rest,
			// corrupting colors). Empty params (`CSI m`) mean a full reset;
			// normalize to `0` so the merged list stays unambiguous.
			let group = "";
			let groupTokens = 0;
			let groupOpenSafe = true;
			for (let q = 0; q < params.length; q++) {
				const norm = params[q]!.length === 0 ? "0" : params[q]!;
				let tk = 1;
				for (let z = 0; z < norm.length; z++) {
					const cc = norm.charCodeAt(z);
					if (cc === CC_SEMI || cc === CC_COLON) tk++;
				}
				if (groupTokens > 0 && (!groupOpenSafe || groupTokens + tk > MERGE_TOKEN_CAP)) {
					out += `\x1b[${group}m`;
					group = "";
					groupTokens = 0;
				}
				group += group.length === 0 ? norm : `;${norm}`;
				groupTokens += tk;
				groupOpenSafe = !endsWithIncompleteExtendedColor(norm);
			}
			if (group.length > 0) out += `\x1b[${group}m`;
			copiedUpto = k;
		}
		i = k;
	}
	if (copiedUpto === 0) return line;
	return out + line.slice(copiedUpto);
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	terminal: Terminal;
	#frameProvider: TerminalFrameProvider | undefined;
	#acceptedHistoryBatchId = 0;
	// Screen row where the provider's mutable viewport begins (0-based); rows
	// above it hold history still visible on the physical screen.
	#providerViewportTop = 0;
	// Viewport-relative row of the hardware cursor after the last normal paint
	// (0 = parked at the viewport top). A resize reflows the normal buffer
	// before the app hears about it; terminals keep the cursor attached to its
	// logical line through rewrap, so a DSR round trip against this parked
	// cursor recovers the reflowed viewport anchor (see #resolveResizeAnchor).
	#parkedViewportOffset = 0;
	// In-flight post-resize anchor probe: the stale viewport snapshot and park
	// offset captured when CSI 6n was written, plus the no-reply fallback timer.
	#resizeProbe:
		| {
				window: readonly string[];
				offset: number;
				timer: RenderTimer;
				epoch: number;
				retried: boolean;
		  }
		| undefined;
	// Pre-erase viewport snapshot for the settled resize-anchor probe: the erase
	// in #beginResizeAltPaint empties #providerWindow, so the probe must bound
	// the anchor with the window that was actually on screen when the resize
	// began (see #resolveResizeAnchor's `height - staleRows` clamp).
	#resizeProbeWindow: readonly string[] = [];
	#resizeProbeOffset = 0;
	// Direction tracking for the current coalesced resize burst (reset when a
	// plan frame commits, alongside #previousHeight). A burst containing any
	// height grow invalidates the multiplexer clip model in
	// #resolveResizeAnchor: the grow pulls scrollback into the pane and moves
	// the parked logical row, so the net shrink no longer telescopes from
	// pre-burst state.
	#resizeBurstGrew = false;
	#resizeBurstLastHeight: number | undefined;
	// Sum of every grow step in the burst: bounds how much scrollback a
	// multiplexer can have pulled down across the whole burst, including a
	// shrink-then-regrow that never exceeds the pre-burst height (see the
	// CPR-timeout fallback in #resolveResizeAnchor).
	#resizeBurstPull = 0;
	// Geometry epoch: bumped on every resize transaction entry, so each CSI 6n
	// request records the geometry it was parked under.
	#geometryEpoch = 0;
	// CPR attribution: each request parks a distinct column (CHA) before its
	// CSI 6n; the terminal processes requests serially, so every reply carries
	// its own request's column. That makes attribution exact even when replies
	// are dropped or arbitrarily delayed — anonymous FIFO counting cannot
	// survive drops (forgetting retired requests eagerly misattributes late
	// replies, remembering them forever poisons later probes with phantoms,
	// and age expiry is unsound because replies carry no lifetime guarantee).
	// A rewrap can only invalidate a reply's row via a width-change SIGWINCH,
	// which bumps the geometry epoch and discards the reply anyway, so the
	// scheme is sound on direct terminals too. Tags are never expired; a late
	// reply to a dead tag is stripped and discarded by column.
	#cprColumnTags = new Map<number, number>();
	#cprProbeSeq = 0;
	// Prepared rows painted by the previous provider frame, for row diffing.
	#providerWindow: string[] = [];
	#previousFrameLength = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#focusedComponent: Component | null = null;
	#debugServer: TuiDebugServer | undefined;
	#debugPaint:
		| {
				lines: readonly string[];
				windowTop: number;
				altScreen: boolean;
				cursor?: { x: number; y: number; visible?: boolean };
		  }
		| undefined;
	#debugNextWindowTop = 0;
	#inputListeners = new Set<InputListener>();
	#startListeners = new Set<StartListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	onDebug?: () => void;
	#renderRequested = false;
	#renderTimer: RenderTimer | undefined;
	#renderScheduler: RenderScheduler;
	#lastRenderAt = 0;
	/**
	 * Wall-clock cost of the most recent `#doRender()` call. Used by
	 * `#scheduleRender` to inflate the next render delay proportionally so a
	 * spike of slow frames (large transcript diffs, huge assistant text wrap,
	 * component-tree walks) does not busy-loop the CPU: the throttle would
	 * otherwise collapse to zero once `elapsed >= MIN_RENDER_INTERVAL_MS` and
	 * fire the next frame immediately (see #4145).
	 */
	#lastFrameCostMs = 0;
	static readonly #MIN_RENDER_INTERVAL_MS = 1000 / 30;
	static readonly #INPUT_RENDER_GRACE_MS = TUI.#MIN_RENDER_INTERVAL_MS;
	/**
	 * Cap on the adaptive floor derived from `#lastFrameCostMs`. Bounds the UI
	 * responsiveness at ~5 fps under sustained heavy renders — anything slower
	 * feels dead to the user and no longer justifies further CPU savings.
	 */
	static readonly #MAX_ADAPTIVE_RENDER_MS = 200;
	/**
	 * Output backpressure gate. While the terminal still owes more than this
	 * many bytes, composing another frame would only queue a stale paint
	 * behind the backlog — and once the kernel PTY buffer is full, handing the
	 * runtime more bytes degrades into thread-blocking writes. Defer the
	 * render (keeping its forced/clear-scrollback intent) and retry shortly;
	 * the eventual frame composes the latest component state, so a slow
	 * terminal receives only fresh frames instead of every intermediate one.
	 *
	 * This is the terminal's healthy-backlog level ({@link STDOUT_BACKLOG_CLEAR_BYTES}):
	 * gating here and ending a StdoutStallWatchdog episode there keeps the stall
	 * watchdog armed across exactly the range where frames are deferred (#10434).
	 */
	static readonly #MAX_PENDING_OUTPUT_BYTES = STDOUT_BACKLOG_CLEAR_BYTES;
	/** Retry cadence while the output backlog gate is holding renders back. */
	static readonly #OUTPUT_BACKLOG_RETRY_MS = 10;
	/** Quiet window before restoring the normal buffer after resize. */
	static readonly #RESIZE_VIEWPORT_SETTLE_MS = 120;
	/** Longest wait for a CPR reply before the settled repaint falls back. */
	static readonly #RESIZE_PROBE_TIMEOUT_MS = 200;
	#inputRenderGraceUntilMs = 0;
	// A scale-`s` OSC 66 heading reserves `s - 1` rows, and the protocol
	// caps `s` at 7. This bounds spacer lookups and supplies enough context
	// above the resize viewport to classify every legal heading exactly.
	static readonly #OSC66_MAX_SPACER_ROWS = 6;
	// Ghostty can drop Kitty graphics commands sent during its first post-startup
	// settle window, leaving only Unicode placeholder cells. Hold the first image
	// paint until that window has passed; later images render normally.
	static readonly #GHOSTTY_INITIAL_IMAGE_DELAY_MS = 100;
	#hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	#hardwareCursorState: HardwareCursorState | null = null;
	#sixelProbePendingGraphics = false;
	#sixelProbeBuffer = "";
	#sixelProbeTimeout?: NodeJS.Timeout;
	#sixelProbeUnsubscribe?: () => void;
	#showHardwareCursor = $flag("PI_HARDWARE_CURSOR");
	#synchronizedOutputEnabled = shouldEnableSynchronizedOutputByDefault();
	#paintBeginSequence = this.#synchronizedOutputEnabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
	#paintEndSequence = this.#synchronizedOutputEnabled ? PAINT_END : PAINT_END_NO_SYNC;

	#fullRedrawCount = 0;
	// Caps how many inline images render as live graphics; older ones fall back
	// to text via a purge + full redraw. Cap is configured by the host app.
	#imageBudget = new ImageBudget(DEFAULT_MAX_INLINE_IMAGES, () => this.requestRender());
	#ghosttyInitialImageDelayDone = false;
	#ghosttyInitialImageDelayTimer: RenderTimer | undefined;
	#ghosttyImageReadyAtMs = 0;
	#clearScrollbackOnNextRender = false;
	// Consumed by the next frame: a user-driven redraw gesture (resetDisplay,
	// requestRender(true)) that must rewrite the viewport even when the diff
	// believes nothing changed.
	#forceViewportRepaintOnNextRender = false;
	#hasEverRendered = false;
	#stopped = false;
	#cancelPostmortemRestore?: () => void;
	/** True between a `deferInput` start() and enableInput(). */
	#inputDeferred = false;
	// Always-on event-loop lag probe. The high default threshold keeps it quiet;
	// it only logs `ui.loop-blocked` (with the current loop phase) when a frame
	// budget is genuinely starved. Armed in start(), disarmed in stop().
	#watchdog: LoopWatchdog;

	// Transient alternate-screen state for a fullscreen overlay. While active, the
	// engine paints only the modal on the alt buffer and leaves every
	// normal-screen accounting field (#previousFrameLength, #viewportTopRow, …)
	// untouched, so exiting reconciles cleanly against the terminal-restored
	// normal screen. #altPreviousLines is the last alt frame, for repaint-skip.
	#altActive = false;
	#altMouseTrackingActive = false;
	#altPreviousLines: string[] = [];
	#altEnterWidth = 0;
	#altEnterHeight = 0;
	#resizeAltActive = false;
	#resizeSettleTimer: RenderTimer | undefined;
	#suppressResizeUntil = 0;
	#resizeScrollbackMode: ResizeScrollbackMode = TUI.#initialResizeScrollbackMode();
	#resizeReplaySize: string | undefined;
	// Holds an alternate-screen exit until its replacement full paint can emit it
	// atomically. It must survive a deferred Ghostty image frame.
	#pendingAltExit = "";

	// Overlay stack for modal components rendered on top of base content
	overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options?: TUIOptions) {
		super();
		this.terminal = terminal;
		this.#renderScheduler = options?.renderScheduler ?? DEFAULT_RENDER_SCHEDULER;
		this.#showHardwareCursor = showHardwareCursor === undefined ? this.#showHardwareCursor : showHardwareCursor;
		this.#watchdog = new LoopWatchdog();
	}
	static #initialResizeScrollbackMode(): ResizeScrollbackMode {
		const mode = Bun.env.PI_TUI_RESIZE_SCROLLBACK;
		return mode === "append" || mode === "rebuild" || mode === "preserve" ? mode : "preserve";
	}

	/** Install the product-owned bounded frame provider. */
	setFrameProvider(provider: TerminalFrameProvider | undefined): void {
		this.#frameProvider = provider;
		this.#providerWindow = [];
		this.#resizeReplaySize = undefined;
		this.requestRender(true);
	}

	#syncTerminalCursorMode(component: Component | null): void {
		if (isFocusable(component)) {
			component.setUseTerminalCursor?.(this.#showHardwareCursor);
		}
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	/** Shared budget that caps how many inline images render as live graphics. */
	get imageBudget(): ImageBudget {
		return this.#imageBudget;
	}

	/**
	 * Set how many inline images stay live graphics before older ones fall back
	 * to text (`0` disables the cap). Older images are hidden via a graphics purge
	 * plus a full redraw on the frame after a new image exceeds the cap.
	 */
	setMaxInlineImages(cap: number): void {
		this.#imageBudget.setCap(cap);
	}
	/** Return how settled resizes refresh native scrollback. */
	getResizeScrollback(): ResizeScrollbackMode {
		return this.#resizeScrollbackMode;
	}

	/** Set how settled resizes refresh native scrollback. */
	setResizeScrollback(mode: ResizeScrollbackMode): void {
		this.#resizeScrollbackMode = mode;
	}

	/** Delete every tracked Kitty image from the terminal graphics store. */
	clearInlineImages(): void {
		if (this.#stopped) return;
		this.#purgeInlineImages();
	}

	#purgeInlineImages(): void {
		const transmittedIds = this.#imageBudget.takeAllTransmittedIds();
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const id of transmittedIds) {
			this.terminal.write(encodeKittyDeleteImage(id));
		}
	}

	getShowHardwareCursor(): boolean {
		return this.#showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.#showHardwareCursor === enabled) return;
		this.#showHardwareCursor = enabled;
		this.#syncTerminalCursorMode(this.#focusedComponent);
		if (!enabled) {
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
		}
		this.requestRender();
	}

	/**
	 * Whether DEC 2026 synchronized-output wrappers are currently emitted around
	 * paints. Starts from conservative terminal/env detection and is reconciled at
	 * runtime against the terminal's DECRQM mode-2026 report — enabled on a
	 * positive report, disabled on a negative one.
	 */
	get synchronizedOutput(): boolean {
		return this.#synchronizedOutputEnabled;
	}

	/**
	 * Cost in milliseconds of the most recently completed frame.
	 *
	 * Animation components use this to apply proportional backpressure after
	 * their render request is asynchronously composed and written.
	 */
	get lastFrameCostMs(): number {
		return this.#lastFrameCostMs;
	}

	setFocus(component: Component | null): void {
		const topVisibleOverlay = this.#getTopmostVisibleOverlay();
		if (topVisibleOverlay && !isOverlayFocusTarget(topVisibleOverlay.component, component)) {
			const currentFocus = this.#focusedComponent;
			component = isOverlayFocusTarget(topVisibleOverlay.component, currentFocus)
				? currentFocus
				: topVisibleOverlay.component;
		}

		const previousFocusedComponent = this.#focusedComponent;
		// Clear focused flag on old component
		if (isFocusable(previousFocusedComponent)) {
			previousFocusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		// Set focused flag on new component and keep its software/hardware cursor
		// rendering mode aligned with TUI's single cursor-visibility preference.
		if (isFocusable(component)) {
			component.focused = true;
			this.#syncTerminalCursorMode(component);
		}
	}

	/** Component currently receiving keyboard input, if any. */
	getFocused(): Component | null {
		return this.#focusedComponent;
	}
	/** Last viewport successfully written by the renderer, for debug inspection. */
	getDebugPaint():
		| {
				lines: readonly string[];
				windowTop: number;
				altScreen: boolean;
				cursor?: { x: number; y: number; visible?: boolean };
		  }
		| undefined {
		return this.#debugPaint;
	}

	/** Render the current root document at the live terminal width for debug inspection. */
	getDebugDocument(): readonly string[] {
		return this.render(Math.max(1, this.terminal.columns));
	}

	/** Feed debug and test input through the same pipeline as terminal stdin. */
	injectDebugInput(data: string): void {
		this.#handleInput(data);
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		component.setIgnoreTight?.(true);
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false };
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (this.#isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.#recordHardwareCursorHidden();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay or one of its owned targets had focus
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) {
						this.terminal.hideCursor();
						this.#recordHardwareCursorHidden();
					}
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay or one of its owned targets had focus, move focus to next visible or preFocus
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (this.#isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		// Find topmost visible overlay, or fall back to preFocus
		const topVisible = this.#getTopmostVisibleOverlay();
		this.setFocus(topVisible?.component ?? overlay.preFocus);
		if (this.overlayStack.length === 0) {
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
		}
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some(o => this.#isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	#isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible overlay, if any */
	#getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.#isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(options?: TUIStartOptions): void {
		this.#stopped = false;
		this.#debugPaint = undefined;
		this.#debugServer?.stop();
		this.#debugServer = undefined;
		const debugPath = process.env.OMP_TUI_DEBUG;
		if (debugPath !== undefined && debugPath.length > 0) {
			this.#debugServer = new TuiDebugServer(this, debugPath);
			this.#debugServer.start();
		}
		this.#inputDeferred = options?.deferInput === true;
		this.#watchdog.start();
		this.#ghosttyInitialImageDelayDone = false;
		this.#ghosttyImageReadyAtMs = this.#renderScheduler.now() + TUI.#GHOSTTY_INITIAL_IMAGE_DELAY_MS;
		// A confirmed DECRPM report for mode 2026 is authoritative: enable
		// synchronized output when the terminal reports support and disable it for
		// an explicit unsupported status. A DA1 sentinel without a DECRPM reply is
		// inconclusive: many terminals implement synchronized output without
		// implementing DECRQM, so retain the statically detected default instead of
		// exposing destructive full paints. An explicit user opt-out/force still
		// wins, so skip every probe result in that case.
		this.terminal.onPrivateModeReport?.((mode, supported, confirmed = true, status) => {
			if (mode !== 2026 || !confirmed) return;
			if (synchronizedOutputUserOverride() !== null) return;
			// Herdr's Ghostty VTE honors DEC 2026 even when DECRQM is unanswered or
			// reports unrecognized (status 0). Other confirmed unsupported reports
			// still disable: status 4 is permanently reset, and a three-argument
			// callback (`status` omitted) is a definitive unsupported from a
			// custom Terminal that does not distinguish DECRPM codes.
			if (!supported && isInsideHerdr() && status === 0) return;
			this.#setSynchronizedOutput(supported);
		});
		this.terminal.start(
			data => this.#handleInput(data),
			() => {
				if (this.#resizeProbe) {
					// The anchor being probed is already stale; restart the transaction.
					this.#cancelResizeProbe();
					this.#beginResizeAltPaint(true);
					return;
				}
				if (this.#renderScheduler.now() < this.#suppressResizeUntil) {
					this.requestRender(true);
					return;
				}
				this.#beginResizeAltPaint();
			},
			() => this.stop(),
			{ deferInput: this.#inputDeferred },
		);
		if (this.#stopped) return;
		this.#cancelPostmortemRestore?.();
		this.#cancelPostmortemRestore = postmortem.register("tui-restore", () => this.stop());
		for (const listener of this.#startListeners) {
			try {
				listener();
			} catch {
				// Startup listeners are feature hooks; one broken hook must not prevent rendering.
			}
		}
		this.terminal.hideCursor();
		this.#recordHardwareCursorHidden();
		if (!this.#inputDeferred) {
			this.#querySixelSupport();
			this.#queryCellSize();
		}
		this.requestRender(true, { clearScrollback: options?.clearScrollback === true });
	}
	/**
	 * Borrow the alternate buffer for stable, history-free resize repainting.
	 * `restartingProbe` marks a transaction restarted by a SIGWINCH that
	 * arrived while the settled anchor probe was in flight: the live window
	 * was already stashed and emptied, so the snapshot below must be skipped
	 * to keep the good stash.
	 */
	#beginResizeAltPaint(restartingProbe = false): void {
		if (this.#altActive) {
			this.requestRender(true);
			return;
		}
		const burstLastHeight = this.#resizeBurstLastHeight ?? this.#previousHeight;
		if (this.terminal.rows > burstLastHeight) this.#resizeBurstGrew = true;
		this.#resizeBurstLastHeight = this.terminal.rows;
		this.#resizeBurstPull += Math.max(0, this.terminal.rows - burstLastHeight);
		this.#geometryEpoch++;
		if (!this.#resizeAltActive) {
			this.#resizeAltActive = true;
			setAltScreenActive(true);
			this.#altPreviousLines = [];
			this.#forgetHardwareCursorState();
			this.#recordHardwareCursorHidden();
			// Erase the mutable live viewport from the normal screen before borrowing
			// the alt buffer. The terminal keeps reflowing the normal buffer during
			// the drag, and a height shrink pushes its top rows into scrollback;
			// with the live region blanked, only committed history rows (correct to
			// push) or blanks can leave the screen — never live placeholder rows
			// such as compact tool dots, whose real blocks must enter scrollback
			// through the ordered history path. Addressing depends on the resize
			// direction. Terminals keep the parked cursor attached to its logical
			// line through width rewrap and height-grow scrollback pull-down, so
			// cursor-relative movement lands on the viewport's top row. On height
			// shrink kitty clamps the cursor instead of moving it with pushed rows,
			// so cursor-relative addressing would start rows late; fall back to the
			// same bottom-preserving bound as resize-anchor recovery. The pre-erase
			// window is stashed for the settled CPR probe: its reflowed row count
			// bounds the anchor to `height - staleRows`, so a mis-parked cursor (a
			// single-step tmux zoom re-lays the pane before SIGWINCH delivery,
			// moving the park target under us) cannot anchor the settled repaint
			// over pulled-back history rows or scroll-push the frame into
			// scrollback again.
			let erase = "";
			if (!restartingProbe) {
				this.#resizeProbeWindow = this.#providerWindow;
				this.#resizeProbeOffset = this.#parkedViewportOffset;
			}
			if (this.#hasEverRendered && this.#providerWindow.length > 0 && !isInsideTerminalMultiplexer()) {
				if (this.terminal.rows < this.#previousHeight) {
					const staleRows = this.#reflowedRowCount(
						this.#providerWindow,
						0,
						this.#providerWindow.length,
						this.terminal.columns,
					);
					const top = Math.max(0, Math.min(this.#providerViewportTop, this.terminal.rows - staleRows));
					erase = `\x1b[?25l${this.#eraseBelowRow(top, this.terminal.rows)}`;
				} else {
					const up = this.#reflowedRowCount(
						this.#providerWindow,
						0,
						this.#parkedViewportOffset,
						this.terminal.columns,
					);
					const eraseBelow = this.#eraseBelowCursorRow(this.terminal.columns, this.terminal.rows);
					erase = `\x1b[?25l${up > 0 ? `\x1b[${up}A` : ""}${eraseBelow}`;
				}
				// Both erase paths leave the cursor on the viewport's top row, so the
				// parked offset no longer applies; carrying a stale nonzero offset
				// into the probe would anchor the settled repaint above the real
				// viewport top and overwrite visible committed rows.
				this.#resizeProbeOffset = 0;
				this.#providerWindow = [];
				this.#parkedViewportOffset = 0;
			}
			if (this.#hasEverRendered && this.#providerWindow.length > 0 && isInsideTerminalMultiplexer()) {
				// Multiplexers apply the pane re-layout on their own schedule relative
				// to SIGWINCH delivery, so an immediate erase races it: with the pane
				// already re-laid the stale coordinates blank pulled-back committed
				// rows (destroying popped scrollback), and with the pane not yet
				// re-laid the erase lands on rows about to move. Skip it — the
				// settled repaint overwrites the live region at the clip-model anchor
				// and erases below it, race-free after the quiet window.
				this.#providerWindow = [];
				this.#parkedViewportOffset = 0;
			}
			this.terminal.write(`${erase}\x1b[?1049h${this.#keyboardEnhancementEnter()}`);
		}
		this.#resizeSettleTimer?.cancel();
		this.#resizeSettleTimer = this.#renderScheduler.scheduleRender(() => {
			this.#resizeSettleTimer = undefined;
			if (this.#stopped || !this.#resizeAltActive) return;
			this.#resizeAltActive = false;
			this.#suppressResizeUntil = this.#renderScheduler.now() + 100;
			this.terminal.write(`${this.#keyboardEnhancementExit()}\x1b[?1049l`);
			setAltScreenActive(false);
			this.#altPreviousLines = [];
			this.#beginResizeAnchorProbe();
		}, TUI.#RESIZE_VIEWPORT_SETTLE_MS);
		this.requestRender(true);
	}
	/**
	 * Recover the reflowed viewport anchor after the resize alt-buffer borrow
	 * ends. The terminal reflowed the restored normal buffer during the drag, so
	 * `#providerViewportTop` is in stale grid coordinates; a DSR (CSI 6n) round
	 * trip against the parked cursor reports where the viewport's logical line
	 * landed. The settled repaint waits for the reply (or a short timeout).
	 */
	#beginResizeAnchorProbe(retry = false): void {
		this.#cancelResizeProbe();
		const timer = this.#renderScheduler.scheduleRender(() => {
			const probe = this.#resizeProbe;
			if (probe !== undefined && !probe.retried && (isInsideTerminalMultiplexer() || this.#resizeBurstGrew)) {
				// A CPR-less resolve is heuristic: a grow's pull span is unknown
				// on any terminal, and SIGWINCH coalescing can hide intermediate
				// grows entirely, so even an observed-monotonic multiplexer
				// shrink cannot be modeled with certainty. A dropped DSR reply
				// is a transient race — multiplexers in particular answer DSR
				// themselves — so ask once more before falling back.
				this.#beginResizeAnchorProbe(true);
				return;
			}
			this.#resolveResizeAnchor(undefined);
		}, TUI.#RESIZE_PROBE_TIMEOUT_MS);
		this.#resizeProbe = {
			window: this.#resizeProbeWindow,
			offset: this.#resizeProbeOffset,
			timer,
			epoch: this.#geometryEpoch,
			retried: retry,
		};
		// Tags are never expired by age: a reply has no lifetime guarantee, and
		// freeing a column while its reply may still arrive would let that
		// reply match a newer tag on the reused column. Dead tags only
		// accumulate from genuinely dropped replies; a terminal that drops
		// enough of them to exhaust the span earns the timeout-only fallback.
		// Park a distinct column for this request so its reply is
		// self-identifying, then return the cursor to column 1 immediately:
		// the reply snapshots the column when the terminal processes the CSI
		// 6n, but a cursor RESTING on a nonzero column would reflow onto a
		// later visual row if a direct terminal's width later shrank below it,
		// corrupting the next probe's cursor-relative math. Columns 1-16 are
		// never used as tags: column 1 cannot be told apart from a spurious or
		// clamped reply, and modified F3 keys encode as CSI 1;<mod>R with
		// modifier codes 2-16, which is byte-identical to a CPR for row 1 on
		// those columns. A column may not be reused while its tag is live —
		// the old request's delayed reply would be attributed to the new
		// epoch — so scan for a free slot.
		const span = Math.min(30, this.terminal.columns - 16);
		if (span >= 4) {
			for (let index = 0; index < span; index++) {
				const candidate = 17 + ((this.#cprProbeSeq + index) % span);
				if (this.#cprColumnTags.has(candidate)) continue;
				this.#cprProbeSeq += index + 1;
				this.#cprColumnTags.set(candidate, this.#geometryEpoch);
				this.terminal.write(`\x1b[${candidate}G\x1b[6n\x1b[1G`);
				return;
			}
		}
		// Degenerate span or full occupancy: an untagged reply could never be
		// attributed, so no DSR is sent at all; the timeout anchors
		// conservatively on its own.
	}

	#cancelResizeProbe(): void {
		if (!this.#resizeProbe) return;
		this.#resizeProbe.timer.cancel();
		this.#resizeProbe = undefined;
	}

	/**
	 * Anchor the settled post-resize repaint. `reportedRow` is the 0-based CPR
	 * row of the parked cursor (undefined = probe timed out). Direct terminals
	 * use `min(reported - parkOffset, height - staleRows)`: they track the
	 * cursor exactly through width rewrap, and the second bound reconstructs
	 * height-shrink scrollback pushes that leave the cursor behind (kitty
	 * clamps the cursor instead of scrolling it) — bottom-preserving resize
	 * guarantees the stale viewport ends on the last screen row whenever a
	 * push happened; validated against kitty's real core in
	 * resize-anchor-recovery.test.ts. Multiplexers clip on height changes
	 * (though they reflow on width changes), so that bound never applies:
	 * monotonic shrinks use the deterministic clip model below, everything
	 * else trusts the CPR directly.
	 */
	#resolveResizeAnchor(reportedRow: number | undefined): void {
		const probe = this.#resizeProbe;
		if (!probe) return;
		probe.timer.cancel();
		this.#resizeProbe = undefined;
		// Column tags stay live across resolves: their replies are
		// self-identifying and discarded by tag whenever they arrive.
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const staleRows = this.#reflowedRowCount(probe.window, 0, probe.window.length, width);
		const reportedTop =
			reportedRow === undefined
				? this.#providerViewportTop
				: reportedRow - this.#reflowedRowCount(probe.window, 0, probe.offset, width);
		let top: number;
		if (isInsideTerminalMultiplexer()) {
			if (reportedRow !== undefined) {
				// The parked cursor's reply is exact under multiplexer clipping:
				// discards leave the cursor in place, pushes only occur after
				// everything below it is discarded (the bottom row IS the
				// attached position), and grow pull-down rides it down. It
				// therefore also reflects intermediate geometries that SIGWINCH
				// coalescing hid from the burst tracker, and always outranks the
				// clip model. The `height - staleRows` bound must NOT apply here:
				// it encodes bottom-preserving rewrap, but a multiplexer shrink
				// may have discarded stale rows below the cursor instead of
				// pushing the top ones. Frame-size clamping happens when the
				// settled plan frame is emitted.
				top = Math.max(0, reportedTop);
			} else if (height < this.#previousHeight && !this.#resizeBurstGrew) {
				// Last resort after the retry: model the clip deterministically
				// from the saved parked cursor. Rows strictly below the cursor
				// are discarded first (even non-blank ones — measured against
				// real tmux), and only the remainder of the shrink pushes top
				// rows into scrollback; across an observed burst the totals
				// telescope from pre-burst state. SIGWINCH coalescing can hide a
				// grow from this model, which is why a reply always wins above.
				const parkedRow = this.#providerViewportTop + this.#reflowedRowCount(probe.window, 0, probe.offset, width);
				const shrink = this.#previousHeight - height;
				const discardedBelow = Math.min(shrink, Math.max(0, this.#previousHeight - 1 - parkedRow));
				const pushed = Math.max(0, shrink - discardedBelow);
				top = Math.max(0, this.#providerViewportTop - pushed);
			} else {
				// CPR-less grow or reversed burst: the pre-resize top is
				// stale-low, every grow step already pulled scrollback down.
				// Anchor at the conservative upper bound — pull never exceeds
				// the burst's accumulated growth, and pushes/discards only lower
				// the top. Exact when scrollback covers the pull; when it does
				// not, the repaint lands below the real viewport and leaves
				// stale rows above rather than overwriting committed ones.
				top = Math.max(0, this.#providerViewportTop + this.#resizeBurstPull);
			}
		} else {
			// Direct terminals rewrap bottom-preserving: with `staleRows` stale
			// rows on screen the viewport top cannot exceed `height - staleRows`
			// whenever a push happened, so the bound reconstructs height-shrink
			// pushes that leave the cursor behind (kitty clamps the cursor
			// instead of scrolling it). A CPR-less grow is stale-low like the
			// multiplexer case — grow pull-down moved the real viewport — so it
			// anchors at the accumulated pull bound, still under the clamp.
			const fallbackTop =
				reportedRow === undefined && this.#resizeBurstGrew
					? this.#providerViewportTop + this.#resizeBurstPull
					: reportedTop;
			top = Math.max(0, Math.min(fallbackTop, height - staleRows));
		}
		if ($flag("PI_DEBUG_REDRAW")) {
			const msg = `[${new Date().toISOString()}] resize anchor: size=${width}x${height} cpr=${reportedRow ?? "timeout"} park=${probe.offset} stale=${staleRows} old=${this.#providerViewportTop} top=${top}\n`;
			fs.appendFileSync(getDebugLogPath(), msg);
		}
		this.#providerViewportTop = Math.min(top, Math.max(0, height - 1));
		this.#forceViewportRepaintOnNextRender = true;
		this.requestRender(true);
	}

	/**
	 * Rows `[start, end)` of a previously painted window re-measured at
	 * `width`. Every terminal rewraps content on a width change — including
	 * multiplexers: tmux clips in place on height changes only, and reflows
	 * the pane (scrollback included) when the width moves, so a row painted
	 * wider than the current width spans ceil(cells/width) physical rows
	 * everywhere. For height-only resizes the painted rows already fit the
	 * width and the count is unchanged.
	 */
	#reflowedRowCount(window: readonly string[], start: number, end: number, width: number): number {
		const stop = Math.min(end, window.length);
		const from = Math.max(0, start);
		let rows = 0;
		for (let index = from; index < stop; index++) {
			rows += Math.max(1, Math.ceil(visibleWidth(window[index]!) / Math.max(1, width)));
		}
		return rows;
	}

	/** Paint the full semantic tail on the borrowed resize buffer. */
	#renderResizeAltFrame(width: number, height: number): void {
		const provider = this.#frameProvider;
		let rendered: readonly string[];
		do {
			this.#imageBudget.beginPass();
			rendered =
				provider?.renderResizeFrame?.({ columns: width, rows: height }) ??
				(provider ? provider.renderFrame({ columns: width, rows: height }).viewport : this.render(width));
		} while (this.#imageBudget.endPass());
		const viewport = rendered.length > height ? rendered.slice(rendered.length - height) : Array.from(rendered);
		this.#extractCursorMarkers(viewport);
		this.#emitAltFrame(this.#prepareLinesArray(viewport, width), width, height);
	}

	/**
	 * Take ownership of stdin after a `deferInput` start: raw mode, input
	 * handlers, and the response-eliciting capability probes start() skipped.
	 * Keystrokes typed in cooked mode meanwhile arrive through the normal input
	 * path. Idempotent; no-op when input was never deferred.
	 */
	enableInput(): void {
		if (!this.#inputDeferred || this.#stopped) return;
		this.#inputDeferred = false;
		this.terminal.enableInput?.();
		this.#querySixelSupport();
		this.#queryCellSize();
	}

	addStartListener(listener: StartListener): () => void {
		this.#startListeners.add(listener);
		return () => {
			this.#startListeners.delete(listener);
		};
	}

	addInputListener(listener: InputListener): () => void {
		this.#inputListeners.add(listener);
		return () => {
			this.#inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.#inputListeners.delete(listener);
	}

	#querySixelSupport(): void {
		// A statically known protocol (Kitty/iTerm2 terminals) or an explicit
		// PI_FORCE_IMAGE_PROTOCOL choice — including its `off` kill switch — wins
		// over the probe.
		if (TERMINAL.imageProtocol) return;
		if (isImageProtocolForced()) return;
		if (!process.stdin.isTTY || !process.stdout.isTTY) return;

		this.#clearSixelProbeState();
		this.#sixelProbePendingGraphics = true;
		this.#sixelProbeUnsubscribe = this.addInputListener(data => this.#handleSixelProbeInput(data));
		// XTSMGRAPHICS item 2 reports the terminal's maximum SIXEL geometry. DA1
		// attribute 4 advertises SIXEL as well, but ProcessTerminal swallows every
		// `CSI ? … c` reply for the whole session so a late one cannot leak into the
		// composer (#8542): those bytes never reach an input listener, so this probe
		// cannot read them.
		this.terminal.write("\x1b[?2;1;0S");
		this.#sixelProbeTimeout = setTimeout(() => {
			this.#finishSixelProbe(false);
		}, 250);
	}

	#handleSixelProbeInput(data: string): InputListenerResult {
		if (!this.#sixelProbePendingGraphics) {
			return undefined;
		}

		this.#sixelProbeBuffer += data;
		let passthrough = "";
		let probeOutcome: boolean | null = null;

		while (this.#sixelProbeBuffer.length > 0) {
			const graphicsMatch = this.#sixelProbeBuffer.match(/\x1b\[\?2;(\d+);([0-9;]+)S/u);
			if (!graphicsMatch || graphicsMatch.index === undefined) break;

			passthrough += this.#sixelProbeBuffer.slice(0, graphicsMatch.index);
			this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(graphicsMatch.index + graphicsMatch[0].length);

			if (this.#sixelProbePendingGraphics) {
				this.#sixelProbePendingGraphics = false;
				// Reply shape `CSI ? 2 ; Ps ; Pv S`: per xterm ctlseqs Ps is the status
				// (0 = success, 1..3 = error/failure) and Pv the maximum SIXEL geometry,
				// which a terminal without SIXEL reports as zero.
				const status = Number.parseInt(graphicsMatch[1] ?? "", 10);
				const hasGeometry = (graphicsMatch[2] ?? "").split(";").some(part => Number.parseInt(part, 10) > 0);
				probeOutcome = status === 0 && hasGeometry;
			}
		}

		if (this.#sixelProbePendingGraphics) {
			const partialStart = this.#getSixelProbePartialStart(this.#sixelProbeBuffer);
			if (partialStart >= 0) {
				passthrough += this.#sixelProbeBuffer.slice(0, partialStart);
				this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(partialStart);
			} else {
				passthrough += this.#sixelProbeBuffer;
				this.#sixelProbeBuffer = "";
			}
		} else {
			passthrough += this.#sixelProbeBuffer;
			this.#sixelProbeBuffer = "";
		}

		if (probeOutcome !== null) {
			this.#finishSixelProbe(probeOutcome);
		}

		if (passthrough.length === 0) {
			return { consume: true };
		}

		return { data: passthrough };
	}

	#getSixelProbePartialStart(buffer: string): number {
		const lastEsc = buffer.lastIndexOf("\x1b");
		if (lastEsc < 0) return -1;
		const tail = buffer.slice(lastEsc);
		if (/^\x1b\[\?[0-9;]*$/u.test(tail)) {
			return lastEsc;
		}
		return -1;
	}

	#clearSixelProbeState(): void {
		if (this.#sixelProbeTimeout) {
			clearTimeout(this.#sixelProbeTimeout);
			this.#sixelProbeTimeout = undefined;
		}
		if (this.#sixelProbeUnsubscribe) {
			this.#sixelProbeUnsubscribe();
			this.#sixelProbeUnsubscribe = undefined;
		}
		this.#sixelProbePendingGraphics = false;
		this.#sixelProbeBuffer = "";
	}

	#finishSixelProbe(supported: boolean): void {
		this.#clearSixelProbeState();
		if (!supported || TERMINAL.imageProtocol) return;

		setTerminalImageProtocol(ImageProtocol.Sixel);
		this.#queryCellSize();
		this.invalidate();
		this.requestRender(true);
	}
	#queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!TERMINAL.imageProtocol) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	/**
	 * Toggle synchronized-output (DEC 2026) wrappers on paint/cursor writes and
	 * recompute the cached begin/end sequences. Driven by the terminal's DECRQM
	 * mode-2026 report (#1765 covers the static env opt-out).
	 */
	#setSynchronizedOutput(enabled: boolean): void {
		if (this.#synchronizedOutputEnabled === enabled) return;
		this.#synchronizedOutputEnabled = enabled;
		this.#paintBeginSequence = enabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
		this.#paintEndSequence = enabled ? PAINT_END : PAINT_END_NO_SYNC;
	}

	#flushHistoryBeforeStop(): void {
		const provider = this.#frameProvider;
		if (provider?.beginHistoryFlush === undefined) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (width <= 0 || height <= 0) return;
		provider.beginHistoryFlush();
		while (true) {
			let plan: TerminalFramePlan;
			do {
				this.#imageBudget.beginPass();
				plan = provider.renderFrame({ columns: width, rows: height });
			} while (this.#imageBudget.endPass());
			if (plan.history === undefined) return;
			let viewport = Array.from(plan.viewport);
			if (viewport.length > height) viewport = viewport.slice(0, height);
			const acceptedBefore = this.#acceptedHistoryBatchId;
			this.#emitPlanFrame(width, height, viewport, plan.history, provider);
			if (plan.history.id > acceptedBefore && this.#acceptedHistoryBatchId === acceptedBefore) {
				throw new Error("History flush did not accept the offered batch");
			}
		}
	}

	stop(): void {
		this.#cancelPostmortemRestore?.();
		this.#cancelPostmortemRestore = undefined;
		this.#debugServer?.stop();
		this.#debugServer = undefined;
		this.#resizeSettleTimer?.cancel();
		this.#resizeSettleTimer = undefined;
		this.#cancelResizeProbe();
		if (this.#resizeAltActive) {
			this.#resizeAltActive = false;
			this.terminal.write(`${this.#keyboardEnhancementExit()}\x1b[?1049l`);
			setAltScreenActive(false);
		}
		if (this.#altActive || this.#pendingAltExit) {
			const mouseExit = this.#altMouseTrackingActive ? MOUSE_TRACKING_OFF : "";
			const exitSequence = this.#pendingAltExit || `${mouseExit}${this.#keyboardEnhancementExit()}\x1b[?1049l`;
			this.terminal.write(exitSequence);
			setAltScreenActive(false);
			this.#altActive = false;
			this.#altMouseTrackingActive = false;
			this.#altPreviousLines = [];
			this.#pendingAltExit = "";
		}
		// A latched destructive reset (settled rebuild-mode resize, /clear) pairs
		// ED3 with a complete-ledger replay. Running that pair during stop would
		// erase native history and re-stream the whole transcript at quit; drop
		// the latch so the flush below writes only un-retired rows.
		this.#clearScrollbackOnNextRender = false;
		this.#flushHistoryBeforeStop();
		// Deliberately leave transmitted images in the terminal's graphics store:
		// placeholder cells committed to native scrollback render only while their
		// image data lives, so a delete-by-id here blanks every transcript image
		// the instant the session exits. The terminal enforces its own store quota
		// (and live-session ghosts are already bounded by the inline-image budget).
		this.#clearSixelProbeState();
		this.#stopped = true;
		this.#watchdog.stop();
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		if (this.#ghosttyInitialImageDelayTimer) {
			this.#ghosttyInitialImageDelayTimer.cancel();
			this.#ghosttyInitialImageDelayTimer = undefined;
		}
		// Place the parent shell on the first line after the rendered content. When
		// that line is still inside the viewport, moving there and writing `\r` is
		// enough; emitting `\r\n` would create an extra blank row. If the content
		// already reaches the viewport bottom, scroll exactly once so the prompt
		// lands directly below the last visible TUI row.
		if (this.#previousFrameLength > 0) {
			// Provider frames anchor the mutable viewport below retained history;
			// the shell prompt belongs on the first row after that content.
			const targetRow = this.#providerViewportTop + this.#previousFrameLength;
			const viewportBottom = this.terminal.rows - 1;
			const clampedCursorRow = Math.max(0, Math.min(this.#hardwareCursorRow, viewportBottom));
			const moveTargetRow = Math.min(targetRow, viewportBottom);
			const lineDiff = moveTargetRow - clampedCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write(targetRow <= viewportBottom ? "\r" : "\r\n");
		}

		// Force: the parent shell needs the cursor back regardless of what the
		// terminal-level dedupe believes was last written.
		this.terminal.showCursor(true);
		this.#forgetHardwareCursorState();
		this.terminal.stop();
	}

	/**
	 * Destructive user-gesture reset: invalidate every component, erase native
	 * history, then repaint from row zero. Reachable only from explicit gestures (session
	 * replace, /tree, an explicit clear) — never from ordinary rendering,
	 * animation, resize, or finalization.
	 */
	resetDisplay(): void {
		if (this.#stopped) return;
		this.invalidate();
		this.#prepareForcedRender(true);
		this.#renderRequested = false;
		this.#executeRender();
	}

	requestRender(force = false, options?: RenderRequestOptions): void {
		if (force) {
			this.#prepareForcedRender(options?.clearScrollback === true);
			this.#renderRequested = true;
			this.#renderScheduler.scheduleImmediate(() => {
				if (this.#stopped || !this.#renderRequested) {
					return;
				}
				this.#renderRequested = false;
				this.#executeRender();
			});
			return;
		}
		this.#requestOrdinaryRender();
	}

	/**
	 * Paint a forced frame synchronously when startup must hand off an already
	 * visible component tree before further async initialization. Same as
	 * {@link requestRender} minus the `setImmediate` hop.
	 */
	renderNow(options?: RenderRequestOptions): void {
		if (this.#stopped) return;
		this.#prepareForcedRender(options?.clearScrollback === true);
		this.#renderRequested = false;
		const start = this.#renderScheduler.now();
		this.#lastRenderAt = start;
		this.#doRender();
		this.#lastFrameCostMs = this.#renderScheduler.now() - start;
	}

	/**
	 * Schedule a render on behalf of `component` after a self-contained change
	 * (spinner frame, blink). Frames always compose the bounded viewport from
	 * scratch — retired blocks no longer render — so a scoped request is simply
	 * an ordinary render.
	 */
	requestComponentRender(_component: Component): void {
		if (this.#stopped) return;
		this.#requestOrdinaryRender();
	}

	/** Ordinary (non-forced) render scheduling. */
	#requestOrdinaryRender(): void {
		if (this.#renderRequested) return;
		this.#renderRequested = true;
		this.#renderScheduler.scheduleImmediate(() => this.#scheduleRender());
	}

	#maybeDeferGhosttyInitialImagePaint(): boolean {
		if (this.#ghosttyInitialImageDelayDone) return false;
		if (TERMINAL.id !== "ghostty" || TERMINAL.imageProtocol !== ImageProtocol.Kitty) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}
		if (!this.#imageBudget.hasPendingTransmits()) return false;
		if (this.#ghosttyInitialImageDelayTimer) return true;

		const delayMs = Math.max(0, this.#ghosttyImageReadyAtMs - this.#renderScheduler.now());
		if (delayMs === 0) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}

		this.#ghosttyInitialImageDelayTimer = this.#renderScheduler.scheduleRender(() => {
			this.#ghosttyInitialImageDelayTimer = undefined;
			this.#ghosttyInitialImageDelayDone = true;
			if (this.#stopped) return;
			this.#executeRender();
			if (this.#renderRequested) this.#scheduleRender();
		}, delayMs);
		return true;
	}
	#prepareForcedRender(clearScrollback: boolean): void {
		if (clearScrollback && !this.#clearScrollbackOnNextRender) {
			this.#frameProvider?.beginHistoryReplay?.();
			if (TERMINAL.imageProtocol === ImageProtocol.Kitty) this.#imageBudget.forgetTransmitted();
		}
		this.#clearScrollbackOnNextRender ||= clearScrollback;
		this.#forceViewportRepaintOnNextRender = true;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
	}

	#runScheduledRender = (): void => {
		this.#renderTimer = undefined;
		if (this.#stopped || !this.#renderRequested) {
			return;
		}
		this.#renderRequested = false;
		this.#executeRender();
		if (this.#renderRequested) {
			this.#scheduleRender();
		}
	};

	#scheduleRender(): void {
		if (this.#stopped || this.#renderTimer || !this.#renderRequested) {
			return;
		}
		const now = this.#renderScheduler.now();
		const elapsed = now - this.#lastRenderAt;
		const cadenceDelay = Math.max(0, TUI.#MIN_RENDER_INTERVAL_MS - elapsed);
		// Adaptive backpressure — target ~50% render duty cycle: the next frame
		// starts no sooner than `last_frame_end + last_frame_cost`, i.e.
		// `last_frame_start + 2 × last_frame_cost`. So `elapsed` (which counts
		// from the last frame's start) must already exceed twice the cost
		// before we allow the follow-up render to fire. Capped so a
		// pathological one-off spike doesn't lock the UI (#4145).
		const adaptiveFloor = Math.min(TUI.#MAX_ADAPTIVE_RENDER_MS, this.#lastFrameCostMs * 2);
		const adaptiveDelay = Math.max(0, adaptiveFloor - elapsed);
		const inputGraceDelay = Math.max(0, this.#inputRenderGraceUntilMs - now);
		const delay = Math.max(cadenceDelay, adaptiveDelay, inputGraceDelay);
		this.#renderTimer = this.#renderScheduler.scheduleRender(this.#runScheduledRender, delay);
	}

	/**
	 * Wrap `#doRender()` so every path records the wall-clock frame cost that
	 * feeds adaptive backpressure. Set `#lastRenderAt` first (some render code
	 * reads it re-entrantly) and compute the cost once the paint returns.
	 */
	#executeRender(): void {
		if (this.#deferRenderForOutputBacklog()) return;
		const start = this.#renderScheduler.now();
		this.#lastRenderAt = start;
		this.#doRender();
		this.#lastFrameCostMs = this.#renderScheduler.now() - start;
	}
	/**
	 * True when the frame was deferred because the terminal's output backlog
	 * exceeds {@link TUI.#MAX_PENDING_OUTPUT_BYTES}. Re-arms a retry render;
	 * one-shot paint intents (`#clearScrollbackOnNextRender`,
	 * `#forceViewportRepaintOnNextRender`) survive untouched for it.
	 */
	#deferRenderForOutputBacklog(): boolean {
		const pending = this.terminal.pendingOutputBytes;
		if (pending === undefined || pending <= TUI.#MAX_PENDING_OUTPUT_BYTES) return false;
		this.#renderRequested = true;
		this.#renderTimer ??= this.#renderScheduler.scheduleRender(
			this.#runScheduledRender,
			TUI.#OUTPUT_BACKLOG_RETRY_MS,
		);
		return true;
	}

	#handleInput(data: string): void {
		// Consume CPR replies (CSI row;col R) while an anchor probe is unanswered;
		// they are terminal reports, never keystrokes, and must not reach the
		// focused component.
		let searchFrom = 0;
		while (this.#cprColumnTags.size > 0) {
			const match = data.slice(searchFrom).match(/\x1b\[(\d+);(\d+)R/);
			if (!match || match.index === undefined) break;
			const row = Number(match[1]);
			const column = Number(match[2]);
			if (!this.#cprColumnTags.has(column) && row === 1 && column >= 2) {
				// CSI 1;<mod>R with no live tag is modified F3: the modifier
				// parameter spans 2-256 once the lock-state bits (caps 64,
				// num 128) and hyper/meta are included, so no practical tag
				// range escapes it entirely. Anything row-1 we did not tag is
				// treated as a keystroke and left for the focused component;
				// a tagged column hit by a hyper/meta-modified F3 (params
				// 17-64, practically unused) is still gated by the epoch check
				// below.
				searchFrom += match.index + match[0].length;
				continue;
			}
			if (this.#cprColumnTags.has(column)) {
				// Column-tagged reply: exact attribution. Resolve only when its
				// request was parked under the active probe's geometry; a reply
				// from an older epoch is stale and discarded.
				const tagEpoch = this.#cprColumnTags.get(column);
				this.#cprColumnTags.delete(column);
				const probe = this.#resizeProbe;
				if (probe !== undefined && tagEpoch === probe.epoch) {
					this.#resolveResizeAnchor(Number(match[1]) - 1);
				}
			}
			// Other unknown-column replies while expecting tagged ones are our
			// requests answered with a clamped or mangled column: strip and
			// discard; the probe timeout covers recovery.
			data = data.slice(0, searchFrom + match.index) + data.slice(searchFrom + match.index + match[0].length);
		}
		if (data.length === 0) return;
		// Ctrl+C/Esc use app-level double-press windows. Give those gestures one
		// frame to drain queued input before an ordinary repaint; delaying every
		// key would make idle navigation pay a full frame of latency.
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.#inputRenderGraceUntilMs = this.#renderScheduler.now() + TUI.#INPUT_RENDER_GRACE_MS;
		}
		if (this.#inputListeners.size > 0) {
			let current = data;
			for (const listener of this.#inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.#consumeCellSizeResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find(o => o.component === this.#focusedComponent);
		if (focusedOverlay && !this.#isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.#getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C).
		// The focused component can decide how to handle Ctrl+C.
		// Opted-in components only dirty their focused subtree. Unregistered
		// components retain the legacy full compose because their callbacks may
		// mutate siblings; focus changes also require the new surface to paint.
		const focused = this.#focusedComponent;
		if (focused?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !focused.wantsKeyRelease) {
				return;
			}
			focused.handleInput(data);
			this.requestRender();
		}
	}

	#consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	#resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight) ?? availHeight;
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));

		// Effective overlay height: maxHeight is always resolved (defaults to
		// availHeight above), so the overlay is unconditionally clamped to fit.
		const effectiveHeight = Math.min(overlayHeight, maxHeight);

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.#resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.#resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.#resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.#resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	#resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	#resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/**
	 * Composite all visible overlays into the window slice (screen
	 * coordinates, in stack order, later = on top). Overlays never touch the
	 * frame: composited rows exist only in the painted window, and commits are
	 * frozen while an overlay is visible, so overlay pixels can never enter
	 * native scrollback.
	 */
	#compositeOverlaysIntoWindow(window: string[], termWidth: number, termHeight: number): string[] {
		const result = [...window];
		for (const entry of this.overlayStack) {
			if (!this.#isOverlayVisible(entry)) continue;
			const { component, options } = entry;
			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height).
			const { width, maxHeight } = this.#resolveOverlayLayout(options, 0, termWidth, termHeight);
			let overlayLines = component.render(width);
			if (overlayLines.length > maxHeight) {
				const anchor = options?.anchor ?? "center";
				overlayLines =
					anchor === "bottom-left" || anchor === "bottom-center" || anchor === "bottom-right"
						? overlayLines.slice(overlayLines.length - maxHeight)
						: overlayLines.slice(0, maxHeight);
			}
			const { row, col } = this.#resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = row + i;
				if (idx < 0 || idx >= result.length) continue;
				const truncatedOverlayLine =
					visibleWidth(overlayLines[i]) > width ? sliceByColumn(overlayLines[i], 0, width, true) : overlayLines[i];
				result[idx] = this.#compositeLineAt(result[idx], truncatedOverlayLine, col, width, termWidth);
			}
		}
		return result;
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	#compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (TERMINAL.isImageLine(baseLine)) {
			// Full-width overlays such as /switch are opaque: replace the
			// Unicode placeholder cells so the image cannot cover the modal.
			// Partial overlays cannot safely splice placement control sequences.
			if (startCol !== 0 || overlayWidth < totalWidth) return baseLine;
			const overlay = sliceWithWidth(overlayLine, 0, totalWidth, true);
			return SEGMENT_RESET + overlay.text + " ".repeat(Math.max(0, totalWidth - overlay.width));
		}

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Strip every CURSOR_MARKER from the rendered lines (markers are internal
	 * sentinels and must never reach the terminal) and return their positions,
	 * bottom-most first. Callers pick the visible one once the window top is
	 * known.
	 */
	#extractCursorMarkers(lines: string[]): { row: number; col: number }[] {
		const markers: { row: number; col: number }[] = [];
		for (let row = lines.length - 1; row >= 0; row--) {
			const line = lines[row];
			let markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex === -1) continue;
			const beforeMarker = line.slice(0, markerIndex);
			markers.push({ row, col: visibleWidth(beforeMarker) });
			let stripped = line;
			while (markerIndex !== -1) {
				stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
				markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
			}
			lines[row] = stripped;
		}
		return markers;
	}

	/**
	 * Rewrite a Kitty direct-placement line for the viewport row it is written
	 * at, clipping to the visible slice (see {@link encodeKittyPlacementLine})
	 * under the placement id resolved by the budget's epoch tracking (see
	 * {@link ImageBudget.resolvePlacementEmit}). `screenRow` -1 (write position
	 * unknown) and non-placement image lines (placeholder grids, sixel, iTerm2,
	 * tmux-wrapped) pass through verbatim.
	 */
	#imageLineSequence(line: string, screenRow: number, frameRow: number, committedTo: number): string {
		if (screenRow < 0) return line;
		const parsed = parseKittyDirectPlacementLine(line);
		if (!parsed) return line;
		// The emitted placement attaches from the block's first *visible* row
		// (the clip drops the rows above the viewport), so epoch tracking keys
		// on that row — not the block origin, which may be long committed.
		const placement = this.#imageBudget.resolvePlacementEmit(
			parsed.imageId,
			frameRow >= 0 ? frameRow - Math.min(parsed.rows - 1, screenRow) : -1,
			committedTo,
		);
		if (!placement) return line;
		return encodeKittyPlacementLine({
			imageId: parsed.imageId,
			placementId: placement.placementId,
			columns: parsed.columns,
			rows: parsed.rows,
			screenRow,
			imageHeightPx: placement.heightPx,
		});
	}

	#terminalLine(line: string, screenRow = -1, frameRow = -1, committedTo = -1): string {
		if (TERMINAL.isImageLine(line)) return this.#imageLineSequence(line, screenRow, frameRow, committedTo);
		const coalesced = coalesceAdjacentSgr(line);
		return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}
	#renderProviderFrame(width: number, height: number): void {
		const provider = this.#frameProvider;
		if (!provider || width <= 0 || height <= 0) return;
		this.#debugNextWindowTop = 0;
		let plan: TerminalFramePlan;
		do {
			this.#imageBudget.beginPass();
			plan = provider.renderFrame({ columns: width, rows: height });
		} while (this.#imageBudget.endPass());
		let viewport = Array.from(plan.viewport);
		if (viewport.length > height) {
			const message = `Frame provider returned ${viewport.length} rows for a ${height}-row viewport`;
			if (Bun.env.NODE_ENV === "test" || Bun.env.NODE_ENV === "development") throw new Error(message);
			logger.error("TUI layout contract violated", { rows: viewport.length, height });
			viewport = viewport.slice(0, height);
		}
		if (this.#maybeDeferGhosttyInitialImagePaint()) return;
		this.#emitPlanFrame(width, height, viewport, plan.history, provider);
	}
	/**
	 * Re-offer finalized history once after a settled resize.
	 *
	 * Append mode leaves the terminal's prior copy in place and writes a
	 * current-width copy below it. Rebuild mode routes through the destructive
	 * reset latch so ED3 removes stale history before the same replay.
	 *
	 * The append replay only exists to refresh width-shredded scrollback: a
	 * width change leaves the terminal's committed history wrapped at the old
	 * width, so the copy below it is the intended fresh current-width render. A
	 * height-only change reflows nothing (the terminal merely pulls rows back
	 * out of scrollback), so replaying would write an identical duplicate — the
	 * editor/status chrome included — below the retained copy. Skip it, matching
	 * the `widthChanged`-gated commit-ledger logic in {@link #doRender}.
	 */
	#prepareResizeReplay(width: number, height: number): void {
		const size = `${width}x${height}`;
		if (
			!this.#hasEverRendered ||
			(this.#previousWidth === width && this.#previousHeight === height) ||
			this.#resizeReplaySize === size ||
			this.#resizeScrollbackMode === "preserve"
		) {
			return;
		}
		const provider = this.#frameProvider;
		if (!provider?.beginHistoryReplay) return;
		this.#resizeReplaySize = size;
		if (this.#clearScrollbackOnNextRender) {
			this.#forceViewportRepaintOnNextRender = true;
			return;
		}
		if (this.#resizeScrollbackMode === "rebuild") {
			this.#prepareForcedRender(true);
			return;
		}
		if (width === this.#previousWidth) return;
		provider.beginHistoryReplay();
		this.#forceViewportRepaintOnNextRender = true;
	}

	/**
	 * Erase `row` and everything below it, absolute-addressed, without ever
	 * issuing a full-screen clear. tmux and Windows conhost (#9597) archive a
	 * screen-wide erase into pane history instead of discarding it, so an erase
	 * anchored on the first row would preserve the unfinished frame it exists to
	 * remove (#9780). Below existing history a plain ED0 cannot span the screen;
	 * on the first row, EL2 that row and ED0 from the second down touch the same
	 * cells with no full-screen clear. `row` is clamped because a caller's
	 * viewport top can predate a height shrink.
	 * Every form leaves the cursor on the clamped row at column zero.
	 */
	#eraseBelowRow(row: number, height: number): string {
		const top = Math.max(0, Math.min(row, Math.max(0, height - 1)));
		if (top > 0) return `\x1b[${top + 1};1H\x1b[J`;
		if (height <= 1) return `\x1b[1;1H${ERASE_LINE}`;
		return `\x1b[1;1H${ERASE_LINE}\x1b[2;1H\x1b[J\x1b[1;1H`;
	}

	/**
	 * Erase the cursor's row and everything below it, cursor-relative, without
	 * ever issuing a full-screen clear. Used where the resize path must stay
	 * cursor-relative: the terminal reflowed the normal buffer, so absolute rows
	 * are stale and only the parked cursor still tracks the viewport's logical
	 * line. Every form leaves the cursor on column zero of that row, exactly
	 * where a plain `\r\x1b[J` left it.
	 *
	 * The erase must never run from the first cell, which is what makes tmux and
	 * Windows conhost (#9597) archive the screen instead of discarding it
	 * (#9780), and a clamped CUU can put the cursor on the first row without
	 * naming it. Stepping one column right is enough and needs no row movement,
	 * but at one column CUF cannot leave the first cell, so step one row down
	 * instead: from the first row that can only reach row 1, and DECSC/DECRC
	 * restores the anchor even when CUD clamps at the last row. A one-row screen
	 * has nothing below the cursor, so EL2 alone clears everything.
	 */
	#eraseBelowCursorRow(width: number, height: number): string {
		if (height <= 1) return `\r${ERASE_LINE}`;
		if (width > 1) return `\r${ERASE_LINE}\x1b[C\x1b[J\r`;
		return `\r${ERASE_LINE}\x1b7\x1b[B\x1b[J\x1b8`;
	}

	/**
	 * Physical write transaction: append an ordinary batch, or bottom-split one
	 * complete replay into a history remainder and final viewport, then serialize
	 * the whole result in one terminal write before acknowledgement.
	 */
	#emitPlanFrame(
		width: number,
		height: number,
		viewportRows: string[],
		offered: HistoryBatch | undefined,
		provider: TerminalFrameProvider | undefined,
	): void {
		let viewport = viewportRows;
		if (this.#getTopmostVisibleOverlay() !== undefined) {
			while (viewport.length < height) viewport.push("");
			viewport = this.#compositeOverlaysIntoWindow(viewport, width, height);
		}
		const history = offered !== undefined && offered.id > this.#acceptedHistoryBatchId ? offered : undefined;
		if (offered !== undefined && offered.id <= this.#acceptedHistoryBatchId) provider?.acknowledgeHistory(offered.id);

		let historyRows = history?.rows ?? [];
		let replayViewportRows = 0;
		if (history?.kind === "replay") {
			// Providers may omit unused leading rows from a short viewport. Make
			// that logical space explicit before the bottom-first replay split.
			while (viewport.length < height) viewport.unshift("");
			let leadingBlankRows = 0;
			while (leadingBlankRows < viewport.length && !/\S/.test(viewport[leadingBlankRows]!)) {
				leadingBlankRows++;
			}
			const moved = Math.min(historyRows.length, leadingBlankRows);
			if (moved > 0) {
				viewport = [...historyRows.slice(historyRows.length - moved), ...viewport.slice(moved)];
				historyRows = historyRows.slice(0, historyRows.length - moved);
				replayViewportRows = moved;
			}
		}
		const markers = this.#extractCursorMarkers(viewport);
		const prepared = this.#prepareLinesArray(viewport, width);
		const preparedHistory = this.#prepareLinesArray(historyRows, width);
		const rows = prepared.length;
		// Destructive reset (session replace, /tree, explicit clear, or a settled
		// resize in rebuild mode): erase native history and the viewport,
		// then repaint from row zero.
		const destructiveReset = this.#clearScrollbackOnNextRender;
		if (destructiveReset) {
			this.#providerViewportTop = 0;
			this.#providerWindow = [];
		}
		// The viewport stays anchored directly below whatever history remains on
		// screen. Appending K history rows moves the anchor down by K; the write
		// scrolls only when history + viewport overflow the physical screen, and
		// the rows that scroll off the top are exactly the oldest history rows.
		const geometryStable = this.#hasEverRendered && this.#previousWidth === width && this.#previousHeight === height;
		const startTop = destructiveReset ? 0 : Math.min(this.#providerViewportTop, Math.max(0, height - 1));
		const newTop = Math.max(0, Math.min(startTop + historyRows.length, height - rows));
		const pendingAltExit = this.#pendingAltExit;
		let buffer = this.#paintBeginSequence + pendingAltExit;
		if (destructiveReset && TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			// ED2/ED3 erase text cells but leave Kitty graphics visible. A reset is
			// explicitly destructive, so remove every placement—not only the ones
			// this TUI tracked—then resend images composed for the clean replay.
			buffer += encodeKittyDeleteAllImages();
			this.#imageBudget.resetPlacementEpochs();
		}
		for (const sequence of this.#imageBudget.takeTransmits()) buffer += sequence;
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of this.#imageBudget.takePurgeIds()) buffer += encodeKittyDeleteImage(id);
		} else {
			this.#imageBudget.takePurgeIds();
		}
		// ED2 MUST precede ED3: tmux implements ED2 by scrolling the live screen
		// into pane history (so cleared content stays reachable), so erasing
		// history first would let ED2 refill it with a copy of the old screen —
		// which the replay then repaints, duplicating one full frame per reset.
		// ED2-then-ED3 clears the screen, then wipes history including that
		// push. On xterm-family terminals the two erases are independent and
		// the order is irrelevant.
		if (destructiveReset) buffer += "\x1b[H\x1b[2J\x1b[3J";
		const diffable =
			geometryStable &&
			historyRows.length === 0 &&
			startTop === newTop &&
			!this.#forceViewportRepaintOnNextRender &&
			!destructiveReset &&
			this.#providerWindow.length > 0;
		if (diffable) {
			for (let index = 0; index < rows; index++) {
				if (this.#providerWindow[index] === prepared[index]) continue;
				buffer += `\x1b[${newTop + index + 1};1H${this.#lineRewriteSequence(
					prepared[index] ?? "",
					width,
					newTop + index,
					-1,
					-1,
					this.#osc66SpacerGlyphWidth(prepared, index),
				)}`;
			}
			if (this.#providerWindow.length > rows && newTop + rows < height) {
				buffer += `\x1b[${newTop + rows + 1};1H\x1b[J`;
			}
		} else {
			// This write scrolls when history + viewport overflow the screen; the
			// terminal pushes the physical top rows into scrollback. Rows above the
			// old viewport are committed history (correct to push), but old live
			// viewport rows are not — erase them first so a scroll can only push
			// committed rows and blanks, never an unfinished frame.
			const pushed = Math.max(0, startTop + preparedHistory.length + rows - height);
			if (pushed > this.#providerViewportTop && this.#providerWindow.length > 0) {
				buffer += this.#eraseBelowRow(this.#providerViewportTop, height);
			}
			buffer += `\x1b[${startTop + 1};1H`;
			let screenRow = startTop;
			for (let index = 0; index < preparedHistory.length; index++) {
				if (screenRow > startTop) buffer += "\r\n";
				buffer += this.#lineRewriteSequence(
					preparedHistory[index] ?? "",
					width,
					Math.min(screenRow, height - 1),
					-1,
					-1,
					this.#osc66SpacerGlyphWidth(preparedHistory, index),
				);
				screenRow++;
			}
			for (let index = 0; index < rows; index++) {
				if (screenRow > startTop) buffer += "\r\n";
				buffer += this.#lineRewriteSequence(
					prepared[index] ?? "",
					width,
					Math.min(screenRow, height - 1),
					-1,
					-1,
					this.#osc66SpacerGlyphWidth(prepared, index),
				);
				screenRow++;
			}
			if (newTop + rows < height) buffer += `\x1b[${newTop + rows + 1};1H\x1b[J`;
		}
		const mutableTop = newTop + replayViewportRows;
		const mutablePrepared = replayViewportRows > 0 ? prepared.slice(replayViewportRows) : prepared;
		const marker = markers[0];
		const target =
			marker !== undefined && rows > 0
				? this.#targetHardwareCursorState({ row: newTop + Math.min(marker.row, rows - 1), col: marker.col }, height)
				: null;
		if (target) {
			buffer += `\x1b[${target.row + 1};${target.col + 1}H${target.visible ? "\x1b[?25h" : "\x1b[?25l"}`;
			this.#parkedViewportOffset = Math.max(0, target.row - mutableTop);
		} else {
			// Park the hidden cursor on the viewport's top row: terminals keep the
			// cursor attached to its logical line through resize reflow, so the
			// post-resize anchor probe can recover where the viewport landed.
			buffer += `\x1b[?25l\x1b[${mutableTop + 1};1H`;
			this.#parkedViewportOffset = 0;
		}
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#debugPaint = {
			lines: prepared,
			windowTop: this.#debugNextWindowTop,
			altScreen: false,
			...(target === null ? {} : { cursor: { x: target.col, y: target.row, visible: target.visible } }),
		};
		if (pendingAltExit) {
			this.#pendingAltExit = "";
			setAltScreenActive(false);
		}
		if (target) this.#recordHardwareCursorState(target);
		else this.#recordHardwareCursorHidden();
		this.#providerWindow = mutablePrepared;
		this.#providerViewportTop = mutableTop;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#resizeBurstGrew = false;
		this.#resizeBurstLastHeight = undefined;
		this.#resizeBurstPull = 0;
		this.#previousFrameLength = mutablePrepared.length;
		this.#clearScrollbackOnNextRender = false;
		this.#forceViewportRepaintOnNextRender = false;
		this.#hasEverRendered = true;
		this.#resizeReplaySize = undefined;
		if (history !== undefined) {
			this.#acceptedHistoryBatchId = history.id;
			provider?.acknowledgeHistory(history.id);
			// Normal retirement may hold another ordered batch. Replay is always
			// complete, so pumping it would create a second visible redraw/write.
			if (history.kind !== "replay") this.requestRender();
		}
	}

	/** Render one frame: alt-screen modal, provider plan, or children fallback. */
	#doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (this.#resizeAltActive) {
			this.#renderResizeAltFrame(width, height);
			return;
		}
		if (this.#resizeProbe) {
			// The settled repaint lands via #resolveResizeAnchor; painting now would
			// use the stale pre-resize anchor.
			return;
		}

		// Fullscreen alt-screen short-circuit. While the topmost visible overlay
		// requests it, borrow the terminal's alternate buffer and paint only the
		// modal there; the normal screen and all accounting stay untouched.
		const topOverlay = this.#getTopmostVisibleOverlay();
		const wantAlt = topOverlay?.options?.fullscreen === true;
		const wantMouseTracking = wantAlt && topOverlay.options?.mouseTracking !== false;
		if (wantAlt && !this.#altActive) {
			// Enhanced keyboard modes can be buffer-local: re-push the active
			// modified-key reporting sequence on the freshly entered alternate
			// screen, or Esc/modified keys revert to legacy encoding inside
			// fullscreen overlays (Ghostty/kitty/iTerm2).
			const mouseEnter = wantMouseTracking ? MOUSE_TRACKING_ON : "";
			this.terminal.write(`\x1b[?1049h${this.#keyboardEnhancementEnter()}${mouseEnter}`);
			setAltScreenActive(true);
			this.terminal.hideCursor();
			this.#forgetHardwareCursorState();
			this.#recordHardwareCursorHidden();
			this.#altActive = true;
			this.#altMouseTrackingActive = wantMouseTracking;
			this.#altPreviousLines = [];
			this.#altEnterWidth = width;
			this.#altEnterHeight = height;
		} else if (!wantAlt && this.#altActive) {
			const mouseExit = this.#altMouseTrackingActive ? MOUSE_TRACKING_OFF : "";
			const enhancementExit = this.#keyboardEnhancementExit();
			const exitSequence = `${mouseExit}${enhancementExit}\x1b[?1049l`;
			// Session replacement finishes while its fullscreen selector still
			// covers the old normal buffer. Fuse the restore into the destructive
			// repaint so no stale frame can become visible between writes.
			if (this.#clearScrollbackOnNextRender) {
				this.#pendingAltExit = exitSequence;
			} else {
				this.terminal.write(exitSequence);
				setAltScreenActive(false);
			}
			this.#forgetHardwareCursorState();
			this.#altActive = false;
			this.#altMouseTrackingActive = false;
			this.#altPreviousLines = [];
			// The alt-buffer restore put the pre-overlay normal screen back. If
			// that buffer resized while covered, its cursor moved with width
			// rewrap or a height-grow scrollback pull, while our viewport anchor
			// stayed frozen. Recover the restored cursor position before any
			// provider repaint can overwrite history at the stale row.
			if (width !== this.#altEnterWidth || height !== this.#altEnterHeight) {
				if (this.#frameProvider !== undefined) {
					this.#beginResizeAnchorProbe();
					return;
				}
				this.#forceViewportRepaintOnNextRender = true;
			}
		} else if (wantMouseTracking !== this.#altMouseTrackingActive) {
			this.terminal.write(wantMouseTracking ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
			this.#altMouseTrackingActive = wantMouseTracking;
		}
		if (this.#altActive) {
			this.#renderAltFrame(width, height);
			return;
		}
		if (this.#frameProvider !== undefined) {
			this.#prepareResizeReplay(width, height);
			this.#renderProviderFrame(width, height);
			return;
		}
		this.#renderChildrenFrame(width, height);
	}

	/**
	 * Fallback frame for hosts without a frame provider (tests, simple embeds):
	 * compose the root children and paint the bottom `height` rows as the
	 * mutable viewport. Nothing is ever appended to terminal history.
	 */
	#renderChildrenFrame(width: number, height: number): void {
		let composed: readonly string[];
		do {
			this.#imageBudget.beginPass();
			composed = this.render(width);
		} while (this.#imageBudget.endPass());
		if (this.#maybeDeferGhosttyInitialImagePaint()) return;
		this.#debugNextWindowTop = Math.max(0, composed.length - height);
		const viewport = composed.length > height ? composed.slice(composed.length - height) : Array.from(composed);
		this.#emitPlanFrame(width, height, viewport, undefined, undefined);
	}

	/** Stateless variant for overlay-composited windows and alt-screen frames. */
	#prepareLinesArray(lines: readonly string[], width: number): string[] {
		// oxlint-disable-next-line unicorn/no-new-array -- render-frame length preallocation
		const prepared: string[] = new Array(lines.length);
		for (let i = 0; i < lines.length; i++) {
			prepared[i] = this.#prepareLine(lines[i]!, width).line;
		}
		return prepared;
	}

	#prepareLine(raw: string, width: number): PreparedLine {
		if (TERMINAL.isImageLine(raw)) {
			return { raw, width, line: raw };
		}
		const source = this.#lineFitSource(raw, width);
		const normalized = normalizeTerminalOutput(source);
		const asciiWidth = this.#ansiAsciiLineWidth(normalized, width);
		if ((asciiWidth ?? visibleWidth(normalized)) <= width) {
			return { raw, width, line: normalized };
		}
		const line = truncateToWidth(normalized, width, Ellipsis.Omit);
		return { raw, width, line };
	}

	#lineFitSource(raw: string, width: number): string {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
		const maxSourceLength = Math.min(
			LINE_FIT_MAX_SOURCE_CODE_UNITS,
			Math.max(LINE_FIT_MIN_SOURCE_CODE_UNITS, safeWidth * LINE_FIT_SOURCE_WIDTH_MULTIPLIER),
		);
		if (raw.length <= maxSourceLength) return raw;

		let output = "";
		let cells = 0;
		for (let i = 0; i < raw.length && cells < safeWidth;) {
			if (raw.charCodeAt(i) === 0x1b) {
				const end = this.#ansiSequenceEnd(raw, i);
				if (end < 0) break;
				if (this.#ansiSequenceHasVisiblePayload(raw, i)) {
					const sequence = raw.slice(i, end);
					if (output.length + sequence.length <= maxSourceLength) {
						output += sequence;
						cells += visibleWidth(sequence);
					}
				}
				i = end;
				continue;
			}

			const code = raw.charCodeAt(i);
			if (code >= 0x20 && code <= 0x7e) {
				// Printable-ASCII run: every char here is exactly one cell wide, so
				// the run is copied with a single slice instead of a per-char
				// slice + visibleWidth call. Stop conditions mirror the general
				// path: width budget (cells), source budget (maxSourceLength).
				if (output.length >= maxSourceLength) break;
				const cap = i + Math.min(safeWidth - cells, maxSourceLength - output.length);
				let j = i + 1;
				while (j < raw.length && j < cap) {
					const c = raw.charCodeAt(j);
					if (c < 0x20 || c > 0x7e) break;
					j++;
				}
				output += raw.slice(i, j);
				cells += j - i;
				i = j;
				continue;
			}

			const next = code >= 0xd800 && code <= 0xdbff && i + 1 < raw.length ? i + 2 : i + 1;
			const char = raw.slice(i, next);
			const charWidth = visibleWidth(char);
			if (charWidth > 0 && cells + charWidth > safeWidth) break;
			if (output.length + char.length > maxSourceLength) {
				if (charWidth > 0) break;
				i = next;
				continue;
			}
			if (charWidth === 0) {
				const remainingVisibleCells = safeWidth - cells;
				const reservedCodeUnits = remainingVisibleCells * 2;
				if (output.length + char.length > maxSourceLength - reservedCodeUnits) {
					i = next;
					continue;
				}
			}
			output += char;
			cells += charWidth;
			i = next;
		}

		return output + SEGMENT_RESET;
	}

	#ansiSequenceEnd(line: string, start: number): number {
		const next = line.charCodeAt(start + 1);
		if (next === 0x5b) {
			let i = start + 2;
			while (i < line.length) {
				const final = line.charCodeAt(i);
				if (final >= 0x40 && final <= 0x7e) return i + 1;
				i++;
			}
			return -1;
		}
		if (next === 0x5d) {
			let i = start + 2;
			while (i < line.length) {
				const osc = line.charCodeAt(i);
				if (osc === 0x07) return i + 1;
				if (osc === 0x1b && line.charCodeAt(i + 1) === 0x5c) return i + 2;
				i++;
			}
			return -1;
		}
		return start + 2 <= line.length ? start + 2 : -1;
	}

	#ansiSequenceHasVisiblePayload(line: string, start: number): boolean {
		// OSC 66 (`\x1b]66;META;TEXT\x1b\\`) carries visible cells inside the payload.
		return (
			line.charCodeAt(start + 1) === 0x5d &&
			line.charCodeAt(start + 2) === 0x36 &&
			line.charCodeAt(start + 3) === 0x36 &&
			line.charCodeAt(start + 4) === 0x3b
		);
	}

	#ansiAsciiLineWidth(line: string, maxWidth: number): number | undefined {
		let col = 0;
		for (let i = 0; i < line.length;) {
			const code = line.charCodeAt(i);
			if (code === 0x1b) {
				const next = line.charCodeAt(i + 1);
				if (next === 0x5b) {
					let j = i + 2;
					while (j < line.length) {
						const final = line.charCodeAt(j);
						if (final >= 0x40 && final <= 0x7e) break;
						j++;
					}
					if (j >= line.length) return undefined;
					i = j + 1;
					continue;
				}
				if (next === 0x5d) {
					// OSC 66 text-sizing spans carry visible payload inside the OSC.
					// Fall back to visibleWidth() so scaled cells stay exact.
					if (
						line.charCodeAt(i + 2) === 0x36 &&
						line.charCodeAt(i + 3) === 0x36 &&
						line.charCodeAt(i + 4) === 0x3b
					) {
						return undefined;
					}
					let j = i + 2;
					while (j < line.length) {
						const osc = line.charCodeAt(j);
						if (osc === 0x07) {
							i = j + 1;
							break;
						}
						if (osc === 0x1b && line.charCodeAt(j + 1) === 0x5c) {
							i = j + 2;
							break;
						}
						j++;
					}
					if (j >= line.length) return undefined;
					continue;
				}
				return undefined;
			}
			if (code < 0x20 || code > 0x7e) return undefined;
			col++;
			if (col > maxWidth) return col;
			i++;
		}
		return col;
	}

	/**
	 * Columns to preserve when `lines[index]` is a blank row that a scaled OSC 66
	 * heading flows into, or `-1` when it is not such a row. A scale-`s` heading
	 * occupies `s` rows and `visibleWidth` columns, so the `s - 1` blank rows
	 * beneath it hold the multicell glyph's lower half; those columns must never
	 * be erased or overdrawn or the glyph vanishes, leaving reserved-but-invisible
	 * space (issue #8318). Scans upward across the contiguous blank run so every
	 * reserved row of a scale ≥ 3 heading is covered, not just the first.
	 */
	#osc66SpacerGlyphWidth(lines: readonly string[], index: number): number {
		if (index <= 0 || lines[index] !== "") return -1;
		let gap = 1;
		while (gap < TUI.#OSC66_MAX_SPACER_ROWS && index - gap > 0 && lines[index - gap] === "") {
			gap++;
		}
		const above = lines[index - gap];
		if (above === undefined || !isOsc66Line(above) || gap > osc66MaxScale(above) - 1) return -1;
		return visibleWidth(above);
	}

	#lineRewriteSequence(
		line: string,
		width: number,
		screenRow = -1,
		frameRow = -1,
		committedTo = -1,
		spacerGlyphWidth = -1,
	): string {
		// Reserved lower half of a scaled OSC 66 heading. The glyph re-emitted on
		// the row above owns columns `[0, spacerGlyphWidth)` here, so preserve
		// them (any erase there clears the glyph — issue #8318) but still clear
		// stale cells to their right: a row can reflow from wider text into this
		// spacer, and the glyph write never covers those columns. Leading reset
		// keeps the erase on the default background (BCE).
		if (spacerGlyphWidth >= 0) {
			if (spacerGlyphWidth >= width) return "";
			return `${SEGMENT_RESET}\x1b[${spacerGlyphWidth}C${ERASE_TO_END_OF_LINE}`;
		}
		if (TERMINAL.isImageLine(line)) {
			return ERASE_LINE + this.#imageLineSequence(line, screenRow, frameRow, committedTo);
		}
		const terminalLine = this.#terminalLine(line);
		const asciiWidth = this.#ansiAsciiLineWidth(line, width);
		if (asciiWidth !== undefined) {
			// Exact width model: skip the erase only when the row truly fills
			// the line (an EL there would eat the last cell via pending-wrap).
			return asciiWidth >= width ? terminalLine : terminalLine + ERASE_TO_END_OF_LINE;
		}
		// Non-ASCII rows: the native measure can over-count combining-heavy
		// scripts, so a row it calls "full" may render short and leave stale
		// cells from the previous occupant — which would then scroll into
		// history baked into the committed row. Erase the line first instead
		// (rewrites always start at column 1, so EL-to-end clears the whole
		// row); the leading reset keeps BCE on the default background.
		return SEGMENT_RESET + ERASE_TO_END_OF_LINE + terminalLine;
	}

	#targetHardwareCursorState(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
	): HardwareCursorState | null {
		if (!cursorPos || totalLines <= 0) return null;
		return {
			row: Math.max(0, Math.min(cursorPos.row, totalLines - 1)),
			col: Math.max(0, cursorPos.col),
			visible: this.#showHardwareCursor,
		};
	}

	#recordHardwareCursorState(state: HardwareCursorState): void {
		this.#hardwareCursorRow = state.row;
		this.#hardwareCursorState = state;
	}

	#recordHardwareCursorHidden(): void {
		if (!this.#hardwareCursorState) return;
		this.#hardwareCursorState = { ...this.#hardwareCursorState, visible: false };
	}

	#forgetHardwareCursorState(): void {
		this.#hardwareCursorState = null;
	}

	/**
	 * Resolve the active keyboard-enhancement enter sequence. Falls back to the
	 * legacy `kittyEnableSequence` when a custom Terminal predates the
	 * `keyboardEnhancementEnterSequence` property.
	 */
	#keyboardEnhancementEnter(): string {
		return this.terminal.keyboardEnhancementEnterSequence ?? this.terminal.kittyEnableSequence ?? "";
	}

	/**
	 * Resolve the active keyboard-enhancement exit sequence. Falls back to popping
	 * kitty whenever a custom Terminal exposes its push sequence but predates the
	 * `keyboardEnhancementExitSequence` property.
	 */
	#keyboardEnhancementExit(): string {
		const exit = this.terminal.keyboardEnhancementExitSequence;
		if (exit !== undefined) return exit ?? "";
		return this.terminal.kittyEnableSequence ? "\x1b[<u" : "";
	}

	/**
	 * Compose and paint a single fullscreen overlay frame on the alt buffer.
	 * Cursor markers are stripped (the modal draws its own in-band caret and
	 * keeps the hardware cursor hidden), and only the modal is composited over a
	 * blank base — the transcript is never touched while the alt buffer is up.
	 */
	#renderAltFrame(width: number, height: number): void {
		// oxlint-disable-next-line unicorn/no-new-array -- alt-frame length preallocation
		const base: string[] = new Array(Math.max(0, height)).fill("");
		let lines = this.#compositeOverlaysIntoWindow(base, width, height);
		this.#extractCursorMarkers(lines);
		lines = this.#prepareLinesArray(lines, width);
		this.#emitAltFrame(lines, width, height);
	}

	/**
	 * Full per-row viewport rewrite on the alt buffer. Emits only sync-output
	 * brackets, a cursor home, and per-row rewrites — never ED3 or any
	 * native-scrollback byte. The hardware cursor stays hidden here.
	 */
	#emitAltFrame(lines: string[], width: number, height: number): void {
		// oxlint-disable-next-line unicorn/no-new-array -- alt-frame length preallocation
		const fitted: string[] = new Array(height);
		for (let r = 0; r < height; r++) fitted[r] = lines[r] ?? "";
		// Flush queued image-data transmits (`a=t`, no visible output) before the
		// paint so id-keyed placements and placeholder cells composed into this
		// frame resolve against loaded data. The normal-screen path flushes these
		// ahead of its paint; without this, an image first shown inside a
		// fullscreen overlay (e.g. the settings shape preview) would render as
		// blank placeholder cells until the overlay closed.
		const imageTransmits = this.#imageBudget.takeTransmits();
		if (imageTransmits.length > 0) {
			let transmitBuffer = "";
			for (const seq of imageTransmits) transmitBuffer += seq;
			this.terminal.write(transmitBuffer);
		}
		// Skip an identical repaint (the modal is mostly static between
		// keystrokes) — unless a forced repaint (resetDisplay,
		// requestRender(true)) is pending: the redraw gesture must repair a
		// corrupted modal even when our cached frame is byte-identical.
		const force = this.#forceViewportRepaintOnNextRender;
		this.#forceViewportRepaintOnNextRender = false;
		if (!force && this.#altPreviousLines.length === height) {
			let same = true;
			for (let r = 0; r < height; r++) {
				if (fitted[r] !== this.#altPreviousLines[r]) {
					same = false;
					break;
				}
			}
			if (same) return;
		}
		let buffer = `${this.#paintBeginSequence}\x1b[H`;
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(fitted[r], width, r, -1, -1, this.#osc66SpacerGlyphWidth(fitted, r));
		}
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#altPreviousLines = fitted;
		this.#debugPaint = { lines: fitted, windowTop: 0, altScreen: true };
		this.#fullRedrawCount += 1;
	}
}
