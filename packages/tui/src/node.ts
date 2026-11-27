/**
 * The node model: one retained tree both backends render.
 *
 * A lowercase JSX tag creates a {@link UiNode}: a TSP kind (or `canvas`)
 * with reactive props and children. The native backend describes it to a
 * Tern terminal as-is; the terminal backend paints it with the kind's
 * painter. Nothing in application code renders rows or describes nodes by
 * hand.
 *
 * `props()` and `children()` are cached: they return the same object until
 * something they read changes, so backends can cache by identity and only
 * revisit changed paths.
 */
import { TSP_TEXT_KINDS, type TspCommonProps, type TspKind, type TspProps } from "@oh-my-pi/pi-wire";
import { resolveChildren } from "./children";
import type { KeyEvent, PasteEvent, UiEvent } from "./events";
import { type Accessor, computed, getOwner, onCleanup, read, signal, structural } from "./reactive";

/** Every kind a node may be: the TSP vocabulary plus the terminal-only `canvas`. */
export type UiKind = TspKind | "canvas";

/**
 * Drawing TSP cannot express (a powerline bar, a gradient lockup, a minimap).
 * The terminal backend calls `paint`; a native terminal receives the same
 * rows as a `rows` node. Reactive reads inside `paint` repaint it.
 */
export interface CanvasProps extends TspCommonProps {
	/** Rows at `width`; no row may exceed it. */
	paint: (width: number) => readonly string[];
}

/** Props of a node of kind `K`. */
export type UiProps<K extends UiKind> = K extends TspKind ? TspProps<K> : CanvasProps;

/**
 * Event handlers a node accepts. UI events bubble from the node they name to
 * the nearest node with a handler for their type; keys bubble from the
 * focused node up its ancestors until a handler returns true.
 */
export interface UiHandlers {
	onToggle?: (collapsed: boolean, event: Extract<UiEvent, { type: "toggle" }>) => void;
	onSelect?: (item: string, event: Extract<UiEvent, { type: "select" }>) => void;
	onActivate?: (item: string, event: Extract<UiEvent, { type: "activate" }>) => void;
	onAction?: (act: string, event: Extract<UiEvent, { type: "action" }>) => void;
	onChange?: (event: Extract<UiEvent, { type: "change" }>) => void;
	onEdit?: (event: Extract<UiEvent, { type: "edit" }>) => void;
	onUndo?: (event: Extract<UiEvent, { type: "undo" }>) => void;
	onSend?: (text: string, event: Extract<UiEvent, { type: "send" }>) => void;
	onFocus?: (event: Extract<UiEvent, { type: "focus" }>) => void;
	/** Any UI event not taken by a typed handler on the same node. */
	onEvent?: (event: UiEvent) => void;
	/** A key the focused widget did not consume; return true to stop it here. */
	onKey?: (key: KeyEvent) => boolean;
	/** Bracketed paste into the focused node or a descendant; return true to stop it here. */
	onPaste?: (paste: PasteEvent) => boolean;
}

const HANDLER_NAMES: Readonly<Record<string, true>> = {
	onToggle: true,
	onSelect: true,
	onActivate: true,
	onAction: true,
	onChange: true,
	onEdit: true,
	onUndo: true,
	onSend: true,
	onFocus: true,
	onEvent: true,
	onKey: true,
	onPaste: true,
};

/** Props that configure the node rather than its kind. */
const NODE_FIELDS: Readonly<Record<string, true>> = {
	children: true,
	key: true,
	ref: true,
	reveal: true,
	scroll: true,
};

const TEXT_KINDS: ReadonlySet<string> = new Set(TSP_TEXT_KINDS);

/** Where a revealed node lands in its scroller. */
export type RevealAt = "start" | "end" | "nearest";

/** A repeatable reveal: bump `n` to scroll the node into view again. */
export interface Reveal {
	readonly at: RevealAt;
	readonly n: number;
}

/** Forwarded keyboard scrolling: move the scroller holding the node by `by` whenever `n` changes. */
export interface ScrollRequest {
	readonly by: "line-up" | "line-down" | "page-up" | "page-down" | "start" | "end";
	readonly n: number;
}

