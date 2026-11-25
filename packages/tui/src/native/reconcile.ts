/**
 * The native reconciler: a {@link Surface} → minimal TSP ops.
 *
 * Every described node keeps a record: its wire id, the props last sent and
 * the identities of the node's `props()`/`children()` last seen. One watcher
 * effect per record marks it dirty when anything it reads changes and flags
 * the path to the region, so a frame visits only dirty paths and skips
 * unchanged subtrees without walking them.
 *
 * - Ids come from keypaths: the structural parent's id, `/`, then the node's
 *   `key` or child index (`^` before it when hoisted). An id still in use
 *   (a deferred delete, a moved node) gets a `~n` suffix. A record keeps its
 *   id while its node lives, wherever it moves.
 * - Children match by node identity first; a node replacing a retired one
 *   at the key/index it was last placed at with the same kind takes over its
 *   record (`set` of what differs), whatever id the record was born with.
 *   Matched children that left the longest stable run are
 *   `move`d before their next sibling; new ones are `add`ed whole.
 * - `set` carries changed props only (`null` removes one). A primary-text
 *   kind's `text` travels as `text append` when it extends, else `replace`.
 * - Deletes are deferred to the end of the frame, so nodes moved out of a
 *   deleted subtree survive.
 * - `overlay` and `picker` nodes in `main`/`dock` are hoisted into `layer`
 *   (ahead of the layer region's own nodes, in document order).
 *   An overlay's anchor keypath is relative to its structural parent, not
 *   its wire parent; the terminal receives the target's actual wire id.
 * - A settled top-level `main` node gets `settle`; its subtree's retained
 *   props and per-node watchers are dropped. It stays editable: one watcher
 *   over the whole block notices a later change, which describes just that
 *   block again (`del` + `add` under its id), then settles it again.
 * - `focus` follows the surface focus; `reveal`/`scroll` follow node fields
 *   (a plain reveal on add; a repeatable reveal or a scroll when `n` moves).
 * - `canvas` nodes become `rows` painted at the surface width.
 * - A `card`/`section` without a `head` prop names its child keyed `head`
 *   by wire id: the row that stays when it folds.
 * - A node's `term` prop (terminal-only look facts) is never sent.
 * - A streaming `md` sends its text without the table row still being
 *   written, its last open link/math span closed.
 */
import {
	TSP_TEXT_KINDS,
	type TspKind,
	type TspNode,
	type TspOp,
	type TspOverlayAnchor,
	type TspOverlayProps,
} from "@oh-my-pi/pi-wire";
import type { UiEvent } from "../events";
import type { CanvasProps, UiNode } from "../node";
import { type Accessor, computed, createRoot, effect, untrack } from "../reactive";
import { isSettled, type Surface } from "../surface";
import { holdPartialTableRow, speculativeStreamingSource } from "../text/markdown/stream";
import type { NativeEnvironment } from "./connection";
import { normalizeIconProps } from "./icons";
import { estimateRows } from "./measure";

type Props = Readonly<Record<string, unknown>>;
type AnchorRef = Exclude<TspOverlayAnchor, string>;

const TEXT_KINDS: ReadonlySet<string> = new Set(TSP_TEXT_KINDS);
const HOISTED_KINDS: Readonly<Record<string, true>> = { overlay: true, picker: true };

/** Whether `node` is drawn in `layer` wherever it is declared. A picker sized to the screen is its program's content and stays put. */
function hoists(node: UiNode): boolean {
	if (!HOISTED_KINDS[node.kind]) return false;
	return !(node.kind === "picker" && (node.props() as { size?: unknown }).size === "screen");
}
/** Kinds whose wire props name a child by its wire id (see `#wireProps`). */
const CHILD_REF_KINDS: Readonly<Record<string, true>> = { list: true, card: true, section: true };
/** The document's top-level regions, children of the surface's root. */
const REGION_IDS = ["main", "dock", "layer"] as const;
type RegionId = (typeof REGION_IDS)[number];

const NO_RECORDS: readonly Rec[] = Object.freeze([]);
const NO_HOISTS: readonly Hoist[] = Object.freeze([]);
/** Scroll steps sent for one change of a scroll request at most. */
const MAX_SCROLL_STEPS = 64;

/** An overlay found in `main`/`dock`, bound for `layer`. */
interface Hoist {
	readonly node: UiNode;
	readonly owner: Rec;
	readonly seg: string;
}

/** A child to place under a wire parent. */
interface Placement {
	readonly node: UiNode;
	/** Structural parent (the wire parent unless hoisted). */
	readonly owner: Rec;
	readonly seg: string;
	readonly hoisted: boolean;
}

