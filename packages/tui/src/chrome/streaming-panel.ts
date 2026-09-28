import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { type Component, Container } from "../tui";

/** One refresh of a streaming overlay's presentation. */
export interface StreamingPanelPresentation {
	/** Non-empty sections separated by one blank row. */
	readonly sections: readonly (Component | readonly Component[] | undefined)[];
	/** Use a provider when action availability may change without a controller transition. */
	readonly footer: string | (() => string);
}

function isComponentList(value: Component | readonly Component[]): value is readonly Component[] {
	return Array.isArray(value);
}

class StreamingPanelFooter implements Component {
	readonly #line: string | (() => string);
	#renderedLine: string | undefined;
	#text: Text | undefined;

	constructor(line: string | (() => string)) {
		this.#line = line;
	}

	render(width: number): readonly string[] {
		const line = typeof this.#line === "function" ? this.#line() : this.#line;
		if (!this.#text || line !== this.#renderedLine) {
			this.#renderedLine = line;
			this.#text = new Text(line, 0, 0);
		}
		return this.#text.render(width);
	}

	invalidate(): void {
		this.#renderedLine = undefined;
		this.#text = undefined;
	}
}

/**
 * Shared body/footer shell for streaming overlays. The overlay controller keeps
 * its own state machine and calls {@link refresh} after each transition.
 */
export class StreamingPanelContent extends Container {
	readonly #presentation: () => StreamingPanelPresentation;

	constructor(presentation: () => StreamingPanelPresentation) {
		super();
		this.#presentation = presentation;
		this.refresh();
	}

	/** Rebuild sections and the footer from controller-owned state. */
	refresh(): void {
		this.disposeChildren();
		this.addChild(new Spacer(1));
		const presentation = this.#presentation();
		for (const section of presentation.sections) {
			if (!section) continue;
			const children = isComponentList(section) ? section : [section];
			if (children.length === 0) continue;
			for (const child of children) this.addChild(child);
			this.addChild(new Spacer(1));
		}
		this.addChild(new StreamingPanelFooter(presentation.footer));
	}

	override invalidate(): void {
		this.refresh();
	}
}
