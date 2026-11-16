/**
 * The TUI: the JS half of the terminal UI.
 *
 * It owns what is inherently JS — the component model and tree, focus, the
 * overlay stack, input routing to components, the Tern Surface Protocol
 * backend, and the inline-image budget — and composes frames for the native
 * terminal engine (`crates/pi-natives/src/tui`), which owns everything a
 * terminal sees: input parsing, capability negotiation, row preparation and
 * diffing, history commits, resize transactions, the alternate screen, and
 * render pacing. The engine announces that a frame is due; the TUI asks it
 * what to compose (`beginFrame`), renders the frame provider and overlays into
 * rows, and hands the rows back (`presentPlan` / `presentAlt` /
 * `presentResize`).
 *
 * Two output channels: a product-owned {@link TerminalFrameProvider} returns,
 * per frame, an optional immutable {@link HistoryBatch} (finalized or naturally
 * emitted stable rows, or one complete replay, gated by a monotonic id and
 * acknowledgement) plus the complete mutable viewport. The engine anchors the
 * viewport directly below whatever history remains visible, diffs
 * viewport-only frames, and never infers finality from a row's position.
 * Destructive clears (ED3) happen through explicit user gestures or configured
 * settled-width rebuilds. Hosts without a provider paint their composed
 * children as a bounded viewport and never touch history. See
 * `docs/tui-core-renderer.md`.
 */
import { performance } from "node:perf_hooks";
import { type EngineOverlay, ImageBudget, isInsideTerminalMultiplexer } from "@oh-my-pi/pi-natives";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import type { TspFrame, TspNode, TspText } from "@oh-my-pi/pi-wire";
import { TuiDebugServer } from "./debug-server";
import { minFrameIntervalMs } from "./frame-rate";
import { extractPrintableText, isKeyRelease, matchesKey } from "./keys";
import { LoopWatchdog } from "./loop-watchdog";
import { assumedTspHello, NativeBackend, type NativeHost } from "./native/backend";
import { col } from "./native/describe";
import { TSP_PREFIX, type TspHello } from "./native/encode";
import type { DescribeContext, NativeNode, NativeScreen, NativeSurfaceProvider, NativeUiEvent } from "./native/node";
import type { Terminal, TerminalHost } from "./terminal";
import { getTerminalBackgroundColor, ImageProtocol, TERMINAL } from "./terminal-capabilities";
import { onTerminalBackgroundFallbackChange } from "./theme/theme";
import { visibleWidth } from "./utils";

export interface RenderTimer {
	cancel(): void;
}

/**
 * The clock and timers the TUI runs on. The native terminal engine never reads
 * a clock: every call into it carries {@link RenderScheduler.now}, and its one
 * timer is re-armed through {@link RenderScheduler.scheduleRender}, so a test
 * that injects a scheduler drives renders, probe timeouts, and resize settling
 * deterministically.
 */
export interface RenderScheduler {
	now(): number;
	scheduleImmediate(callback: () => void): void;
	scheduleRender(callback: () => void, delayMs: number): RenderTimer;
}

/** Wall-clock scheduler: `performance.now()`, `setImmediate`, `setTimeout`. */
export const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
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

/** Observer of completed terminal paints; see `TUI.addPaintListener`. */
export type PaintListener = (paint: TuiPaint) => void;

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

/** Full-attribute reset terminating each rendered content row. */
export const SEGMENT_RESET = "\x1b[0m";

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
	 * the ones derived from the overlay options. `size` is a width class: on a
	 * narrow pane the backend fills it only when the described content is tall
	 * (see `NativeBackend`).
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
	 * Native transcript blocks drawn right after this one as siblings (a `TranscriptContainer` child only): notes
	 * about the block that must show while it is collapsed, such as a tool card's Spotlight notice. The terminal
	 * rows never show them. Return the same array while unchanged.
	 */
	nativeTrailers?(): readonly Component[];

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
	 * Optional handler for text pasted while the component owns input (a
	 * bracketed paste or an input-method commit). The engine already stripped
	 * the paste markers and decoded the payload; it may still carry CR/LF, tabs
	 * and other control characters for the component to sanitize. Routed like
	 * keys (focus, input-less key holders, the startup hold), never through
	 * {@link handleInput}; a component without it ignores pastes.
	 *
	 * `enter` is an Enter key that shared the paste's stdin read. It is only a
	 * hint (a host can stage a paste for the coming submit instead of prompting
	 * about it): the TUI delivers it through {@link handleInput} right after.
	 */
	handlePaste?(text: string, enter?: string): void;

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

/** Whether `component` is `owner` itself or a focus target `owner` declares through {@link OverlayFocusOwner}. */
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

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * The terminal engine finds and strips this marker, then positions the
 * hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

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

/**
 * `component`'s own native description, or `null` when it draws as rendered rows: it has no
 * `describe`, answers `null`, or is a Container subclass that paints its own rows but inherits the
 * plain column description, which would lose that rendering.
 */
export function ownDescription(component: Component, cx: DescribeContext): NativeNode | null {
	const describe = component.describe;
	if (describe === undefined) return null;
	if (describe === Container.prototype.describe && component.render !== Container.prototype.render) return null;
	return describe.call(component, cx);
}

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

/** One stacked overlay; `TUI.overlayStack` holds them bottom to top. */
interface OverlayEntry {
	component: Component;
	options?: OverlayOptions;
	/** Focus restored after closing; tracks live focus changes beneath an input-less key holder. */
	preFocus: Component | null;
	hidden: boolean;
	/**
	 * A sheet the user clicked away from: it stays up but no longer holds the
	 * keys, until focus moves back into it.
	 */
	released: boolean;
}

