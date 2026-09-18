/**
 * Shared rendering for extension/hook custom message frames.
 *
 * `CustomMessageComponent` and `HookMessageComponent` share one behavior-owning
 * frame: it tries a user-supplied renderer first and falls back to a label plus
 * markdown body when the renderer returns nothing or throws. Hook messages
 * collapse to the first N lines when not expanded; extension messages render
 * in full.
 */

import type { TextContent } from "@oh-my-pi/pi-ai";
import { Box } from "../components/box";
import { Markdown } from "../components/markdown";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { type Component, Container } from "../tui";
import { getMarkdownTheme, type Theme, type ThemeColor, theme } from "../theme/index";
/** Message shape consumed by the shared frame. */
export interface FramedMessage {
	customType: string;
	content: string | (TextContent | { type: string })[];
}

/**
 * Callable signature shared by `MessageRenderer` (extensions) and
 * `HookMessageRenderer` (hooks). Both narrow `message` to their own type;
 * this signature is the structural intersection callers can hand off here.
 */
export type FramedRenderer<M extends FramedMessage> = (
	message: M,
	options: { expanded: boolean },
	theme: Theme,
) => Component | undefined;

/** Presentation and extension-renderer policy for a framed custom message. */
export interface FramedMessageOptions<M extends FramedMessage> {
	readonly message: M;
	/** Theme-aware icon glyph shown before the custom type. */
	readonly icon?: string | (() => string);
	/** Hide the default type header while retaining the message body. */
	readonly hideHeader?: boolean | (() => boolean);
	/** Semantic color for the outline, defaulting to the muted border. */
	readonly borderColor?: ThemeColor;
	/** Collapse the markdown body to this many lines when `expanded` is false. Omit to never collapse. */
	readonly collapseAfterLines?: number;
	readonly customRenderer?: FramedRenderer<M>;
}

/**
 * Behavior-owning custom message frame. It retries extension renderers whenever
 * expansion or theme state changes and falls back to the shared card when a
 * renderer returns nothing or throws.
 */
export class FramedMessageComponent<M extends FramedMessage> extends Container {
	readonly #options: FramedMessageOptions<M>;
	readonly #box: Box;
	#customComponent: Component | undefined;
	#expanded = false;
	#disposed = false;

	constructor(options: FramedMessageOptions<M>) {
		super();
		this.#options = options;
		this.#box = new Box(1, 1, text => theme.bg("customMessageBg", text));
		this.#box.setIgnoreTight(true);
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	override invalidate(): void {
		this.#rebuild();
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		super.dispose();
		for (const child of this.#box.children) child.dispose?.();
		this.#box.clear();
		this.clear();
		this.#customComponent = undefined;
	}

	#rebuild(): void {
		if (this.#disposed) return;
		let nextCustomComponent: Component | undefined;
		const customRenderer = this.#options.customRenderer;
		if (customRenderer) {
			try {
				nextCustomComponent = customRenderer(this.#options.message, { expanded: this.#expanded }, theme);
			} catch {
				// A broken extension renderer must not hide its persisted message.
			}
		}

		const previousCustomComponent = this.#customComponent;
		if (nextCustomComponent) {
			if (nextCustomComponent === previousCustomComponent) {
				super.invalidate();
				return;
			}
			if (previousCustomComponent) {
				this.removeChild(previousCustomComponent);
				previousCustomComponent.dispose?.();
			}
			this.removeChild(this.#box);
			for (const child of this.#box.children) child.dispose?.();
			this.#box.clear();
			this.#customComponent = nextCustomComponent;
			this.addChild(nextCustomComponent);
			return;
		}

		if (previousCustomComponent) {
			this.removeChild(previousCustomComponent);
			previousCustomComponent.dispose?.();
			this.#customComponent = undefined;
		}
		this.removeChild(this.#box);
		for (const child of this.#box.children) child.dispose?.();
		this.#box.clear();
		this.#box.setBorder({
			chars: theme.boxRound,
			color: text => theme.fg(this.#options.borderColor ?? "borderMuted", text),
		});

		const hideHeader =
			typeof this.#options.hideHeader === "function" ? this.#options.hideHeader() : this.#options.hideHeader;
		if (!hideHeader) {
			const icon = typeof this.#options.icon === "function" ? this.#options.icon() : this.#options.icon;
			const tag = icon ? `${icon} ${this.#options.message.customType}` : this.#options.message.customType;
			this.#box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(tag)), 0, 0));
			this.#box.addChild(new Spacer(1));
		}

		let text: string;
		if (typeof this.#options.message.content === "string") {
			text = this.#options.message.content;
		} else {
			text = this.#options.message.content
				.filter((content): content is TextContent => content.type === "text")
				.map(content => content.text)
				.join("\n");
		}

		const collapseAfterLines = this.#options.collapseAfterLines;
		if (!this.#expanded && collapseAfterLines !== undefined) {
			const lines = text.split("\n");
			if (lines.length > collapseAfterLines) text = `${lines.slice(0, collapseAfterLines).join("\n")}\n…`;
		}

		this.#box.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: value => theme.fg("customMessageText", value),
			}),
		);
		this.addChild(this.#box);
	}
}
