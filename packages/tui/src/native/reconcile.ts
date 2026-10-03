/**
 * Reconciler: turns successive component descriptions into minimal TSP ops.
 *
 * Ids. Every component instance gets a stable base-36 id (its root node's
 * wire id); a node nested inside it gets `<base>.<keypath>`, where the
 * keypath joins each level's `key` (or child index) with `/`. Ids therefore
 * derive from the description itself, so the reconciler keeps no per-node
 * table: its whole memory is, per mounted component, the node object the
 * component last returned (which the component itself retains as its memo),
 * the component boundaries and hoisted overlays found inside it, and
 * rows-fallback bookkeeping.
 *
 * Diffing. Reference-equal nodes are skipped without walking; component
 * boundaries inside them are still visited through the recorded boundary
 * list. Children are matched by id; keyed reorders become `move`s placed
 * around the longest run of children that kept their order, removals are
 * deferred to the end of the frame so a component moved elsewhere in the same
 * frame keeps its terminal-side state. Primary text that extends the previous
 * text becomes `text append`.
 *
 * Settling. A settled component (see `settle.ts`) drops its retained node
 * after the `settle` hint; only a weak identity, its root kind, root prop
 * names and child ids survive. A later change is sent as targeted ops by id
 * (`set` of the root props, `del` + `add` of its children), never by diffing
 * against state omp no longer keeps.
 *
 * `overlay` nodes described anywhere but directly under `layer` are hoisted
 * into `layer`; their anchor keypaths are rewritten to wire ids.
 */
import * as logger from "@oh-my-pi/pi-utils/logger";
import { TSP_TEXT_KINDS, type TspKind, type TspNode, type TspOp, type TspScrollBy } from "@oh-my-pi/pi-wire";
import { type Component, Container, CURSOR_MARKER } from "../tui";
import { normalizeIconProps } from "./icons";
import type { DescribeContext, NativeChild, NativeNode, NativeRevealAt } from "./node";
import { quietMotion } from "./quiet";
import { isNativeSettled } from "./settle";

/** The regions a frame fills. */
export interface NativeRegions {
	readonly main: readonly NativeChild[];
	readonly dock: readonly NativeChild[];
	readonly layer: readonly NativeChild[];
}

/** Where a wire id came from, for event routing. */
export interface NativeTarget {
	readonly component: Component;
	/** Keypath inside the component ("" for its root node). */
	readonly keypath: string;
}

const kNativeId = Symbol("native.id");

interface IdTagged {
	[kNativeId]?: string;
}

const REGION_IDS = ["main", "dock", "layer"] as const;
type RegionId = (typeof REGION_IDS)[number];
const RESERVED_IDS: ReadonlySet<string> = new Set(REGION_IDS);
const TEXT_KINDS: ReadonlySet<string> = new Set(TSP_TEXT_KINDS);
/** Most `scroll` ops one node's coalesced key presses send in a frame. */
const MAX_SCROLL_REPEAT = 32;
let nextComponentId = 0;

/** Stable base-36 wire id of a component instance (its root node's id). */
export function nativeComponentId(component: Component): string {
	const tagged = component as IdTagged;
	let id = tagged[kNativeId];
	if (id === undefined) {
		do {
			id = (nextComponentId++).toString(36);
		} while (RESERVED_IDS.has(id));
		tagged[kNativeId] = id;
	}
	return id;
}

function isComponent(child: NativeChild): child is Component {
	return typeof (child as Component).render === "function";
}

const KEY_ESCAPES: Readonly<Record<string, string>> = { "%": "%25", "/": "%2F", "^": "%5E" };
const KEY_UNESCAPES: Readonly<Record<string, string>> = { "%25": "%", "%2F": "/", "%5E": "^" };

function escapeKey(key: string): string {
	return key.replace(/[%/^]/g, c => KEY_ESCAPES[c]!);
}

/** A keypath segment back to the key it was built from (hoisted overlays carry a `^` marker). */
function unescapeKey(segment: string): string {
	return (segment.startsWith("^") ? segment.slice(1) : segment).replace(/%2F|%25|%5E/g, c => KEY_UNESCAPES[c]!);
}

function nodeId(base: string, keypath: string): string {
	return keypath === "" ? base : `${base}.${keypath}`;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	return typeof a === "object" && typeof b === "object" && a !== null && b !== null && Bun.deepEquals(a, b);
}

function asProps(node: NativeNode): Readonly<Record<string, unknown>> | undefined {
	return node.p as Readonly<Record<string, unknown>> | undefined;
}

/** Longest increasing subsequence over non-negative `sources`; marks the members. */
function stableMask(sources: readonly number[]): boolean[] {
	const n = sources.length;
	const mask = Array.from({ length: n }, () => false);
	const tails: number[] = [];
	const prev = Array.from({ length: n }, () => -1);
	for (let i = 0; i < n; i++) {
		const value = sources[i]!;
		if (value < 0) continue;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sources[tails[mid]!]! < value) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1]!;
		tails[lo] = i;
	}
	for (let at = tails.length > 0 ? tails[tails.length - 1]! : -1; at >= 0; at = prev[at]!) mask[at] = true;
	return mask;
}

