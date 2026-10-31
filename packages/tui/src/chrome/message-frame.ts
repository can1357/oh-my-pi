/**
 * Shared rendering for extension/hook custom message frames.
 *
 * `CustomMessageComponent` and `HookMessageComponent` share one behavior-owning
 * frame: it tries a user-supplied renderer first and falls back to a label plus
 * markdown body when the renderer returns nothing or throws. Hook messages
 * collapse to the first N lines when not expanded; extension messages render
 * in full.
 *
 * An extension's renderer carries the scope its session's code runs in
 * (`ToolRendererScope`); the component it returns is mounted through it
 * (`SafeToolRendererComponent`), and once that scope has gone the frame draws
 * its own card and calls nothing the renderer returned.
 */

import type { TextContent } from "@oh-my-pi/pi-ai";
import { Box } from "../components/box";
import { Markdown } from "../components/markdown";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { type Component, Container } from "../tui";
import { getMarkdownTheme, getThemeEpoch, type Theme, type ThemeColor, theme } from "../theme/index";
import { card, col, md, span } from "../native/describe";
import { type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { Memo } from "../native/memo";
import { colorTone } from "../native/tone";
import { SafeToolRendererComponent, type ToolRendererScope, toolRendererScope } from "../tools/renderer-scope";
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
	/** Semantic role of the native card. */
	readonly role: string;
}

/**
 * Behavior-owning custom message frame. It retries extension renderers whenever
 * expansion or theme state changes and falls back to the shared card when a
 * renderer returns nothing or throws.
 */
export class FramedMessageComponent<M extends FramedMessage> extends Container {
	readonly #options: FramedMessageOptions<M>;
	readonly #box: Box;
	/** The mounted custom component: what the renderer returned, through its scope when it has one. */
	#customComponent: Component | undefined;
	/** What the renderer returned for {@link #customComponent}, kept to tell a renderer that hands
	 *  back the component it is already showing. */
	#customRendered: Component | undefined;
	/** The scope an extension's renderer runs in; `undefined` for the host's own renderer. */
	readonly #scope: ToolRendererScope | undefined;
	/** Whether {@link #scope} was live when the frame was last built. */
	#builtLive = true;
	/** The {@link #version} {@link #box} holds the default card for. */
	#boxVersion = -1;
	#expanded = false;
	#disposed = false;
	#version = 0;
	readonly #native = new Memo();

	constructor(options: FramedMessageOptions<M>) {
		super();
		this.#options = options;
		this.#scope = toolRendererScope(options.customRenderer);
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
		this.#customRendered = undefined;
	}

	override render(width: number): readonly string[] {
		this.#redrawIfRetired();
		return super.render(width);
	}

	/**
	 * The extension renderer's component when it supplied one; otherwise a
	 * card with the type tag as its head and the markdown body, clamped by the
	 * terminal while collapsed.
	 */
	override describe(): NativeNode {
		this.#redrawIfRetired();
		const key = [this.#version, this.#expanded, getThemeEpoch()];
		return this.#native.get(key, () => {
			if (this.#customComponent) return col([this.#customComponent], { role: this.#options.role });
			const hideHeader =
				typeof this.#options.hideHeader === "function" ? this.#options.hideHeader() : this.#options.hideHeader;
			// The role icon (Tern's named icon) replaces the nerd glyph.
			const tag = this.#options.message.customType;
			const collapseAfterLines = this.#options.collapseAfterLines;
			return card(
				{
					role: this.#options.role,
					tone: colorTone(this.#options.borderColor),
					head: hideHeader ? undefined : [span(tag, "customMessageLabel strong")],
					collapsible: collapseAfterLines !== undefined,
					collapsed: collapseAfterLines !== undefined ? !this.#expanded : undefined,
					preview: collapseAfterLines !== undefined ? { lines: collapseAfterLines } : undefined,
				},
				[md(this.#messageText())],
			);
		});
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.setExpanded(expanded);
	}

	#messageText(): string {
		const content = this.#options.message.content;
		if (typeof content === "string") return content;
		return content
			.filter((part): part is TextContent => part.type === "text")
			.map(part => part.text)
			.join("\n");
	}

	/** A renderer whose scope has gone since the frame was built is no renderer: rebuild as the
	 *  frame's own card before anything the renderer returned is drawn or called. */
	#redrawIfRetired(): void {
		if (this.#builtLive && this.#scope?.live === false) this.#rebuild();
	}

	#rebuild(): void {
		if (this.#disposed) return;
		this.#version++;
		const scope = this.#scope;
		const live = scope?.live !== false;
		this.#builtLive = live;
		let rendered: Component | undefined;
		const customRenderer = this.#options.customRenderer;
		if (customRenderer && live) {
			try {
				rendered = customRenderer(this.#options.message, { expanded: this.#expanded }, theme);
			} catch {
				// A broken extension renderer must not hide its persisted message.
			}
		}

		const previousCustomComponent = this.#customComponent;
		if (rendered) {
			if (rendered === this.#customRendered) {
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
			this.#boxVersion = -1;
			const mounted =
				scope === undefined
					? rendered
					: new SafeToolRendererComponent(
							this.#options.message.customType,
							"message",
							rendered,
							() => this.#defaultCard(),
							scope,
						);
			this.#customRendered = rendered;
			this.#customComponent = mounted;
			this.addChild(mounted);
			return;
		}

		if (previousCustomComponent) {
			this.removeChild(previousCustomComponent);
			previousCustomComponent.dispose?.();
			this.#customComponent = undefined;
			this.#customRendered = undefined;
		}
		this.removeChild(this.#box);
		this.addChild(this.#defaultCard());
	}

	/** The frame's own card in {@link #box}: the type tag and the markdown body, built once per
	 *  {@link #version}. Mounted when no renderer draws the message, and drawn in place of an
	 *  extension's component that fails to render. */
	#defaultCard(): Box {
		if (this.#boxVersion === this.#version) return this.#box;
		this.#boxVersion = this.#version;
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

		let text = this.#messageText();

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
		return this.#box;
	}
}
