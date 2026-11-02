import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { type Component, Container } from "../tui";
import { col, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { plainText } from "../native/spans";

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
	#native: { line: string; node: NativeNode } | undefined;

	constructor(line: string | (() => string)) {
		this.#line = line;
	}

	/** The footer line as muted text, re-read each describe because action availability can change. */
	describe(): NativeNode {
		const line = plainText(typeof this.#line === "function" ? this.#line() : this.#line);
		if (this.#native?.line !== line) {
			this.#native = { line, node: text([span(line, "muted")], { wrap: "word", role: "omp.panel.footer" }) };
		}
		return this.#native.node;
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
	#native: NativeNode = col([]);

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
		const sections: NativeChild[] = [];
		for (const section of presentation.sections) {
			if (!section) continue;
			const children = isComponentList(section) ? section : [section];
			if (children.length === 0) continue;
			for (const child of children) this.addChild(child);
			this.addChild(new Spacer(1));
			sections.push(col(children));
		}
		const footer = new StreamingPanelFooter(presentation.footer);
		this.addChild(footer);
		sections.push(footer);
		this.#native = col(sections, { gap: "sm" });
	}

	/** The sections as a spaced stack followed by the footer; spacing is the terminal's. */
	override describe(): NativeNode {
		return this.#native;
	}

	override invalidate(): void {
		this.refresh();
	}
}
