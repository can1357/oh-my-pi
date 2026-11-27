/**
 * The overlay stack: pickers, dialogs, sheets and toasts in the layer region.
 *
 * Opening an overlay moves keyboard focus into it (unless it opts out);
 * closing it gives focus back to whatever held it before, if that node is
 * still mounted, else to the shell's default focus (the composer).
 */
import { type Accessor, createRoot, type JSXNode, structuralEffect, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import type { MouseTracking } from "@oh-my-pi/pi-tui/driver/io";
import { mountNode, type ViewEntry, ViewList } from "./views";

/** Options of {@link Overlays.open}. */
export interface OverlayOptions {
	/**
	 * Take keyboard focus: the overlay (default), a node inside it, or none (toasts).
	 * A selector follows replacements of its focused target without taking focus from another view.
	 */
	readonly focus?: boolean | ((root: UiNode) => UiNode);
	/** Mouse reporting while this screen is on top; omitted overlays inherit the underlying setting. */
	readonly mouse?: MouseTracking;
	/** Runs once when the overlay closes, however it closes. */
	readonly onClose?: () => void;
}

/** An open overlay. */
export interface OverlayHandle {
	readonly node: UiNode;
	readonly closed: boolean;
	/** Close it (idempotent). */
	close(): void;
}

/** The focus operations the stack needs from the surface. */
export interface FocusHost {
	readonly focused: Accessor<UiNode | null>;
	focus(node: UiNode | null): void;
	/** Where focus goes when the node that held it is gone. */
	fallback(): UiNode | null;
}

interface OverlayEntry extends ViewEntry {
	readonly mouse: MouseTracking | undefined;
	readonly blocking: boolean;
	readonly handle: OverlayHandle;
}

/** See the module docs. */
export class Overlays {
	readonly #list = new ViewList<OverlayEntry>();
	readonly #focus: FocusHost;

	/** The layer region's nodes, bottom to top (reactive). */
	readonly nodes: Accessor<readonly UiNode[]> = this.#list.nodes;

	/** Mouse reporting requested by the foremost screen with an override (reactive). */
	readonly mouse: Accessor<MouseTracking | undefined> = () =>
		this.#list.entries().findLast(entry => entry.mouse !== undefined)?.mouse;

	/** Whether any overlay is open (reactive). */
	readonly open: Accessor<boolean> = () => this.#list.entries().length > 0;

	/** Whether an overlay owns input and defers app-wide shortcuts (reactive). */
	readonly blocking: Accessor<boolean> = () => this.#list.entries().some(entry => entry.blocking);

	constructor(focus: FocusHost) {
		this.#focus = focus;
	}

	/** Mount an overlay on top; `factory` must build exactly one node. */
	show(factory: () => JSXNode, options?: OverlayOptions): OverlayHandle {
		const view = mountNode(factory, "An overlay");
		const previous = this.#focus.focused();
		let closed = false;
		let stopFocus: (() => void) | undefined;
		const handle: OverlayHandle = {
			node: view.node,
			get closed() {
				return closed;
			},
			close: () => {
				if (closed) return;
				closed = true;
				const holder = this.#focus.focused();
				const held = holder !== null && (holder === view.node || within(holder, view.node));
				stopFocus?.();
				this.#list.remove(entry);
				if (held) this.#focus.focus(previous && !previous.disposed ? previous : this.#focus.fallback());
				options?.onClose?.();
			},
		};
		const entry: OverlayEntry = { ...view, handle, mouse: options?.mouse, blocking: options?.focus !== false };
		this.#list.push(entry);
		const focus = options?.focus ?? true;
		if (focus === true) this.#focus.focus(view.node);
		else if (focus) {
			stopFocus = createRoot(dispose => {
				let target: UiNode | undefined;
				structuralEffect(() => {
					const next = focus(view.node);
					const holder = untrack(this.#focus.focused);
					if (!target || (target.disposed && holder === target)) this.#focus.focus(next);
					target = next;
				});
				return dispose;
			});
		}
		return handle;
	}

	/** The topmost open overlay. */
	top(): OverlayHandle | undefined {
		return this.#list.peek().at(-1)?.handle;
	}

	/** Move open overlay `handle` to the top of the stack, as it is (focus untouched). */
	raise(handle: OverlayHandle): void {
		const entries = this.#list.peek();
		const entry = entries.find(candidate => candidate.handle === handle);
		if (!entry || entries.at(-1) === entry) return;
		this.#list.move(entry);
	}

	/** Close every overlay, topmost first. */
	closeAll(): void {
		for (const entry of this.#list.peek().toReversed()) entry.handle.close();
	}
}

/** Whether `node` is a descendant of `root` (a node inside an overlay's tree). */
export function within(node: UiNode, root: UiNode): boolean {
	const stack = [...root.children()];
	while (stack.length > 0) {
		const next = stack.pop()!;
		if (next === node) return true;
		stack.push(...next.children());
	}
	return false;
}
