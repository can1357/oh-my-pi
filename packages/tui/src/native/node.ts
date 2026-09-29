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
import type { TspEvent, TspKind, TspProps, TspSpan } from "@oh-my-pi/pi-wire";
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
	};
}[TspKind];

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
	  };

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
