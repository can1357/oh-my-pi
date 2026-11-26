/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Framed extension and hook messages: a card headed by the message's type
 * with its text as Markdown, or whatever the extension's renderer returns.
 *
 * - The renderer is asked again whenever the expansion changes; when it
 *   returns nothing or throws, the card shows (a broken renderer must not
 *   hide its persisted message).
 * - With `collapseAfterLines`, the card is collapsible and clamps the body
 *   while collapsed.
 *
 * Terminal look: `omp.custom*` / `omp.hook` (`src/ui/styles/messages/frame.ts`).
 */
import { computed, type JSXNode, type Reactive, read, untrack } from "@oh-my-pi/pi-tui";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "../../../session/transcript/messages";
import { cardExpansion } from "../expansion";

/** The message a frame shows. */
export interface FramedMessage {
	readonly customType: string;
	readonly content:
		| string
		| readonly ({ readonly type: string; readonly text?: string } | { readonly type: string })[];
}

/** An extension's renderer: nodes for the message, or undefined for the default card. */
export type FrameRenderer = (expanded: boolean) => JSXNode | undefined;

/** How a framed message is presented. */
export interface MessageFrameProps {
	readonly message: FramedMessage;
	readonly role: string;
	/** Symbol key of the glyph before the type in the terminal header (`icon.package`). */
	readonly icon?: string;
	/** A literal glyph before the type (instead of `icon`). */
	readonly glyph?: string;
	/** Hide the type header (the body stays). */
	readonly hideHeader?: Reactive<boolean>;
	/** Theme color of the outline (default `borderMuted`). */
	readonly borderColor?: string;
	/** Clamp the body to this many lines while collapsed (and make the card collapsible). */
	readonly collapseAfterLines?: number;
	readonly renderer?: FrameRenderer;
	readonly expanded: Reactive<boolean>;
	readonly onToggle?: (expanded: boolean) => void;
}

const BORDER_TONE: Readonly<Record<string, TspTone>> = {
	border: "neutral",
	borderAccent: "accent",
	accent: "accent",
	borderMuted: "muted",
	muted: "muted",
	dim: "muted",
	success: "success",
	error: "error",
	warning: "warning",
};

/** The text parts of a message's content, one per line. */
export function messageText(content: FramedMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.flatMap(part => (part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

/** A framed message. */
export function MessageFrame(props: MessageFrameProps): JSXNode {
	const { expanded, toggle } = cardExpansion(props.expanded, props.onToggle);
	const rendered = computed(() => {
		const renderer = props.renderer;
		if (!renderer) return undefined;
		const open = expanded();
		return untrack(() => {
			try {
				return renderer(open) ?? undefined;
			} catch {
				return undefined;
			}
		});
	});
	const text = messageText(props.message.content);
	const collapse = props.collapseAfterLines;
	const tag = props.message.customType;
	return () => {
		const custom = rendered();
		if (custom !== undefined) {
			return untrack(() => (
				<col role={props.role} onToggle={toggle}>
					{custom}
				</col>
			));
		}
		return untrack(() => (
			<card
				role={props.role}
				tone={props.borderColor ? BORDER_TONE[props.borderColor] : undefined}
				head={() => (read(props.hideHeader) ? undefined : [{ t: tag, s: "customMessageLabel strong" }])}
				collapsible={collapse !== undefined}
				collapsed={() => (collapse !== undefined ? !expanded() : undefined)}
				preview={collapse !== undefined ? { lines: collapse } : undefined}
				term={() => ({
					glyph: props.glyph,
					icon: props.icon,
					tag,
					border: props.borderColor ?? "borderMuted",
					collapseAfterLines: collapse,
				})}
				onToggle={toggle}
			>
				<md text={text} />
			</card>
		));
	};
}

/** An extension's custom message (`custom` role; legacy hook messages and live delegations included). */
export function CustomMessageBlock(props: {
	message: FramedMessage & { readonly role?: string };
	expanded: Reactive<boolean>;
	renderer?: FrameRenderer;
	onToggle?: (expanded: boolean) => void;
}): JSXNode {
	const delegation = props.message.customType === LIVE_DELEGATION_MESSAGE_TYPE;
	const hook = props.message.role === "hookMessage";
	return (
		<MessageFrame
			message={props.message}
			role={hook ? "omp.hook" : delegation ? "omp.custom.delegation" : "omp.custom"}
			icon={hook ? "icon.extensionHook" : "icon.package"}
			hideHeader={delegation}
			borderColor={delegation ? "borderAccent" : undefined}
			renderer={props.renderer}
			expanded={props.expanded}
			onToggle={props.onToggle}
		/>
	);
}

/** Lines of a hook message's body shown before the fold while collapsed. */
const HOOK_COLLAPSED_LINES = 5;

/** A hook's message. */
export function HookMessageBlock(props: {
	message: FramedMessage;
	expanded: Reactive<boolean>;
	renderer?: FrameRenderer;
	onToggle?: (expanded: boolean) => void;
}): JSXNode {
	return (
		<MessageFrame
			message={props.message}
			role="omp.hook"
			collapseAfterLines={HOOK_COLLAPSED_LINES}
			renderer={props.renderer}
			expanded={props.expanded}
			onToggle={props.onToggle}
		/>
	);
}
