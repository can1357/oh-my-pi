import { type Component, Container } from "../tui";
import { col } from "../native/describe";
import type { NativeNode } from "../native/node";
export interface ToolActivityComponent {
	setToolActivityVisible(visible: boolean): void;
}

export function isToolActivityComponent(component: Component): component is Component & ToolActivityComponent {
	return typeof (component as Partial<ToolActivityComponent>).setToolActivityVisible === "function";
}

export class ToolActivityContainer extends Container implements ToolActivityComponent {
	#visible = true;
	#native: { children: readonly Component[]; visible: boolean; node: NativeNode } | undefined;
	/** Children that keep rendering while tool activity is hidden (failure rows punch through). */
	#pinned = new Container();

	constructor(component: Component | Component[]) {
		super();
		if (Array.isArray(component)) {
			for (const child of component) this.addChild(child);
		} else {
			this.addChild(component);
		}
	}

	/** Add a child that stays visible when tool activity is hidden. */
	pin(component: Component): void {
		this.addChild(component);
		this.#pinned.addChild(component);
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		this.invalidate();
	}

	/**
	 * Forward Ctrl+O expansion to wrapped children. The transcript's expansion
	 * traversal only visits top-level children, so the wrapper must proxy or
	 * wrapped renderers would freeze at their insertion-time expansion state.
	 */
	setExpanded(expanded: boolean): void {
		for (const child of this.children) {
			const expandable = child as Partial<{ setExpanded(expanded: boolean): void }>;
			if (typeof expandable.setExpanded === "function") expandable.setExpanded(expanded);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#pinned.invalidate();
	}

	override render(width: number): readonly string[] {
		return this.#visible ? super.render(width) : this.#pinned.render(width);
	}

	/**
	 * The wrapped children; hidden tool activity stays mounted so toggling it is one prop change.
	 * Pinned children stay visible while the rest of the activity is hidden.
	 */
	override describe(): NativeNode {
		const cached = this.#native;
		const children = this.children;
		if (
			cached?.visible === this.#visible &&
			cached.children.length === children.length &&
			cached.children.every((child, index) => child === children[index])
		) {
			return cached.node;
		}
		const snapshot = children.slice();
		const pinned = this.#pinned.children;
		const node =
			this.#visible || pinned.length === 0
				? col(snapshot, this.#visible ? { role: "omp.activity" } : { role: "omp.activity", hidden: true })
				: col(
						snapshot.map(child => (pinned.includes(child) ? child : col([child], { hidden: true }))),
						{ role: "omp.activity" },
					);
		this.#native = { children: snapshot, visible: this.#visible, node };
		return node;
	}
}