interface Rec {
	readonly id: string;
	/**
	 * Where it was last placed: its structural parent's id, `/`, then its key or index (`^` before
	 * it when hoisted). Its `id` keeps where it was first placed; a node replacing it here takes it over.
	 */
	slot: string;
	/** Null for the three region records. */
	node: UiNode | null;
	readonly kind: TspKind;
	/** Structural parent: events bubble along it. */
	owner: Rec | null;
	/** Wire parent. */
	parent: Rec | null;
	/** Whether `overlay`/`picker` descendants are hoisted (in `main`/`dock`, outside hoisted nodes). */
	readonly hoisting: boolean;
	kids: readonly Rec[];
	/** Hoisted descendants in document order (records under `main`/`dock`). */
	hoists: readonly Hoist[];
	/** Structural children: wire children and hoisted ones, in order. */
	structural: readonly (Rec | Hoist)[];
	/** Wire props last sent (null once settled). */
	props: Props | null;
	rawProps: unknown;
	rawChildren: readonly UiNode[] | null;
	revealN: number | undefined;
	scrollN: number | undefined;
	dirty: boolean;
	childDirty: boolean;
	settled: boolean;
	/** Removed from its parent this frame and not placed again (yet). */
	detached: boolean;
	released: boolean;
	/** Frame in which the record was last placed (duplicate detection). */
	placed: number;
	canvas: Accessor<readonly string[]> | null;
	stop: (() => void) | null;
}

/** The ops of one frame and the blobs they reference. */
export interface NativeFrame {
	readonly ops: TspOp[];
	readonly blobs: ReadonlySet<string>;
}

/** A terminal event resolved to its node: the path from its top-level node, and the {@link UiEvent} it means. */
export interface ResolvedEvent {
	readonly path: readonly UiNode[];
	readonly event: UiEvent;
}

function escapeSegment(segment: string): string {
	return segment.replace(/[%/~^]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Index of each element of the longest increasing subsequence of `values` (-1 entries skipped). */
function longestIncreasing(values: readonly number[]): Set<number> {
	const tails: number[] = [];
	const prev: number[] = Array.from({ length: values.length }, () => -1);
	for (let i = 0; i < values.length; i++) {
		const value = values[i]!;
		if (value < 0) continue;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (values[tails[mid]!]! < value) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1]!;
		tails[lo] = i;
	}
	const out = new Set<number>();
	for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) out.add(i);
	return out;
}

/** Collect blob ids referenced by `props` (an image's `blob`, editor decorations). */
function collectBlobs(props: Props, out: Set<string>): void {
	for (const name in props) {
		const value = props[name];
		if (name === "blob" && typeof value === "string") out.add(value);
		else if (Array.isArray(value)) {
			for (const item of value) {
				const blob = (item as { blob?: unknown } | null)?.blob;
				if (typeof blob === "string") out.add(blob);
			}
		}
	}
}

function sameHoists(a: readonly Hoist[], b: readonly Hoist[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i]!.node !== b[i]!.node || a[i]!.owner !== b[i]!.owner) return false;
	return true;
}

/** Below this many columns a centered sheet with tall content fills the pane instead of floating with margins. */
export const NARROW_SHEET_COLS = 100;
/** The share of the viewport's rows a sheet's content must reach to fill a narrow pane. */
const SHEET_FILL_FRACTION = 0.5;

/**
 * The first `editor`/`input` at or under `node`: the terminal's keyboard focus is a text field's
 * (it edits and selects there natively); any other focused node keeps the keys in the program.
 */