/** Whether `entry` is drawn at a `columns` x `rows` terminal: not hidden, and its `visible` predicate (if any) agrees. */
function isOverlayVisible(entry: OverlayEntry, columns: number, rows: number): boolean {
	if (entry.hidden) return false;
	if (entry.options?.visible) return entry.options.visible(columns, rows);
	return true;
}

/** Resolved placement of an overlay inside the terminal. */
interface OverlayLayout {
	width: number;
	row: number;
	col: number;
	maxHeight: number;
}

/**
 * Resolve overlay layout from options.
 * Returns { width, row, col, maxHeight } for rendering.
 */
function resolveOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): OverlayLayout {
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
				row = resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
			}
		} else {
			// Absolute row position
			row = opt.row;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		row = resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
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
				col = resolveAnchorCol("center", width, availWidth, marginLeft);
			}
		} else {
			// Absolute column position
			col = opt.col;
		}
	} else {
		// Anchor-based (default: center)
		const anchor = opt.anchor ?? "center";
		col = resolveAnchorCol(anchor, width, availWidth, marginLeft);
	}

	// Apply offsets
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;

	// Clamp to terminal bounds (respecting margins)
	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

	return { width, row, col, maxHeight };
}

function resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
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

function resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
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
 * Render the visible entries of `stack` (in stack order, later = on top) at
 * their resolved width and place them in screen coordinates for the engine,
 * which composites them into the painted window. Overlays never touch the
 * frame: composited rows exist only in the painted window, and commits are
 * frozen while an overlay is visible, so overlay pixels can never enter
 * native scrollback.
 *
 * Callers run this inside their image-budget pass so the frame's whole image
 * set — transcript plus modal — reaches one reconcile, instead of leaving the
 * overlay's graphics outside the cap for as long as it stays up.
 */