type Props = Readonly<Record<string, unknown>>;

const EMPTY_PROPS: Props = Object.freeze({});
const NO_CHILDREN: readonly UiNode[] = Object.freeze([]);

let nextNodeId = 1;

function shallowEqual(a: Props, b: Props): boolean {
	if (a === b) return true;
	let count = 0;
	for (const name in a) {
		if (!Object.is(a[name], b[name])) return false;
		count++;
	}
	for (const _ in b) count--;
	return count === 0;
}

function joinText(content: unknown): string | undefined {
	if (content === undefined || content === null || typeof content === "boolean") return undefined;
	if (Array.isArray(content)) {
		let out: string | undefined;
		for (const part of content) {
			const text = joinText(part);
			if (text !== undefined) out = (out ?? "") + text;
		}
		return out;
	}
	const value = read(content);
	if (value === undefined || value === null || typeof value === "boolean") return undefined;
	return String(value);
}

/**
 * The selection made by raw keys in an editor or input. It belongs to one
 * revision of the field: replacing the draft, moving the caret externally,
 * or entering a modal editor must not revive it, even after undo.
 */
class FieldSelection {
	readonly #revision: Accessor<number>;
	readonly #active = signal<{ anchor: number; revision: number } | null>(null);

	constructor({ text, cursor, mode, anchor }: Props) {
		this.#revision = structural<number>(previous => {
			read(text);
			read(cursor);
			read(mode);
			read(anchor);
			return (previous ?? 0) + 1;
		});
	}

	get anchor(): number | null {
		const active = this.#active();
		return active && active.revision === this.#revision() ? active.anchor : null;
	}

	set anchor(offset: number | null) {
		this.#active.set(offset === null ? null : { anchor: offset, revision: this.#revision() });
	}

	range(cursor: number): { from: number; to: number } | null {
		const anchor = this.anchor;
		return anchor === null || anchor === cursor
			? null
			: { from: Math.min(anchor, cursor), to: Math.max(anchor, cursor) };
	}
}

/** A retained UI node (see the module docs). */
export class UiNode<K extends UiKind = UiKind> {
	/** Unique per instance; backends derive cache keys and default ids from it. */
	readonly id = nextNodeId++;
	readonly kind: K;
	readonly handlers: UiHandlers;
	/** Raw-key selection of an editor/input; exposed as its ordinary `anchor` prop on both backends. */
	readonly fieldSelection?: FieldSelection;
	/** Resolved props: the same object while nothing they read changed. */
	readonly props: Accessor<Readonly<UiProps<K>>>;
	/** Resolved child nodes: the same array while the child list is unchanged. */
	readonly children: Accessor<readonly UiNode[]>;
	/** Identity among siblings; defaults to the child index. */
	readonly key: Accessor<string | undefined>;
	readonly reveal: Accessor<RevealAt | Reveal | undefined>;
	readonly scroll: Accessor<ScrollRequest | undefined>;
	/** Explicit lifecycle provenance: a replacement's source, or the members of a grouped view. */
	readonly source?: UiNode | Accessor<readonly UiNode[]>;
	#disposers: (() => void)[] | null = null;
	#disposed = false;

