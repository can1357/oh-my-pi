/**
 * The describe contract: how components hand the Tern Surface Protocol (TSP)
 * backend a semantic description instead of rendered rows.
 *
 * A component opts in with `describe(cx)`, returning a {@link NativeNode}: a
 * wire node without ids. Children are either nested nodes or other
 * components; a component child is a describe boundary the reconciler visits
 * on its own, so each component owns a stable id prefix and can be skipped
 * when it returns the same node object it returned last time (the same
 * reference contract as `render()`). A component without `describe` becomes a
 * `rows` fallback node rendered through `render(cx.cols)`.
 *
 * See `packages/wire/src/tsp.ts` for the wire vocabulary and
 * `crates/tern/SURFACE_PROTOCOL.md` (Stencil repository) for the spec.
 */
import type { TspEvent, TspKind, TspProps, TspScrollBy, TspSpan } from "@oh-my-pi/pi-wire";
import type { Component } from "../tui";

/** A described node: a wire node minus its id, with components allowed as children. */
export type NativeNode = {
	[K in TspKind]: {
		readonly k: K;
		readonly p?: TspProps<K>;
		readonly c?: readonly NativeChild[];
		/**
		 * Identity among its siblings inside the owning component (defaults to
		 * the child index). Give keys to children that can be inserted, removed
		 * or reordered so their ids and terminal-side view state survive.
		 */
		readonly key?: string;
		/**
		 * Scroll the node into view, placed like the `reveal` op. A placement
		 * reveals it when it is added: key a node by what it points at to
		 * reveal it again on a move. A {@link NativeReveal} reveals it whenever
		 * its `n` differs from the previous description of the same node.
		 */
		readonly reveal?: NativeRevealAt | NativeReveal;
		/**
		 * Keyboard scrolling forwarded to the terminal (PgUp/PgDn/End reach the
		 * program): moves the scroller at or above the node by `by` whenever
		 * `n` differs from the previous description of the same node. Bump `n`
		 * per key press; presses between two frames repeat the latest `by` once
		 * each (`start`/`end` once). A freshly added node never scrolls.
		 */
		readonly scroll?: NativeScroll;
	};
}[TspKind];

/** Where a revealed node lands in its scroller. */
export type NativeRevealAt = "start" | "end" | "nearest";

/**
 * A repeatable {@link NativeNode.reveal}: bump `n` to bring an existing node
 * into view again (a Contents entry jumping to its section). A freshly added
 * node is not revealed.
 */
export interface NativeReveal {
	readonly at: NativeRevealAt;
	readonly n: number;
}

/** A {@link NativeNode.scroll} request. */
export interface NativeScroll {
	readonly by: TspScrollBy;
	readonly n: number;
}

/** A child slot: a described node, or a component that describes itself. */
export type NativeChild = NativeNode | Component;

/** What a component may consult while describing itself. Never a clock: motion is terminal-clocked. */
export interface DescribeContext {
	/** Surface width in cells; only for `rows` fallback and ANSI wrap hints. */
	readonly cols: number;
	/** The terminal asked for reduced motion. */
	readonly reduceMotion: boolean;
	/** The terminal's appearance is dark. */
	readonly dark: boolean;
	/** Whether the terminal renders `kind` natively (else describe something simpler or let it fall back). */
	supports(kind: TspKind): boolean;
	/**
	 * Whether the terminal's `hello` advertised protocol feature `name`
	 * (`aside`: a `prefs` page in `layer` docks as a sheet at the pane's right
	 * edge, the transcript narrowed beside it).
	 */
	feature(name: string): boolean;
}

/** The regions a frame provider fills when it describes a whole surface. */
export interface NativeSurface {
	/** The flowing document (transcript). */
	readonly main: readonly NativeChild[];
	/** Sticky bottom chrome while live (editor, status line, HUDs). */
	readonly dock: readonly NativeChild[];
}

/**
 * The screen surface a fullscreen overlay fills as a page of its own (see
 * `Component.describeScreen`): its regions plus the surface `role`, which the
 * terminal exposes to styling.
 */
export interface NativeScreen extends NativeSurface {
	readonly role: string;
}

/**
 * A user action on a node a component described, routed back to that
 * component. `key` is the node's key path inside the component (`""` for the
 * component's root node, `"body/3"` for a nested keyed child).
 */
export type NativeUiEvent =
	| { readonly type: "toggle"; readonly key: string; readonly collapsed: boolean }
	| { readonly type: "select"; readonly key: string; readonly item: string }
	| { readonly type: "activate"; readonly key: string; readonly item: string }
	| {
			readonly type: "action";
			readonly key: string;
			readonly act: string;
			/** Scope/tab/strip id, sort column, or the prefs row an action control belongs to. */
			readonly value?: string;
			readonly mods: readonly string[];
	  }
	/** A typed value changed by pointer (prefs rows, picker toggles); `null` resets to the default. */
	| {
			readonly type: "change";
			readonly key: string;
			readonly item: string;
			readonly value: boolean | number | string | readonly string[] | null;
	  }
	/** An edit over the terminal's own selection in an `editor`/`input` node (see {@link NativeTextEdit}). */
	| ({ readonly type: "edit"; readonly key: string } & NativeTextEdit)
	/** Undo the last change to an `editor`/`input` node's text (the terminal's ⌃Z); a no-op with no history. */
	| { readonly type: "undo"; readonly key: string }
	/** Submit an explicit prompt through the composer's normal path, preserving the previous draft for recall. */
	| { readonly type: "send"; readonly key: string; readonly text: string };

