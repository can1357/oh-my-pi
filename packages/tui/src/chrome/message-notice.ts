import { Box } from "../components/box";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import type { TspPreview, TspText } from "@oh-my-pi/pi-wire";
import { type Component, Container } from "../tui";
import { type ThemeColor, theme } from "../theme";
import { card, node, text, withHidden } from "../native/describe";
import { type NativeChild, type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { Memo } from "../native/memo";
import { colorTone } from "../native/tone";

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

/** Semantic notice content for native terminals: the card head and body, never pre-styled rows. */
export interface MessageNoticeNativePresentation {
	readonly head: TspText;
	readonly body?: readonly NativeChild[];
	/** Body clamp while collapsed; set to make the notice collapsible. */
	readonly preview?: TspPreview;
	/**
	 * Draw as an inline notice (a named icon and one line, the body a
	 * disclosure below it) instead of a toned card.
	 */
	readonly inline?: { readonly icon: string };
}

function isComponentList(value: Component | readonly Component[]): value is readonly Component[] {
	return Array.isArray(value);
}

/** Presentation policy for a transcript notice. */
export interface MessageNoticeOptions {
	readonly presentation: (context: MessageNoticeContext) => MessageNoticePresentation;
	/** Card content for native terminals; the full content, since collapse is the terminal's. */
	readonly nativePresentation: () => MessageNoticeNativePresentation;
	/** Semantic role of the native card (`omp.notice.<name>`). */
	readonly role: string;
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
	#version = 0;
	readonly #native = new Memo();

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
		this.#version++;
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

	/** A severity-toned card; collapse is local to the terminal and mirrored through {@link handleNativeEvent}. */
	override describe(): NativeNode {
		const key = [this.#version, this.#expanded, this.#toolActivityVisible];
		return this.#native.get(key, () => {
			const presentation = this.#options.nativePresentation();
			if (presentation.inline) {
				const body = presentation.body ?? [];
				const head = node(
					"row",
					{ gap: "sm" },
					[node("icon", { name: presentation.inline.icon }), text(presentation.head, { truncate: "end" })],
					"head",
				);
				const notice = node(
					"section",
					{
						role: this.#options.role,
						tone: colorTone(this.#options.severity ?? "warning"),
						collapsible: body.length > 0,
						collapsed: body.length > 0 ? !this.#expanded : undefined,
					},
					[head, ...body],
				);
				return withHidden(notice, !this.#toolActivityVisible);
			}
			const collapsible = presentation.preview !== undefined;
			const notice = card(
				{
					role: this.#options.role,
					tone: colorTone(this.#options.severity ?? "warning"),
					head: presentation.head,
					collapsible,
					collapsed: collapsible ? !this.#expanded : undefined,
					preview: presentation.preview,
				},
				presentation.body ?? [],
			);
			return withHidden(notice, !this.#toolActivityVisible);
		});
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.setExpanded(expanded);
	}
}
