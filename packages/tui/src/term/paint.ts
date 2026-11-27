/**
 * The painter contract: how the terminal backend turns a node into rows.
 *
 * Every node kind has a painter (and a role may override it, like a CSS
 * class): `(node, cx) → Block`. A painter reads the node's props and
 * children, paints children through `cx.paint`, and returns its rows. The
 * result is cached per node and size; reactive reads inside the painter
 * (props, children, child blocks, the theme, the clock, focus) invalidate
 * exactly that cache entry, so an unchanged subtree costs nothing.
 *
 * Painters never write to the terminal and never keep their own caches of
 * reactive state; they are pure functions of what they read.
 */
import type { CellSize } from "../driver/images/fit";
import type { ImageRequest, ImageRows, ImageSource } from "../driver/images/store";
import type { UiKind, UiNode } from "../node";
import { type Accessor, computed, createRoot, signal } from "../reactive";
import type { Theme } from "../theme/contract";
import type { RenderedText } from "./text-layout";

/** A cell position inside a block. */
export interface Cell {
	readonly row: number;
	readonly col: number;
}

/** A rectangle inside a block that a mouse event resolves to. */
export interface Hit {
	readonly row: number;
	readonly col: number;
	readonly width: number;
	readonly height: number;
	/** Row of the widget's visible content at the top of this rectangle (default 0; chrome can separate text rows). */
	readonly fieldRowOffset?: number;
	/** The node the event goes to. */
	readonly node: UiNode;
	/** The list item / tab / row key under the pointer, when the node has items. */
	readonly item?: string;
	/** The action a click runs (buttons). */
	readonly act?: string;
	/** The region where `activateTargets` gates this shortcut. The same content in a dialog keeps its hits. */
	readonly optionalTarget?: "main" | "dock";
}

/** What a painter returns: rows (none wider than the width it got), plus cursor and hit regions. */
export interface Block {
	readonly rows: readonly string[];
	/** Hardware cursor (the focused editor's caret), in this block's coordinates. */
	readonly cursor?: Cell;
	/** Mouse targets, in this block's coordinates. */
	readonly hits?: readonly Hit[];
	/**
	 * Leading rows that can no longer change while the node streams (an
	 * answer's finished paragraphs): the main surface may move them into
	 * terminal history before the node settles. Containers add their offset.
	 */
	readonly stable?: number;
	/**
	 * Rows of a dock block drawn over the transcript instead of taking room
	 * from it (a completion popup): the main region keeps its height, and its
	 * rows under them are hidden, not moved into history. Containers add their
	 * children's.
	 */
	readonly covering?: number;
	/** Logical text of each row (term/text-layout.ts), computed on demand; absent: rows copy literally. */
	readonly text?: () => RenderedText;
}

/** Every observable part of the block counts, including pointer routing when no cell changed. */
function sameBlock(a: Block, b: Block): boolean {
	if (a === b) return true;
	if (
		// Annotations are lazy. Matching cells can still copy differently (a soft wrap vs. a newline).
		a.text !== b.text ||
		a.rows.length !== b.rows.length ||
		a.stable !== b.stable ||
		a.covering !== b.covering ||
		a.cursor?.row !== b.cursor?.row ||
		a.cursor?.col !== b.cursor?.col
	)
		return false;
	if (a.rows !== b.rows) {
		for (let i = 0; i < a.rows.length; i++) if (a.rows[i] !== b.rows[i]) return false;
	}
	if (a.hits !== b.hits) {
		if (!a.hits || !b.hits || a.hits.length !== b.hits.length) return false;
		for (let i = 0; i < a.hits.length; i++) {
			const x = a.hits[i]!;
			const y = b.hits[i]!;
			if (
				x !== y &&
				(x.node !== y.node ||
					x.item !== y.item ||
					x.act !== y.act ||
					x.optionalTarget !== y.optionalTarget ||
					x.row !== y.row ||
					x.fieldRowOffset !== y.fieldRowOffset ||
					x.col !== y.col ||
					x.width !== y.width ||
					x.height !== y.height)
			)
				return false;
		}
	}
	return true;
}

/** What a painter may consult. */
export interface PaintContext {
	/** Cells available per row. */
	readonly width: number;
	/** Rows allocated when the parent fixes a height (fullscreen layers, flex columns); undefined: natural height. */
	readonly height: number | undefined;
	/** The active theme (reading it subscribes to theme changes). */
	readonly theme: Theme;
	/** Paint a child in this pass's scope (cached for normal terminal paints). */
	paint(node: UiNode, width: number, height?: number): Block;
	/**
	 * Terminal clock in ms; reading it repaints this block on every animation tick. `smooth` asks for
	 * 20 Hz ticks while the block is drawn (a sweep that reads as motion), else the spinner cadence.
	 */
	now(smooth?: boolean): number;
	/** Whether `node` holds keyboard focus. */
	focused(node: UiNode): boolean;
	/**
	 * What the pointer is over inside `node`'s painted hits (the hit's `item`
	 * or `act`), or undefined. Reading it repaints the block as the pointer
	 * moves; the terminal reports motion only while the program enables
	 * pointer tracking (`setMouse("any")`).
	 */
	hovered(node: UiNode): PointerHover | undefined;
	/** The terminal asked for reduced motion: clocked kinds draw their still frame. */
	readonly reduceMotion: boolean;
	/** The terminal draws OSC 8 hyperlinks (painters may emit them). */
	readonly hyperlinks: boolean;
	/**
	 * Painters may draw OSC 66 sized text (the terminal draws it and the host allows it). A row with
	 * a scale-`s` span must be followed by `s - 1` blank (whitespace-only) rows its glyphs extend into.
	 */
	readonly textSizing: boolean;
	/** The terminal's inline images; undefined when it draws none (images show their text fallback). */
	readonly images: PaintImages | undefined;
}

