import { type Component, Container } from "@oh-my-pi/pi-tui";

export interface ToolActivityComponent {
	setToolActivityVisible(visible: boolean): void;
}

export function isToolActivityComponent(component: Component): component is Component & ToolActivityComponent {
	return typeof (component as Partial<ToolActivityComponent>).setToolActivityVisible === "function";
}

/** Component that renders a tool call's output and can fold it into its call summary. */
export interface ToolOutputDetailsComponent {
	setToolOutputDetailsHidden(hidden: boolean): void;
}

export function supportsToolOutputDetails(component: Component): component is Component & ToolOutputDetailsComponent {
	return typeof (component as Partial<ToolOutputDetailsComponent>).setToolOutputDetailsHidden === "function";
}

export class ToolActivityContainer extends Container implements ToolActivityComponent, ToolOutputDetailsComponent {
	#visible = true;

	constructor(component: Component | Component[]) {
		super();
		if (Array.isArray(component)) {
			for (const child of component) this.addChild(child);
		} else {
			this.addChild(component);
		}
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		this.invalidate();
	}

	/** Proxy for the same reason as {@link setExpanded}: wrappers hide transcript children from traversal. */
	setToolOutputDetailsHidden(hidden: boolean): void {
		for (const child of this.children) {
			if (supportsToolOutputDetails(child)) child.setToolOutputDetailsHidden(hidden);
		}
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

	override render(width: number): readonly string[] {
		if (!this.#visible) return [];
		return super.render(width);
	}
}