function firstField(node: UiNode, depth: number): UiNode | undefined {
	if (node.kind === "editor" || node.kind === "input") return node;
	if (depth > 64) return undefined;
	for (const child of node.children()) {
		const found = firstField(child, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/** See the module docs. */
export class Reconciler {
	readonly #surface: Surface;
	/** The surface's wire id: the document root the regions hang off. */
	readonly #root: string;
	readonly #env: NativeEnvironment;
	readonly #onDirty: () => void;
	readonly #byNode = new Map<UiNode, Rec>();
	readonly #byId = new Map<string, Rec>();
	/** Overlays whose anchor depends on the placement of another record. */
	readonly #anchors = new Map<Rec, AnchorRef>();
	/** Ids the terminal holds (live records plus deletes not yet sent). */
	readonly #ids = new Set<string>();
	/** A retained transcript can still contain rows the terminal has evicted. Never describe those rows again. */
	#evicted: WeakSet<UiNode> | undefined;
	#main!: Rec;
	#dock!: Rec;
	#layer!: Rec;
	/** Regions the terminal's document lacks: the next frame adds them first (a fresh open, a keep-close). */
	#missingRegions: readonly RegionId[] = REGION_IDS;
	#layerHoists: readonly Hoist[] = NO_HOISTS;
	#focusDirty = true;
	#sentFocus: string | null = null;
	/** Centered sheets that fill a narrow pane: once tall, they stay full while they live. */
	readonly #filling = new WeakSet<UiNode>();
	#frame = 0;
	#disposeRegions: (() => void) | undefined;
	// Per-frame output.
	#ops: TspOp[] = [];
	#late: TspOp[] = [];
	#removed: Rec[] = [];
	#blobs = new Set<string>();

	constructor(surface: Surface, root: string, env: NativeEnvironment, onDirty: () => void) {
		this.#surface = surface;
		this.#root = root;
		this.#env = env;
		this.#onDirty = onDirty;
		this.#init();
	}

	/** Whether a frame would have something to send. */
	get dirty(): boolean {
		for (const region of [this.#main, this.#dock, this.#layer]) if (region.dirty || region.childDirty) return true;
		return this.#focusDirty || this.#missingRegions.length > 0;
	}

	/** The wire id `node` is described under, if it is. */
	idOf(node: UiNode): string | undefined {
		const rec = this.#byNode.get(node);
		if (!rec) return undefined;
		// A record under a subtree leaving this frame is on its way out too.
		for (let r: Rec | null = rec; r; r = r.parent) if (r.released || r.detached) return undefined;
		return rec.id;
	}

	/** Compute the ops that bring the terminal's document to the surface's current state. */
	reconcile(): NativeFrame {
		this.#frame++;
		this.#ops = [];
		this.#late = [];
		this.#removed = [];
		this.#blobs = new Set();
		// A document starts as its root alone; the regions are the program's to add.
		for (const id of this.#missingRegions) this.#ops.push(["add", id, this.#root, null, { id, k: "col" }]);
		this.#missingRegions = [];
		untrack(() => {
			this.#visit(this.#main);
			this.#visit(this.#dock);
			const hoists = [...this.#main.hoists, ...this.#dock.hoists];
			if (!sameHoists(hoists, this.#layerHoists)) {
				this.#layerHoists = hoists;
				this.#layer.dirty = true;
			}
			this.#visit(this.#layer);
			// A target can move or be replaced without dirtying the overlay.
			// Resolve again after all siblings (including forward references) have been placed.
			for (const [rec, ref] of this.#anchors) {
				if (!rec.node || !rec.props || this.idOf(rec.node) !== rec.id) continue;
				const props = this.#anchorProps(rec, rec.props, ref);
				if (props === rec.props) continue;
				rec.props = props;
				this.#ops.push(["set", rec.id, { anchor: props.anchor ?? null }]);
			}
			this.#measureSheets();
			// The focused node may have been described (or re-created) this frame: resolve it every time.
			this.#focusDirty = false;
			const focused = this.#surface.focused();
			const field = focused ? firstField(focused, 0) : undefined;
			const id = field ? (this.idOf(field) ?? null) : null;
			if (id !== this.#sentFocus) {
				this.#sentFocus = id;
				this.#late.push(["focus", id]);
			}
		});
		const ops = this.#ops;
		ops.push(...this.#late);
		for (const rec of this.#removed) {
			if (!rec.detached || rec.released) continue;
			ops.push(["del", rec.id]);
			this.#release(rec);
		}
		// Deleted ids are free again once their `del` is out.
		for (const rec of this.#removed) if (rec.released) this.#ids.delete(rec.id);
		return { ops, blobs: this.#blobs };
	}

	/**
	 * Forget everything sent (the terminal lost the surface): the next frame
	 * describes the whole surface again.
	 */
	reset(): void {
		for (const region of [this.#main, this.#dock, this.#layer]) for (const rec of region.kids) this.#release(rec);
		this.#disposeRegions?.();
		this.#byNode.clear();
		this.#byId.clear();
		this.#ids.clear();
		this.#evicted = undefined;
		this.#layerHoists = NO_HOISTS;
		this.#sentFocus = null;
		this.#missingRegions = REGION_IDS;
		this.#init();
	}

	/**
	 * The terminal dropped the live regions (`x keep:true` keeps only `main`): the next frame adds
	 * `dock` and `layer` again and describes their content afresh, and resends the focus.
	 */
	dropLiveRegions(): void {
		for (const region of [this.#dock, this.#layer]) {
			for (const rec of region.kids) {
				if (rec.parent !== region) continue;
				this.#release(rec);
				this.#ids.delete(rec.id);
			}
			region.kids = NO_RECORDS;
			region.structural = NO_RECORDS;
			region.hoists = NO_HOISTS;
			region.dirty = true;
		}
		this.#layerHoists = NO_HOISTS;
		this.#missingRegions = ["dock", "layer"];
		this.#sentFocus = null;
		this.#focusDirty = true;
	}

	/** Forget settled `main` subtrees evicted by Tern; record lost ids and next siblings if ops are queued. */
	forget(ids: readonly string[], gone?: Map<string, string | null>): void {
		let lost = false;
		for (const id of ids) {
			const rec = this.#byId.get(id);
			if (!rec?.node || rec.parent !== this.#main || !rec.settled) continue;
			lost = true;
			(this.#evicted ??= new WeakSet()).add(rec.node);
			this.#release(rec, gone);
			this.#ids.delete(id);
		}
		if (!lost) return;
		if (gone) {
			let next: string | null = null;
			for (let i = this.#main.kids.length - 1; i >= 0; i--) {
				const kid = this.#main.kids[i]!;
				if (kid.released) gone.set(kid.id, next);
				else next = kid.id;
			}
		}
		// It is already absent: do not delete it or use it as a `before` sibling.
		this.#main.kids = this.#main.kids.filter(kid => !kid.released);
		this.#markDirty(this.#main);
	}

	/** Release every watcher. */
	dispose(): void {
		for (const region of [this.#main, this.#dock, this.#layer]) for (const rec of region.kids) this.#release(rec);
		this.#disposeRegions?.();
		this.#disposeRegions = undefined;
	}

	/** Describe again the settled `main` block holding `node`: the program changed it after it was final. */
	redescribe(node: UiNode): void {
		let rec = this.#byNode.get(node);
		while (rec && rec.parent !== this.#main) rec = rec.parent ?? undefined;
		if (rec?.settled && !rec.released) this.#markDirty(rec);
	}

	/** Resolve a terminal UI event to the node it names; null for unknown ids. */
	resolve(event: { readonly id: string }): readonly UiNode[] | null {
		const rec = this.#byId.get(event.id);
		if (!rec?.node || rec.released || rec.node.disposed) return null;
		const path: UiNode[] = [];
		for (let r: Rec | null = rec; r?.node; r = r.owner) path.push(r.node);
		return path.reverse();
	}

	/**
	 * The key of the child of node `id` that wire id `item` names (a `list`
	 * selection), or `item` itself when it names no child (picker item ids).
	 */
	itemKey(id: string, item: string): string {
		const rec = this.#byId.get(id);
		const child = this.#byId.get(item);
		if (!rec?.node || !child?.node || child.owner !== rec) return item;
		return child.node.key() ?? String(rec.node.children().indexOf(child.node));
	}

	#init(): void {
		const surface = this.#surface;
		this.#main = this.#region("main");
		this.#dock = this.#region("dock");
		this.#layer = this.#region("layer");
		createRoot(dispose => {
			this.#disposeRegions = dispose;
			const watch = (rec: Rec, source: Accessor<readonly UiNode[]>): void => {
				let first = true;
				effect(() => {
					source();
					if (first) first = false;
					else this.#markDirty(rec);
				});
			};
			watch(this.#main, surface.main);
			watch(this.#dock, surface.dock);
			watch(this.#layer, surface.layer);
			let first = true;
			effect(() => {
				surface.focused();
				if (first) {
					first = false;
					return;
				}
				this.#focusDirty = true;
				this.#onDirty();
			});
		});
	}

	#region(id: RegionId): Rec {
		return {
			id,
			slot: id,
			node: null,
			kind: "col",
			owner: null,
			parent: null,
			hoisting: id !== "layer",
			kids: NO_RECORDS,
			hoists: NO_HOISTS,
			structural: NO_RECORDS,
			props: null,
			rawProps: undefined,
			rawChildren: null,
			revealN: undefined,
			scrollN: undefined,
			dirty: true,
			childDirty: false,
			settled: false,
			detached: false,
			released: false,
			placed: 0,
			canvas: null,
			stop: null,
		};
	}

	/**
	 * A narrow pane has no room for a floating sheet with margins, but a sheet stretched over a few
	 * lines is mostly empty. The terminal lays the content out, so the rows are estimated from what
	 * was just described: a centered sheet whose content reaches {@link SHEET_FILL_FRACTION} of the
	 * viewport fills the pane from the next frame on, and keeps filling while it stays open, so a
	 * filter or a reload never makes it jump between sizes.
	 */
	#measureSheets(): void {
		const cols = this.#env.cols();
		if (cols >= NARROW_SHEET_COLS) return;
		const limit = Math.max(1, Math.ceil(this.#env.rows() * SHEET_FILL_FRACTION));
		for (const rec of this.#layer.kids) {
			const node = rec.node;
			if (!node || rec.kind !== "overlay" || !rec.props || this.#filling.has(node)) continue;
			const { anchor, size } = rec.props as TspOverlayProps;
			if (size === "full" || (anchor !== undefined && anchor !== "center")) continue;
			if (estimateRows(rec, cols, limit) < limit) continue;
			this.#filling.add(node);
			rec.rawProps = undefined;
			this.#markDirty(rec);
		}
	}

	#markDirty(rec: Rec): void {
		rec.dirty = true;
		for (let p = rec.parent; p && !p.childDirty; p = p.parent) p.childDirty = true;
		this.#onDirty();
	}

	/** The nodes a record's children come from. */
	#sourceOf(rec: Rec): readonly UiNode[] {
		if (rec.node) return rec.node.children();
		if (rec === this.#main) return this.#surface.main();
		if (rec === this.#dock) return this.#surface.dock();
		return this.#surface.layer();
	}

	/** The placements a record's children are now. */
	#placements(rec: Rec): Placement[] {
		const out: Placement[] = [];
		if (rec === this.#layer) {
			for (const hoist of this.#layerHoists) out.push({ ...hoist, hoisted: true });
		}
		const nodes = this.#sourceOf(rec);
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			if (this.#evicted?.has(node)) continue;
			out.push({ node, owner: rec, seg: node.key() ?? String(i), hoisted: false });
		}
		return out;
	}

	#visit(rec: Rec): void {
		if (rec.dirty && rec.settled && rec.parent === this.#main) {
			const before = this.#main.kids[this.#main.kids.indexOf(rec) + 1]?.id ?? null;
			this.#republish(rec, this.#main, before);
			return;
		}
		if (rec.dirty) {
			rec.dirty = false;
			const node = rec.node;
			const reshaped = !node || node.children() !== rec.rawChildren;
			if (reshaped) this.#updateChildren(rec);
			if (node) this.#updateNode(rec, node, reshaped);
		}
		if (rec.childDirty) {
			rec.childDirty = false;
			for (const kid of rec.kids) if (kid.dirty || kid.childDirty) this.#visit(kid);
		}
		if (rec.hoisting) this.#gatherHoists(rec);
		if (rec.node && rec.parent === this.#main && !rec.settled && isSettled(rec.node)) this.#settle(rec);
	}

	/** Recompute a visited record's hoisted descendants, keeping the old list when unchanged. */
	#gatherHoists(rec: Rec): void {
		let out: Hoist[] | undefined;
		for (const item of rec.structural) {
			if ("seg" in item) (out ??= []).push(item);
			else if (item.hoists.length > 0) (out ??= []).push(...item.hoists);
		}
		const next = out ?? NO_HOISTS;
		if (!sameHoists(next, rec.hoists)) rec.hoists = next;
	}

	/** Diff a node's props, text, reveal and scroll against what was sent. */
	#updateNode(rec: Rec, node: UiNode, reshaped: boolean): void {
		const raw = rec.canvas ? rec.canvas() : node.props();
		// A list's selection and a fold's head name a child by wire id: new children may change it.
		if (raw !== rec.rawProps || (reshaped && CHILD_REF_KINDS[rec.kind])) {
			rec.rawProps = raw;
			const next = this.#wireProps(rec, node);
			const prev = rec.props ?? {};
			rec.props = next;
			let changed: Record<string, unknown> | undefined;
			const textual = TEXT_KINDS.has(rec.kind);
			for (const name in next) {
				if (textual && name === "text") continue;
				const before = prev[name];
				const after = next[name];
				// Most props are the same value the last frame sent (or a primitive): only a
				// value that changed identity needs the deep comparison.
				if (before === after) continue;
				if (!Bun.deepEquals(before, after)) (changed ??= {})[name] = after;
			}
			for (const name in prev) {
				if (textual && name === "text") continue;
				if (!(name in next)) (changed ??= {})[name] = null;
			}
			if (changed) {
				this.#ops.push(["set", rec.id, changed]);
				collectBlobs(changed, this.#blobs);
			}
			if (textual) {
				const before = typeof prev.text === "string" ? prev.text : "";
				const after = typeof next.text === "string" ? next.text : "";
				if (before !== after) this.#textOp(rec.id, rec.kind, before, after);
			}
		}
		const reveal = node.reveal();
		if (typeof reveal === "object" && reveal.n !== rec.revealN) {
			rec.revealN = reveal.n;
			this.#late.push(["reveal", rec.id, reveal.at]);
		}
		const scroll = node.scroll();
		if (rec.scrollN === undefined) {
			// A node that replaced a retired one starts from its request, as a new node does.
			rec.scrollN = scroll?.n ?? 0;
		} else if (scroll && scroll.n !== rec.scrollN) {
			const steps = Math.min(MAX_SCROLL_STEPS, scroll.n - rec.scrollN);
			rec.scrollN = scroll.n;
			if (steps > 0 && this.#env.hasFeature("scroll"))
				for (let i = 0; i < steps; i++) this.#late.push(["scroll", rec.id, scroll.by]);
		}
	}

	/**
	 * The op taking a node's primary text from `before` to `after`: an append when it only grew,
	 * else a splice of the changed range for an edited field or a streaming answer (whose
	 * speculatively closed tail is rewritten as it arrives), else a replace.
	 */
	#textOp(id: string, kind: TspKind, before: string, after: string): void {
		if (after.length > before.length && after.startsWith(before)) {
			this.#ops.push(["text", id, "append", after.slice(before.length)]);
			return;
		}
		if ((kind === "editor" || kind === "input" || kind === "md") && before.length > 0) {
			const limit = Math.min(before.length, after.length);
			let prefix = 0;
			while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
			// A Markdown source rewritten from its start re-renders whole either way.
			if (kind !== "md" || prefix > 0) {
				let suffix = 0;
				while (
					suffix < limit - prefix &&
					before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
				)
					suffix++;
				this.#ops.push([
					"splice",
					id,
					prefix,
					before.length - prefix - suffix,
					after.slice(prefix, after.length - suffix),
				]);
				return;
			}
		}
		this.#ops.push(["text", id, "replace", after]);
	}

	/**
	 * A node's props as sent: canvas rows, a list's selection as its item's wire id, a card's or
	 * section's child keyed `head` (when no `head` prop is set) as its `head` wire id.
	 */
	#wireProps(rec: Rec, node: UiNode): Props {
		return normalizeIconProps(rec.kind, this.#sentProps(rec, node));
	}

	/** {@link #wireProps} before icon normalization. */
	#sentProps(rec: Rec, node: UiNode): Props {
		let raw = node.props() as Props;
		if ("term" in raw) {
			// Terminal-only look facts never travel.
			const { term: _term, ...rest } = raw;
			raw = rest;
		}
		if (rec.kind === "overlay" && "page" in raw) {
			// Nor does an overlay's page declaration (`prefs` has a wire prop of that name).
			const { page: _page, ...rest } = raw;
			raw = rest;
		}
		if (rec.canvas) {
			const { paint: _paint, ...common } = raw as Readonly<CanvasProps>;
			return { ...common, cols: this.#env.cols(), lines: rec.canvas() };
		}
		if (rec.kind === "md" && "prepared" in raw) {
			// Nor does an `md`'s note that its streaming text is final as given.
			const { prepared, ...rest } = raw;
			if (prepared === true) return rest;
			raw = rest;
		}
		if (rec.kind === "md" && raw.stream === true && typeof raw.text === "string") {
			// A terminal lays out every row it gets: hold the table row being written, close an open link/math span.
			return { ...raw, text: speculativeStreamingSource(holdPartialTableRow(raw.text)) };
		}
		if (rec.kind === "overlay") {
			const ref = (raw as TspOverlayProps).anchor;
			if (ref && typeof ref === "object") {
				this.#anchors.set(rec, ref);
				return this.#anchorProps(rec, raw, ref);
			}
			this.#anchors.delete(rec);
			if (this.#filling.has(node) && raw.size !== "full") return { ...raw, size: "full" };
		}
		if (rec.kind === "list" && typeof raw.selected === "string") {
			const selected = raw.selected;
			const item = rec.kids.find(kid => kid.node && (kid.node.key() ?? null) === selected);
			const byIndex =
				item ?? rec.kids.find(kid => kid.node && String(node.children().indexOf(kid.node)) === selected);
			return { ...raw, selected: byIndex ? byIndex.id : null };
		}
		if ((rec.kind === "card" || rec.kind === "section") && raw.head === undefined) {
			const head = rec.kids.find(kid => kid.node?.key() === "head");
			if (head) return { ...raw, head: head.id };
		}
		return raw;
	}

	/** Resolve an owner's keypath through structural children, never guessing a collision suffix or a moved id. */
	#anchorProps(rec: Rec, props: Props, ref: AnchorRef): Props {
		const path = "caret" in ref ? ref.caret : ref.node;
		let target = rec.owner;
		for (const segment of path.split("/")) {
			if (!target) break;
			const child: UiNode | undefined = this.#sourceOf(target).find((node, i) => {
				const key = node.key();
				return (key === undefined ? String(i) : escapeSegment(key)) === segment;
			});
			const record: Rec | undefined = child && this.#byNode.get(child);
			target = record?.owner === target ? record : null;
		}
		// A layer may also name an already-qualified wire id in another region.
		const record = target ?? this.#byId.get(path);
		const id = record?.node && this.idOf(record.node) === record.id ? record.id : undefined;
		const prev = (props as TspOverlayProps).anchor;
		if (id === undefined) {
			if (prev === undefined) return props;
			const { anchor: _missing, ...rest } = props;
			return rest;
		}
		if ("caret" in ref) {
			if (typeof prev === "object" && "caret" in prev && prev.caret === id) return props;
			return { ...props, anchor: { caret: id } };
		}
		if (typeof prev === "object" && "node" in prev && prev.node === id && prev.side === ref.side) return props;
		return { ...props, anchor: { node: id, side: ref.side } };
	}

	/** Reconcile a record's wire children with its node's current children. */
	#updateChildren(rec: Rec): void {
		const node = rec.node;
		if (node) rec.rawChildren = node.children();
		const placements = this.#placements(rec);
		const old = rec.kids;
		const next: Rec[] = [];
		const structural: (Rec | Hoist)[] = [];
		const fresh = new Set<Rec>();
		const slots: (Rec | undefined)[] = [];
		for (const placement of placements) {
			if (rec.hoisting && !placement.hoisted && hoists(placement.node)) {
				slots.push(undefined);
				continue;
			}
			let match = this.#byNode.get(placement.node);
			if (match && (match.released || match.placed === this.#frame)) match = undefined;
			slots.push(match);
		}
		// Old children that may be taken over by a node replacing them (their node retired, not placed again).
		let vacant: Map<string, Rec> | undefined;
		for (const kid of old) {
			if (kid.node?.disposed && kid.parent === rec && !slots.includes(kid))
				(vacant ??= new Map()).set(`${kid.kind}\0${kid.slot}`, kid);
		}
		for (let i = 0; i < placements.length; i++) {
			const placement = placements[i]!;
			if (rec.hoisting && !placement.hoisted && hoists(placement.node)) {
				structural.push({ node: placement.node, owner: rec, seg: placement.seg });
				continue;
			}
			let kid = slots[i];
			const slot = this.#childId(placement, false);
			if (!kid && vacant) {
				const key = `${this.#kindOf(placement.node)}\0${slot}`;
				const candidate = vacant.get(key);
				if (candidate) {
					vacant.delete(key);
					kid = this.#rebind(candidate, placement.node);
					rec.childDirty = true;
				}
			}
			if (kid) {
				kid.owner = placement.owner;
				kid.detached = false;
			} else {
				kid = this.#create(placement, rec);
				fresh.add(kid);
			}
			kid.placed = this.#frame;
			kid.slot = slot;
			next.push(kid);
			structural.push(kid);
		}
		// Old children not placed again leave (their delete waits for the frame's end).
		for (const kid of old) {
			if (kid.parent !== rec || kid.placed === this.#frame || kid.detached) continue;
			kid.detached = true;
			this.#removed.push(kid);
		}
		// Keep the longest run of children already in order; place the rest right to left.
		const oldIndex = new Map<Rec, number>();
		for (let i = 0; i < old.length; i++) oldIndex.set(old[i]!, i);
		const order = next.map(kid => (kid.parent === rec && !fresh.has(kid) ? (oldIndex.get(kid) ?? -1) : -1));
		const stable = longestIncreasing(order);
		// Right to left: each `before` sibling already sits where it ends up.
		let before: string | null = null;
		for (let i = next.length - 1; i >= 0; i--) {
			const kid = next[i]!;
			if (fresh.has(kid)) this.#ops.push(["add", kid.id, rec.id, before, this.#describe(kid)]);
			// A settled ancestor dropped this child's props and watches. Moving it out must
			// describe its current state and install watches appropriate to its new position.
			else if (kid.parent !== rec && (!kid.stop || kid.settled)) this.#republish(kid, rec, before);
			else if (!stable.has(i)) {
				kid.parent = rec;
				this.#ops.push(["move", kid.id, rec.id, before]);
			}
			before = kid.id;
		}
		rec.kids = next.length > 0 ? next : NO_RECORDS;
		rec.structural = structural.length > 0 ? structural : NO_RECORDS;
	}

	/** Rebuild one record whose old props were discarded, preserving its wire identity. */
	#republish(rec: Rec, parent: Rec, before: string | null): void {
		for (const kid of rec.kids) {
			if (kid.parent !== rec) continue;
			this.#release(kid);
			this.#ids.delete(kid.id);
		}
		rec.parent = parent;
		rec.dirty = false;
		rec.childDirty = false;
		if (rec.settled) {
			// The block-wide watcher gives way to the per-node ones until it settles again.
			rec.settled = false;
			rec.stop?.();
			rec.stop = null;
		}
		if (!rec.stop) this.#watch(rec);
		this.#ops.push(["del", rec.id], ["add", rec.id, parent.id, before, this.#describe(rec)]);
	}

	#kindOf(node: UiNode): TspKind {
		return node.kind === "canvas" ? "rows" : node.kind;
	}

	#childId(placement: Placement, unique: boolean): string {
		const base = `${placement.owner.id}/${placement.hoisted ? "^" : ""}${escapeSegment(placement.seg)}`;
		if (!unique || !this.#ids.has(base)) return base;
		for (let n = 1; ; n++) {
			const id = `${base}~${n}`;
			if (!this.#ids.has(id)) return id;
		}
	}

	#create(placement: Placement, parent: Rec): Rec {
		const node = placement.node;
		const slot = this.#childId(placement, false);
		const id = this.#childId(placement, true);
		// A node still described elsewhere (moved into a new subtree) gets a fresh record; the old one is deleted.
		const previous = this.#byNode.get(node);
		if (previous && !previous.released && previous.placed !== this.#frame && !previous.detached) {
			previous.detached = true;
			this.#removed.push(previous);
		}
		const rec: Rec = {
			id,
			slot,
			node,
			kind: this.#kindOf(node),
			owner: placement.owner,
			parent,
			hoisting: parent.hoisting && !placement.hoisted,
			kids: NO_RECORDS,
			hoists: NO_HOISTS,
			structural: NO_RECORDS,
			props: null,
			rawProps: undefined,
			rawChildren: null,
			revealN: undefined,
			scrollN: undefined,
			dirty: false,
			childDirty: false,
			settled: false,
			detached: false,
			released: false,
			placed: this.#frame,
			canvas: null,
			stop: null,
		};
		this.#ids.add(id);
		this.#byId.set(id, rec);
		this.#byNode.set(node, rec);
		this.#watch(rec);
		return rec;
	}

	/** Point an existing record at the node that replaced its retired one. */
	#rebind(rec: Rec, node: UiNode): Rec {
		const old = rec.node;
		if (old && this.#byNode.get(old) === rec) this.#byNode.delete(old);
		rec.stop?.();
		rec.canvas = null;
		rec.node = node;
		rec.rawProps = undefined;
		rec.rawChildren = null;
		rec.revealN = undefined;
		rec.scrollN = undefined;
		this.#byNode.set(node, rec);
		this.#watch(rec);
		rec.dirty = true;
		rec.childDirty = true;
		rec.detached = false;
		return rec;
	}

	/** Watch everything a record's description reads; any change marks it dirty. */
	#watch(rec: Rec): void {
		const node = rec.node!;
		const settleable = rec.parent === this.#main;
		rec.stop = createRoot(dispose => {
			if (node.kind === "canvas") {
				rec.canvas = computed(() => (node.props() as Readonly<CanvasProps>).paint(this.#env.cols()), {
					equals: (a, b) => a.length === b.length && a.every((row, i) => row === b[i]),
				});
			}
			let first = true;
			effect(() => {
				node.props();
				node.children();
				node.key();
				node.reveal();
				node.scroll();
				rec.canvas?.();
				if (settleable) isSettled(node);
				if (first) first = false;
				else this.#markDirty(rec);
			});
			return dispose;
		});
	}

	/** Describe a new record (and its subtree) as a wire node. */
	#describe(rec: Rec): TspNode {
		const node = rec.node!;
		rec.rawChildren = node.children();
		const placements = this.#placements(rec);
		const kids: Rec[] = [];
		const structural: (Rec | Hoist)[] = [];
		const children: TspNode[] = [];
		for (const placement of placements) {
			if (rec.hoisting && hoists(placement.node)) {
				structural.push({ node: placement.node, owner: rec, seg: placement.seg });
				continue;
			}
			const previous = this.#byNode.get(placement.node);
			if (previous?.placed === this.#frame && !previous.released) continue;
			const kid = this.#create(placement, rec);
			kids.push(kid);
			structural.push(kid);
			children.push(this.#describe(kid));
		}
		rec.kids = kids.length > 0 ? kids : NO_RECORDS;
		rec.structural = structural.length > 0 ? structural : NO_RECORDS;
		if (rec.hoisting) this.#gatherHoists(rec);
		rec.rawProps = rec.canvas ? rec.canvas() : node.props();
		const props = this.#wireProps(rec, node);
		rec.props = props;
		collectBlobs(props, this.#blobs);
		const reveal = node.reveal();
		if (typeof reveal === "string") this.#late.push(["reveal", rec.id, reveal]);
		else if (reveal) rec.revealN = reveal.n;
		rec.scrollN = node.scroll()?.n ?? 0;
		if (rec.parent === this.#main && isSettled(node)) this.#settle(rec);
		const wire: Record<string, unknown> = { id: rec.id, k: rec.kind };
		// A new node has no prop to clear: `null` (the `set` spelling of "remove") is left out.
		let sent: Record<string, unknown> | undefined;
		for (const name in props)
			if (props[name] !== null && props[name] !== undefined) (sent ??= {})[name] = props[name];
		if (sent) wire.p = sent;
		if (children.length > 0) wire.c = children;
		return wire as TspNode;
	}

	/**
	 * Send `settle` and drop the subtree's per-node watchers and retained props. One watcher over the
	 * whole block stays: a settled block that changes after all is described again.
	 */
	#settle(rec: Rec): void {
		rec.settled = true;
		if (this.#env.hasFeature("settle")) this.#late.push(["settle", rec.id]);
		const drop = (r: Rec): void => {
			r.stop?.();
			r.stop = null;
			r.canvas = null;
			r.props = null;
			r.rawProps = undefined;
			r.dirty = false;
			r.childDirty = false;
			for (const kid of r.kids) drop(kid);
		};
		drop(rec);
		const root = rec.node!;
		const read = (node: UiNode): void => {
			node.props();
			for (const child of node.children()) read(child);
		};
		rec.stop = createRoot(dispose => {
			let first = true;
			effect(() => {
				read(root);
				if (first) first = false;
				else this.#markDirty(rec);
			});
			return dispose;
		});
	}

	/** Forget a deleted record and its subtree (children moved elsewhere stay). */
	#release(rec: Rec, gone?: Map<string, string | null>): void {
		if (rec.released) return;
		rec.released = true;
		gone?.set(rec.id, null);
		this.#anchors.delete(rec);
		rec.stop?.();
		rec.stop = null;
		rec.canvas = null;
		if (this.#byId.get(rec.id) === rec) this.#byId.delete(rec.id);
		if (rec.node && this.#byNode.get(rec.node) === rec) this.#byNode.delete(rec.node);
		for (const kid of rec.kids) {
			if (kid.parent !== rec) continue;
			this.#release(kid, gone);
			this.#ids.delete(kid.id);
		}
	}
}