/**
 * A primitive edit the terminal made over its own text selection (cut,
 * typing, Backspace/Delete or paste over it, or collapsing it). Offsets are
 * UTF-16 code units into the text last described (lines joined with `"\n"`),
 * the coordinates of the node's `cursor`: replace `[from, to)` with `text`,
 * then put the caret at `cursor` in the resulting text. `from == to` with an
 * empty `text` is a pure caret move. `len` is the length of the text the
 * terminal saw: when the current text differs (keys in flight changed it) the
 * edit is stale and ignored.
 */
export interface NativeTextEdit {
	readonly from: number;
	readonly to: number;
	readonly text: string;
	readonly cursor: number;
	readonly len: number;
}

/** A {@link NativeTextEdit} checked against the current text and clamped, ready to apply. */
export interface ResolvedTextEdit {
	/** Replaced range in the current text, widened by the caller's `widen`. */
	readonly from: number;
	readonly to: number;
	/** The cleaned replacement. */
	readonly insert: string;
	/** The whole text after the edit. */
	readonly text: string;
	/** Caret in {@link text}. */
	readonly cursor: number;
	/** Whether the text changes (false: a pure caret move). */
	readonly changed: boolean;
}

/** `value` as an integer offset in `[0, max]` (anything non-finite is 0). */
export function clampTextOffset(value: number, max: number): number {
	return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), max) : 0;
}

/** Whether `offset` falls between the halves of a surrogate pair in `text`. */
function splitsSurrogatePair(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return false;
	const high = text.charCodeAt(offset - 1);
	const low = text.charCodeAt(offset);
	return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Check `edit` against `current` and resolve it: null when stale (`len`
 * differs), else the range clamped (reversed ends swapped, never splitting a
 * surrogate pair), widened by `widen` when non-empty, the replacement passed
 * through `clean`, and the caret mapped from the text the terminal expects
 * onto the text the edit actually produces.
 */
export function resolveTextEdit(
	current: string,
	edit: NativeTextEdit,
	clean: (text: string) => string,
	widen?: (from: number, to: number) => { from: number; to: number },
): ResolvedTextEdit | null {
	if (edit.len !== current.length) return null;
	const size = current.length;
	let from = clampTextOffset(edit.from, size);
	let to = clampTextOffset(edit.to, size);
	if (to < from) [from, to] = [to, from];
	if (splitsSurrogatePair(current, from)) from--;
	if (splitsSurrogatePair(current, to)) to++;
	const raw = typeof edit.text === "string" ? edit.text : "";
	const widened = widen && from < to ? widen(from, to) : { from, to };
	const insert = raw ? clean(raw) : "";
	const text = current.slice(0, widened.from) + insert + current.slice(widened.to);
	// Where the terminal's caret sits in its own result (`[from, to)` replaced
	// by `raw`), carried over to ours: widening swallows neighbours, cleaning
	// may change the replacement's length.
	const expected = clampTextOffset(edit.cursor, size - (to - from) + raw.length);
	let cursor: number;
	if (expected <= widened.from) cursor = expected;
	else if (expected <= from) cursor = widened.from;
	else if (expected < from + raw.length) cursor = widened.from + Math.min(expected - from, insert.length);
	else cursor = widened.from + insert.length + Math.max(0, expected - from - raw.length - (widened.to - to));
	cursor = Math.min(cursor, text.length);
	if (splitsSurrogatePair(text, cursor)) cursor--;
	return {
		from: widened.from,
		to: widened.to,
		insert,
		text,
		cursor,
		changed: widened.from !== widened.to || insert !== "",
	};
}

/** The expanded state a `toggle` on the component's root node asks for, else undefined. */
export function rootToggleExpanded(event: NativeUiEvent): boolean | undefined {
	return event.type === "toggle" && event.key === "" ? !event.collapsed : undefined;
}

/** The last segment of an event keypath (`"split/sidebar/toc"` → `"toc"`). */
export function leafKey(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Terminal-level events the backend doesn't route to a single component. */
export type NativeTerminalEvent = Extract<TspEvent, { ev: "theme" | "motion" | "visible" | "resize" }>;

/** Implemented by components that react to user actions on their described nodes. */
export interface NativeEventTarget {
	handleNativeEvent(event: NativeUiEvent): void;
}

/** Implemented by frame providers (the composer) that describe the whole surface. */
export interface NativeSurfaceProvider {
	describeSurface(cx: DescribeContext): NativeSurface;
}

/** Re-exported for describe helpers. */
export type { TspSpan };
