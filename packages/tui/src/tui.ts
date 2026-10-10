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
import { getDebugLogPath } from "@oh-my-pi/pi-utils/dirs";
import { $flag } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import type { TspFrame, TspNode, TspText } from "@oh-my-pi/pi-wire";
import { DEFAULT_MAX_INLINE_IMAGES, ImageBudget } from "./components/image";
import { TuiDebugServer } from "./debug-server";
import { isKeyRelease, matchesKey } from "./keys";
import { KITTY_PLACEHOLDER } from "./kitty-graphics";
import { LoopWatchdog } from "./loop-watchdog";
import { assumedTspHello, NativeBackend, type NativeHost } from "./native/backend";
import { col } from "./native/describe";
import { TSP_PREFIX, type TspHello } from "./native/encode";
import type { DescribeContext, NativeNode, NativeScreen, NativeSurfaceProvider, NativeUiEvent } from "./native/node";
import { STDOUT_BACKLOG_CLEAR_BYTES, setAltScreenActive, type Terminal } from "./terminal";
import { classifyTerminalMultiplexerModule, terminalMultiplexerSessions } from "./terminal-multiplexer";
import {
	encodeKittyDeleteAllImages,
	encodeKittyDeleteImage,
	encodeKittyPlacementLine,
	ImageProtocol,
	isImageProtocolForced,
	isInsideTerminalMultiplexer,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	setTerminalImageProtocol,
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
	TERMINAL,
} from "./terminal-capabilities";
import { compositeLineAt } from "./render/composite";
import {
	Ellipsis,
	getWidthConfigEpoch,
	isOsc66Line,
	normalizeTerminalOutput,
	osc66MaxScale,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "./utils";

/** Full-attribute reset terminating each rendered content row. */
export const SEGMENT_RESET = "\x1b[0m";
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
// tmux expires synchronized output after one second. Renew during large
// replays as the output queue drains, at complete sequence/row boundaries.
const SYNC_OUTPUT_RENEW_BYTES = 16 * 1024;
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const PAINT_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`;
const PAINT_END = `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}`;
const PAINT_BEGIN_NO_SYNC = `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
const PAINT_END_NO_SYNC = ENABLE_AUTOWRAP;
// Mouse reporting is scoped to fullscreen overlays that opt into pointer
// interaction, plus the opt-in normal-buffer click capture (`tui.mouse`).
// 1000h = button click tracking, 1003h = any-motion tracking for hover
// targets, and 1006h = SGR extended coordinates past column/row 223.
// Selection-first surfaces leave these modes disabled so the terminal retains
// native text selection.
const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

type MouseTrackingState = "off" | "inline" | "full";

/**
 * `PI_TUI_RESIZE_IN_PLACE=1|true` forces in-place resize (no alt-buffer borrow).
 * `0|false` forces the alt-buffer path even on Warp. Unset defers to Warp detection:
 * Warp re-reports its size on CSI ?1049h / CSI ?1049l, which the resize alt-borrow
 * turns into a flicker loop.
 */
function resizeInPlaceOverride(): boolean | null {
	const override = Bun.env.PI_TUI_RESIZE_IN_PLACE;
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	return null;
}
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

/** Rows painted by one TUI frame, observed through `TUIOptions.onPaint`. */
export interface TuiPaint {
	/** Rows committed above the viewport by this paint (native scrollback). Empty on diff paints and alt-screen paints. */
	readonly history: readonly string[];
	/** Complete live viewport after this paint: one prepared (normalized, width-truncated, SGR-coalesced) ANSI string per row. */
	readonly viewport: readonly string[];
	/** True when this paint erased scrollback and repainted from row zero (destructive reset or history replay): consumers drop their history copy before applying `history`. */
	readonly reset: boolean;
	/** True when `viewport` is an alternate-screen overlay; history is untouched. */
	readonly alt: boolean;
	readonly columns: number;
	readonly rows: number;
}

/** Observer of completed terminal paints; see {@link TUI.addPaintListener}. */
export type PaintListener = (paint: TuiPaint) => void;

export interface TUIOptions {
	renderScheduler?: RenderScheduler;
	onPaint?: PaintListener;
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
	 *
	 * A terminal expected to speak TSP needs raw input from the start, so it
	 * gets it; its keystrokes are held instead (TSP events and the cell-size
	 * reply still apply) until {@link TUI.releaseHeldInput} replays them.
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

	/** Inline decision panels must keep displaced settled transcript rows in
	 * native scrollback even when mounted inside a transient editor container. */
	readonly retireDisplacedTranscript?: boolean;

	/**
	 * Describe the component semantically for a Tern Surface Protocol
	 * terminal (see `native/node.ts`). Called instead of `render()` when the
	 * native backend is active. Return the same node object while nothing
	 * changed; return null to fall back to `render()` rows.
	 */
	describe?(cx: DescribeContext): NativeNode | null;

	/**
	 * Props for the native `overlay` wrapper when this component is shown as
	 * an overlay: the sheet's `role` (Tern styles `omp.overlay.*` roles as
	 * glass sheets, so the component's own root must not draw a second frame),
	 * `head` spans for the sheet's title row, and `size`/`anchor` overriding
	 * the ones derived from the overlay options.
	 */
	nativeOverlay?: {
		role?: string;
		head?: TspText;
		size?: "sm" | "md" | "lg" | "full";
		anchor?: "center" | "top" | "bottom";
	};

	/**
	 * True when this component, shown as an overlay, describes a data-first
	 * sheet (`picker`, `prefs`) that is its own frame: the backend puts it
	 * directly in `layer` with no `overlay` wrapper. Usually
	 * `cx.supports("picker")`, so older terminals keep the wrapped fallback.
	 */
	nativeSheet?(cx: DescribeContext): boolean;

	/**
	 * A fullscreen overlay that is a page of its own rather than one block:
	 * the regions (and role) of the screen surface it fills, instead of the
	 * default lone `main` child. Put the component itself in `dock` to keep
	 * its focus target and events.
	 */
	describeScreen?(cx: DescribeContext): NativeScreen;

	/** User actions on nodes this component described (toggle, select, activate, custom). */
	handleNativeEvent?(event: NativeUiEvent): void;

