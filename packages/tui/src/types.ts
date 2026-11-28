/**
 * The `JSX` namespace TypeScript checks TSX against, and what a JSX
 * expression evaluates to.
 */
import type { TspKind, TspProps } from "@oh-my-pi/pi-wire";
import type { CanvasProps, Reveal, RevealAt, ScrollRequest, UiHandlers, UiNode } from "./node";
import type { Reactive } from "./reactive";

/**
 * What a JSX expression evaluates to: nodes, lists, accessors (dynamic
 * children); strings and numbers become `text` nodes; `false`/`null`/
 * `undefined`/`true`/`""` render nothing, so `{cond && <x />}` works.
 */
export type JSXNode = UiNode | readonly JSXNode[] | (() => JSXNode) | string | number | boolean | null | undefined;

/** Fields every tag accepts besides its kind's props. */
export interface NodeAttributes extends UiHandlers {
	key?: Reactive<string | undefined>;
	/** The wire prop `key` (TspCommonProps), which JSX's own `key` (node identity) cannot carry. */
	propKey?: Reactive<string | undefined>;
	/** The wire prop `ref` (a node the terminal may reference), which JSX's own `ref` (node callback) cannot carry. */
	propRef?: Reactive<string | undefined>;
	/** Terminal-only look facts for painters; the native backend never sends them. */
	term?: Reactive<Readonly<Record<string, unknown>> | undefined>;
	/** Scroll the node into view when added (a placement) or whenever `n` changes. */
	reveal?: Reactive<RevealAt | Reveal | undefined>;
	/** Forwarded keyboard scrolling of the scroller holding the node. */
	scroll?: Reactive<ScrollRequest | undefined>;
	/** Receives the node once it is created. */
	ref?: (node: UiNode) => void;
	children?: JSXNode;
}

/**
 * A fullscreen page: a `size="full"` overlay the program draws as a screen of
 * its own rather than a sheet over the session. Tern gets a `screen` surface
 * (the overlay's children are its `main`, the last `dock` of them its `dock`,
 * later layer nodes its `layer`); a terminal draws the overlay on the
 * alternate screen either way. Never sent as a prop.
 */
export interface PageProps {
	/** The screen surface's role (Tern styles a page by it). Default: the host's surface role. */
	readonly role?: string;
	/** How many trailing children form the page's dock (controls pinned under its `main`). Default 0. */
	readonly dock?: number;
}

/** `overlay` attributes that never travel as props. */
export interface OverlayAttributes {
	/** Draw this full-size overlay as a page: see {@link PageProps}. */
	page?: Reactive<PageProps | undefined>;
}

/** `md` attributes that never travel as props. */
export interface MdAttributes {
	/** The streaming `text` is already as it is to be sent (partial table row held, open spans closed). */
	prepared?: Reactive<boolean | undefined>;
}

/** Attributes of a lowercase tag: its props, each possibly reactive, plus {@link NodeAttributes}. */
export type KindAttributes<P> = { [Name in keyof P]?: Reactive<P[Name]> } & NodeAttributes;

/** The `JSX` namespace TypeScript resolves through `jsxImportSource`. */
export declare namespace JSX {
	type Element = JSXNode;
	type ElementType = TspKind | "canvas" | ((props: never) => JSXNode);
	interface ElementChildrenAttribute {
		children: {};
	}
	interface IntrinsicAttributes {
		key?: Reactive<string | undefined>;
	}
	type IntrinsicElements = { [K in TspKind]: KindAttributes<TspProps<K>> } & {
		overlay: KindAttributes<TspProps<"overlay">> & OverlayAttributes;
		md: KindAttributes<TspProps<"md">> & MdAttributes;
		canvas: Omit<KindAttributes<CanvasProps>, "paint" | "onMouse"> & Pick<CanvasProps, "paint" | "onMouse">;
	};
}
