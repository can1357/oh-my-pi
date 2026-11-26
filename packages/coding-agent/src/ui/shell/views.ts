/**
 * Owned views: UI built on demand by controllers, outside any component.
 *
 * Every view runs in its own reactive root, so its effects, timers and nodes
 * live until the view is replaced or removed, never longer. {@link Slot}
 * holds at most one view (a dock row, a banner); {@link ViewList} holds an
 * ordered run of them (the transcript, the overlay stack).
 */
import { type Accessor, createRoot, type JSXNode, signal, type UiNode, untrack } from "@oh-my-pi/pi-tui";

/** Builds a view; runs once, inside the view's own root. */
export type ViewFactory = () => JSXNode;

/** A mounted view. */
export interface MountedView {
	readonly node: JSXNode;
	dispose(): void;
}

/** Run `factory` in a fresh root, outside any reactive tracking. */
export function mountView(factory: ViewFactory): MountedView {
	return untrack(() => createRoot(dispose => ({ node: factory(), dispose })));
}

/** A position that shows at most one view. */
export class Slot {
	readonly #current = signal<MountedView | undefined>(undefined);

	/** What the region draws here. */
	readonly view: Accessor<JSXNode> = () => this.#current()?.node;

	/** Whether a view is mounted (reactive). */
	readonly occupied: Accessor<boolean> = () => this.#current() !== undefined;

	/** Replace the view (disposing the old one); `undefined` empties the slot. */
	set(factory: ViewFactory | undefined): void {
		const previous = this.#current.peek();
		this.#current.set(factory ? mountView(factory) : undefined);
		previous?.dispose();
	}

	clear(): void {
		this.set(undefined);
	}
}

/** One entry of a {@link ViewList}: a single node and the root that owns it. */
export interface ViewEntry {
	readonly node: UiNode;
	readonly dispose: () => void;
}

/** Mount `factory`, which must build exactly one node (a block, an overlay). */
export function mountNode(factory: () => JSXNode, what: string): ViewEntry {
	const view = mountView(factory);
	const node = view.node;
	if (!isUiNode(node)) {
		view.dispose();
		throw new TypeError(`${what} must build exactly one node`);
	}
	return { node, dispose: view.dispose };
}

function isUiNode(value: JSXNode): value is UiNode {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value;
}

/** An ordered run of owned single-node views. */
export class ViewList<T extends ViewEntry = ViewEntry> {
	readonly #entries = signal<readonly T[]>([]);

	/** Entries in order (reactive). */
	readonly entries: Accessor<readonly T[]> = () => this.#entries();

	/** Their nodes, as a region draws them (reactive). */
	readonly nodes: Accessor<readonly UiNode[]> = () => this.#entries().map(entry => entry.node);

	get length(): number {
		return this.#entries.peek().length;
	}

	/** Snapshot without subscribing. */
	peek(): readonly T[] {
		return this.#entries.peek();
	}

	push(...entries: T[]): void {
		if (entries.length > 0) this.#entries.set([...this.#entries.peek(), ...entries]);
	}

	/** Insert before `anchor`, or at the end when it is gone. */
	insertBefore(anchor: T, entry: T): void {
		const list = this.#entries.peek();
		const index = list.indexOf(anchor);
		this.#entries.set(index < 0 ? [...list, entry] : [...list.slice(0, index), entry, ...list.slice(index)]);
	}

	/** Move listed `entry` to the end, keeping it mounted. */
	move(entry: T): void {
		const list = this.#entries.peek();
		const index = list.indexOf(entry);
		if (index < 0) return;
		this.#entries.set([...list.toSpliced(index, 1), entry]);
	}

	/** Remove and dispose `entry`; false when it is not listed. */
	remove(entry: T): boolean {
		const list = this.#entries.peek();
		const index = list.indexOf(entry);
		if (index < 0) return false;
		this.#entries.set(list.toSpliced(index, 1));
		entry.dispose();
		return true;
	}

	/** Remove and dispose every entry `keep` rejects, in one write. */
	retain(keep: (entry: T) => boolean): void {
		const kept: T[] = [];
		const removed: T[] = [];
		for (const entry of this.#entries.peek()) (keep(entry) ? kept : removed).push(entry);
		if (removed.length === 0) return;
		this.#entries.set(kept);
		for (const entry of removed) entry.dispose();
	}

	/** Remove and dispose every entry from `index` on; returns what was removed. */
	truncate(index: number): readonly T[] {
		const list = this.#entries.peek();
		if (index >= list.length) return [];
		const removed = list.slice(index);
		this.#entries.set(list.slice(0, index));
		for (const entry of removed) entry.dispose();
		return removed;
	}

	clear(): void {
		this.truncate(0);
	}

	/** Empty the list without disposing anything; returns the entries, now the caller's. */
	take(): readonly T[] {
		const list = this.#entries.peek();
		this.#entries.set([]);
		return list;
	}
}