interface Owner {
	readonly base: string;
	readonly state: CompState | null;
}

interface NodeEntry {
	readonly id: string;
	readonly node: NativeNode;
	readonly owner: Owner;
	readonly keypath: string;
	/** Whether overlay descendants of this node are hoisted into `layer`. */
	readonly hoist: boolean;
	readonly comp?: undefined;
}

interface CompEntry {
	readonly id: string;
	readonly comp: Component;
}

type Entry = NodeEntry | CompEntry;

/**
 * What a component's walk met, in walk order: nested component boundaries
 * (with their document position) and hoisted overlays. Replaying it for an
 * unchanged component reproduces the walk's visits and overlay order.
 */
type Inner =
	| {
			readonly comp: Component;
			readonly parent: string;
			readonly before: string | null;
			readonly portal?: undefined;
	  }
	| { readonly portal: NodeEntry; readonly comp?: undefined };

interface CompState {
	readonly comp: Component;
	readonly id: string;
	readonly owner: Owner;
	/** Last description while unsettled; null once settled. */
	node: NativeNode | null;
	/** Settled: identity of the last description (node, or rows array). */
	weak: WeakRef<object> | null;
	kind: TspKind;
	propKeys: readonly string[];
	childIds: readonly string[];
	inner: Inner[];
	rowsLines: readonly string[] | null;
	rowsCols: number;
	rowsNode: NativeNode | null;
	settled: boolean;
	settleSent: boolean;
	frame: number;
	/** The component whose node currently contains this one in the document (null: a region or the root). */
	container: CompState | null;
	/** Moved under the surface root this frame to survive a delete or a parent/child swap. */
	parked: boolean;
}

interface Walk {
	readonly owner: Owner;
	/** Records the owner's boundaries and hoisted overlays (null: don't record). */
	readonly inner: Inner[] | null;
	readonly settled: boolean;
	readonly hoist: boolean;
}

interface PendingMove {
	readonly id: string;
	readonly parent: string;
	readonly before: string | null;
}

const EMPTY_ENTRIES: readonly Entry[] = [];