/**
 * Inline images as painters reach them (the driver's `TerminalImages`): the
 * rows an image takes at a size. Calling `rows` inside a painter keeps the
 * image referenced while that block is cached.
 */
export interface PaintImages {
	rows(source: ImageSource, request: ImageRequest): ImageRows;
	/** Offscreen geometry only, without acquiring or encoding the image. */
	measure?(source: ImageSource, request: ImageRequest): ImageRows;
	/** The terminal's cell size in pixels (what an image's natural size in cells is measured by). */
	cell(): CellSize;
}

/** Paints one kind (or one role of a kind). */
export type Painter = (node: UiNode, cx: PaintContext) => Block;

/** The empty block (hidden nodes, zero-size allocations). */
export const EMPTY_BLOCK: Block = Object.freeze({ rows: Object.freeze([]) as readonly string[] });

const kindPainters = new Map<UiKind, Painter>();
const rolePainters = new Map<string, Painter>();
/** How often each `kind|role` key was registered: a second registration silently wins by load order. */
const roleRegistrations = new Map<string, number>();

/** Register the painter for a kind. Later registrations replace earlier ones. */
export function definePainter(kind: UiKind, painter: Painter): void {
	kindPainters.set(kind, painter);
}

/**
 * Register a painter for nodes of `kind` whose `role` prop is `role` (or
 * starts with `role.` when `prefix` is set): the look a specific screen needs.
 */
export function defineRolePainter(kind: UiKind, role: string, painter: Painter, options?: { prefix?: boolean }): void {
	const key = `${kind}|${role}${options?.prefix ? ".*" : ""}`;
	rolePainters.set(key, painter);
	roleRegistrations.set(key, (roleRegistrations.get(key) ?? 0) + 1);
}

/** Every role painter key (`kind|role`, `.*` for prefixes) with how many times it was registered. */
export function rolePainterRegistrations(): ReadonlyMap<string, number> {
	return roleRegistrations;
}

/** The painter for `node`: its role's (exact, then nearest dotted prefix), else its kind's. */
export function painterFor(node: UiNode): Painter | undefined {
	return byRole(rolePainters, node) ?? kindPainters.get(node.kind);
}

/**
 * The role a node's terminal look and input follow: its wire `role`, else a
 * terminal-only `term.role` (for nodes whose wire role must stay unset).
 */
export function roleOf(node: UiNode): string | undefined {
	const props = node.props() as { role?: string; term?: { role?: unknown } };
	return props.role ?? (typeof props.term?.role === "string" ? props.term.role : undefined);
}

/** The entry registered for `node`'s kind and role: exact role first, then the nearest dotted prefix. */
export function byRole<T>(registry: ReadonlyMap<string, T>, node: UiNode): T | undefined {
	const role = roleOf(node);
	if (!role) return undefined;
	const exact = registry.get(`${node.kind}|${role}`);
	if (exact) return exact;
	for (let end = role.lastIndexOf("."); end > 0; end = role.lastIndexOf(".", end - 1)) {
		const prefix = registry.get(`${node.kind}|${role.slice(0, end)}.*`);
		if (prefix) return prefix;
	}
	return undefined;
}

/** The hit under the pointer (see {@link PaintContext.hovered}). */
export interface PointerHover {
	readonly node: UiNode;
	readonly item?: string;
	readonly act?: string;
}

/** Process-wide paint environment: theme, clock, focus, motion. One per terminal backend. */
export interface PaintEnvironment {
	readonly theme: Accessor<Theme>;
	/** Animation clock in ms (ticked by the backend while painters read it). */
	readonly clock: (smooth?: boolean) => number;
	readonly focus: Accessor<UiNode | null>;
	readonly reduceMotion: Accessor<boolean>;
	readonly hyperlinks: Accessor<boolean>;
	/** Whether painters may draw OSC 66 sized text; absent: never. */
	readonly textSizing?: Accessor<boolean>;
	/** Inline images the terminal draws; absent: none. */
	readonly images?: PaintImages;
	/** The hit under the pointer; absent: no pointer tracking. */
	readonly hover?: Accessor<PointerHover | null>;
}

const kCache = Symbol("pi-tui.term.paint-cache");

interface PaintEntry {
	readonly read: Accessor<Block>;
	readonly dispose: () => void;
}