	/** `source`: the node this one is a view of (see {@link derivedNode}); its props and children are taken as given. */
	constructor(kind: K, attributes: Props, key?: unknown, source?: DerivedSource<K>) {
		this.kind = kind;
		const handlers: Record<string, unknown> = {};
		const raw: Record<string, unknown> = {};
		for (const name in attributes) {
			if (NODE_FIELDS[name]) continue;
			if (HANDLER_NAMES[name]) handlers[name] = attributes[name];
			// JSX reserves `key` (node identity) and `ref` (node callback); `propKey`/`propRef` set those wire props.
			else if (name === "propKey") raw.key = attributes[name];
			else if (name === "propRef") raw.ref = attributes[name];
			else raw[name] = attributes[name];
		}
		this.handlers = handlers;
		if (source) {
			this.fieldSelection = source.fieldSelection;
			this.source = source.source;
			this.props = source.props;
			this.children = source.children;
			this.key = source.key;
			this.reveal = source.reveal;
			this.scroll = source.scroll;
			if (getOwner()) onCleanup(() => this.dispose());
			return;
		}
		if (kind === "editor" || kind === "input") {
			const selection = (this.fieldSelection = new FieldSelection(raw));
			const anchor = raw.anchor;
			raw.anchor = () => selection.anchor ?? read(anchor);
		}
		const textual = TEXT_KINDS.has(kind);
		const content = attributes.children;
		const keyValue = key ?? attributes.key;
		const revealValue = attributes.reveal;
		const scrollValue = attributes.scroll;
		const fnProps = kind === "canvas" ? CANVAS_FN_PROPS : undefined;
		this.props = computed(
			() => {
				let out: Record<string, unknown> | undefined;
				for (const name in raw) {
					const value = fnProps?.[name] ? raw[name] : read(raw[name]);
					if (value === undefined) continue;
					(out ??= {})[name] = value;
				}
				if (textual && content !== undefined && out?.text === undefined && out?.spans === undefined) {
					const text = joinText(content);
					if (text !== undefined) (out ??= {}).text = text;
				}
				return (out ?? EMPTY_PROPS) as Readonly<UiProps<K>>;
			},
			{ equals: shallowEqual },
		);
		this.children = textual || content === undefined ? () => NO_CHILDREN : resolveChildren(content);
		this.key = () => read(keyValue as string | undefined);
		this.reveal = () => read(revealValue as RevealAt | Reveal | undefined);
		this.scroll = () => read(scrollValue as ScrollRequest | undefined);
		const ref = attributes.ref;
		if (typeof ref === "function") ref(this);
		// A node lives as long as the scope that built it (a region rerun or a root dispose retires it).
		if (getOwner()) onCleanup(() => this.dispose());
	}

	/** Whether the scope that built this node retired it. */
	get disposed(): boolean {
		return this.#disposed;
	}

	/** Run `fn` when the node is retired (backends release per-node state here). Runs now if already retired. */
	onDispose(fn: () => void): void {
		if (this.#disposed) fn();
		else (this.#disposers ??= []).push(fn);
	}

	/** Retire the node: release backend state. Idempotent; called by the owning scope. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const disposers = this.#disposers;
		this.#disposers = null;
		if (disposers) for (const fn of disposers) fn();
	}
}

/** What a derived node takes from the node it is a view of. */
type DerivedSource<K extends UiKind> = Pick<UiNode<K>, "props" | "children" | "key" | "reveal" | "scroll"> & {
	readonly fieldSelection?: FieldSelection;
	readonly source?: UiNode | Accessor<readonly UiNode[]>;
};

/**
 * A view of `node` with its props mapped by `map` (a transient mark laid on a block built
 * elsewhere): a node of its own with `node`'s kind, key and children, and `handlers` (default:
 * `node`'s) on the event path. Describe one or the other, never both under one surface.
 * Finality and native eviction follow the source; disposing the view never disposes the source.
 */
export function derivedNode<K extends UiKind>(
	node: UiNode<K>,
	map: (props: Readonly<UiProps<K>>) => Readonly<UiProps<K>>,
	handlers: UiHandlers = node.handlers,
): UiNode<K> {
	const props = computed(() => map(node.props()), { equals: shallowEqual });
	return new UiNode(node.kind, handlers as Props, undefined, {
		source: node,
		props,
		children: node.children,
		key: node.key,
		reveal: node.reveal,
		scroll: node.scroll,
		...(node.fieldSelection ? { fieldSelection: node.fieldSelection } : {}),
	});
}

/** Canvas props whose function value is the prop itself, not an accessor. */
const CANVAS_FN_PROPS: Readonly<Record<string, true>> = { paint: true };

/** Whether `value` is a {@link UiNode}. */
export function isUiNode(value: unknown): value is UiNode {
	return value instanceof UiNode;
}
