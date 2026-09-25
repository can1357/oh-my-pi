import { Box } from "../components/box";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { type Component, Container } from "../tui";
import { type ThemeColor, theme } from "../theme";

const NO_LINES: readonly string[] = [];

/** Render-time state supplied to a notice presentation. */
export interface MessageNoticeContext {
	readonly expanded: boolean;
}

/** Header and optional detail rows rendered inside a notice box. */
export interface MessageNoticePresentation {
	readonly header: string;
	readonly icon?: string;
	readonly body?: Component | readonly Component[];
}

function isComponentList(value: Component | readonly Component[]): value is readonly Component[] {
	return Array.isArray(value);
}

/** Presentation policy for a transcript notice. */
export interface MessageNoticeOptions {
	readonly presentation: (context: MessageNoticeContext) => MessageNoticePresentation;
	readonly severity?: ThemeColor;
	readonly background?: (text: string) => string;
	readonly leadingSpace?: boolean;
}

/**
 * Shared transcript notice shell with expansion and tool-activity visibility.
 * Domain controllers own their state and call {@link refresh} after mutations.
 */
export class MessageNoticeComponent extends Container {
	readonly #options: MessageNoticeOptions;
	readonly #box: Box;
	#expanded = false;
	#toolActivityVisible = true;

	constructor(options: MessageNoticeOptions) {
		super();
		this.#options = options;
		const severity = options.severity ?? "warning";
		this.#box = new Box(1, 1, options.background ?? (text => theme.inverse(theme.fg(severity, text))));
		this.#box.setIgnoreTight(true);
		if (options.leadingSpace !== false) this.addChild(new Spacer(1));
		this.addChild(this.#box);
		this.refresh();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.refresh();
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	/** Rebuild the presentation after controller-owned state changes. */
	refresh(): void {
		for (const child of this.#box.children) child.dispose?.();
		this.#box.clear();
		const presentation = this.#options.presentation({ expanded: this.#expanded });
		const header = presentation.icon ? `${presentation.icon} ${presentation.header}` : presentation.header;
		this.#box.addChild(new Text(header, 0, 0));
		const body = presentation.body
			? isComponentList(presentation.body)
				? presentation.body
				: [presentation.body]
			: [];
		if (body.length > 0) {
			this.#box.addChild(new Spacer(1));
			for (const child of body) this.#box.addChild(child);
		}
		super.invalidate();
	}

	override invalidate(): void {
		this.refresh();
	}

	override dispose(): void {
		super.dispose();
		for (const child of this.#box.children) child.dispose?.();
		this.#box.clear();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return NO_LINES;
		return super.render(width);
	}
}