/** One surface's reconciler. */
export class Reconciler {
	readonly surface: string;
	#cx: DescribeContext | undefined;
	#states = new Map<Component, CompState>();
	#byId = new Map<string, CompState>();
	#frame = 0;
	#ops: TspOp[] = [];
	#dels: Entry[] = [];
	#settles: string[] = [];
	/**
	 * Selected list items, added `reveal` nodes and nodes whose reveal `n` moved this frame,
	 * revealed once the frame's adds have landed.
	 */
	#reveals: [id: string, at: NativeRevealAt][] = [];
	/** `scroll` requests whose `n` moved this frame, sent after the reveals. */
	#scrolls: [id: string, by: TspScrollBy][] = [];
	/** Wire ids `list.selected` keys resolved to (an unresolved key names no node to reveal). */
	#selectedIds = new Set<string>();
	#moves: PendingMove[] = [];
	/** Ids of components updated this frame that wait for an enclosing `add` to move in. */
	#pendingMoves = new Set<string>();
	/** Components parked under the root this frame. */
	#parked: CompState[] = [];
	#framePortals: NodeEntry[] = [];
	#prevPortals: NodeEntry[] = [];
	#regions: Record<RegionId, readonly Entry[]> | null = null;
	#rows = 0;
	#gone = new Set<string>();
	/** Live-only regions to re-add after the surface was closed and adopted. */
	#readd: readonly RegionId[] = [];
	#regionOwners: Record<RegionId, Owner> = {
		main: { base: "main", state: null },
		dock: { base: "dock", state: null },
		layer: { base: "layer", state: null },
	};

	constructor(surface: string) {
		this.surface = surface;
	}

	/** `rows` fallback nodes in the last reconciled frame. */
	get fallbackCount(): number {
		return this.#rows;
	}

	/** Diff the regions against the previous frame; the first call adds everything. */
	reconcile(regions: NativeRegions, cx: DescribeContext): TspOp[] {
		this.#cx = cx;
		this.#frame++;
		this.#ops = [];
		this.#dels = [];
		this.#settles = [];
		this.#reveals = [];
		this.#scrolls = [];
		this.#selectedIds.clear();
		this.#framePortals = [];
		this.#rows = 0;
		let prev = this.#regions;
		if (prev === null) {
			for (const region of REGION_IDS) this.#ops.push(["add", region, this.surface, null, { id: region, k: "col" }]);
			prev = { main: EMPTY_ENTRIES, dock: EMPTY_ENTRIES, layer: EMPTY_ENTRIES };
		}
		for (const region of this.#readd) this.#ops.push(["add", region, this.surface, null, { id: region, k: "col" }]);
		this.#readd = [];
		const next = {} as Record<RegionId, readonly Entry[]>;
		for (const region of REGION_IDS) {
			const hoist = region !== "layer";
			const walk: Walk = { owner: this.#regionOwners[region], inner: null, settled: false, hoist };
			const entries = this.#entries(regions[region], "", walk.owner, hoist, walk);
			this.#diffChildren(region, prev[region], entries, null, walk);
			next[region] = entries;
		}
		// Hoisted overlays sit before the overlay stack in `layer`.
		const layerFirst = next.layer.length > 0 ? next.layer[0]!.id : null;
		const portalWalk: Walk = { owner: this.#regionOwners.layer, inner: null, settled: false, hoist: false };
		const portals = this.#framePortals.slice();
		this.#diffChildren("layer", this.#prevPortals, portals, layerFirst, portalWalk);
		if (this.#framePortals.length > portals.length) {
			// Components inside a hoisted overlay described overlays of their own;
			// only one level of hoisting exists, so those stay unsent.
			logger.debug("TSP: overlay nested in a hoisted overlay dropped", {
				ids: this.#framePortals.slice(portals.length).map(portal => portal.id),
			});
		}
		this.#prevPortals = portals;
		this.#regions = next;
		for (const entry of this.#dels) this.#deleteEntry(entry);
		// Parked to survive a parent/child swap but absent from the new description.
		for (const state of this.#parked) {
			if (!state.parked) continue;
			state.parked = false;
			this.#dropState(state);
			this.#ops.push(["del", state.id]);
		}
		this.#parked = [];
		for (const id of this.#settles) this.#ops.push(["settle", id]);
		for (const [id, at] of this.#reveals) this.#ops.push(["reveal", id, at]);
		if (cx.feature("scroll")) for (const [id, by] of this.#scrolls) this.#ops.push(["scroll", id, by]);
		const ops = this.#ops;
		this.#ops = [];
		return this.#gone.size === 0 ? ops : ops.filter(op => !this.#touchesGone(op));
	}

	/**
	 * The surface was closed (`keep:true`) and is being adopted: the terminal
	 * dropped `dock`, `layer` and focus but kept `main`. The next frame re-adds
	 * the live regions from scratch and keeps diffing `main`.
	 */
	detachLive(): void {
		const regions = this.#regions;
		if (!regions) return;
		// A fresh frame number so every state below counts as unvisited.
		this.#frame++;
		for (const region of ["dock", "layer"] as const) {
			for (const entry of regions[region]) {
				if (entry.comp === undefined) this.#dropSubtree(entry);
				else {
					const state = this.#states.get(entry.comp);
					if (state) this.#dropState(state);
				}
			}
		}
		for (const portal of this.#prevPortals) this.#dropSubtree(portal);
		this.#prevPortals = [];
		this.#regions = { main: regions.main, dock: EMPTY_ENTRIES, layer: EMPTY_ENTRIES };
		this.#readd = ["dock", "layer"];
	}

	/** The component and keypath that described wire node `id`. */
	target(id: string): NativeTarget | null {
		const dot = id.indexOf(".");
		const state = this.#byId.get(dot === -1 ? id : id.slice(0, dot));
		if (!state) return null;
		const keypath =
			dot === -1
				? ""
				: id
						.slice(dot + 1)
						.split("/")
						.map(unescapeKey)
						.join("/");
		return { component: state.comp, keypath };
	}

	/**
	 * The component that described wire node `id`, then each component whose
	 * node contains it, innermost first (empty for an unknown id).
	 */
	owners(id: string): Component[] {
		const dot = id.indexOf(".");
		const out: Component[] = [];
		for (let state = this.#byId.get(dot === -1 ? id : id.slice(0, dot)) ?? null; state; state = state.container) {
			out.push(state.comp);
		}
		return out;
	}

	/** The key a list item node was described with (its key, else its child index). */
	itemKey(id: string): string {
		const dot = id.indexOf(".");
		if (dot === -1) return this.#byId.get(id)?.node?.key ?? id;
		const slash = id.lastIndexOf("/");
		return unescapeKey(id.slice(Math.max(dot, slash) + 1));
	}

	/** Wire id of the first `editor`/`input` `component` describes (for `focus`), or null. */
	focusTarget(component: Component): string | null {
		const state = this.#states.get(component);
		return state ? this.#findEditor(state, 0) : null;
	}

	/** Stop referencing ids the terminal dropped (`gone`). */
	forget(ids: readonly string[]): void {
		for (const id of ids) this.#gone.add(id);
	}

	#touchesGone(op: TspOp): boolean {
		const gone = this.#gone;
		switch (op[0]) {
			case "add":
			case "move":
				return gone.has(op[1]) || gone.has(op[2]) || (op[3] !== null && gone.has(op[3]));
			case "focus":
				return op[1] !== null && gone.has(op[1]);
			case "suspend":
			case "resume":
				return false;
			default:
				return gone.has(op[1]);
		}
	}

	#findEditor(state: CompState, depth: number): string | null {
		if (depth > 64) return null;
		const node = state.node ?? (state.weak?.deref() as NativeNode | undefined);
		if (!node || typeof node.k !== "string") return null;
		return this.#findEditorIn(node, state.id, "", state.owner, depth);
	}

	#findEditorIn(node: NativeNode, id: string, keypath: string, owner: Owner, depth: number): string | null {
		if (node.k === "editor" || node.k === "input") return id;
		for (const entry of this.#entries(node.c, keypath, owner, true, null)) {
			const found =
				entry.comp === undefined
					? this.#findEditorIn(entry.node, entry.id, entry.keypath, owner, depth)
					: this.#findEditorOf(entry.comp, depth + 1);
			if (found !== null) return found;
		}
		return null;
	}

	#findEditorOf(component: Component, depth: number): string | null {
		const state = this.#states.get(component);
		return state ? this.#findEditor(state, depth) : null;
	}

	// ── Entries ──────────────────────────────────────────────────────────

	/**
	 * Child slots of a node with their wire ids. Overlays are split off into the
	 * hoisted list when `hoist` is set (and a walk collects them).
	 */
	#entries(
		children: readonly NativeChild[] | undefined,
		keypath: string,
		owner: Owner,
		hoist: boolean,
		walk: Walk | null,
	): readonly Entry[] {
		if (!children || children.length === 0) return EMPTY_ENTRIES;
		const out: Entry[] = [];
		let used: Set<string> | undefined;
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			if (isComponent(child)) {
				out.push({ id: nativeComponentId(child), comp: child });
				continue;
			}
			const segment = child.key === undefined ? String(i) : escapeKey(child.key);
			let path = keypath === "" ? segment : `${keypath}/${segment}`;
			if (children.length > 1) {
				// A key may repeat, or equal an unkeyed sibling's index.
				used ??= new Set();
				if (used.has(path)) {
					let n = 2;
					while (used.has(`${path}~${n}`)) n++;
					path = `${path}~${n}`;
				}
				used.add(path);
			}
			const entry: NodeEntry = {
				id: nodeId(owner.base, path),
				node: child,
				owner,
				keypath: path,
				hoist: hoist && child.k !== "overlay" && child.k !== "picker",
			};
			// A picker is its own sheet: hoisted like an overlay.
			if (hoist && (child.k === "overlay" || child.k === "picker")) {
				if (walk) {
					// Its own id namespace (`^` marks the hoisted segment): the node now
					// lives under `layer`, so a same-keypath node in place must not collide.
					const portalPath = keypath === "" ? `^${path}` : `${keypath}/^${path.slice(keypath.length + 1)}`;
					const portal: NodeEntry = {
						...entry,
						id: nodeId(owner.base, portalPath),
						keypath: portalPath,
						hoist: false,
					};
					walk.inner?.push({ portal });
					this.#framePortals.push(portal);
				}
				continue;
			}
			out.push(entry);
		}
		return out;
	}

	// ── Children ─────────────────────────────────────────────────────────

	#diffChildren(
		parent: string,
		oldEntries: readonly Entry[],
		newEntries: readonly Entry[],
		tailBefore: string | null,
		walk: Walk,
	): void {
		const oldIndex = new Map<string, number>();
		if (oldEntries.length > 0) {
			const keep = new Set<string>();
			for (const entry of newEntries) keep.add(entry.id);
			for (let i = 0; i < oldEntries.length; i++) {
				const entry = oldEntries[i]!;
				oldIndex.set(entry.id, i);
				if (!keep.has(entry.id)) this.#dels.push(entry);
			}
		}
		const count = newEntries.length;
		const sources = newEntries.map(entry => oldIndex.get(entry.id) ?? -1);
		const stable = stableMask(sources);
		// Children that kept their relative order stay; every other child is
		// placed before the nearest following one that stays. Processing left to
		// right keeps walk order (and so hoisted-overlay order) canonical.
		const anchors: (string | null)[] = [];
		let anchor = tailBefore;
		for (let i = count - 1; i >= 0; i--) {
			anchors[i] = anchor;
			if (stable[i]) anchor = newEntries[i]!.id;
		}
		for (let i = 0; i < count; i++) {
			const entry = newEntries[i]!;
			const source = sources[i]!;
			const before = anchors[i]!;
			const next = i + 1 < count ? newEntries[i + 1]!.id : tailBefore;
			if (source < 0) {
				this.#place(entry, parent, before, next, walk);
				continue;
			}
			if (!stable[i]) {
				const state = entry.comp === undefined ? undefined : this.#states.get(entry.comp);
				if (state) this.#move(state, parent, before);
				else this.#ops.push(["move", entry.id, parent, before]);
			}
			if (entry.comp !== undefined) this.#visitChild(entry.comp, parent, before, next, walk);
			else this.#diffNode(oldEntries[source] as NodeEntry, entry, parent, before, walk);
		}
	}

	/**
	 * Put a child that wasn't under `parent` last frame before `before`.
	 * `next` is its following sibling, recorded for later re-adds.
	 */
	#place(entry: Entry, parent: string, before: string | null, next: string | null, walk: Walk): void {
		if (entry.comp === undefined) {
			this.#ops.push(["add", entry.id, parent, before, this.#materialize(entry, this.#walkFor(entry, walk))]);
			this.#flushMoves();
			return;
		}
		const state = this.#states.get(entry.comp);
		if (state?.frame === this.#frame) {
			this.#warnDuplicate(state);
			return;
		}
		walk.inner?.push({ comp: entry.comp, parent, before: next });
		if (state) {
			this.#move(state, parent, before);
			this.#visit(state, parent, before, walk.settled);
			return;
		}
		this.#addComponent(entry.comp, parent, before, walk.settled);
	}

	/**
	 * Visit a component whose document position is already right. `before` is
	 * an anchor present in the document now (for a root re-add); `next` is its
	 * following sibling, recorded for later frames.
	 */
	#visitChild(comp: Component, parent: string, before: string | null, next: string | null, walk: Walk): void {
		const state = this.#states.get(comp);
		if (state?.frame === this.#frame) {
			this.#warnDuplicate(state);
			return;
		}
		walk.inner?.push({ comp, parent, before: next });
		if (state) this.#visit(state, parent, before, walk.settled);
		else this.#addComponent(comp, parent, before, walk.settled);
	}

	#addComponent(comp: Component, parent: string, before: string | null, settled: boolean): void {
		const state = this.#createState(comp, parent);
		this.#ops.push(["add", state.id, parent, before, this.#materializeComponent(state, settled)]);
		this.#flushMoves();
	}

	#warnDuplicate(state: CompState): void {
		logger.warn("TSP: component described twice in one frame; later occurrence skipped", {
			id: state.id,
			kind: state.comp.constructor.name,
		});
	}

	#walkFor(entry: NodeEntry, walk: Walk): Walk {
		return entry.hoist === walk.hoist ? walk : { ...walk, hoist: entry.hoist };
	}

	// ── Nodes ────────────────────────────────────────────────────────────

	#diffNode(old: NodeEntry, next: NodeEntry, parent: string, before: string | null, walk: Walk): void {
		const inner = this.#walkFor(next, walk);
		if (old.node === next.node) {
			this.#revisitNode(next, inner);
			return;
		}
		const reveal = next.node.reveal;
		if (typeof reveal === "object") {
			const was = old.node.reveal;
			if (reveal.n !== (typeof was === "object" ? was.n : undefined)) this.#reveals.push([next.id, reveal.at]);
		}
		if (old.node.k !== next.node.k) {
			this.#dropSubtree(old);
			this.#ops.push(["del", next.id]);
			this.#ops.push(["add", next.id, parent, before, this.#materialize(next, inner)]);
			this.#flushMoves();
			return;
		}
		const scroll = next.node.scroll;
		if (scroll && scroll.n !== old.node.scroll?.n) {
			// Presses described in one frame coalesce: repeat the latest step once per
			// press (an end once), so key repeat keeps its distance.
			const jump = scroll.by === "start" || scroll.by === "end";
			const presses = jump ? 1 : Math.min(Math.max(scroll.n - (old.node.scroll?.n ?? 0), 1), MAX_SCROLL_REPEAT);
			for (let i = 0; i < presses; i++) this.#scrolls.push([next.id, scroll.by]);
		}
		const oldEntries = this.#entries(old.node.c, old.keypath, old.owner, old.hoist, null);
		const newEntries = this.#entries(next.node.c, next.keypath, next.owner, next.hoist, inner);
		this.#diffProps(
			next.id,
			next.node.k,
			this.#wireProps(old.node, old.owner, oldEntries),
			this.#wireProps(next.node, next.owner, newEntries),
		);
		this.#diffChildren(next.id, oldEntries, newEntries, null, inner);
	}

	/** Walk an unchanged node for the component boundaries and overlays inside it. */
	#revisitNode(entry: NodeEntry, walk: Walk): void {
		const entries = this.#entries(entry.node.c, entry.keypath, entry.owner, entry.hoist, walk);
		for (let i = 0; i < entries.length; i++) {
			const child = entries[i]!;
			const before = i + 1 < entries.length ? entries[i + 1]!.id : null;
			if (child.comp === undefined) this.#revisitNode(child, this.#walkFor(child, walk));
			else this.#visitChild(child.comp, entry.id, before, before, walk);
		}
	}

	#diffProps(
		id: string,
		kind: TspKind,
		oldProps: Readonly<Record<string, unknown>> | undefined,
		newProps: Readonly<Record<string, unknown>> | undefined,
	): void {
		const textKind = TEXT_KINDS.has(kind);
		let set: Record<string, unknown> | undefined;
		if (newProps) {
			for (const key in newProps) {
				const value = newProps[key];
				if (value === undefined || (textKind && key === "text")) continue;
				if (!sameValue(oldProps?.[key], value)) (set ??= {})[key] = value;
			}
			if (kind === "list") this.#noteSelected(set?.selected);
		}
		if (oldProps) {
			for (const key in oldProps) {
				if (oldProps[key] === undefined || newProps?.[key] !== undefined) continue;
				if (textKind && key === "text") continue;
				(set ??= {})[key] = null;
			}
		}
		if (textKind) {
			const oldText = oldProps?.text as string | undefined;
			const newText = newProps?.text as string | undefined;
			if (newText === undefined) {
				if (oldText !== undefined) (set ??= {}).text = null;
			} else if (newText !== oldText) {
				this.#textOp(id, kind, oldText ?? "", newText);
			}
		}
		if (set) this.#ops.push(["set", id, set]);
	}

	#textOp(id: string, kind: TspKind, oldText: string, newText: string): void {
		if (newText.length >= oldText.length && newText.startsWith(oldText)) {
			this.#ops.push(["text", id, "append", newText.slice(oldText.length)]);
			return;
		}
		if ((kind === "editor" || kind === "input") && oldText.length > 0) {
			const limit = Math.min(oldText.length, newText.length);
			let prefix = 0;
			while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
			let suffix = 0;
			while (
				suffix < limit - prefix &&
				oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
			)
				suffix++;
			this.#ops.push([
				"splice",
				id,
				prefix,
				oldText.length - prefix - suffix,
				newText.slice(prefix, newText.length - suffix),
			]);
			return;
		}
		this.#ops.push(["text", id, "replace", newText]);
	}

	/**
	 * Props as sent: item keys, header children and anchor keypaths resolved to
	 * wire ids, and icon glyphs split into `icon` spans.
	 */
	#wireProps(
		node: NativeNode,
		owner: Owner,
		entries: readonly Entry[],
	): Readonly<Record<string, unknown>> | undefined {
		return normalizeIconProps(node.k, this.#resolveRefs(node, owner, entries));
	}

	#resolveRefs(
		node: NativeNode,
		owner: Owner,
		entries: readonly Entry[],
	): Readonly<Record<string, unknown>> | undefined {
		const props = asProps(node);
		switch (node.k) {
			case "list": {
				const selected = props?.selected;
				if (typeof selected !== "string") return props;
				const item = entries.find(entry => entry.comp === undefined && entry.node.key === selected);
				if (!item) return props;
				this.#selectedIds.add(item.id);
				return { ...props, selected: item.id };
			}
			case "card":
			case "section": {
				if (props?.head !== undefined) return props;
				const head = entries.find(entry => entry.comp === undefined && entry.node.key === "head");
				return head ? { ...props, head: head.id } : props;
			}
			case "overlay": {
				const anchor = props?.anchor;
				if (owner.state === null || typeof anchor !== "object" || anchor === null) return props;
				if ("caret" in anchor && typeof anchor.caret === "string")
					return { ...props, anchor: { caret: nodeId(owner.base, anchor.caret) } };
				if ("node" in anchor && typeof anchor.node === "string")
					return { ...props, anchor: { ...anchor, node: nodeId(owner.base, anchor.node) } };
				return props;
			}
			default:
				return props;
		}
	}

	/** A full wire subtree for an entry; nested components get states (or pending moves when mounted elsewhere). */
	#materialize(entry: NodeEntry, walk: Walk): TspNode {
		if (typeof entry.node.reveal === "string") this.#reveals.push([entry.id, entry.node.reveal]);
		const entries = this.#entries(entry.node.c, entry.keypath, entry.owner, entry.hoist, walk);
		const children: TspNode[] = [];
		for (let i = 0; i < entries.length; i++) {
			const child = entries[i]!;
			if (child.comp === undefined) {
				children.push(this.#materialize(child, this.#walkFor(child, walk)));
				continue;
			}
			let state = this.#states.get(child.comp);
			if (state?.frame === this.#frame) {
				this.#warnDuplicate(state);
				continue;
			}
			const before = i + 1 < entries.length ? entries[i + 1]!.id : null;
			walk.inner?.push({ comp: child.comp, parent: entry.id, before });
			if (state) {
				const next = this.#resolve(state);
				if (next.k === (state.node?.k ?? state.kind)) {
					// Mounted elsewhere: update it in place now, then move it in once
					// this subtree lands, keeping its terminal-side state. Its own adds
					// flush their moves; ours wait for the enclosing add.
					// Pending before the visit: a delete during it that would take this
					// component along parks it instead.
					this.#pendingMoves.add(state.id);
					const pending = this.#moves;
					this.#moves = [];
					this.#visit(state, entry.id, before, walk.settled, next);
					this.#moves = pending;
					pending.push({ id: state.id, parent: entry.id, before });
					continue;
				}
				// Its root kind changed too: nothing worth keeping, rebuild it here.
				this.#dropState(state);
				this.#ops.push(["del", state.id]);
			}
			state = this.#createState(child.comp, entry.id);
			children.push(this.#materializeComponent(state, walk.settled));
		}
		return this.#wire(entry.id, entry.node.k, this.#wireProps(entry.node, entry.owner, entries), children);
	}

	#wire(
		id: string,
		k: TspKind,
		props: Readonly<Record<string, unknown>> | undefined,
		children: readonly TspNode[],
	): TspNode {
		if (k === "list") this.#noteSelected(props?.selected);
		const out: { id: string; k: TspKind; p?: Record<string, unknown>; c?: readonly TspNode[] } = { id, k };
		if (props) {
			let p: Record<string, unknown> | undefined;
			for (const key in props) {
				const value = props[key];
				if (value !== undefined && value !== null) (p ??= {})[key] = value;
			}
			if (p) out.p = p;
		}
		if (children.length > 0) out.c = children;
		return out as TspNode;
	}

	/** A list's selection went out (on add or change): scroll it into view at frame end. */
	#noteSelected(selected: unknown): void {
		if (typeof selected === "string" && this.#selectedIds.has(selected)) this.#reveals.push([selected, "nearest"]);
	}

	/** Move components an `add` left out into their new parent, last first so every `before` exists. */
	#flushMoves(): void {
		const moves = this.#moves;
		if (moves.length === 0) return;
		this.#moves = [];
		for (let i = moves.length - 1; i >= 0; i--) {
			const move = moves[i]!;
			const state = this.#byId.get(move.id);
			if (state) this.#move(state, move.parent, move.before);
			else this.#ops.push(["move", move.id, move.parent, move.before]);
			this.#pendingMoves.delete(move.id);
		}
	}

	/** The component whose description holds node `parent` in the document (null: region, root, or `layer` via hoisting). */
	#containerOf(parent: string): CompState | null {
		if (parent.includes("^")) return null;
		const dot = parent.indexOf(".");
		return this.#byId.get(dot === -1 ? parent : parent.slice(0, dot)) ?? null;
	}

	/**
	 * Move a component. When the target currently sits inside the component
	 * itself (a parent and child swapped places this frame), first park the
	 * component on that path under the root; it moves to its own new place
	 * later in the frame.
	 */
	#move(state: CompState, parent: string, before: string | null): void {
		const target = this.#containerOf(parent);
		// The first component on the path that still has to move this frame
		// (not yet visited, or waiting for an enclosing add): parking it breaks
		// the cycle without disturbing anything already in its final place.
		let movable: CompState | null = null;
		for (let at = target, guard = 0; at && guard < 4096; at = at.container, guard++) {
			if (at === state) {
				if (movable) {
					this.#ops.push(["move", movable.id, this.surface, null]);
					movable.container = null;
					movable.parked = true;
					this.#parked.push(movable);
				}
				break;
			}
			if (!movable && (at.frame !== this.#frame || this.#pendingMoves.has(at.id))) movable = at;
		}
		this.#ops.push(["move", state.id, parent, before]);
		state.container = target;
		state.parked = false;
	}

	// ── Components ───────────────────────────────────────────────────────

	#createState(comp: Component, parent: string): CompState {
		const id = nativeComponentId(comp);
		const owner: { base: string; state: CompState | null } = { base: id, state: null };
		const state: CompState = {
			comp,
			id,
			owner,
			node: null,
			weak: null,
			kind: "col",
			propKeys: [],
			childIds: [],
			inner: [],
			rowsLines: null,
			rowsCols: 0,
			rowsNode: null,
			settled: false,
			settleSent: false,
			frame: 0,
			container: this.#containerOf(parent),
			parked: false,
		};
		owner.state = state;
		this.#states.set(comp, state);
		this.#byId.set(id, state);
		return state;
	}

	/** The component's description, or a `rows` node rendered at `cx.cols`. */
	#resolve(state: CompState): NativeNode {
		const comp = state.comp;
		const describe = comp.describe;
		// A Container subclass that paints its own rows but inherits the plain
		// column description would lose its rendering: fall back to rows.
		// (Read lazily: this module and tui.ts import each other.)
		const inherited = describe === Container.prototype.describe && comp.render !== Container.prototype.render;
		if (describe && !inherited) {
			const node = describe.call(comp, this.#cx!);
			if (node) return quietMotion(node);
		}
		this.#rows++;
		const cols = Math.max(1, this.#cx!.cols);
		const lines = comp.render(cols);
		if (state.rowsNode && lines === state.rowsLines && cols === state.rowsCols) return state.rowsNode;
		state.rowsLines = lines;
		state.rowsCols = cols;
		const clean = lines.some(line => line.includes(CURSOR_MARKER))
			? lines.map(line => line.replaceAll(CURSOR_MARKER, ""))
			: lines;
		state.rowsNode = { k: "rows", p: { cols, lines: clean } };
		return state.rowsNode;
	}

	#identity(state: CompState, node: NativeNode): object {
		return node === state.rowsNode && state.rowsLines ? state.rowsLines : node;
	}

	#rootEntry(state: CompState, node: NativeNode): NodeEntry {
		return { id: state.id, node, owner: state.owner, keypath: "", hoist: true };
	}

	#materializeComponent(state: CompState, settledAbove: boolean): TspNode {
		state.frame = this.#frame;
		const node = this.#resolve(state);
		const settled = settledAbove || state.settled || isNativeSettled(state.comp);
		const inner: Inner[] = [];
		const wire = this.#materialize(this.#rootEntry(state, node), { owner: state.owner, inner, settled, hoist: true });
		state.inner = inner;
		state.node = node;
		state.weak = null;
		state.settleSent = false;
		this.#finish(state, node, settled);
		return wire;
	}

	#visit(
		state: CompState,
		parent: string,
		before: string | null,
		settledAbove: boolean,
		next: NativeNode = this.#resolve(state),
	): void {
		state.frame = this.#frame;
		const settled = settledAbove || state.settled || isNativeSettled(state.comp);
		if (state.node !== null) {
			if (next === state.node) this.#revisitComponent(state, settled);
			else {
				const inner: Inner[] = [];
				const walk: Walk = { owner: state.owner, inner, settled, hoist: true };
				this.#diffNode(this.#rootEntry(state, state.node), this.#rootEntry(state, next), parent, before, walk);
				state.inner = inner;
				state.node = next;
			}
		} else if (state.weak?.deref() === this.#identity(state, next)) {
			this.#revisitComponent(state, settled);
		} else {
			this.#replaceSettled(state, next, parent, before, settled);
		}
		this.#finish(state, next, settled);
	}

	/** Replay an unchanged component's walk: visit its boundaries, re-offer its overlays. */
	#revisitComponent(state: CompState, settled: boolean): void {
		const walk: Walk = { owner: state.owner, inner: null, settled, hoist: true };
		for (const item of state.inner) {
			if (item.comp === undefined) this.#framePortals.push(item.portal);
			else this.#visitChild(item.comp, item.parent, item.before, item.before, walk);
		}
	}

	/** A settled component changed: targeted ops by id, no diff against dropped state. */
	#replaceSettled(state: CompState, next: NativeNode, parent: string, before: string | null, settled: boolean): void {
		state.settleSent = false;
		const inner: Inner[] = [];
		const walk: Walk = { owner: state.owner, inner, settled, hoist: true };
		if (next.k !== state.kind) {
			this.#dropNested(state);
			this.#ops.push(["del", state.id]);
			this.#ops.push(["add", state.id, parent, before, this.#materialize(this.#rootEntry(state, next), walk)]);
			this.#flushMoves();
			state.inner = inner;
			return;
		}
		const entries = this.#entries(next.c, "", state.owner, true, walk);
		const props = this.#wireProps(next, state.owner, entries);
		const textKind = TEXT_KINDS.has(next.k);
		let set: Record<string, unknown> | undefined;
		if (props) {
			for (const key in props) {
				const value = props[key];
				if (value === undefined || (textKind && key === "text")) continue;
				(set ??= {})[key] = value;
			}
		}
		for (const key of state.propKeys) {
			if (props?.[key] === undefined) (set ??= {})[key] = null;
		}
		if (set) this.#ops.push(["set", state.id, set]);
		if (next.k === "list") this.#noteSelected(set?.selected);
		if (textKind && typeof props?.text === "string") this.#ops.push(["text", state.id, "replace", props.text]);
		this.#dropNested(state);
		for (const childId of state.childIds) {
			// A child component updated elsewhere this frame, or parked, no longer sits here.
			const child = this.#byId.get(childId);
			if (child?.frame !== this.#frame && !child?.parked) this.#ops.push(["del", childId]);
		}
		this.#diffChildren(state.id, EMPTY_ENTRIES, entries, null, walk);
		state.inner = inner;
	}

	/** Send the settle hint once, then keep only what targeted updates need. */
	#finish(state: CompState, node: NativeNode, settled: boolean): void {
		if (!settled) return;
		state.settled = true;
		if (!state.settleSent) {
			state.settleSent = true;
			this.#settles.push(state.id);
		}
		const entries = this.#entries(node.c, "", state.owner, true, null);
		const props = this.#wireProps(node, state.owner, entries);
		const keys: string[] = [];
		if (props) for (const key in props) if (props[key] !== undefined) keys.push(key);
		state.kind = node.k;
		state.propKeys = keys;
		state.childIds = entries.map(entry => entry.id);
		state.weak = new WeakRef(this.#identity(state, node));
		state.node = null;
	}

	// ── Removal ──────────────────────────────────────────────────────────

	#deleteEntry(entry: Entry): void {
		if (entry.comp !== undefined) {
			const state = this.#states.get(entry.comp);
			if (state?.frame === this.#frame) return;
			if (state) this.#dropState(state);
			this.#ops.push(["del", entry.id]);
			return;
		}
		this.#dropSubtree(entry);
		this.#ops.push(["del", entry.id]);
	}

	/**
	 * Forget the components inside a subtree about to be deleted. Call before
	 * emitting its `del`: a component already updated this frame and waiting to
	 * move into a new subtree is parked under the surface root first, so the
	 * delete doesn't take it along.
	 */
	#dropSubtree(entry: NodeEntry): void {
		for (const child of this.#entries(entry.node.c, entry.keypath, entry.owner, entry.hoist, null)) {
			if (child.comp === undefined) this.#dropSubtree(child);
			else {
				const state = this.#states.get(child.comp);
				if (state) this.#dropOrPark(state);
			}
		}
	}

	#dropNested(state: CompState): void {
		for (const item of state.inner) {
			if (item.comp === undefined) continue;
			const child = this.#states.get(item.comp);
			if (child) this.#dropOrPark(child);
		}
		state.inner = [];
	}

	#dropOrPark(state: CompState): void {
		// Already parked: no longer inside the subtree being deleted.
		if (state.parked) return;
		if (state.frame !== this.#frame) this.#dropState(state);
		else if (this.#pendingMoves.has(state.id)) {
			this.#ops.push(["move", state.id, this.surface, null]);
			state.container = null;
			state.parked = true;
			this.#parked.push(state);
		}
	}

	#dropState(state: CompState): void {
		state.parked = false;
		this.#states.delete(state.comp);
		this.#byId.delete(state.id);
		this.#dropNested(state);
	}
}