function renderOverlays(stack: readonly OverlayEntry[], termWidth: number, termHeight: number): EngineOverlay[] {
	const overlays: EngineOverlay[] = [];
	for (const entry of stack) {
		if (!isOverlayVisible(entry, termWidth, termHeight)) continue;
		const { component, options } = entry;
		// Get layout with height=0 first to determine width and maxHeight
		// (width and maxHeight don't depend on overlay height).
		const { width, maxHeight } = resolveOverlayLayout(options, 0, termWidth, termHeight);
		const rendered = component.render(width);
		let lines: string[];
		if (rendered.length > maxHeight) {
			const anchor = options?.anchor ?? "center";
			lines =
				anchor === "bottom-left" || anchor === "bottom-center" || anchor === "bottom-right"
					? rendered.slice(rendered.length - maxHeight)
					: rendered.slice(0, maxHeight);
		} else {
			lines = rendered.slice();
		}
		const { row, col } = resolveOverlayLayout(options, lines.length, termWidth, termHeight);
		overlays.push({ row, col, width, lines });
	}
	return overlays;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
/** Sees a paste before the focused component; `consume` stops delivery. */
type PasteListener = (text: string) => { consume?: boolean } | undefined;
/** Input held during a TSP startup hold: a key sequence, or a paste with the Enter that shared its read. */
type HeldInput = string | { paste: string; enter: string | undefined };
type StartListener = () => void;

/**
 * Mouse reporting wanted for a frame. It is scoped to fullscreen overlays that
 * opt into pointer interaction (`full`), plus the opt-in normal-buffer click
 * capture (`inline`, `tui.mouse`). Selection-first surfaces leave it `off` so
 * the terminal retains native text selection.
 */
type MouseTracking = "off" | "inline" | "full";

/** What the host wants on screen for the frame the engine is about to begin. */
interface FrameView {
	/** The topmost visible overlay borrows the alternate screen. */
	alt: boolean;
	mouse: MouseTracking;
}

/** Whether a frame provider also describes its surface for a Tern Surface Protocol terminal. */
function describesSurface(provider: TerminalFrameProvider): provider is TerminalFrameProvider & NativeSurfaceProvider {
	return "describeSurface" in provider && typeof provider.describeSurface === "function";
}

export interface TUIOptions {
	renderScheduler?: RenderScheduler;
	onPaint?: PaintListener;
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
	 * gets it. Plain typing (printable text, Backspace) still edits the focused
	 * component live, as the kernel echo shows it elsewhere; the first other key
	 * and every key after it are held instead (TSP events still apply) until
	 * {@link TUI.releaseHeldInput} replays them.
	 */
	deferInput?: boolean;
}

/**
 * TUI - owns the component tree, focus, overlays, and input routing, and
 * composes the frames the terminal engine paints.
 */
export class TUI extends Container {
	terminal: Terminal;
	#frameProvider: TerminalFrameProvider | undefined;
	#acceptedHistoryBatchId = 0;
	#focusedComponent: Component | null = null;
	#debugServer: TuiDebugServer | undefined;
	#inputListeners = new Set<InputListener>();
	#pasteListeners = new Set<PasteListener>();
	#startListeners = new Set<StartListener>();
	/** True from the end of start() until stop(): the terminal modes start listeners enable are live. */
	#started = false;
	#paintListeners = new Set<PaintListener>();
	#frameTextListeners = new Map<string, Set<() => void>>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	onDebug?: () => void;
	#renderScheduler: RenderScheduler;
	/** A frame was requested that the engine has not announced yet. */
	#renderPending = false;
	/** A frame is being composed or presented. */
	#rendering = false;
	/** A `render` arrived while {@link #rendering}. */
	#renderAgain = false;
	// Caps how many inline images render as live graphics; older ones fall back
	// to text via a purge + full redraw. Cap is configured by the host app.
	// The engine shares it: frames drain its purges and transmits, and the
	// redraws it asks for are scheduled by the engine.
	#imageBudget = new ImageBudget();
	// The frame interval the engine mirrors, as last pushed. `setMaxFps` changes
	// it from anywhere, so the host reconciles it before requesting or composing
	// a frame.
	#engineFrameIntervalMs: number | undefined;
	#stopped = false;
	#appearanceReportUnsubscribe: (() => void) | undefined;
	#cancelPostmortemRestore?: () => void;
	/** True between a `deferInput` start() and enableInput(). */
	#inputDeferred = false;
	/**
	 * Keystrokes held since a TSP `deferInput` start, replayed by
	 * releaseHeldInput(); undefined when not holding, empty while plain typing
	 * still goes through live.
	 */
	#heldInput: HeldInput[] | undefined;
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
	/** Product-owned probe for opt-in normal-buffer click capture (`tui.mouse`). Read every frame. */
	#inlineMouseProvider: (() => boolean) | undefined;

	// Tern Surface Protocol backend, created when the engine's handshake opens
	// the surface (the terminal answered the `hello` probe, or the environment
	// names Tern). Kept across stop/start so a restart adopts the surface.
	#native: NativeBackend | undefined;
	#nativeLive = false;

	// Overlay stack for modal components rendered on top of base content
	overlayStack: OverlayEntry[] = [];

	readonly #terminalHost: TerminalHost = {
		input: data => this.#handleInput(data),
		paste: (text, enter) => this.#handlePaste(text, enter),
		render: () => this.#render(),
		resize: () => {
			// The terminal lays a native surface out: a resize only refreshes the
			// width `rows` fallback nodes render at. Everything else a resize needs
			// (the transient resize buffer, settling, anchor recovery, replay) is
			// the engine's.
			if (this.#nativeLive) this.#native?.noteTerminalColumns(this.terminal.columns);
		},
		disconnect: () => this.stop(),
		historyReplay: () => this.#frameProvider?.beginHistoryReplay?.(),
		frameText: text => this.#notifyFrameText(text),
		cellSize: () => {
			// Invalidate all components so images re-render with correct dimensions.
			this.invalidate();
			this.requestRender();
		},
		nativeSurface: (live, hello, reason) => this.#onNativeSurface(live, hello, reason),
		// The engine adopted SIXEL and forced the repaint: images render anew.
		imageProtocol: () => this.invalidate(),
	};

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options?: TUIOptions) {
		super();
		this.terminal = terminal;
		this.#renderScheduler = options?.renderScheduler ?? DEFAULT_RENDER_SCHEDULER;
		terminal.bind(this.#terminalHost, this.#renderScheduler);
		terminal.attachImageBudget(this.#imageBudget);
		if (options?.onPaint) this.#paintListeners.add(options.onPaint);
		if (showHardwareCursor !== undefined) {
			terminal.run(engine => engine.setShowHardwareCursor(showHardwareCursor));
		}
		this.#watchdog = new LoopWatchdog();
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

	/**
	 * Call `listener` whenever a frame write — transient resize paints included
	 * — emits a row containing `text`; returns the unsubscribe. Rows a frame
	 * left untouched do not count: only what the terminal was actually sent.
	 */
	addFrameTextListener(text: string, listener: () => void): () => void {
		let listeners = this.#frameTextListeners.get(text);
		if (listeners === undefined) {
			listeners = new Set();
			this.#frameTextListeners.set(text, listeners);
			this.#pushFrameTextWatches();
		}
		listeners.add(listener);
		return () => {
			const current = this.#frameTextListeners.get(text);
			if (current === undefined || !current.delete(listener) || current.size > 0) return;
			this.#frameTextListeners.delete(text);
			this.#pushFrameTextWatches();
		};
	}

	#pushFrameTextWatches(): void {
		const texts = [...this.#frameTextListeners.keys()];
		this.terminal.run(engine => engine.setFrameTextWatches(texts));
	}

	#notifyFrameText(text: string): void {
		const listeners = this.#frameTextListeners.get(text);
		if (listeners === undefined) return;
		for (const listener of listeners) {
			try {
				listener();
			} catch (err) {
				logger.error("TUI frame text listener failed", { err });
			}
		}
	}

	/** Install the product-owned bounded frame provider. */
	setFrameProvider(provider: TerminalFrameProvider | undefined): void {
		this.#frameProvider = provider;
		// The engine drops its painted window and requests a forced frame.
		if (!this.#stopped) this.#renderPending = true;
		this.terminal.run((engine, now) =>
			engine.setFrameProvider(now, provider !== undefined, provider?.beginHistoryReplay !== undefined),
		);
	}

	#syncTerminalCursorMode(component: Component | null): void {
		if (isFocusable(component)) {
			component.setUseTerminalCursor?.(this.terminal.engine.showHardwareCursor);
		}
	}

	get fullRedraws(): number {
		return this.terminal.engine.fullRedraws;
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
		const before = this.#imageBudget.cap;
		this.#imageBudget.setCap(cap);
		if (this.#imageBudget.cap !== before) this.requestRender();
	}
	/** Return how settled resizes refresh native scrollback. */
	getResizeScrollback(): ResizeScrollbackMode {
		return this.terminal.engine.resizeScrollback;
	}

	/** Set how settled resizes refresh native scrollback. */
	setResizeScrollback(mode: ResizeScrollbackMode): void {
		this.terminal.run(engine => engine.setResizeScrollback(mode));
	}

	/** Delete every tracked Kitty image from the terminal graphics store. */
	clearInlineImages(): void {
		if (this.#stopped) return;
		this.terminal.run(engine => engine.clearInlineImages());
	}

	getShowHardwareCursor(): boolean {
		return this.terminal.engine.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.getShowHardwareCursor() === enabled) return;
		// Turning it off hides the cursor at once.
		this.terminal.run(engine => engine.setShowHardwareCursor(enabled));
		this.#syncTerminalCursorMode(this.#focusedComponent);
		this.requestRender();
	}

	/**
	 * Whether DEC 2026 synchronized-output wrappers are currently emitted around
	 * paints. Starts from conservative terminal/env detection and is reconciled at
	 * runtime against the terminal's DECRQM mode-2026 report — enabled on a
	 * positive report, disabled on a negative one.
	 */
	get synchronizedOutput(): boolean {
		return this.terminal.engine.synchronizedOutput;
	}

	/**
	 * Cost in milliseconds of the most recently completed frame.
	 *
	 * Animation components use this to apply proportional backpressure after
	 * their render request is asynchronously composed and written.
	 */
	get lastFrameCostMs(): number {
		return this.terminal.engine.lastFrameCostMs;
	}

	setFocus(component: Component | null): void {
		const holder = this.#getKeyHolderOverlay();
		if (holder && !isOverlayFocusTarget(holder.component, component)) {
			if (!holder.component.handleInput && this.#focusedComponent === holder.component) {
				holder.preFocus = component;
			}
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
		const paint = this.terminal.engine.debugPaint();
		if (paint === null) return undefined;
		return paint;
	}

	/** Render the current root document at the live terminal width for debug inspection. */
	getDebugDocument(): readonly string[] {
		return this.render(Math.max(1, this.terminal.columns));
	}

	/** Feed debug and test input through the same pipeline as terminal stdin. */
	injectDebugInput(data: string): void {
		this.#handleInput(data);
	}

	/** Feed a debug or test paste through the same pipeline as a terminal paste. */
	injectDebugPaste(text: string): void {
		this.#handlePaste(text, undefined);
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		component.setIgnoreTight?.(true);
		const entry: OverlayEntry = {
			component,
			options,
			preFocus: this.#focusedComponent,
			hidden: false,
			released: false,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (this.#isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Overlays opened over this one return focus to where it would have.
					for (const other of this.overlayStack) {
						if (other.preFocus && isOverlayFocusTarget(component, other.preFocus))
							other.preFocus = entry.preFocus;
					}
					// Restore focus if this overlay or one of its owned targets had focus
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						this.setFocus(this.#getKeyHolderOverlay()?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) {
						this.terminal.hideCursor();
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
		return this.terminal.engine.mutableViewport();
	}

	/**
	 * Rows of native history the last paint left on screen above a mutable
	 * viewport that reached the bottom row, or `undefined` when that paint left
	 * rows free below it (or none happened, or a destructive reset will repaint
	 * from row zero). Rows above a bottom-reaching viewport may already sit in
	 * native scrollback, which a later shrink cannot pull back down.
	 */
	getFilledHistoryRows(): number | undefined {
		return this.terminal.engine.filledHistoryRows() ?? undefined;
	}

	/** Whether native history holds rows the frame provider committed since the last destructive reset. */
	hasProviderHistory(): boolean {
		return this.terminal.engine.hasProviderHistory();
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

	/** Check if an overlay entry is currently visible */
	#isOverlayVisible(entry: OverlayEntry): boolean {
		return isOverlayVisible(entry, this.terminal.columns, this.terminal.rows);
	}

	/** Find the topmost visible overlay, if any */
	#getTopmostVisibleOverlay(): OverlayEntry | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.#isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	/** The topmost visible overlay that holds the keys: not a sheet the user clicked away from. */
	#getKeyHolderOverlay(): OverlayEntry | undefined {
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
		this.#renderPending = false;
		this.#stopped = false;
		this.#appearanceReportUnsubscribe?.();
		let backgroundRgb: number | undefined;
		let subscribed = true;
		const repaintForBackgroundChange = () => {
			if (!subscribed || this.#stopped) return;
			const nextBackgroundRgb = getTerminalBackgroundColor();
			// Track RGB before the SIXEL guard: the startup OSC 11 reply usually
			// arrives before DA1 enables SIXEL, so revisiting the same color once
			// SIXEL is live must not replay identical rows.
			if (nextBackgroundRgb === backgroundRgb) return;
			backgroundRgb = nextBackgroundRgb;
			if (TERMINAL.imageProtocol !== ImageProtocol.Sixel) return;
			// Track RGB even during optimistic native ownership: fallback paints
			// with the latest color, so a later return to the startup RGB must repaint.
			// Never write rows while the native surface still owns rendering.
			if (this.#nativeLive) return;
			this.invalidate();
			// Match theme changes: replay owned history on direct terminals, but
			// leave multiplexer scrollback intact and repaint only the viewport.
			this.requestRender(true, { clearScrollback: !isInsideTerminalMultiplexer(Bun.env) });
		};
		const unsubscribe = this.terminal.onAppearanceReport(repaintForBackgroundChange);
		const unsubscribeFallback = onTerminalBackgroundFallbackChange(repaintForBackgroundChange);
		this.#appearanceReportUnsubscribe = () => {
			subscribed = false;
			unsubscribe();
			unsubscribeFallback();
		};
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
		const nativeExpected = this.terminal.tspExpected;
		this.#inputDeferred = options?.deferInput === true && !nativeExpected;
		// A restart (a startup dialog's external editor stops and restarts the
		// TUI) keeps an existing hold: those keys still belong to the editor.
		if (options?.deferInput === true && nativeExpected) {
			this.#heldInput = [];
			this.#heldFocus = this.#focusedComponent;
		}
		this.#watchdog.start();
		// Icons painted before the Glyph Protocol registration landed may sit in
		// the terminal as tofu; a full repaint re-emits them against the glossary.
		this.terminal.onGlyphProtocolReport(supported => {
			if (!supported || this.#stopped) return;
			this.invalidate();
			this.requestRender(true);
		});
		// Starting sends the capability probes (unless input is deferred); a
		// terminal that could not parse one left its bytes on the cursor row,
		// which the forced frame below repaints. With the `hello` probe out, the
		// engine opens the surface on assumed capabilities (the environment names
		// Tern) or holds the first paint until the probe resolves
		// (`nativeSurface`).
		this.terminal.start({
			deferInput: this.#inputDeferred,
			isLoopStalled: () => this.#watchdog.isStalled(),
		});
		// A process terminal's start() resets the previous owner's RGB. Seed only
		// after that reset so an identical OSC 11 reply still repaints fallback rows.
		backgroundRgb = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getTerminalBackgroundColor() : undefined;
		if (this.#stopped) return;
		this.#cancelPostmortemRestore?.();
		this.#cancelPostmortemRestore = postmortem.register("tui-restore", () => this.stop());
		for (const listener of this.#startListeners) this.#runStartListener(listener);
		this.#started = !this.#stopped;
		this.terminal.hideCursor();
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
		if (this.#renderPending) this.#renderImmediately({ immediate: true });
		this.#native?.stop();
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

	/**
	 * The engine's handshake moved the surface (see {@link TerminalHost.nativeSurface}).
	 * Opening adopts the backend a stop/start cycle closed; the engine already
	 * stopped painting rows (erasing any it painted). A revoke closes the
	 * backend without keeping anything; the engine forces the row repaint, and
	 * a reply that still arrives later opens a fresh surface the usual way.
	 */
	#onNativeSurface(live: boolean, hello: TspHello | undefined, reason: string | undefined): void {
		if (this.#stopped) return;
		if (!live) {
			logger.warn("TSP: terminal did not confirm the surface; falling back to rows", { reason });
			this.#nativeLive = false;
			this.#native?.stop(false);
			this.#native = undefined;
			return;
		}
		if (this.#nativeLive) {
			// The reply confirmed the surface opened on assumed capabilities.
			if (hello !== undefined) this.#native?.confirm(hello);
			return;
		}
		this.#nativeLive = true;
		const capabilities = hello ?? assumedTspHello(this.terminal);
		if (this.#native) {
			this.#native.resume(capabilities);
			return;
		}
		this.#native = new NativeBackend(this.#nativeHost(), capabilities, {
			mirror: this.#debugServer !== undefined,
			scheduler: this.#renderScheduler === DEFAULT_RENDER_SCHEDULER ? undefined : this.#renderScheduler,
		});
		this.#native.start();
	}

	#nativeHost(): NativeHost {
		return {
			terminal: this.terminal,
			describeSurface: cx => {
				const provider = this.#frameProvider;
				if (provider !== undefined && describesSurface(provider)) return provider.describeSurface(cx);
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
				this.terminal.refreshAppearance();
			},
			motionChanged: () => {
				this.invalidate();
				this.requestRender();
			},
			invalidate: () => this.invalidate(),
		};
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
		this.terminal.enableInput();
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
		for (const item of held) {
			if (typeof item === "string") this.#handleInput(item);
			else this.#handlePaste(item.paste, item.enter);
		}
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

	/**
	 * Register a hook that re-enables terminal modes on every start(). A hook
	 * added while the TUI is already running (a prepaint composer starts it
	 * before the interactive mode wires its controllers) missed that start, so
	 * it runs immediately instead of waiting for a stop/start cycle that may
	 * never come.
	 */
	addStartListener(listener: StartListener): () => void {
		this.#startListeners.add(listener);
		if (this.#started) this.#runStartListener(listener);
		return () => {
			this.#startListeners.delete(listener);
		};
	}

	#runStartListener(listener: StartListener): void {
		try {
			listener();
		} catch {
			// Startup listeners are feature hooks; one broken hook must not prevent rendering.
		}
	}

	/** Registers a key listener; `prepend` gives a foreground input owner first refusal over global shortcuts. */
	addInputListener(listener: InputListener, options?: { prepend?: boolean }): () => void {
		if (options?.prepend) {
			this.#inputListeners = new Set([listener, ...this.#inputListeners]);
		} else {
			this.#inputListeners.add(listener);
		}
		return () => {
			this.#inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.#inputListeners.delete(listener);
	}

	/** Registers a paste listener; key listeners never see pastes. `prepend` gives it first refusal. */
	addPasteListener(listener: PasteListener, options?: { prepend?: boolean }): () => void {
		if (options?.prepend) {
			this.#pasteListeners = new Set([listener, ...this.#pasteListeners]);
		} else {
			this.#pasteListeners.add(listener);
		}
		return () => {
			this.#pasteListeners.delete(listener);
		};
	}

	/** Push the frame interval the engine mirrors when `setMaxFps` changed it. */
	#syncEngineSettings(): void {
		const frameIntervalMs = minFrameIntervalMs();
		if (frameIntervalMs === this.#engineFrameIntervalMs) return;
		this.#engineFrameIntervalMs = frameIntervalMs;
		this.terminal.run(engine => engine.setFrameIntervalMs(frameIntervalMs));
	}

	/**
	 * Retire every eligible history batch into native scrollback before quitting.
	 *
	 * The only frame path that deliberately does not composite overlays. Its
	 * output is the transcript the shell prompt lands under, and it forces
	 * commits that overlay compositing otherwise relies on being frozen while an
	 * overlay is up — so a modal painted here would leave debris above the
	 * prompt and could reach native scrollback. `stop()` drops the alternate
	 * buffer without unstacking the overlay, so leaving it in would also charge
	 * a no-longer-painted modal's images against the cap and delete the
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
			this.#presentPlan(viewport, plan.history, provider, 0);
			if (plan.history.id > acceptedBefore && this.#acceptedHistoryBatchId === acceptedBefore) {
				throw new Error("History flush did not accept the offered batch");
			}
		}
	}

	stop(): void {
		if (this.#stopped) return;
		// Nothing renders from here on: frames the teardown below still announces
		// are dropped, and the flush presents its own.
		this.#stopped = true;
		this.#started = false;
		this.#renderPending = false;
		this.#appearanceReportUnsubscribe?.();
		this.#appearanceReportUnsubscribe = undefined;
		this.#cancelPostmortemRestore?.();
		this.#cancelPostmortemRestore = undefined;
		this.#debugServer?.stop();
		this.#debugServer = undefined;
		const nativeWasLive = this.#nativeLive;
		if (nativeWasLive) {
			this.#native?.stop();
			this.#nativeLive = false;
		}
		// The engine ends whatever owns the screen besides the transcript — the
		// TSP surface and its handshake (confirm deadline, first-paint hold), a
		// resize transaction, the alternate buffer, mouse reporting — and drops a
		// latched destructive reset: that pairs ED3 with a complete-ledger replay,
		// and running the pair during stop would erase native history and
		// re-stream the whole transcript at quit. The flush below then writes
		// only un-retired rows.
		this.terminal.run((engine, now) => engine.prepareStop(now));
		// The surface already holds the transcript; there's no row history to retire.
		if (!nativeWasLive) this.#flushHistoryBeforeStop();
		// Deliberately leave transmitted images in the terminal's graphics store:
		// placeholder cells committed to native scrollback render only while their
		// image data lives, so a delete-by-id here blanks every transcript image
		// the instant the session exits. The terminal enforces its own store quota
		// (and live-session ghosts are already bounded by the inline-image budget).
		this.#watchdog.stop();
		// The engine places the parent shell on the first line after the rendered
		// content, shows the cursor, and restores the terminal.
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
		this.#renderImmediately({ force: true, clearScrollback: true, immediate: true });
	}

	requestRender(force = false, options?: RenderRequestOptions): void {
		if (this.#stopped) return;
		this.#syncEngineSettings();
		this.#renderPending = true;
		// Every request is forwarded: the engine coalesces ordinary ones, paces
		// them (the `tui.maxFps` ceiling, the input cadence while a keystroke's
		// latch is set, adaptive backpressure), and defers them while the
		// terminal's output backlog is deep.
		this.terminal.requestRender(
			force ? { force: true, clearScrollback: options?.clearScrollback === true } : undefined,
		);
	}

	/** Run `callback` after `delayMs` on the render scheduler's clock, unless the TUI has stopped. */
	scheduleAfter(delayMs: number, callback: () => void): RenderTimer {
		return this.#renderScheduler.scheduleRender(() => {
			if (!this.#stopped) callback();
		}, delayMs);
	}

	/**
	 * Paint a forced frame synchronously when startup must hand off an already
	 * visible component tree before further async initialization. Same as
	 * {@link requestRender} minus the scheduler hop.
	 */
	renderNow(options?: RenderRequestOptions): void {
		if (this.#stopped) return;
		this.#renderImmediately({ force: true, clearScrollback: options?.clearScrollback === true, immediate: true });
	}

	/**
	 * Schedule a render on behalf of `component` after a self-contained change
	 * (spinner frame, blink). Frames always compose the bounded viewport from
	 * scratch — retired blocks no longer render — so a scoped request is simply
	 * an ordinary render.
	 */
	requestComponentRender(_component: Component): void {
		this.requestRender();
	}

	/** Request a frame that is due now and let the engine announce it in this turn. */
	#renderImmediately(request: { force?: boolean; clearScrollback?: boolean; immediate: true }): void {
		this.#syncEngineSettings();
		this.terminal.run((engine, now) => {
			engine.requestRender(now, request);
			engine.tick(now);
		});
	}

	#handleInput(data: string): void {
		// Tern Surface Protocol events (acks, pointer actions, resize, theme)
		// are terminal reports, never keystrokes.
		if (data.startsWith(TSP_PREFIX)) {
			if (this.#nativeLive) this.#native?.handleInput(data);
			return;
		}
		if (data.length === 0) return;
		// Every keystroke arms the input latch before any consumer runs, so whichever consumer
		// requests the paint — an input listener or the focused component — it is paced at the input
		// cadence, not the ceiling. Input that triggers no render leaves the latch for the next frame
		// to consume at the 30 fps floor once; harmless.
		this.terminal.requestRender({ input: true });

		if (
			this.#heldInput !== undefined &&
			this.#focusedComponent === this.#heldFocus &&
			!this.#typesThroughHold(data)
		) {
			this.#holdInput(data);
			return;
		}

		// Runs before the capture preflight below, which must target the effective focus owner, not
		// a hidden overlay.
		this.#refocusHiddenOverlay();
		// Ctrl+C/Esc use app-level double-press windows. Give those gestures one
		// frame to drain queued input before an ordinary repaint; delaying every
		// key would make idle navigation pay a full frame of latency.
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.terminal.requestRender({ input: true, inputGrace: true });
		}

		// The effective input owner can reserve its gesture before TUI-wide listeners
		// and debug shortcuts see the key, then handle the raw event exactly once.
		const focusedForCapture = this.#inputTarget();
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

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		const target = this.#inputTarget();
		if (target?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !target.wantsKeyRelease) {
				return;
			}
			target.handleInput(data);
			this.requestRender();
		}
	}

	/**
	 * Route a paste the way keys go: held behind a startup hold, offered to paste
	 * listeners, then to the input target's {@link Component.handlePaste}. The
	 * Enter that shared the paste's stdin read goes straight to the component
	 * that took the paste, so paste and submit land together even when the paste
	 * itself opens another component; after a listener consumed the paste it
	 * takes the regular key path.
	 */
	#handlePaste(text: string, enter: string | undefined): void {
		// Pastes arm the input latch like keystrokes (see #handleInput).
		this.terminal.requestRender({ input: true });

		// A paste never types through the hold: it is not plain typing.
		if (this.#heldInput !== undefined && this.#focusedComponent === this.#heldFocus) {
			this.#heldInput.push({ paste: text, enter });
			return;
		}

		this.#refocusHiddenOverlay();

		for (const listener of this.#pasteListeners) {
			if (listener(text)?.consume) {
				if (enter !== undefined) this.#handleInput(enter);
				return;
			}
		}

		const target = this.#inputTarget();
		if (!target) return;
		target.handlePaste?.(text, enter);
		if (enter !== undefined) target.handleInput?.(enter);
		this.requestRender();
	}

	/**
	 * If the focused component is an overlay that is no longer visible (visibility can change on a
	 * terminal resize or through its visible() callback), move focus to the topmost visible overlay,
	 * else back to the overlay's preFocus, before input is routed.
	 */
	#refocusHiddenOverlay(): void {
		const focusedOverlay = this.overlayStack.find(o => o.component === this.#focusedComponent);
		if (!focusedOverlay || this.#isOverlayVisible(focusedOverlay)) return;
		const topVisible = this.#getTopmostVisibleOverlay();
		this.setFocus(topVisible ? topVisible.component : focusedOverlay.preFocus);
	}

	/**
	 * Component that receives keyboard input. An input-less key-holding overlay
	 * leaves input with the focus it displaced; other focus owners keep their input.
	 */
	#inputTarget(): Component | null {
		const focused = this.#focusedComponent;
		if (focused?.handleInput) return focused;
		const holder = this.#getKeyHolderOverlay();
		return holder?.component === focused ? holder.preFocus : null;
	}

	/**
	 * Whether a keystroke typed during a TSP startup hold edits the focused
	 * component now: plain typing (printable text, Backspace) and key releases,
	 * while nothing is queued ahead of them. The draft then grows as it is typed,
	 * like a cooked tty's echo; a shortcut waits for the handlers that act on it,
	 * and whatever follows it waits behind it to keep typing order.
	 */
	#typesThroughHold(data: string): boolean {
		if (this.#heldInput === undefined || this.#heldInput.length > 0) return false;
		return extractPrintableText(data) !== undefined || matchesKey(data, "backspace") || isKeyRelease(data);
	}

	/**
	 * Queue a keystroke typed before the app installed its key handlers; input
	 * listeners see it once, on replay. Ctrl+C/Ctrl+D release the queue so a
	 * stalled startup stays interruptible.
	 */
	#holdInput(data: string): void {
		this.#heldInput?.push(data);
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) this.releaseHeldInput();
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

	/** What the next frame should show: the alternate screen for a fullscreen overlay, and mouse reporting. */
	#frameView(): FrameView {
		// A native surface is laid out by the terminal; the engine paints nothing.
		if (this.#nativeLive) return { alt: false, mouse: "off" };
		// While the topmost visible overlay requests it, the engine borrows the
		// terminal's alternate buffer and paints only the modal there; the normal
		// screen and all its accounting stay untouched.
		const topOverlay = this.#getTopmostVisibleOverlay();
		const alt = topOverlay?.options?.fullscreen === true;
		const mouse: MouseTracking =
			topOverlay === undefined
				? this.#inlineMouseProvider?.() === true
					? "inline"
					: "off"
				: alt && topOverlay.options?.mouseTracking !== false
					? "full"
					: "off";
		return { alt, mouse };
	}

	/**
	 * A frame is due. Ask the engine what to compose — it performs the
	 * alternate-screen and mouse transitions the view asks for, latches resize
	 * replays, and answers `none` while a resize settles, an anchor probe is in
	 * flight, or the first paint is held — then compose and present it.
	 *
	 * A `render` raised while a frame is being composed or presented (a
	 * synchronous scheduler firing the engine's timer from inside `run`) is
	 * deferred until that frame finishes, so it never composes against a
	 * provider whose history batch is not acknowledged yet.
	 */
	#render(): void {
		if (this.#rendering) {
			this.#renderAgain = true;
			return;
		}
		this.#rendering = true;
		try {
			do {
				this.#renderAgain = false;
				this.#renderFrame();
			} while (this.#renderAgain && !this.#stopped);
		} finally {
			this.#rendering = false;
		}
	}

	#renderFrame(): void {
		if (this.#stopped) return;
		this.#renderPending = false;
		this.#syncEngineSettings();
		const view = this.#frameView();
		// History replays latched by this call are dispatched to the provider
		// before it returns; alternate-screen entries reset the image budget's
		// alternate surface in the engine.
		const kind = this.terminal.run((engine, now) => engine.beginFrame(now, view));
		if (this.#stopped) return;
		if (this.#nativeLive) {
			this.#native?.render();
			return;
		}
		switch (kind) {
			case "none":
				return;
			case "plan":
				this.#renderPlanFrame();
				return;
			case "alt":
				this.#renderAltFrame();
				return;
			case "resize":
				this.#renderResizeFrame();
				return;
		}
	}

	/**
	 * Compose a normal-buffer frame: the frame provider's plan, or — for hosts
	 * without a provider (tests, simple embeds) — the bottom `height` rows of
	 * the root children as the mutable viewport, with nothing ever appended to
	 * terminal history.
	 */
	#renderPlanFrame(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (width <= 0 || height <= 0) return;
		const provider = this.#frameProvider;
		let history: HistoryBatch | undefined;
		let viewport: string[];
		let overlays: EngineOverlay[];
		// Row of the composed document the painted window starts at: nonzero only
		// for the children fallback, which paints the tail of the root document.
		let windowTop: number;
		if (provider !== undefined) {
			windowTop = 0;
			let plan: TerminalFramePlan;
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
				overlays = renderOverlays(this.overlayStack, width, height);
			} while (this.#imageBudget.endPass());
			history = plan.history;
		} else {
			do {
				this.#imageBudget.beginPass();
				const composed = this.render(width);
				windowTop = Math.max(0, composed.length - height);
				viewport = composed.length > height ? composed.slice(composed.length - height) : Array.from(composed);
				overlays = renderOverlays(this.overlayStack, width, height);
			} while (this.#imageBudget.endPass());
		}
		this.#presentPlan(viewport, history, provider, windowTop, overlays);
	}

	/**
	 * Hand one composed normal-buffer frame to the engine: an ordinary history
	 * batch to append, or one complete replay, plus the mutable viewport. The
	 * engine composites `overlays` (if any) onto the viewport padded to the
	 * screen height, serializes the whole result in one terminal write —
	 * draining the image budget's purges and transmits into it — and names the
	 * batches it accepted, which are then acknowledged to the provider. A frame the engine
	 * holds (Ghostty's startup window for the first image data) acknowledges
	 * nothing.
	 */
	#presentPlan(
		viewport: string[],
		offered: HistoryBatch | undefined,
		provider: TerminalFrameProvider | undefined,
		windowTop: number,
		overlays?: EngineOverlay[],
	): void {
		let history: { id: number; rows: string[]; replay: boolean } | undefined;
		if (offered !== undefined) {
			if (offered.id > this.#acceptedHistoryBatchId) {
				history = { id: offered.id, rows: offered.rows.slice(), replay: offered.kind === "replay" };
			} else {
				// Already accepted: the provider re-offered it before hearing so.
				provider?.acknowledgeHistory(offered.id);
			}
		}
		const frame = { history, viewport, overlays, wantPaint: this.#paintListeners.size > 0 };
		const result = this.terminal.run((engine, now) => {
			engine.setDebugWindowTop(windowTop);
			return engine.presentPlan(now, frame);
		});
		if (result.paint) this.#notifyPaint(result.paint);
		for (const id of result.acknowledged) {
			if (id > this.#acceptedHistoryBatchId) this.#acceptedHistoryBatchId = id;
			provider?.acknowledgeHistory(id);
		}
		// Normal retirement may hold another ordered batch. Replay is always
		// complete, so pumping it would create a second visible redraw/write.
		if (history !== undefined && !history.replay && this.#acceptedHistoryBatchId >= history.id) {
			this.requestRender();
		}
	}

	/**
	 * Compose a single fullscreen overlay frame for the alt buffer. Only a
	 * focused cursor-mode component owned by the fullscreen overlay may position
	 * the hardware cursor. The engine composites the overlays onto a blank
	 * screen: the normal transcript is never composited into the alternate
	 * buffer.
	 */
	#renderAltFrame(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		let overlays: EngineOverlay[];
		do {
			// The pass composes with `altScreen`, so the normal screen's own
			// placements behind it are not treated as retired.
			this.#imageBudget.beginPass(false, true);
			overlays = renderOverlays(this.overlayStack, width, height);
		} while (this.#imageBudget.endPass());
		const topOverlay = this.#getTopmostVisibleOverlay();
		const focused = this.#focusedComponent;
		const cursor =
			topOverlay !== undefined &&
			focused !== null &&
			isFocusable(focused) &&
			focused.focused &&
			typeof focused.setUseTerminalCursor === "function" &&
			isOverlayFocusTarget(topOverlay.component, focused);
		const frame = { overlays, cursor, wantPaint: this.#paintListeners.size > 0 };
		const result = this.terminal.run((engine, now) => engine.presentAlt(now, frame));
		if (result.paint) this.#notifyPaint(result.paint);
	}

	/** Compose the full semantic tail for the borrowed resize buffer. */
	#renderResizeFrame(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const provider = this.#frameProvider;
		let rendered: readonly string[];
		do {
			this.#imageBudget.beginPass(false, true);
			rendered =
				provider?.renderResizeFrame?.({ columns: width, rows: height }) ??
				(provider ? provider.renderFrame({ columns: width, rows: height }).viewport : this.render(width));
		} while (this.#imageBudget.endPass());
		const rows = rendered.length > height ? rendered.slice(rendered.length - height) : Array.from(rendered);
		// The borrowed resize buffer is transient, not a streamable session paint.
		this.terminal.run((engine, now) => engine.presentResize(now, { rows }));
	}
}