interface PaintCache {
	/** The environment the entries were painted in (one terminal backend per node in practice). */
	readonly env: PaintEnvironment;
	/** Cache entries by `${width}x${height}`; a node is usually painted at one or two sizes. */
	readonly entries: Map<string, PaintEntry>;
}

interface CachedNode {
	[kCache]?: PaintCache;
}

/** Most sizes cached per node before the oldest is dropped. */
const MAX_SIZES_PER_NODE = 4;

function paintBlock(node: UiNode, cx: PaintContext): Block {
	if (node.props().hidden === true) return EMPTY_BLOCK;
	const painter = painterFor(node);
	if (!painter) throw new Error(`pi-tui: no terminal painter for <${node.kind}>`);
	return painter(node, cx);
}

function createEntry(node: UiNode, cx: PaintContext): PaintEntry {
	return createRoot(dispose => ({ read: computed(() => paintBlock(node, cx), { equals: sameBlock }), dispose }));
}

/** Recurse under the caller's computation: no node-lifetime caches or detached child owners. */
function paintTree(env: PaintEnvironment, node: UiNode, width: number, height?: number): Block {
	return paintBlock(node, createContext(env, width, height, paintTree));
}

/** One disposable transcript block. Its subtree's reads and image cleanups belong to this entry. */
export function createOwnedPaint(node: UiNode, width: number, env: PaintEnvironment): PaintEntry {
	return createEntry(node, createContext(env, width, undefined, paintTree));
}

/** A one-shot paint under the caller's watcher, using its geometry-only image and clock environment. */
export function paintForMeasurement(node: UiNode, width: number, env: PaintEnvironment): Block {
	return paintTree(env, node, width);
}

/**
 * Paint `node` at a size in `env`, through its per-size cache. Painting a
 * node whose kind has no painter throws: every kind must be covered.
 */
export function paintNode(env: PaintEnvironment, node: UiNode, width: number, height?: number): Block {
	const size = `${width}x${height ?? ""}`;
	const holder = node as CachedNode;
	let cache = holder[kCache];
	if (cache && cache.env !== env) releasePaintCache(node);
	if (!cache || cache.env !== env) {
		const fresh = cache === undefined;
		cache = { env, entries: new Map() };
		holder[kCache] = cache;
		if (fresh) node.onDispose(() => releasePaintCache(node));
	}
	let entry = cache.entries.get(size);
	if (!entry) {
		if (cache.entries.size >= MAX_SIZES_PER_NODE) {
			const oldest = cache.entries.keys().next().value;
			if (oldest !== undefined) {
				cache.entries.get(oldest)?.dispose();
				cache.entries.delete(oldest);
			}
		}
		entry = createEntry(node, createContext(env, width, height, paintNode));
		cache.entries.set(size, entry);
	}
	return entry.read();
}

/** Drop every cached block of `node`. */
export function releasePaintCache(node: UiNode): void {
	const cache = (node as CachedNode)[kCache];
	if (!cache) return;
	for (const entry of cache.entries.values()) entry.dispose();
	cache.entries.clear();
}

function createContext(
	env: PaintEnvironment,
	width: number,
	height: number | undefined,
	paint: typeof paintNode,
): PaintContext {
	return {
		width,
		height,
		get theme() {
			return env.theme();
		},
		paint: (child, childWidth, childHeight) => paint(env, child, childWidth, childHeight),
		now: smooth => env.clock(smooth),
		focused: node => env.focus() === node,
		hovered: node => {
			const hover = env.hover?.();
			return hover && hover.node === node ? hover : undefined;
		},
		get reduceMotion() {
			return env.reduceMotion();
		},
		get hyperlinks() {
			return env.hyperlinks();
		},
		get textSizing() {
			return env.textSizing?.() ?? false;
		},
		images: env.images,
	};
}

/** A paint environment whose inputs a test or preview sets directly. */
export interface StaticEnvironment extends PaintEnvironment {
	setFocus(node: UiNode | null): void;
	setNow(now: number): void;
	setTheme(theme: Theme): void;
}

/** A paint environment with fixed inputs, for tests and offline rendering. */
export function staticEnvironment(
	theme: Theme,
	options?: {
		now?: number;
		focus?: UiNode | null;
		reduceMotion?: boolean;
		hyperlinks?: boolean;
		textSizing?: boolean;
		images?: PaintImages;
	},
): StaticEnvironment {
	const themeSignal = signal(theme);
	const clock = signal(options?.now ?? 0);
	const focus = signal<UiNode | null>(options?.focus ?? null);
	const reduceMotion = signal(options?.reduceMotion ?? false);
	const hyperlinks = signal(options?.hyperlinks ?? false);
	return {
		theme: themeSignal,
		clock,
		focus,
		reduceMotion,
		hyperlinks,
		...(options?.textSizing ? { textSizing: () => true } : {}),
		...(options?.images ? { images: options.images } : {}),
		setFocus: node => focus.set(node),
		setNow: now => clock.set(now),
		setTheme: next => themeSignal.set(next),
	};
}