	/**
	 * Pure preflight for focused input that must precede TUI-wide input listeners
	 * and debug shortcuts. A true result routes the event to this component first.
	 */
	capturesInput?(data: string): boolean;

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
	 * Optional hook to drop memoized render output (rows, parse and wrap state)
	 * that the next `render()` can rebuild from state the component keeps.
	 * Unlike {@link invalidate}, it must not rebuild anything eagerly: no
	 * renderer or extension callbacks, no image conversions, and no child
	 * replacement or disposal. The next render must return the same rows it
	 * would have returned without the release. Components without it are
	 * simply not released.
	 */
	releaseRenderCaches?(): void;
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
	// Memoized native description: rebuilt only when the child list changes, so
	// the reconciler can skip an unchanged container by reference.
	#nativeNode: NativeNode | undefined;
	#nativeChildren: readonly Component[] = [];

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
		this.#memoChildLines = [];
	}

	/** Dispose every child, then detach it from this container. */
	disposeChildren(): void {
		this.dispose();
		this.clear();
	}

	invalidate(): void {
		// The per-child refs pin every row the children last rendered; dropping
		// only the concatenation would keep all of them reachable.
		this.#memoLines = undefined;
		this.#memoChildLines = [];
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	releaseRenderCaches(): void {
		this.#memoLines = undefined;
		this.#memoChildLines = [];
		for (const child of this.children) {
			child.releaseRenderCaches?.();
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

	describe(_cx: DescribeContext): NativeNode | null {
		const children = this.children;
		const previous = this.#nativeChildren;
		let unchanged = this.#nativeNode !== undefined && previous.length === children.length;
		for (let i = 0; unchanged && i < children.length; i++) unchanged = previous[i] === children[i];
		if (unchanged) return this.#nativeNode!;
		this.#nativeChildren = children.slice();
		this.#nativeNode = col(this.#nativeChildren);
		return this.#nativeNode;
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
	widthEpoch: number;
	imageProtocol: ImageProtocol | null;
	line: string;
	terminalContent: string;
	asciiWidth: number | undefined;
	isImage: boolean;
	hasOsc8: boolean;
}

interface PreparedLines {
	lines: string[];
	rows: PreparedLine[];
}

interface LineClassification {
	asciiWidth: number | undefined;
	isImage: boolean;
	hasOsc8: boolean;
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
const CC_KITTY_PLACEHOLDER_HIGH = KITTY_PLACEHOLDER.charCodeAt(0);
const CC_BRACKET = 0x5b; // [
const CC_M = 0x6d; // m
const CC_SEMI = 0x3b; // ;
const CC_COLON = 0x3a; // :
const ANSI_TEXT = 0;
const ANSI_CSI = 1;
const ANSI_OSC = 2;
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
function endsWithIncompleteExtendedColor(line: string, start: number, end: number): boolean {
	let tokenStart = start;
	let needsMode = false;
	let valuesRemaining = 0;
	for (let i = start; i <= end; i++) {
		if (i !== end && line.charCodeAt(i) !== CC_SEMI) continue;
		const tokenLength = i - tokenStart;
		const first = line.charCodeAt(tokenStart);
		if (valuesRemaining > 0) {
			valuesRemaining--;
		} else if (needsMode && tokenLength === 1 && (first === 0x32 || first === 0x35)) {
			valuesRemaining = first === 0x32 ? 3 : 1;
			needsMode = false;
		} else {
			// An unrecognized mode is also a standalone token: `38;48;5`
			// still ends in an incomplete background palette spec.
			needsMode = tokenLength === 2 && first >= 0x33 && first <= 0x35 && line.charCodeAt(tokenStart + 1) === 0x38;
		}
		tokenStart = i + 1;
	}
	return needsMode || valuesRemaining > 0;
}

/**
 * Merge runs of byte-adjacent SGR sequences (`CSI [0-9;:]* m`) into one. Only
 * CSI-SGR sequences are touched; text, cursor moves, OSC, hyperlinks and image
 * payloads pass through verbatim. Isolated sequences require no parameter
 * slices or arrays; output is built only at merged boundaries or empty resets
 * that need normalization within an adjacent run.
 */
export function coalesceAdjacentSgr(line: string): string {
	if (!SGR_COALESCE_ENABLED) return line;
	const n = line.length;
	let out = "";
	let copiedUpto = 0;
	let i = line.indexOf("\x1b[");
	while (i !== -1) {
		// Scan a candidate SGR sequence: ESC [ <params> m.
		let start = i + 2;
		let j = start;
		let groupTokens = 1;
		while (j < n && isSgrParamByte(line.charCodeAt(j))) {
			const cc = line.charCodeAt(j++);
			if (cc === CC_SEMI || cc === CC_COLON) groupTokens++;
		}
		if (j >= n || line.charCodeAt(j) !== CC_M) {
			// Not an SGR (e.g. cursor move); leave it in the pending region.
			i = line.indexOf("\x1b[", j);
			continue;
		}

		let adjacent = false;
		let k = j + 1;
		while (k < n && line.charCodeAt(k) === CC_ESC && line.charCodeAt(k + 1) === CC_BRACKET) {
			const nextStart = k + 2;
			let p = nextStart;
			let tokens = 1;
			while (p < n && isSgrParamByte(line.charCodeAt(p))) {
				const cc = line.charCodeAt(p++);
				if (cc === CC_SEMI || cc === CC_COLON) tokens++;
			}
			if (p >= n || line.charCodeAt(p) !== CC_M) break;
			adjacent = true;

			// Keep the boundary if the preceding list could absorb a missing
			// channel/index, or if merging would overflow the parameter cap.
			// Otherwise replace only `m ESC [` with `;`, keeping the source
			// untouched until a boundary actually merges. Empty lists in an
			// adjacent run normalize to `0`, including at a guarded boundary.
			if (groupTokens + tokens <= MERGE_TOKEN_CAP && !endsWithIncompleteExtendedColor(line, start, j)) {
				out += line.slice(copiedUpto, j) + (start === j ? "0;" : ";");
				copiedUpto = nextStart;
				groupTokens += tokens;
			} else {
				if (start === j) {
					out += `${line.slice(copiedUpto, j)}0`;
					copiedUpto = j;
				}
				groupTokens = tokens;
			}
			start = nextStart;
			j = p;
			k = p + 1;
		}
		if (adjacent && start === j) {
			out += `${line.slice(copiedUpto, j)}0`;
			copiedUpto = j;
		}
		i = line.indexOf("\x1b[", k);
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
	// Net composer-space offset of the published hit-test origin behind the
	// painted top, from the last paint: replay-replaced rows minus viewport
	// rows the paint prepended for a short viewport. Negative while prepended
	// blanks outweigh replaced rows; zero on ordinary frames.
	#providerViewportPadTop = 0;
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
	// Whether any step of the burst left the committed width / geometry. The
	// terminal reflowed the normal buffer at every intermediate step, so a drag
	// that returns to its starting size still shredded retained history and
	// pushed unerased live rows into it; the settled refresh must key on the
	// whole burst, not on the net change (see #prepareResizeReplay).
	#resizeBurstWidthChanged = false;
	#resizeBurstResized = false;
	// A shrink can discard live rows below the cursor and push others into
	// scrollback. Rebuild must repair that even when the burst ends taller.
	#resizeBurstShrank = false;
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
	// The structured sidecar owns classification/coalescing results for reuse;
	// #providerWindow remains the exact normalized string projection used by
	// the established differential comparison and resize accounting.
	#providerWindow: string[] = [];
	#providerPreparedRows: PreparedLine[] = [];
	// Rows of the last marker-stripping prepare pass keyed by their stripped
	// raw line, so rows that only moved (a scroll or a history commit shifts
	// every row under the positional sidecar) reuse their preparation. Swapped
	// with the spare each pass, which bounds the memo to one frame of rows.
	#preparedLineMemo = new Map<string, PreparedLine>();
	#preparedLineMemoSpare = new Map<string, PreparedLine>();
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
	#paintListeners = new Set<PaintListener>();

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
	/**
	 * Smallest settled tmux replay that is preceded by a `Rebuilding…` notice.
	 * The notice can only be published ahead of the replay (tmux holds the
	 * pane's synchronized update until the replay ends), so it stays up for
	 * exactly as long as tmux takes to ingest the replay. tmux next-3.9 on
	 * Apple silicon ingests a real transcript replay at ~14 MiB/s, so this is
	 * about half a second there. A smaller replay finishes before the notice
	 * can be read, and showing it would only flash a status row.
	 */
	static readonly #RESIZE_REBUILD_NOTICE_MIN_BYTES = 7 * 1024 * 1024;
	#inputRenderGraceUntilMs = 0;
	// A scale-`s` OSC 66 heading reserves `s - 1` rows, and the protocol
	// caps `s` at 7. This bounds spacer lookups and supplies enough context
	// above the resize viewport to classify every legal heading exactly.
	static readonly #OSC66_MAX_SPACER_ROWS = 6;
	// Ghostty can drop Kitty graphics commands sent during its first post-startup
	// settle window, leaving only Unicode placeholder cells. Hold the first image
	// paint until that window has passed; later images render normally.
	static readonly #GHOSTTY_INITIAL_IMAGE_DELAY_MS = 100;
	#hardwareCursorRow = 0; // Normal-buffer cursor row, retained while the alternate buffer is active.
	#hardwareCursorState: HardwareCursorState | null = null; // Current buffer's cursor paint/dedupe state.
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
	/**
	 * Keystrokes held since a TSP `deferInput` start, replayed by
	 * releaseHeldInput(); undefined when not holding.
	 */
	#heldInput: string[] | undefined;
	/**
	 * The component focused when holding began. Only its keystrokes are held:
	 * a dialog that takes focus meanwhile (a startup hook's select or confirm)
	 * gets its input live.
	 */
	#heldFocus: Component | null = null;
	// Always-on event-loop lag probe. The high default threshold keeps it quiet;
	// it only logs `ui.loop-blocked` (with the current loop phase) when a frame
	// budget is genuinely starved. Armed in start(), disarmed in stop().
	#watchdog: LoopWatchdog;

	// Transient alternate-screen state for a fullscreen overlay. While active, the
	// engine paints only the modal on the alt buffer and leaves every
	// normal-screen accounting field (#previousFrameLength, #viewportTopRow, …)
	// untouched, so exiting reconciles cleanly against the terminal-restored
	// normal screen. #altPreviousLines is the last alt frame, diffed row by row
	// against the next one.
	#altActive = false;
	#mouseTracking: MouseTrackingState = "off";
	/** Product-owned probe for opt-in normal-buffer click capture (`tui.mouse`). Read every frame. */
	#inlineMouseProvider: (() => boolean) | undefined;
	#altPreviousLines: string[] = [];
	#altPreparedRows: PreparedLine[] = [];
	#altEnterWidth = 0;
	#altEnterHeight = 0;
	#resizeAltActive = false;
	#resizeSettleTimer: RenderTimer | undefined;
	#suppressResizeUntil = 0;
	// Baseline geometry at the last alt-buffer toggle, plus whether its echo is
	// still pending. A Warp-only echo is a height-only ±1 SIGWINCH against this
	// baseline while the CPR probe is in flight. The expectation is single-shot:
	// the first SIGWINCH after the toggle consumes it, so a real one-row resize
	// back to the baseline can never be mistaken for the echo.
	#altToggleColumns = 0;
	#altToggleRows = 0;
	#altToggleEchoPending = false;
	// True while an in-place resize waits for its settled rebuild (tmux) or
	// anchor recovery (Warp): ordinary paints must not use the stale anchor.
	#resizeInPlaceActive = false;
	#resizeScrollbackMode: ResizeScrollbackMode = TUI.#initialResizeScrollbackMode();
	#resizeReplaySize: string | undefined;
	// The resize borrow's entry (live-viewport erase, CSI ?1049h, keyboard
	// push), held for the first resize frame's synchronized update. Written on
	// its own, the terminal can present the blank alternate screen for a frame
	// before the resize frame lands.
	#pendingAltEnter = "";
	// Holds an alternate-screen exit until its replacement full paint can emit it
	// atomically. It must survive a deferred Ghostty image frame.
	#pendingAltExit = "";
	// True while #pendingAltExit holds the resize borrow's own exit: the
	// settle fused it into the destructive rebuild, so the terminal is still
	// on the borrowed alt buffer until that frame is written. A SIGWINCH or a
	// fullscreen overlay arriving first adopts the buffer instead of entering
	// it again (see #settleResizeAltPaint).
	#resizeAltExitFused = false;

	// Tern Surface Protocol backend, created when the terminal answers the
	// `hello` probe, or at start when the environment names Tern. Kept across
	// stop/start so a restart adopts the surface.
	#native: NativeBackend | undefined;
	#nativeLive = false;
	// Holds the first paint while the `hello` probe is outstanding, so a TSP
	// terminal never sees a row paint it would have to erase.
	#nativeHoldTimer: RenderTimer | undefined;
	static readonly #NATIVE_PROBE_HOLD_MS = 300;
	// Optimistic start (`TERM_PROGRAM=tern`): the surface is live on assumed
	// capabilities until the real `hello` reply confirms it. Without a reply
	// by the deadline the surface closes and rows repaint.
	#nativeUnconfirmed = false;
	#nativeConfirmTimer: RenderTimer | undefined;
	static readonly #NATIVE_CONFIRM_MS = 1000;
	// A deadline that fires this late ran after an event-loop stall (module
	// loading), possibly with the reply already queued on stdin: re-arm for
	// this long so input gets a turn before giving up.
	static readonly #NATIVE_CONFIRM_GRACE_MS = 100;

	// Overlay stack for modal components rendered on top of base content
	overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
		/**
		 * A sheet the user clicked away from (see {@link TUI.#focusFromPointer}):
		 * it stays up but no longer holds the keys, until focus moves back into it.
		 */
		released: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options?: TUIOptions) {
		super();
		this.terminal = terminal;
		this.#renderScheduler = options?.renderScheduler ?? DEFAULT_RENDER_SCHEDULER;
		if (options?.onPaint) this.#paintListeners.add(options.onPaint);
		this.#showHardwareCursor = showHardwareCursor === undefined ? this.#showHardwareCursor : showHardwareCursor;
		this.#watchdog = new LoopWatchdog();
	}
	static #initialResizeScrollbackMode(): ResizeScrollbackMode {
		const mode = Bun.env.PI_TUI_RESIZE_SCROLLBACK;
		return mode === "append" || mode === "rebuild" || mode === "preserve" ? mode : "preserve";
	}

	/**
	 * Observe completed terminal paints; returns the unsubscribe. Independent
	 * observers (live stream publisher, session recorder) coexist.
	 */
	addPaintListener(listener: PaintListener): () => void {
		this.#paintListeners.add(listener);
		return () => {
			this.#paintListeners.delete(listener);
		};
	}

	/** Install the product-owned bounded frame provider. */
	setFrameProvider(provider: TerminalFrameProvider | undefined): void {
		this.#frameProvider = provider;
		this.#providerWindow = [];
		this.#providerPreparedRows = [];
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
		const holder = this.#getKeyHolderOverlay();
		if (holder && !isOverlayFocusTarget(holder.component, component)) {
			const currentFocus = this.#focusedComponent;
			component = isOverlayFocusTarget(holder.component, currentFocus) ? currentFocus : holder.component;
		}
		// Focus moving back into a released sheet makes it hold the keys again.
		for (const entry of this.overlayStack) {
			if (entry.released && isOverlayFocusTarget(entry.component, component)) entry.released = false;
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
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false, released: false };
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
						this.setFocus(this.#getKeyHolderOverlay()?.component ?? entry.preFocus);
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
					// If this overlay or one of its owned targets had focus, move focus to the next one holding keys or preFocus
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						this.setFocus(this.#getKeyHolderOverlay()?.component ?? entry.preFocus);
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
		// Find the topmost visible overlay holding keys, or fall back to preFocus
		this.setFocus(this.#getKeyHolderOverlay()?.component ?? overlay.preFocus);
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

	/**
	 * Mutable normal-buffer viewport from the last provider frame: screen row
	 * where it begins plus its row count. Inline click targets are indexed
	 * into this window (`screenRow - top`). Empty while the alt screen owns
	 * the display, while a resize transaction is settling, and while a Ghostty
	 * image paint is deferred — the painted rows predate the latest spans in
	 * all three cases, so hits would map to unrelated old rows.
	 * The origin is in composer rows: a replay paint replaces leading composer
	 * blanks with history rows and prepends blanks for a short viewport, so
	 * the painted top is backed out by that net pad.
	 */
	getMutableViewport(): { top: number; length: number } {
		if (
			this.#altActive ||
			this.#resizeAltActive ||
			this.#resizeProbe !== undefined ||
			this.#resizeInPlaceActive ||
			this.#ghosttyInitialImageDelayTimer !== undefined
		) {
			return { top: 0, length: 0 };
		}
		return { top: this.#providerViewportTop - this.#providerViewportPadTop, length: this.#providerWindow.length };
	}

	/**
	 * Probe for opt-in normal-buffer click capture. The provider is read every
	 * frame; while it returns true (and no fullscreen overlay owns the
	 * display) the terminal reports button clicks as SGR events for inline
	 * click targets. Native text selection becomes Shift+drag while on.
	 */
	setInlineMouseTrackingProvider(provider: (() => boolean) | undefined): void {
		this.#inlineMouseProvider = provider;
	}

	/** Transition mouse reporting, emitting only the sequences a change needs. */
	#setMouseTracking(state: MouseTrackingState): void {
		if (state === this.#mouseTracking) return;
		const wasOff = this.#mouseTracking === "off";
		this.#mouseTracking = state;
		if (state === "off") {
			if (!wasOff) this.terminal.write(MOUSE_TRACKING_OFF);
			return;
		}
		// Inline and fullscreen reporting are the same bytes: moving between
		// live modes needs no emission, only entering from off does.
		if (wasOff) this.terminal.write(MOUSE_TRACKING_ON);
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

	/** The topmost visible overlay that holds the keys: not a sheet the user clicked away from. */
	#getKeyHolderOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			const entry = this.overlayStack[i];
			if (!entry.released && this.#isOverlayVisible(entry)) return entry;
		}
		return undefined;
	}

	/**
	 * Moves keyboard focus where the user clicked (the terminal's `focus` event,
	 * see {@link NativeHost.focusFromPointer}). A click inside an overlay gives it
	 * the keys unless they are already inside it. A click on `field` under the
	 * overlays focuses it only when every visible overlay is a `sheet` (a panel
	 * beside the content, like `/settings` docked in Tern): those stay up but
	 * stop holding the keys until focus moves back into one of them.
	 */
	#focusFromPointer(
		owners: readonly Component[],
		field: Component | null,
		sheet: (overlay: Component) => boolean,
	): void {
		const visible = this.overlayStack.filter(entry => this.#isOverlayVisible(entry));
		const overlay = visible.findLast(entry => owners.some(owner => isOverlayFocusTarget(entry.component, owner)));
		if (overlay) {
			if (!isOverlayFocusTarget(overlay.component, this.#focusedComponent)) this.setFocus(overlay.component);
			return;
		}
		if (!field || field === this.#focusedComponent || !visible.every(entry => sheet(entry.component))) return;
		for (const entry of visible) entry.released = true;
		this.setFocus(field);
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
		// A terminal expected to speak TSP gets its surface from the first frame,
		// and a live surface needs raw input from the start: its events (resize,
		// acks) would otherwise be echoed into the grid by the cooked tty, and the
		// `hello` query must go out now to confirm the surface.
		const nativeExpected = this.terminal.tspExpected === true;
		this.#inputDeferred = options?.deferInput === true && !nativeExpected;
		// A restart (a startup dialog's external editor stops and restarts the
		// TUI) keeps an existing hold: those keys still belong to the editor.
		if (options?.deferInput === true && nativeExpected) {
			this.#heldInput = [];
			this.#heldFocus = this.#focusedComponent;
		}
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
			// Some multiplexer VTEs (Herdr's Ghostty pane) honor DEC 2026 even when
			// DECRQM is unanswered or reports unrecognized (status 0). Other
			// confirmed unsupported reports still disable: status 4 is permanently
			// reset, and a three-argument callback (`status` omitted) is a
			// definitive unsupported from a custom Terminal that does not
			// distinguish DECRPM codes.
			if (
				!supported &&
				status === 0 &&
				terminalMultiplexerSessions().some(multiplexer => multiplexer.honorsSynchronizedOutput)
			) {
				return;
			}
			this.#setSynchronizedOutput(supported);
		});
		// Icons painted before the Glyph Protocol registration landed may sit in
		// the terminal as tofu; a full repaint re-emits them against the glossary.
		this.terminal.onGlyphProtocolReport?.(supported => {
			if (!supported || this.#stopped) return;
			this.invalidate();
			this.requestRender(true);
		});
		this.terminal.onTspHello?.(hello => this.#onTspHello(hello));
		this.terminal.start(
			data => this.#handleInput(data),
			() => {
				if (this.#nativeLive) {
					// The terminal lays the surface out: a resize only refreshes the
					// width `rows` fallback nodes render at. No replay.
					this.#native!.noteTerminalColumns(this.terminal.columns);
					return;
				}
				if (this.#resizeProbe) {
					// Warp echoes a height-only ±1 SIGWINCH on CSI ?1049l. The echo
					// must not restart the alt borrow (that is the flicker loop),
					// but the terminal really did adopt the echoed size, so a CPR
					// reply already in flight may predate it: retire the probe and
					// reissue it at the new geometry. DSR-only, no toggle, so this
					// terminates. A real geometry change restarts the transaction below.
					if (this.#isWarpAltToggleEcho()) {
						this.#cancelResizeProbe();
						this.#trackResizeBurst();
						this.#beginResizeAnchorProbe();
						return;
					}
					this.#cancelResizeProbe();
					if (this.#resizeAvoidsAltBuffer()) this.#beginResizeInPlacePaint();
					else this.#beginResizeAltPaint(true);
					return;
				}
				if (this.#altActive) {
					// A fullscreen overlay owns the alt buffer: repaint the modal at
					// the new size. Never snapshot the normal window or probe its
					// anchor against the alternate grid — not even for a toggle echo.
					this.requestRender(true);
					return;
				}
				if (!this.#resizeAltActive && this.#isWarpAltToggleEcho()) {
					// Delayed echo that lost the signal-vs-pty race with its own
					// probe's CPR reply: the probe already resolved, so re-probe at
					// the echoed size instead of painting on a stale anchor or
					// suppressing into a forced replay. DSR-only, no borrow.
					// While the resize borrow is active the echo is swallowed
					// without probing: a CPR issued now would snapshot the
					// alternate grid and anchor the normal viewport to its row.
					this.#resizeProbeWindow = this.#providerWindow;
					this.#resizeProbeOffset = this.#parkedViewportOffset;
					this.#trackResizeBurst();
					this.#beginResizeAnchorProbe();
					return;
				}
				if (this.#renderScheduler.now() < this.#suppressResizeUntil) {
					this.requestRender(true);
					return;
				}
				if (this.#resizeAvoidsAltBuffer()) {
					this.#beginResizeInPlacePaint();
					return;
				}
				this.#beginResizeAltPaint();
			},
			() => this.stop(),
			{ deferInput: this.#inputDeferred, isLoopStalled: () => this.#watchdog.isStalled() },
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
		if (nativeExpected && this.terminal.tspProbePending && !this.#nativeLive) {
			this.#startNative(assumedTspHello(this.terminal));
			this.#nativeUnconfirmed = true;
			this.#armNativeConfirm(TUI.#NATIVE_CONFIRM_MS);
		} else if (this.terminal.tspProbePending && !this.#nativeLive) {
			this.#nativeHoldTimer = this.#renderScheduler.scheduleRender(() => {
				this.#nativeHoldTimer = undefined;
				if (!this.#stopped && !this.#nativeLive) this.requestRender(true);
			}, TUI.#NATIVE_PROBE_HOLD_MS);
		}
		this.requestRender(true, { clearScrollback: options?.clearScrollback === true });
	}

	/** Whether frames go to a Tern Surface Protocol surface instead of the row renderer. */
	get nativeRendering(): boolean {
		return this.#nativeLive;
	}

	/**
	 * Close the TSP surfaces ahead of {@link stop}, before the exit drains
	 * input: the terminal answers nothing once they are closed, and whatever it
	 * already sent (acks, events) is read and dropped here instead of reaching
	 * the shell as typed text. A render already requested (the exit's status
	 * line) goes out first; none is forced, and nothing renders from now until
	 * `stop()`.
	 */
	closeNative(): void {
		if (!this.#nativeLive) return;
		if (this.#renderRequested) {
			this.#renderTimer?.cancel();
			this.#runScheduledRender();
		}
		this.#native!.stop();
	}

	/** Reference document the TSP terminal should hold (debug mirror only). */
	getNativeDocument(): TspNode | undefined {
		return this.#nativeLive ? this.#native?.document() : undefined;
	}

	/** Most recent TSP frames sent (debug mirror only). */
	getNativeFrames(count?: number): readonly TspFrame[] {
		return this.#native?.recentFrames(count) ?? [];
	}

	/** `rows` fallback nodes in the last native frame. */
	get nativeFallbackCount(): number {
		return this.#native?.fallbackCount ?? 0;
	}

	#onTspHello(hello: TspHello | null): void {
		const held = this.#nativeHoldTimer !== undefined;
		this.#nativeHoldTimer?.cancel();
		this.#nativeHoldTimer = undefined;
		if (this.#stopped) return;
		if (this.#nativeUnconfirmed) {
			if (hello === null) {
				this.#revokeNative("the DA1 sentinel came before a TSP hello reply, or the reply's version is unsupported");
				return;
			}
			this.#clearNativeConfirm();
			this.#native!.confirm(hello);
			return;
		}
		if (this.#nativeLive) return;
		if (hello === null) {
			if (held) this.requestRender(true);
			return;
		}
		this.#startNative(hello);
	}

	/** Switch to the surface (adopting the one a stop/start cycle closed). */
	#startNative(hello: TspHello): void {
		this.#eraseRowPaintForNative();
		this.#nativeLive = true;
		if (this.#native) {
			this.#native.resume(hello);
			return;
		}
		this.#native = new NativeBackend(this.#nativeHost(), hello, {
			mirror: this.#debugServer !== undefined,
			scheduler: this.#renderScheduler === DEFAULT_RENDER_SCHEDULER ? undefined : this.#renderScheduler,
		});
		this.#native.start();
	}

	/**
	 * Deadline for the `hello` reply after an optimistic start. A deadline that
	 * fired late ran after an event-loop stall, possibly with the reply already
	 * queued on stdin, so it re-arms briefly to let input run first.
	 */
	#armNativeConfirm(delayMs: number): void {
		const due = this.#renderScheduler.now() + delayMs;
		this.#nativeConfirmTimer = this.#renderScheduler.scheduleRender(() => {
			this.#nativeConfirmTimer = undefined;
			if (!this.#nativeUnconfirmed || this.#stopped) return;
			if (this.#renderScheduler.now() - due > TUI.#NATIVE_CONFIRM_GRACE_MS) {
				this.#armNativeConfirm(TUI.#NATIVE_CONFIRM_GRACE_MS);
				return;
			}
			this.#revokeNative(`no TSP hello reply within ${TUI.#NATIVE_CONFIRM_MS} ms`);
		}, delayMs);
	}

	#clearNativeConfirm(): void {
		this.#nativeUnconfirmed = false;
		this.#nativeConfirmTimer?.cancel();
		this.#nativeConfirmTimer = undefined;
	}

	/**
	 * The optimistic surface was never confirmed: close it without keeping
	 * anything and repaint every row. A reply that still arrives later switches
	 * to a fresh surface the usual way.
	 */
	#revokeNative(reason: string): void {
		this.#clearNativeConfirm();
		logger.warn("TSP: terminal did not confirm the surface; falling back to rows", { reason });
		this.#nativeLive = false;
		this.#native?.stop(false);
		this.#native = undefined;
		this.requestRender(true);
	}

	/**
	 * The handshake landed after the row renderer painted (deferred input):
	 * leave the alternate screen if borrowed and erase the painted viewport so
	 * the surface opens where the rows began.
	 */
	#eraseRowPaintForNative(): void {
		this.#cancelResizeProbe();
		this.#resizeSettleTimer?.cancel();
		this.#resizeSettleTimer = undefined;
		if (this.#altActive || this.#resizeAltActive) {
			this.terminal.write(`${this.#takePendingAltEnter()}${this.#keyboardEnhancementExit()}\x1b[?1049l`);
			setAltScreenActive(false);
			this.#altActive = false;
			this.#resizeAltActive = false;
		}
		this.#setMouseTracking("off");
		if (this.#previousFrameLength > 0) {
			const lineDiff = this.#providerViewportTop - this.#hardwareCursorRow;
			if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
			else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
			this.terminal.write("\r\x1b[J");
			this.#previousFrameLength = 0;
			this.#providerWindow = [];
			this.#providerPreparedRows = [];
		}
		this.terminal.hideCursor();
		this.#forgetHardwareCursorState();
	}

	#nativeHost(): NativeHost {
		return {
			terminal: this.terminal,
			describeSurface: cx => {
				const provider = this.#frameProvider as
					| (TerminalFrameProvider & Partial<NativeSurfaceProvider>)
					| undefined;
				if (provider?.describeSurface) return provider.describeSurface(cx);
				return { main: this.children, dock: [] };
			},
			overlays: () => {
				const visible = [];
				for (const entry of this.overlayStack) {
					if (!this.#isOverlayVisible(entry)) continue;
					visible.push({
						component: entry.component,
						options: entry.options,
						focused: isOverlayFocusTarget(entry.component, this.#focusedComponent),
					});
				}
				return visible;
			},
			focused: () => this.#focusedComponent,
			focusFromPointer: (owners, field, sheet) => this.#focusFromPointer(owners, field, sheet),
			requestRender: () => this.requestRender(),
			appearanceChanged: () => {
				this.terminal.refreshAppearance?.();
			},
			motionChanged: () => {
				this.invalidate();
				this.requestRender();
			},
			invalidate: () => this.invalidate(),
		};
	}
	/**
	 * Whether a resize only repaints the visible window in place, without history
	 * replay. Warp re-reports its size on alt-buffer toggles, so borrowing there
	 * self-sustains. Inside a multiplexer the mux owns the grid and consumes the
	 * toggles itself, so an inherited Warp marker must not suppress its replay.
	 * tmux's synchronized rebuild is selected separately in #resizeAvoidsAltBuffer.
	 *
	 * A ConPTY host is excluded for the same reason as a multiplexer: conhost owns
	 * the grid the application writes to. Measured on conhost, resizing the
	 * pseudoconsole makes it re-emit its whole viewport from `CSI H` with absolute
	 * addressing while the application writes nothing, and it re-homes the cursor,
	 * so the settled DSR reply carries column 1 instead of the probe's tag column
	 * and can never be attributed. In-place resize has neither of its
	 * preconditions there — a recoverable anchor and a grid nobody else
	 * repaints — so keep the borrow, whose settled transaction ends in the
	 * {@link ResizeScrollbackMode} rebuild that erases conhost's stale copy.
	 */
	#resizeRepaintsInPlace(): boolean {
		const override = resizeInPlaceOverride();
		if (override !== null) return override;
		if (isInsideTerminalMultiplexer() || this.terminal.hostOwnsGridOnResize === true) return false;
		return Bun.env.TERM_PROGRAM?.toLowerCase() === "warpterminal";
	}

	#resizeAvoidsAltBuffer(): boolean {
		if (this.#resizeRepaintsInPlace()) return true;
		// Unlike Warp's viewport-only repaint, tmux still rebuilds history.
		// Restoring an alternate buffer schedules a tmux redraw that ends its
		// synchronized update early, exposing the rest of a long replay.
		return (
			!this.#resizeAltActive &&
			!this.#pendingAltExit &&
			resizeInPlaceOverride() !== false &&
			this.#resizeScrollbackMode === "rebuild" &&
			this.#synchronizedOutputEnabled &&
			classifyTerminalMultiplexerModule()?.altRestoreEndsSynchronizedOutput === true
		);
	}

	#noteAltBufferToggle(): void {
		this.#altToggleColumns = this.terminal.columns;
		this.#altToggleRows = this.terminal.rows;
		this.#altToggleEchoPending = true;
	}

	/**
	 * Warp-only echo: height-only ±1 SIGWINCH against the pending alt-toggle
	 * baseline. Single-shot: the first SIGWINCH after the toggle consumes the
	 * expectation either way, so at most one signal is ever swallowed per toggle.
	 * Never inside a multiplexer, which consumes the toggles itself.
	 */
	#isWarpAltToggleEcho(): boolean {
		if (!this.#altToggleEchoPending) return false;
		this.#altToggleEchoPending = false;
		// Inside a multiplexer the mux consumes alt toggles itself, so no echo is
		// possible: every ±1 resize is real and must restart the transaction.
		if (isInsideTerminalMultiplexer()) return false;
		if (Bun.env.TERM_PROGRAM?.toLowerCase() !== "warpterminal") return false;
		return (
			this.terminal.columns === this.#altToggleColumns && Math.abs(this.terminal.rows - this.#altToggleRows) <= 1
		);
	}

	/**
	 * Fold one SIGWINCH step into the coalesced resize-burst accounting shared by
	 * both resize paths: any grow step poisons the multiplexer clip model, the
	 * accumulated pull bounds CPR-less grow anchors, and the epoch retires the
	 * in-flight CPR tag so a rewrap-invalidated reply cannot anchor a new geometry.
	 */
	#trackResizeBurst(): void {
		const burstLastHeight = this.#resizeBurstLastHeight ?? this.#previousHeight;
		if (this.terminal.rows > burstLastHeight) this.#resizeBurstGrew = true;
		if (this.terminal.rows < burstLastHeight) this.#resizeBurstShrank = true;
		this.#resizeBurstLastHeight = this.terminal.rows;
		this.#resizeBurstPull += Math.max(0, this.terminal.rows - burstLastHeight);
		if (this.terminal.columns !== this.#previousWidth) this.#resizeBurstWidthChanged = true;
		if (this.terminal.columns !== this.#previousWidth || this.terminal.rows !== this.#previousHeight) {
			this.#resizeBurstResized = true;
		}
		this.#geometryEpoch++;
	}

	/**
	 * Coalesced resize without borrowing the alt buffer. Once quiet, tmux can
	 * rebuild directly under synchronized output; viewport-only repaints recover
	 * their anchor with CPR. The existing screen remains visible while waiting.
	 */
	#beginResizeInPlacePaint(): void {
		if (this.#altActive) {
			this.requestRender(true);
			return;
		}
		this.#trackResizeBurst();
		this.#resizeInPlaceActive = true;
		this.#resizeSettleTimer?.cancel();
		this.#forgetHardwareCursorState();
		this.#recordHardwareCursorHidden();
		const erase = this.#liveViewportResizeErase();
		if (erase !== "") {
			this.terminal.write(erase);
			// The erase parked the hardware cursor on the viewport's top row;
			// snapshot the parked offset so the settled probe anchors there.
			this.#parkedViewportOffset = 0;
		}
		this.#resizeSettleTimer = this.#renderScheduler.scheduleRender(() => {
			this.#resizeSettleTimer = undefined;
			if (this.#stopped) return;
			this.#prepareResizeReplay(this.terminal.columns, this.terminal.rows);
			if (this.#clearScrollbackOnNextRender) {
				this.#resizeInPlaceActive = false;
				this.requestRender();
				return;
			}
			this.#resizeProbeWindow = this.#providerWindow;
			this.#resizeProbeOffset = this.#parkedViewportOffset;
			this.#beginResizeAnchorProbe();
		}, TUI.#RESIZE_VIEWPORT_SETTLE_MS);
	}

	/**
	 * Blank the mutable live viewport on the normal screen before a resize
	 * transaction waits out the drag. The terminal keeps reflowing the normal
	 * buffer during the drag, and a height shrink pushes its top rows into
	 * scrollback; with the live region blanked, only committed history rows
	 * (correct to push) or blanks can leave the screen — never live placeholder
	 * rows such as compact tool dots, whose real blocks must enter scrollback
	 * through the ordered history path. Addressing depends on the resize
	 * direction. Terminals keep the parked cursor attached to its logical line
	 * through width rewrap and height-grow scrollback pull-down, so
	 * cursor-relative movement lands on the viewport's top row. On height shrink
	 * kitty clamps the cursor instead of moving it with pushed rows, so
	 * cursor-relative addressing would start rows late; fall back to the same
	 * bottom-preserving bound as resize-anchor recovery.
	 *
	 * Both erase paths leave the cursor on the viewport's top row. Returns the
	 * erase sequence, or "" when there is nothing to erase (multiplexers skip
	 * it: an immediate erase races the pane re-layout and blanks pulled-back
	 * committed rows).
	 */
	#liveViewportResizeErase(): string {
		if (!this.#hasEverRendered || this.#providerWindow.length === 0 || isInsideTerminalMultiplexer()) {
			return "";
		}
		if (this.terminal.rows < this.#previousHeight) {
			const staleRows = this.#reflowedRowCount(
				this.#providerWindow,
				0,
				this.#providerWindow.length,
				this.terminal.columns,
			);
			const top = Math.max(0, Math.min(this.#providerViewportTop, this.terminal.rows - staleRows));
			return `\x1b[?25l${this.#eraseBelowRow(top, this.terminal.rows)}`;
		}
		const up = this.#reflowedRowCount(this.#providerWindow, 0, this.#parkedViewportOffset, this.terminal.columns);
		const eraseBelow = this.#eraseBelowCursorRow(this.terminal.columns, this.terminal.rows);
		return `\x1b[?25l${up > 0 ? `\x1b[${up}A` : ""}${eraseBelow}`;
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
		this.#trackResizeBurst();
		if (!this.#resizeAltActive && this.#resizeAltExitFused) {
			// The settled rebuild has not been written yet, so its fused exit never
			// left the borrowed buffer: resume the borrow there. The live window was
			// already stashed and the rebuild stays latched, so there is nothing to
			// snapshot or erase, and entering again would stack another alt switch.
			this.#resizeAltActive = true;
			this.#pendingAltExit = "";
			this.#resizeAltExitFused = false;
		} else if (!this.#resizeAltActive) {
			this.#resizeAltActive = true;
			setAltScreenActive(true);
			this.#altPreviousLines = [];
			this.#altPreparedRows = [];
			this.#forgetHardwareCursorState();
			this.#recordHardwareCursorHidden();
			// Blank the live region as the borrow enters so a reflow-driven scroll
			// can only push committed rows into scrollback. The erase is computed
			// against this SIGWINCH's geometry but rides in the first resize frame's
			// synchronized update with the buffer switch (#pendingAltEnter), so
			// neither the blanked normal screen nor the empty alternate one is ever
			// presented. The pre-erase window is stashed for
			// the settled CPR probe: its reflowed row count bounds the anchor to
			// `height - staleRows`, so a mis-parked cursor (a single-step tmux zoom
			// re-lays the pane before SIGWINCH delivery, moving the park target
			// under us) cannot anchor the settled repaint over pulled-back history
			// rows or scroll-push the frame into scrollback again.
			if (!restartingProbe) {
				this.#resizeProbeWindow = this.#providerWindow;
				this.#resizeProbeOffset = this.#parkedViewportOffset;
			}
			const erase = this.#liveViewportResizeErase();
			if (erase !== "") {
				// The erase parks the cursor on the viewport's top row, so the
				// parked offset no longer applies; carrying a stale nonzero offset
				// into the probe would anchor the settled repaint above the real
				// viewport top and overwrite visible committed rows.
				this.#resizeProbeOffset = 0;
				this.#providerWindow = [];
				this.#providerPreparedRows = [];
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
				this.#providerPreparedRows = [];
				this.#parkedViewportOffset = 0;
			}
			this.#noteAltBufferToggle();
			this.#imageBudget.beginAltScreenLifecycle();
			this.#pendingAltEnter = `${erase}\x1b[?1049h${this.#keyboardEnhancementEnter()}`;
		}
		this.#resizeSettleTimer?.cancel();
		this.#resizeSettleTimer = this.#renderScheduler.scheduleRender(() => {
			this.#resizeSettleTimer = undefined;
			if (this.#stopped || !this.#resizeAltActive) return;
			this.#settleResizeAltPaint();
		}, TUI.#RESIZE_VIEWPORT_SETTLE_MS);
		this.requestRender(true);
	}

	/**
	 * End the alt-buffer borrow once the resize settles.
	 *
	 * A settle that rebuilds history never needs the viewport anchor: the
	 * destructive reset erases the screen and history and repaints from row
	 * zero. Restoring the normal buffer on its own write would only expose the
	 * reflowed stale screen for the CPR round trip, then clear it and stream
	 * the replay — the one flash a large resize (a tmux zoom) still showed. So
	 * that settle latches the rebuild now and fuses the restore into the same
	 * synchronized write as ED2+ED3 and the replay: the terminal goes straight
	 * from the resize frame to the rebuilt screen.
	 *
	 * Every other settle restores the normal buffer and probes the reflowed
	 * anchor, which the non-destructive repaint depends on.
	 */
	#settleResizeAltPaint(): void {
		this.#resizeAltActive = false;
		this.#suppressResizeUntil = this.#renderScheduler.now() + 100;
		this.#altPreviousLines = [];
		this.#altPreparedRows = [];
		const exitSequence = `${this.#keyboardEnhancementExit()}\x1b[?1049l`;
		// Only the provider plan frame emits a pending exit, and an exit already
		// pending (a fused overlay close) owns that slot.
		if (this.#frameProvider !== undefined && this.#pendingAltExit === "") {
			if (this.#resizeScrollbackMode === "rebuild") {
				this.#prepareResizeReplay(this.terminal.columns, this.terminal.rows);
			}
			if (this.#clearScrollbackOnNextRender) {
				// An entry no resize frame carried yet rides ahead of this exit in
				// the rebuild frame (see #renderProviderFrame).
				this.#pendingAltExit = exitSequence;
				this.#resizeAltExitFused = true;
				this.requestRender(true);
				return;
			}
		}
		this.#noteAltBufferToggle();
		this.terminal.write(this.#takePendingAltEnter() + exitSequence);
		setAltScreenActive(false);
		this.#beginResizeAnchorProbe();
	}
	/**
	 * Claim the resize borrow's entry for the write that carries it. A borrow
	 * that ends before any frame painted (output backpressure deferred them)
	 * still owes its entry, so the exit write prepends it: one write, never a
	 * bare buffer switch the terminal could present.
	 */
	#takePendingAltEnter(): string {
		const enter = this.#pendingAltEnter;
		this.#pendingAltEnter = "";
		return enter;
	}

	/**
	 * Recover the reflowed viewport anchor after the resize settle window ends.
	 * The terminal reflowed the restored normal buffer during the drag, so
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
		// A ConPTY host re-homes the cursor on every resize, so its reply carries
		// column 1 and can never be attributed to a tag. Sending the DSR would
		// only burn a tag column for the rest of the session (dead tags are
		// deliberately never reclaimed) and stall the settled repaint for the
		// full timeout, so anchor from the fallback immediately. Two exemptions:
		// a multiplexer answers DSR from its own grid, so under WSL-in-tmux the
		// reply is attributable and the width-reflow / hidden-grow / reversed-
		// burst logic still needs it; and PI_TUI_RESIZE_IN_PLACE=1 forces the
		// in-place repaint, whose anchor is only as good as this probe, so the
		// documented escape hatch restores the whole pre-change path.
		if (
			this.terminal.hostOwnsGridOnResize === true &&
			!isInsideTerminalMultiplexer() &&
			resizeInPlaceOverride() !== true
		) {
			this.#resolveResizeAnchor(undefined);
			return;
		}
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
		this.#resizeInPlaceActive = false;
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
				// tmux can grow its grid before SIGWINCH reaches the app. A queued
				// retirement frame can then overwrite pulled-down history at the old
				// coordinates and park the cursor there. If a previously full viewport
				// no longer reaches the bottom, replay its semantic history instead of
				// trusting that potentially damaged physical copy. Ordinary grows with
				// an intact bottom anchor still need no replay or additional wait.
				if (
					this.#resizeScrollbackMode === "rebuild" &&
					classifyTerminalMultiplexerModule()?.growsBeforeSigwinch === true &&
					!this.#resizeRepaintsInPlace() &&
					this.#frameProvider?.beginHistoryReplay &&
					this.#resizeBurstGrew &&
					this.#providerViewportTop + probe.window.length >= this.#previousHeight &&
					reportedTop + staleRows < height
				) {
					this.#prepareForcedRender(true);
				}
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
		// Resolved geometry invalidates the replay offset with the old anchor;
		// the forced repaint recomputes it (usually zero).
		this.#providerViewportPadTop = 0;
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
			this.#imageBudget.beginPass(false, true);
			rendered =
				provider?.renderResizeFrame?.({ columns: width, rows: height }) ??
				(provider ? provider.renderFrame({ columns: width, rows: height }).viewport : this.render(width));
		} while (this.#imageBudget.endPass());
		const viewport = rendered.length > height ? rendered.slice(rendered.length - height) : Array.from(rendered);
		// The borrowed resize buffer is transient, not a streamable session paint.
		this.#emitAltFrame(
			this.#prepareLinesArray(viewport, width, this.#altPreparedRows, height, []),
			width,
			height,
			false,
		);
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
		// The probes went out over the painted frame; a terminal that could not
		// parse one left its bytes on the cursor row (see Terminal.enableInput).
		this.requestRender(true);
	}

	/**
	 * Replay the keystrokes held since a TSP `deferInput` start through the
	 * normal input path, then deliver input live. Call once the app's key
	 * handlers are installed so a hotkey pressed during startup still fires.
	 * Only keys typed while the start-time focus owner had focus are held. The
	 * hold survives a stop/start until released. Idempotent; no-op when nothing
	 * is held.
	 */
	releaseHeldInput(): void {
		const held = this.#heldInput;
		if (held === undefined) return;
		this.#heldInput = undefined;
		if (this.#stopped) return;
		for (const data of held) this.#handleInput(data);
	}

	/**
	 * Hand held-key ownership from `previous` to `next` when the app replaces
	 * the component focused at start (a swapped-in custom editor), so keys
	 * typed into the replacement stay queued behind the held ones instead of
	 * overtaking them. No-op unless `previous` owns the held keys.
	 */
	replaceHeldFocus(previous: Component, next: Component): void {
		if (this.#heldInput !== undefined && this.#heldFocus === previous) this.#heldFocus = next;
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
		// A Tern surface (live, or about to open optimistically at start) sends
		// images through TSP; this also keeps held startup input free of probe
		// listeners.
		if (this.#nativeLive || this.terminal.tspExpected) return;
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

	/**
	 * Retire every eligible history batch into native scrollback before quitting.
	 *
	 * The only frame path that deliberately does not composite overlays. Its
	 * output is the transcript the shell prompt lands under, and it forces
	 * commits that {@link #compositeOverlaysIntoWindow} otherwise relies on being
	 * frozen while an overlay is up — so a modal painted here would leave debris
	 * above the prompt and could reach native scrollback. `stop()` drops the
	 * alternate buffer without unstacking the overlay, so leaving it in would also
	 * charge a no-longer-painted modal's images against the cap and delete the
	 * transcript's visible graphics on the way out.
	 */
	#flushHistoryBeforeStop(): void {
		const provider = this.#frameProvider;
		if (provider?.beginHistoryFlush === undefined) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (width <= 0 || height <= 0) return;
		provider.beginHistoryFlush();
		while (true) {
			let plan: TerminalFramePlan;
			let viewport: string[];
			do {
				this.#imageBudget.beginPass();
				plan = provider.renderFrame({ columns: width, rows: height });
				viewport = Array.from(plan.viewport);
				if (viewport.length > height) viewport = viewport.slice(0, height);
			} while (this.#imageBudget.endPass());
			if (plan.history === undefined) return;
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
		this.#nativeHoldTimer?.cancel();
		this.#nativeHoldTimer = undefined;
		this.#clearNativeConfirm();
		const nativeWasLive = this.#nativeLive;
		if (nativeWasLive) {
			this.#native!.stop();
			this.#nativeLive = false;
		}
		this.#resizeSettleTimer?.cancel();
		this.#resizeSettleTimer = undefined;
		if (this.#resizeInPlaceActive && this.terminal.rows > 0) {
			// The hardware cursor sits wherever the drag left it, but tracking still
			// describes the pre-resize row (no alt-buffer restore replays it back).
			// The shell handoff below moves relatively from the tracked row, so park
			// absolutely on the bottom row and record it first.
			this.terminal.write(`\x1b[${this.terminal.rows};1H`);
			this.#hardwareCursorRow = this.terminal.rows - 1;
		}
		this.#resizeInPlaceActive = false;
		this.#altToggleEchoPending = false;
		this.#cancelResizeProbe();
		if (this.#resizeAltActive) {
			this.#resizeAltActive = false;
			this.terminal.write(`${this.#takePendingAltEnter()}${this.#keyboardEnhancementExit()}\x1b[?1049l`);
			setAltScreenActive(false);
		}
		if (this.#altActive || this.#pendingAltExit) {
			// A pending fused exit may have been built without an OFF write to
			// keep inline capture alive across the restore — at process quit
			// nothing continues, so release unconditionally. The pending
			// sequence itself can re-enable tracking (overlay-close restore),
			// so the final OFF goes last or the shell keeps reporting.
			const mouseExit = this.#mouseTracking !== "off" ? MOUSE_TRACKING_OFF : "";
			const exitSequence = this.#pendingAltExit
				? `${this.#takePendingAltEnter()}${this.#pendingAltExit}${mouseExit}`
				: `${mouseExit}${this.#keyboardEnhancementExit()}\x1b[?1049l`;
			this.terminal.write(exitSequence);
			setAltScreenActive(false);
			this.#altActive = false;
			this.#mouseTracking = "off";
			this.#altPreviousLines = [];
			this.#altPreparedRows = [];
			this.#pendingAltExit = "";
			this.#resizeAltExitFused = false;
		} else if (this.#mouseTracking !== "off") {
			// Inline capture with no overlay: still owned by us at quit, so
			// release it — otherwise the parent shell keeps mouse reporting
			// and loses native selection until a manual reset.
			this.terminal.write(MOUSE_TRACKING_OFF);
			this.#mouseTracking = "off";
		}
		// A latched destructive reset (settled rebuild-mode resize, /clear) pairs
		// ED3 with a complete-ledger replay. Running that pair during stop would
		// erase native history and re-stream the whole transcript at quit; drop
		// the latch so the flush below writes only un-retired rows.
		this.#clearScrollbackOnNextRender = false;
		// The surface already holds the transcript; there's no row history to retire.
		if (!nativeWasLive) this.#flushHistoryBeforeStop();
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
		}
		this.#clearScrollbackOnNextRender ||= clearScrollback;
		this.#forceViewportRepaintOnNextRender = true;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
			// The cancelled timer was the only callback owed to a pending ordinary
			// request. Every caller paints right after (a forced or ordinary request
			// it issues, or the render already in progress), and that paint serves
			// the request. Leaving the flag set would turn every later ordinary
			// request into a no-op: the resize settle's rebuild and all spinner
			// frames would never paint until some forced render arrived.
			this.#renderRequested = false;
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
		// Native frames are paced by the terminal's acknowledgements (credits),
		// not by the row renderer's cadence.
		const delay = this.#nativeLive ? 0 : Math.max(cadenceDelay, adaptiveDelay, inputGraceDelay);
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
		// Tern Surface Protocol events (acks, pointer actions, resize, theme)
		// are terminal reports, never keystrokes.
		if (data.startsWith(TSP_PREFIX)) {
			if (this.#nativeLive) this.#native!.handleInput(data);
			return;
		}
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
				// tmux can resize its grid before the application receives SIGWINCH.
				// A reply below our known screen is from that newer geometry: do not
				// repaint it using the stale height. Wait for resize or the probe retry.
				if (probe !== undefined && tagEpoch === probe.epoch && row >= 1 && row <= this.terminal.rows) {
					this.#resolveResizeAnchor(Number(match[1]) - 1);
				}
			}
			// Other unknown-column replies while expecting tagged ones are our
			// requests answered with a clamped or mangled column: strip and
			// discard; the probe timeout covers recovery.
			data = data.slice(0, searchFrom + match.index) + data.slice(searchFrom + match.index + match[0].length);
		}
		if (data.length === 0) return;

		if (this.#heldInput !== undefined && this.#focusedComponent === this.#heldFocus) {
			this.#holdInput(data);
			return;
		}

		// If focused component is an overlay, verify it's still visible (visibility can change due to
		// terminal resize or visible() callback). Runs before the capture preflight below, which must
		// target the effective focus owner, not a hidden overlay.
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

		// Ctrl+C/Esc use app-level double-press windows. Give those gestures one
		// frame to drain queued input before an ordinary repaint; delaying every
		// key would make idle navigation pay a full frame of latency.
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.#inputRenderGraceUntilMs = this.#renderScheduler.now() + TUI.#INPUT_RENDER_GRACE_MS;
		}

		// A focused input owner can reserve its gesture before TUI-wide listeners
		// and debug shortcuts see the key, then handle the raw event exactly once.
		const focusedForCapture = this.#focusedComponent;
		if (
			focusedForCapture?.handleInput &&
			(!isKeyRelease(data) || focusedForCapture.wantsKeyRelease) &&
			focusedForCapture.capturesInput?.(data)
		) {
			focusedForCapture.handleInput(data);
			this.requestRender();
			return;
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

	/**
	 * Queue a keystroke typed before the app installed its key handlers; input
	 * listeners see it once, on replay. The cell-size reply is a terminal report,
	 * consumed now. Ctrl+C/Ctrl+D release the queue so a stalled startup stays
	 * interruptible.
	 */
	#holdInput(data: string): void {
		if (this.#consumeCellSizeResponse(data)) return;
		this.#heldInput!.push(data);
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) this.releaseHeldInput();
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
	/**
	 * Composite the visible overlays onto a full-height copy of `viewport`, or
	 * hand it back untouched when nothing is stacked. Callers run this inside
	 * their image-budget pass so the frame's whole image set — transcript plus
	 * modal — reaches one reconcile, instead of leaving the overlay's graphics
	 * outside the cap for as long as it stays up.
	 */
	#compositeVisibleOverlays(viewport: string[], width: number, height: number): string[] {
		if (this.#getTopmostVisibleOverlay() === undefined) return viewport;
		while (viewport.length < height) viewport.push("");
		return this.#compositeOverlaysIntoWindow(viewport, width, height);
	}

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
				result[idx] = compositeLineAt(result[idx], truncatedOverlayLine, col, width, termWidth);
			}
		}
		return result;
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

	#terminalLine(line: PreparedLine): string {
		if (line.hasOsc8) return line.terminalContent + LINE_TERMINATOR;
		return line.terminalContent.endsWith(SEGMENT_RESET) ? line.terminalContent : line.terminalContent + SEGMENT_RESET;
	}

	/** Encode padding with REP, which tmux expands into identical styled cells. */
	#compactReplaySpaces(line: string): string {
		let copied = 0;
		let output = "";
		for (let offset = 0; offset < line.length;) {
			const spaces = line.indexOf("        ", offset);
			if (spaces === -1) break;
			const escape = line.indexOf("\x1b", offset);
			if (escape !== -1 && escape < spaces) {
				// Only inspect text outside CSI/OSC. Unknown control strings (for
				// example DCS payloads) must remain byte-for-byte unchanged.
				const introducer = line.charCodeAt(escape + 1);
				if (introducer !== 0x5b && introducer !== 0x5d) return line;
				const end = this.#ansiSequenceEnd(line, escape);
				if (end < 0) break;
				offset = end;
				continue;
			}
			let end = spaces + 8;
			while (line.charCodeAt(end) === 0x20) end++;
			output += `${line.slice(copied, spaces)} \x1b[${end - spaces - 1}b`;
			copied = offset = end;
		}
		return copied === 0 ? line : output + line.slice(copied);
	}

	#notifyPaint(paint: TuiPaint): void {
		for (const listener of this.#paintListeners) {
			try {
				listener(paint);
			} catch (err) {
				logger.error("TUI paint listener failed", { err });
			}
		}
	}

	#renderProviderFrame(width: number, height: number): void {
		const provider = this.#frameProvider;
		if (!provider || width <= 0 || height <= 0) return;
		this.#debugNextWindowTop = 0;
		let plan: TerminalFramePlan;
		let viewport: string[];
		do {
			this.#imageBudget.beginPass();
			plan = provider.renderFrame({ columns: width, rows: height });
			viewport = Array.from(plan.viewport);
			if (viewport.length > height) {
				const message = `Frame provider returned ${viewport.length} rows for a ${height}-row viewport`;
				if (Bun.env.NODE_ENV === "test" || Bun.env.NODE_ENV === "development") throw new Error(message);
				logger.error("TUI layout contract violated", { rows: viewport.length, height });
				viewport = viewport.slice(0, height);
			}
			viewport = this.#compositeVisibleOverlays(viewport, width, height);
		} while (this.#imageBudget.endPass());
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
	 *
	 * Both gates key on the whole coalesced burst, not the net change: the
	 * terminal reflowed the normal buffer at every intermediate geometry, so a
	 * drag that ends where it started (80 → 60 → 80) has still rewrapped
	 * retained history and pushed unerased live rows into it. Comparing only
	 * the settled size against the committed one would skip the refresh and
	 * leave those stale copies stacked above the repainted viewport.
	 */
	#prepareResizeReplay(width: number, height: number): void {
		const size = `${width}x${height}`;
		const widthChanged = this.#resizeBurstWidthChanged || width !== this.#previousWidth;
		const resized = this.#resizeBurstResized || widthChanged || height !== this.#previousHeight;
		if (
			!this.#hasEverRendered ||
			!resized ||
			this.#resizeReplaySize === size ||
			this.#resizeScrollbackMode === "preserve" ||
			// In-place resizes (Warp) repaint the settled viewport once the drag
			// goes quiet: no alt borrow, and no ED3 rewrap or history replay, so a
			// drag can neither loop on its own echo nor flash destructive repaints.
			this.#resizeRepaintsInPlace()
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
		// A height-only settled resize rewraps nothing — rewrap is a width change
		// everywhere. A pure height grow pulls committed scrollback down without
		// polluting a copy, so the rebuild (an ED3 plus a full ledger replay)
		// would be a destructive repaint that buys nothing. `rebuild` still
		// refreshes on a burst shrink (the multiplexer pushes live pane rows into its
		// scrollback; the destructive refresh is the only purge) and on a host
		// that repaints its own grid (ConPTY's stale re-emission is untrusted).
		if (this.#resizeScrollbackMode === "rebuild") {
			// Every destructive cause warrants a rebuild: a burst shrink can push
			// live rows into history (tmux discards rows below the cursor, then
			// pushes rows above it; a later grow cannot undo that clipping or the
			// provider's retirement), and ConPTY can repaint its own stale grid.
			if (!widthChanged && this.terminal.hostOwnsGridOnResize !== true && !this.#resizeBurstShrank) return;
			this.#prepareForcedRender(true);
			return;
		}
		if (!widthChanged) return;
		provider.beginHistoryReplay();
		this.#forceViewportRepaintOnNextRender = true;
	}

	/**
	 * Bottom-row `Rebuilding…` notice, closed as its own synchronized update so
	 * tmux forwards it before the replay that follows starts a new hold. Cursor
	 * save/restore and no newline keep the row out of native scrollback; the
	 * replay's ED2 erases it together with the rest of the screen.
	 */
	#rebuildNoticeSequence(width: number, height: number): string {
		const label = truncateToWidth("↻ Rebuilding…", width, Ellipsis.Omit);
		return `${this.#paintBeginSequence}\x1b7\x1b[${height};1H${SEGMENT_RESET}${ERASE_LINE}${label}${LINE_TERMINATOR}\x1b8${this.#paintEndSequence}`;
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
		// Callers composite their overlays inside the budget pass, so `viewportRows`
		// is already the complete frame. Bound the store here rather than at
		// endPass(): this is the last point before the purge and transmit bytes go
		// out, and it runs once per emitted frame instead of once per retry.
		let viewport = viewportRows;
		this.#imageBudget.limitResidentImages();
		const history = offered !== undefined && offered.id > this.#acceptedHistoryBatchId ? offered : undefined;
		if (offered !== undefined && offered.id <= this.#acceptedHistoryBatchId) provider?.acknowledgeHistory(offered.id);

		let historyRows = history?.rows ?? [];
		let replayViewportRows = 0;
		let replayPrependedBlanks = 0;
		if (history?.kind === "replay") {
			// Providers may omit unused leading rows from a short viewport. Make
			// that logical space explicit before the bottom-first replay split.
			replayPrependedBlanks = Math.max(0, height - viewport.length);
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
		// History first: it reuses the previous viewport's rows by content, and
		// the viewport pass replaces that memo with its own rows.
		const preparedHistory = this.#prepareLinesArray(historyRows, width);
		const markers: { row: number; col: number }[] = [];
		const prepared = this.#prepareLinesArray(viewport, width, this.#providerPreparedRows, viewport.length, markers);
		const rows = prepared.lines.length;
		// Destructive reset (session replace, /tree, explicit clear, or a settled
		// resize in rebuild mode): erase native history and the viewport,
		// then repaint from row zero.
		const destructiveReset = this.#clearScrollbackOnNextRender;
		const compactReplay = destructiveReset && classifyTerminalMultiplexerModule()?.expandsRepPadding === true;
		if (destructiveReset) {
			this.#providerViewportTop = 0;
			this.#providerWindow = [];
			this.#providerPreparedRows = [];
		}
		// The viewport stays anchored directly below whatever history remains on
		// screen. Appending K history rows moves the anchor down by K; the write
		// scrolls only when history + viewport overflow the physical screen, and
		// the rows that scroll off the top are exactly the oldest history rows.
		const geometryStable = this.#hasEverRendered && this.#previousWidth === width && this.#previousHeight === height;
		const startTop = destructiveReset ? 0 : Math.min(this.#providerViewportTop, Math.max(0, height - 1));
		const newTop = Math.max(0, Math.min(startTop + historyRows.length, height - rows));
		const pendingAltExit = this.#pendingAltExit;
		// A fused resize exit whose borrow never painted still owes its entry.
		let buffer = this.#paintBeginSequence + (pendingAltExit ? this.#takePendingAltEnter() : "") + pendingAltExit;
		const renewSync =
			destructiveReset &&
			this.#resizeScrollbackMode === "rebuild" &&
			this.#synchronizedOutputEnabled &&
			classifyTerminalMultiplexerModule()?.expiresSynchronizedOutput === true;
		let syncBytes = Buffer.byteLength(buffer);
		const append = (sequence: string): void => {
			buffer += sequence;
			if (!renewSync) return;
			syncBytes += Buffer.byteLength(sequence);
			if (syncBytes < SYNC_OUTPUT_RENEW_BYTES) return;
			buffer += SYNC_OUTPUT_BEGIN;
			syncBytes = 0;
		};
		if (destructiveReset && TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			// A reset is explicitly destructive, so remove every placement—not only
			// the ones this TUI tracked—then resend images composed for the clean
			// replay. ED2 below reclaims the rest, but only on terminals that treat
			// an erase as a graphics clear; the explicit delete covers the others.
			buffer += encodeKittyDeleteAllImages();
			// `d=A` spares virtual placements, and erasing the placeholder text it
			// leaves behind does not remove the prototype either. The ids this
			// reset forgot are named explicitly here — their tracking is gone, so
			// nothing downstream could find them again.
			for (const id of this.#imageBudget.takeResetPurgeIds()) buffer += encodeKittyDeleteImage(id);
			this.#imageBudget.resetPlacementEpochs();
		}
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
		//
		// Both erases MUST precede the image transmits. kitty and Ghostty treat
		// ED2 as a graphics clear that also frees every image left without a
		// placement — which is exactly what freshly transmitted data is until
		// the row carrying its placement is written. Transmitting first let the
		// erase reclaim the data, so the replay's placements then referenced an
		// image the terminal no longer had and every inline image vanished
		// after a settled width resize.
		if (destructiveReset) buffer += `${LINE_TERMINATOR}\x1b[H\x1b[2J\x1b[3J`;
		for (const sequence of this.#imageBudget.takeTransmits()) append(sequence);
		const diffable =
			geometryStable &&
			historyRows.length === 0 &&
			startTop === newTop &&
			!this.#forceViewportRepaintOnNextRender &&
			!destructiveReset &&
			this.#providerWindow.length > 0;
		if (diffable) {
			for (let index = 0; index < rows; index++) {
				if (
					!this.#rowNeedsRewrite(
						this.#providerWindow,
						this.#providerPreparedRows,
						prepared.lines,
						prepared.rows,
						index,
					)
				) {
					continue;
				}
				const current = prepared.rows[index]!;
				buffer += `\x1b[${newTop + index + 1};1H${this.#lineRewriteSequence(
					current,
					width,
					newTop + index,
					-1,
					-1,
					this.#osc66SpacerGlyphWidth(prepared.lines, index),
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
			const pushed = Math.max(0, startTop + preparedHistory.lines.length + rows - height);
			if (pushed > this.#providerViewportTop && this.#providerWindow.length > 0) {
				buffer += this.#eraseBelowRow(this.#providerViewportTop, height);
			}
			buffer += `\x1b[${startTop + 1};1H`;
			let screenRow = startTop;
			for (let index = 0; index < preparedHistory.lines.length; index++) {
				if (screenRow > startTop) buffer += "\n";
				append(
					this.#lineRewriteSequence(
						preparedHistory.rows[index]!,
						width,
						Math.min(screenRow, height - 1),
						-1,
						-1,
						this.#osc66SpacerGlyphWidth(preparedHistory.lines, index),
						{ blankRow: compactReplay },
					),
				);
				screenRow++;
			}
			for (let index = 0; index < rows; index++) {
				if (screenRow > startTop) buffer += "\n";
				append(
					this.#lineRewriteSequence(
						prepared.rows[index]!,
						width,
						Math.min(screenRow, height - 1),
						-1,
						-1,
						this.#osc66SpacerGlyphWidth(prepared.lines, index),
						{ blankRow: compactReplay },
					),
				);
				screenRow++;
			}
			if (newTop + rows < height) buffer += `\x1b[${newTop + rows + 1};1H\x1b[J`;
		}
		const mutableTop = newTop + replayViewportRows;
		const mutablePreparedLines = replayViewportRows > 0 ? prepared.lines.slice(replayViewportRows) : prepared.lines;
		const mutablePreparedRows = replayViewportRows > 0 ? prepared.rows.slice(replayViewportRows) : prepared.rows;
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
		if (
			renewSync &&
			pendingAltExit === "" &&
			this.#resizeReplaySize !== undefined &&
			Buffer.byteLength(buffer) >= TUI.#RESIZE_REBUILD_NOTICE_MIN_BYTES
		) {
			this.terminal.write(this.#rebuildNoticeSequence(width, height));
		}
		this.terminal.write(buffer);
		this.#debugPaint = {
			lines: prepared.lines,
			windowTop: this.#debugNextWindowTop,
			altScreen: false,
			...(target === null ? {} : { cursor: { x: target.col, y: target.row, visible: target.visible } }),
		};
		if (pendingAltExit) {
			this.#noteAltBufferToggle();
			this.#pendingAltExit = "";
			this.#resizeAltExitFused = false;
			setAltScreenActive(false);
		}
		if (target) this.#recordHardwareCursorState(target);
		else this.#recordHardwareCursorHidden();
		this.#providerWindow = mutablePreparedLines;
		this.#providerPreparedRows = mutablePreparedRows;
		this.#providerViewportTop = mutableTop;
		this.#providerViewportPadTop = replayViewportRows - replayPrependedBlanks;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#resizeBurstGrew = false;
		this.#resizeBurstShrank = false;
		this.#resizeBurstLastHeight = undefined;
		this.#resizeBurstPull = 0;
		this.#resizeBurstWidthChanged = false;
		this.#resizeBurstResized = false;
		this.#previousFrameLength = mutablePreparedLines.length;
		this.#clearScrollbackOnNextRender = false;
		this.#forceViewportRepaintOnNextRender = false;
		this.#hasEverRendered = true;
		this.#resizeReplaySize = undefined;
		// Replay-split rows in `prepared.lines` now occupy the physical viewport;
		// only `preparedHistory.lines` crossed above it into native scrollback.
		this.#notifyPaint({
			history: preparedHistory.lines,
			viewport: prepared.lines,
			reset: destructiveReset || history?.kind === "replay",
			alt: false,
			columns: width,
			rows: height,
		});
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
		if (this.#nativeLive) {
			this.#native!.render();
			return;
		}
		// Awaiting the TSP hello: its resolution (or the hold timeout) repaints.
		if (this.#nativeHoldTimer) return;
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
		if (this.#resizeInPlaceActive && !this.#altActive) {
			// The normal-buffer anchor is stale until the settled rebuild or CPR
			// recovery. Painting now would overwrite history and record the new
			// geometry over the pending recovery, so defer until the settle.
			return;
		}

		// Fullscreen alt-screen short-circuit. While the topmost visible overlay
		// requests it, borrow the terminal's alternate buffer and paint only the
		// modal there; the normal screen and all accounting stay untouched.
		const topOverlay = this.#getTopmostVisibleOverlay();
		const wantAlt = topOverlay?.options?.fullscreen === true;
		const wantMouse: MouseTrackingState =
			topOverlay === undefined
				? this.#inlineMouseProvider?.() === true
					? "inline"
					: "off"
				: wantAlt && topOverlay.options?.mouseTracking !== false
					? "full"
					: "off";
		if (wantAlt && !this.#altActive) {
			// Enhanced keyboard modes can be buffer-local: re-push the active
			// modified-key reporting sequence on the freshly entered alternate
			// screen, or Esc/modified keys revert to legacy encoding inside
			// fullscreen overlays (Ghostty/kitty/iTerm2).
			if (this.#resizeAltExitFused) {
				// An overlay opened while the settled resize rebuild was still
				// pending: the terminal never left the borrowed buffer, which already
				// carries the pushed keyboard mode and its image store, so the overlay
				// takes it over. The latched rebuild then lands with the overlay's
				// own fused exit when it closes.
				this.#pendingAltExit = "";
				this.#resizeAltExitFused = false;
			} else {
				this.#noteAltBufferToggle();
				this.#imageBudget.beginAltScreenLifecycle();
				this.terminal.write(`\x1b[?1049h${this.#keyboardEnhancementEnter()}`);
			}
			this.#setMouseTracking(wantMouse);
			setAltScreenActive(true);
			this.terminal.hideCursor();
			this.#forgetHardwareCursorState();
			this.#recordHardwareCursorHidden();
			this.#altActive = true;
			this.#altPreviousLines = [];
			this.#altPreparedRows = [];
			this.#altEnterWidth = width;
			this.#altEnterHeight = height;
		} else if (!wantAlt && this.#altActive) {
			// Leaving reporting on when the normal buffer wants it restores
			// inline capture the same frame the overlay closes: no later paint
			// is needed, so an idle session never sits untrackable.
			const mouseExit = wantMouse === "off" && this.#mouseTracking !== "off" ? MOUSE_TRACKING_OFF : "";
			// A fullscreen overlay that disabled reporting leaves tracking off:
			// restore it in the fused exit or later frames see matching states
			// and inline click/hover stays dead until the setting toggles.
			const mouseEnter = wantMouse !== "off" && this.#mouseTracking === "off" ? MOUSE_TRACKING_ON : "";
			const enhancementExit = this.#keyboardEnhancementExit();
			const exitSequence = `${mouseExit}${mouseEnter}${enhancementExit}\x1b[?1049l`;
			// Session replacement finishes while its fullscreen selector still
			// covers the old normal buffer. Fuse the restore into the destructive
			// repaint so no stale frame can become visible between writes.
			if (this.#clearScrollbackOnNextRender) {
				this.#pendingAltExit = exitSequence;
			} else {
				this.#noteAltBufferToggle();
				this.terminal.write(exitSequence);
				setAltScreenActive(false);
			}
			this.#forgetHardwareCursorState();
			this.#altActive = false;
			this.#mouseTracking = wantMouse;
			this.#altPreviousLines = [];
			this.#altPreparedRows = [];
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
		} else if (wantMouse !== this.#mouseTracking) {
			this.#setMouseTracking(wantMouse);
		}
		if (this.#altActive) {
			this.#renderAltFrame(width, height);
			return;
		}
		// #prepareResizeReplay can latch this frame's reset itself (a settled
		// rebuild-mode resize does), so it runs before the gate; the gate then runs
		// before either arm composes anything.
		if (this.#frameProvider !== undefined) this.#prepareResizeReplay(width, height);
		this.#forgetTransmittedForPendingReset();
		if (this.#frameProvider !== undefined) {
			this.#renderProviderFrame(width, height);
			return;
		}
		this.#renderChildrenFrame(width, height);
	}

	/**
	 * Drop transmit tracking when a destructive repaint is about to compose the
	 * normal screen, so the pass re-sends every image's data alongside its
	 * placement. That repaint opens with `d=A`, which is what removes the store —
	 * queueing per-id deletes when the reset was merely *latched* lets them ride
	 * out on an unrelated frame instead, and a frame painted on the alternate
	 * buffer carries them off without the repaint that restores them. A latch that
	 * never reaches a repaint — `stop()` drops it — then deletes nothing.
	 *
	 * Must run after everything that can latch the reset for this frame and before
	 * anything composes it — one call on the normal-screen dispatch path, ahead of
	 * the arm split, so a new arm cannot be added without it.
	 */
	#forgetTransmittedForPendingReset(): void {
		if (!this.#clearScrollbackOnNextRender) return;
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		this.#imageBudget.forgetTransmitted();
	}

	/**
	 * Fallback frame for hosts without a frame provider (tests, simple embeds):
	 * compose the root children and paint the bottom `height` rows as the
	 * mutable viewport. Nothing is ever appended to terminal history.
	 */
	#renderChildrenFrame(width: number, height: number): void {
		let viewport: string[];
		do {
			this.#imageBudget.beginPass();
			const composed = this.render(width);
			this.#debugNextWindowTop = Math.max(0, composed.length - height);
			viewport = composed.length > height ? composed.slice(composed.length - height) : Array.from(composed);
			viewport = this.#compositeVisibleOverlays(viewport, width, height);
		} while (this.#imageBudget.endPass());
		if (this.#maybeDeferGhosttyInitialImagePaint()) return;
		this.#emitPlanFrame(width, height, viewport, undefined, undefined);
	}

	/**
	 * Prepare one string projection plus its structured write sidecar. A prior
	 * sidecar entry is reusable only under identical raw content, width, width
	 * configuration, and image protocol; those are every mutable input to
	 * normalization, fitting, classification, and terminal coalescing. The same
	 * row at the same index is checked first, then the previous stripping pass's
	 * rows by content, so a scrolled row is not re-prepared.
	 *
	 * With `markers`, every CURSOR_MARKER is stripped (markers are internal
	 * sentinels and must never reach the terminal) and its position recorded,
	 * bottom-most first; callers pick the visible one once the window top is
	 * known. Without it (history rows) lines are prepared verbatim. Every
	 * reusable entry holds a stripped raw line, so a row that matches one
	 * carries no marker and skips the marker scan.
	 */
	#prepareLinesArray(
		lines: readonly string[],
		width: number,
		previous: readonly PreparedLine[] = [],
		length = lines.length,
		markers?: { row: number; col: number }[],
	): PreparedLines {
		// oxlint-disable-next-line unicorn/no-new-array -- render-frame length preallocation
		const prepared: string[] = new Array(length);
		// oxlint-disable-next-line unicorn/no-new-array -- render-frame sidecar preallocation
		const rows: PreparedLine[] = new Array(length);
		const widthEpoch = getWidthConfigEpoch();
		const imageProtocol = TERMINAL.imageProtocol;
		const memo = this.#preparedLineMemo;
		// Only stripping passes index their rows: a verbatim history row may keep
		// a marker, and reusing it for a viewport row would leak that marker.
		const nextMemo = markers === undefined ? undefined : this.#preparedLineMemoSpare;
		for (let i = 0; i < length; i++) {
			const source = lines[i] ?? "";
			let row = this.#reusablePreparedLine(previous[i], memo, source, width, widthEpoch, imageProtocol);
			if (row === undefined) {
				let raw = source;
				if (markers !== undefined) {
					let markerIndex = source.indexOf(CURSOR_MARKER);
					if (markerIndex !== -1) {
						markers.push({ row: i, col: visibleWidth(source.slice(0, markerIndex)) });
						// Resume the search just before the splice so a marker that the
						// removal itself joins together is stripped too; reusable rows
						// must stay marker-free.
						while (markerIndex !== -1) {
							raw = raw.slice(0, markerIndex) + raw.slice(markerIndex + CURSOR_MARKER.length);
							markerIndex = raw.indexOf(CURSOR_MARKER, Math.max(0, markerIndex - CURSOR_MARKER.length + 1));
						}
						row = this.#reusablePreparedLine(previous[i], memo, raw, width, widthEpoch, imageProtocol);
					}
				}
				row ??= this.#prepareLine(raw, width, widthEpoch, imageProtocol);
			}
			nextMemo?.set(row.raw, row);
			prepared[i] = row.line;
			rows[i] = row;
		}
		if (nextMemo !== undefined) {
			memo.clear();
			this.#preparedLineMemo = nextMemo;
			this.#preparedLineMemoSpare = memo;
			markers?.reverse();
		}
		return { lines: prepared, rows };
	}

	#reusablePreparedLine(
		positional: PreparedLine | undefined,
		memo: ReadonlyMap<string, PreparedLine>,
		raw: string,
		width: number,
		widthEpoch: number,
		imageProtocol: ImageProtocol | null,
	): PreparedLine | undefined {
		const cached = positional !== undefined && positional.raw === raw ? positional : memo.get(raw);
		return cached !== undefined &&
			cached.width === width &&
			cached.widthEpoch === widthEpoch &&
			cached.imageProtocol === imageProtocol
			? cached
			: undefined;
	}

	#prepareLine(raw: string, width: number, widthEpoch: number, imageProtocol: ImageProtocol | null): PreparedLine {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
		const maxSourceLength = Math.min(
			LINE_FIT_MAX_SOURCE_CODE_UNITS,
			Math.max(LINE_FIT_MIN_SOURCE_CODE_UNITS, safeWidth * LINE_FIT_SOURCE_WIDTH_MULTIPLIER),
		);

		let source: string;
		let classification: LineClassification;
		if (raw.length <= maxSourceLength) {
			// The overwhelmingly common path classifies image markers, OSC 8,
			// ANSI validity, OSC 66, non-ASCII, and exact ASCII width together.
			classification = this.#classifyLine(raw, safeWidth);
			if (classification.isImage) {
				return {
					raw,
					width,
					widthEpoch,
					imageProtocol,
					line: raw,
					terminalContent: raw,
					asciiWidth: undefined,
					isImage: true,
					hasOsc8: false,
				};
			}
			source = raw;
		} else {
			// Fitting a giant source can discard everything after the visible
			// prefix. Preserve image rows verbatim first, but do not scan the
			// entire source for width/OSC metadata that will immediately vanish.
			if (TERMINAL.isImageLine(raw)) {
				return {
					raw,
					width,
					widthEpoch,
					imageProtocol,
					line: raw,
					terminalContent: raw,
					asciiWidth: undefined,
					isImage: true,
					hasOsc8: false,
				};
			}
			source = this.#lineFitSource(raw, safeWidth, maxSourceLength);
			// Preserve the former lineRewriteSequence classification: fitting can
			// move a marker from outside the raw scan window into the prepared
			// line's window, at which point terminal image dispatch owns it.
			classification = this.#classifyLine(source, safeWidth);
		}

		const normalized = normalizeTerminalOutput(source);
		// Normalization only decomposes Thai/Lao AM vowels. It cannot introduce
		// or remove ANSI/image markers, and such a row was already non-ASCII, so
		// the source classification remains exact when normalization allocates.
		let line = normalized;
		if ((classification.asciiWidth ?? visibleWidth(normalized)) > width) {
			line = truncateToWidth(normalized, width, Ellipsis.Omit);
			classification = this.#classifyLine(line, safeWidth);
		}
		return {
			raw,
			width,
			widthEpoch,
			imageProtocol,
			line,
			terminalContent: classification.isImage ? line : coalesceAdjacentSgr(line),
			asciiWidth: classification.asciiWidth,
			isImage: classification.isImage,
			hasOsc8: classification.isImage ? false : classification.hasOsc8,
		};
	}

	#lineFitSource(raw: string, safeWidth: number, maxSourceLength: number): string {
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

	/**
	 * One code-unit pass classifies every per-row write decision. Image markers
	 * are checked before ANSI state consumes their bytes, preserving the legacy
	 * "marker anywhere in the protocol window" behavior even inside malformed
	 * control strings. Width saturates once it is known to exceed the viewport,
	 * while the pass continues for image and OSC 8 markers.
	 */
	#classifyLine(line: string, maxWidth: number): LineClassification {
		let col = 0;
		let ascii = true;
		let hasOsc8 = false;
		let state: typeof ANSI_TEXT | typeof ANSI_CSI | typeof ANSI_OSC = ANSI_TEXT;

		for (let i = 0; i < line.length; i++) {
			const code = line.charCodeAt(i);
			if ((code === CC_ESC || code === CC_KITTY_PLACEHOLDER_HIGH) && TERMINAL.hasImageMarkerAt(line, i)) {
				return { asciiWidth: undefined, isImage: true, hasOsc8 };
			}
			if (
				code === 0x1b &&
				line.charCodeAt(i + 1) === 0x5d &&
				line.charCodeAt(i + 2) === 0x38 &&
				line.charCodeAt(i + 3) === 0x3b
			) {
				hasOsc8 = true;
			}

			if (state === ANSI_CSI) {
				if (code >= 0x40 && code <= 0x7e) state = ANSI_TEXT;
				continue;
			}
			if (state === ANSI_OSC) {
				if (code === 0x07) {
					state = ANSI_TEXT;
				} else if (code === 0x1b && line.charCodeAt(i + 1) === 0x5c) {
					state = ANSI_TEXT;
					i++;
				}
				continue;
			}
			if (code === 0x1b) {
				const next = line.charCodeAt(i + 1);
				if (next === 0x5b) {
					state = ANSI_CSI;
					i++;
					continue;
				}
				if (next === 0x5d) {
					// OSC 66 text-sizing spans carry visible payload inside the
					// control string. Defer to visibleWidth() for their scaled cells.
					if (
						line.charCodeAt(i + 2) === 0x36 &&
						line.charCodeAt(i + 3) === 0x36 &&
						line.charCodeAt(i + 4) === 0x3b
					) {
						ascii = false;
					}
					state = ANSI_OSC;
					i++;
					continue;
				}
				ascii = false;
				continue;
			}
			if (code < 0x20 || code > 0x7e) {
				ascii = false;
				continue;
			}
			if (ascii && col <= maxWidth) col++;
		}
		if (state !== ANSI_TEXT) ascii = false;
		return { asciiWidth: ascii ? col : undefined, isImage: false, hasOsc8 };
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

	/**
	 * Whether screen row `index` must be rewritten to turn the previously painted
	 * frame into this one: its line, or the preparation it was painted with,
	 * changed.
	 */
	#rowNeedsRewrite(
		previousLines: readonly string[],
		previousRows: readonly PreparedLine[],
		lines: readonly string[],
		rows: readonly PreparedLine[],
		index: number,
	): boolean {
		const previous = previousRows[index];
		const current = rows[index]!;
		return (
			previousLines[index] !== lines[index] ||
			previous === undefined ||
			previous.width !== current.width ||
			previous.widthEpoch !== current.widthEpoch ||
			previous.imageProtocol !== current.imageProtocol
		);
	}

	#lineRewriteSequence(
		line: PreparedLine,
		width: number,
		screenRow = -1,
		frameRow = -1,
		committedTo = -1,
		spacerGlyphWidth = -1,
		options?: { blankRow?: boolean },
	): string {
		// End every rewrite at column zero. ConPTY can materialize a pending
		// wrap before a following cursor-addressing sequence even while DECAWM is
		// disabled; on the bottom row that becomes an untracked scroll and leaks
		// live chrome into native history (#9783). The row loops append only LF
		// because this CR supplies the other half of their explicit CRLF.
		let rewrite: string;
		// Reserved lower half of a scaled OSC 66 heading. The glyph re-emitted on
		// the row above owns columns `[0, spacerGlyphWidth)` here, so preserve
		// them (any erase there clears the glyph — issue #8318) but still clear
		// stale cells to their right: a row can reflow from wider text into this
		// spacer, and the glyph write never covers those columns. Leading reset
		// keeps the erase on the default background (BCE).
		if (spacerGlyphWidth >= 0) {
			rewrite = spacerGlyphWidth >= width ? "" : `${SEGMENT_RESET}\x1b[${spacerGlyphWidth}C${ERASE_TO_END_OF_LINE}`;
		} else if (line.isImage) {
			rewrite = ERASE_LINE + this.#imageLineSequence(line.line, screenRow, frameRow, committedTo);
		} else {
			const terminalLine = this.#terminalLine(line);
			if (options?.blankRow) {
				// A destructive replay starts on a cleared screen and advances only
				// into fresh rows. Each line resets its rendition before scrolling,
				// so those rows already have the default background. Re-erasing every
				// row only adds terminal parser work; images and OSC 66 spacers keep
				// their dedicated cleanup above.
				rewrite = this.#compactReplaySpaces(terminalLine);
			} else if (line.asciiWidth !== undefined) {
				// Exact width model: skip the erase only when the row truly fills
				// the line (an EL there would eat the last cell via pending-wrap).
				rewrite = line.asciiWidth >= width ? terminalLine : terminalLine + ERASE_TO_END_OF_LINE;
			} else {
				// Non-ASCII rows: the native measure can over-count combining-heavy
				// scripts, so a row it calls "full" may render short and leave stale
				// cells from the previous occupant — which would then scroll into
				// history baked into the committed row. Erase the line first instead
				// (rewrites always start at column 1, so EL-to-end clears the whole
				// row); the leading reset keeps BCE on the default background.
				rewrite = SEGMENT_RESET + ERASE_TO_END_OF_LINE + terminalLine;
			}
		}
		return `${rewrite}\r`;
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
	 * Cursor markers are stripped from the frame, but only a focused cursor-mode
	 * component owned by the fullscreen overlay may position the hardware cursor.
	 * The normal transcript is never composited into the alternate buffer.
	 */
	#renderAltFrame(width: number, height: number): void {
		// oxlint-disable-next-line unicorn/no-new-array -- alt-frame length preallocation
		const base: string[] = new Array(Math.max(0, height)).fill("");
		let lines: string[];
		do {
			this.#imageBudget.beginPass(false, true);
			lines = this.#compositeOverlaysIntoWindow(base, width, height);
		} while (this.#imageBudget.endPass());
		const markers: { row: number; col: number }[] = [];
		const prepared = this.#prepareLinesArray(lines, width, this.#altPreparedRows, height, markers);
		const topOverlay = this.#getTopmostVisibleOverlay();
		const focused = this.#focusedComponent;
		const acceptsTerminalCursor =
			topOverlay !== undefined &&
			focused !== null &&
			isFocusable(focused) &&
			focused.focused &&
			typeof focused.setUseTerminalCursor === "function" &&
			isOverlayFocusTarget(topOverlay.component, focused);
		this.#emitAltFrame(prepared, width, height, true, acceptsTerminalCursor ? (markers[0] ?? null) : null);
	}

	/**
	 * Paint a frame on the alt buffer: only the rows that changed since the
	 * previous frame, or every row when the height changed, a repaint is forced,
	 * or a changed frame holds OSC 66 text before or after. Emits only
	 * sync-output brackets, cursor moves, and per-row rewrites — never ED3 or
	 * any native-scrollback byte.
	 */
	#emitAltFrame(
		prepared: PreparedLines,
		width: number,
		height: number,
		notifyPaint: boolean,
		cursorPosition: { row: number; col: number } | null = null,
	): void {
		// The pass that composed this frame ran with `altScreen`, so the normal
		// screen's own placements behind it are not treated as retired.
		this.#imageBudget.limitResidentImages();
		// Flush queued image-data transmits (`a=t`, no visible output) before the
		// paint so id-keyed placements and placeholder cells composed into this
		// frame resolve against loaded data. The normal-screen path flushes these
		// ahead of its paint; without this, an image first shown inside a
		// fullscreen overlay (e.g. the settings shape preview) would render as
		// blank placeholder cells until the overlay closed. A pending resize-borrow
		// entry leads: the image commands address the alternate buffer's store.
		let prelude = this.#takePendingAltEnter();
		const purgeIds = this.#imageBudget.takePurgeIds();
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of purgeIds) prelude += encodeKittyDeleteImage(id);
		}
		for (const seq of this.#imageBudget.takeTransmits()) prelude += seq;
		// A forced repaint (resetDisplay, requestRender(true)) rewrites every row
		// even when the cached frame is byte-identical: the redraw gesture must
		// repair a corrupted modal. So does a changed frame with OSC 66 text in
		// it, before or after: a scaled glyph spans the rows below its own and the
		// terminal drops it when any of them is written, so those rows are not
		// independent. Otherwise rewrite only the rows that changed (a keystroke
		// in a modal touches a row or two), and skip an identical frame entirely.
		const force = this.#forceViewportRepaintOnNextRender;
		this.#forceViewportRepaintOnNextRender = false;
		const full =
			force ||
			this.#altPreviousLines.length !== height ||
			((this.#altPreviousLines.some(isOsc66Line) || prepared.lines.some(isOsc66Line)) &&
				prepared.rows.some((_row, r) =>
					this.#rowNeedsRewrite(this.#altPreviousLines, this.#altPreparedRows, prepared.lines, prepared.rows, r),
				));
		let rowsBuffer = "";
		for (let r = 0; r < height; r++) {
			if (full) {
				if (r > 0) rowsBuffer += "\n";
			} else if (
				this.#rowNeedsRewrite(this.#altPreviousLines, this.#altPreparedRows, prepared.lines, prepared.rows, r)
			) {
				rowsBuffer += `\x1b[${r + 1};1H`;
			} else {
				continue;
			}
			rowsBuffer += this.#lineRewriteSequence(
				prepared.rows[r]!,
				width,
				r,
				-1,
				-1,
				this.#osc66SpacerGlyphWidth(prepared.lines, r),
			);
		}
		this.#altPreviousLines = prepared.lines;
		this.#altPreparedRows = prepared.rows;
		const target = this.#targetHardwareCursorState(cursorPosition, height);
		const previousCursor = this.#hardwareCursorState;
		const cursorChanged =
			target === null
				? previousCursor?.visible === true
				: previousCursor === null ||
					previousCursor.row !== target.row ||
					previousCursor.col !== target.col ||
					previousCursor.visible !== target.visible;
		const placeCursor = target !== null && (rowsBuffer !== "" || cursorChanged);
		const hideCursor = target === null && previousCursor?.visible === true;
		if (rowsBuffer === "" && !placeCursor && !hideCursor) {
			if (prelude !== "") this.terminal.write(prelude);
			return;
		}

		let cursorBuffer = "";
		if (placeCursor && target !== null) {
			cursorBuffer = `\x1b[${target.row + 1};${target.col + 1}H${target.visible ? "\x1b[?25h" : "\x1b[?25l"}`;
		} else if (hideCursor) {
			cursorBuffer = "\x1b[?25l";
		}
		this.terminal.write(
			`${this.#paintBeginSequence}${prelude}${full ? "\x1b[H" : ""}${rowsBuffer}${cursorBuffer}${this.#paintEndSequence}`,
		);
		this.#debugPaint = {
			lines: prepared.lines,
			windowTop: 0,
			altScreen: true,
			...(target === null ? {} : { cursor: { x: target.col, y: target.row, visible: target.visible } }),
		};
		if (notifyPaint && rowsBuffer !== "") {
			this.#notifyPaint({
				history: [],
				viewport: prepared.lines,
				reset: false,
				alt: true,
				columns: width,
				rows: height,
			});
		}
		if (full && rowsBuffer !== "") this.#fullRedrawCount += 1;
		// DEC 1049 restores the normal-buffer cursor on exit. Track this buffer's
		// visibility and marker position without replacing that saved normal row,
		// which stop() and a late native-surface handshake use after the restore.
		if (target) this.#hardwareCursorState = target;
		else this.#recordHardwareCursorHidden();
	}
}
