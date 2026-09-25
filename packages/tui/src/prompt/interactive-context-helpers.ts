/** Shared assistant transcript construction and model-authored link caching. */
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getMarkdownLinkUrls } from "../index";
import { EMPTY_LINK_TARGETS } from "../render/render-utils";
import type { ImageBudget } from "../components/image";
import type { AssistantThinkingRenderer } from "../chat/extension-types";
import { AssistantMessageComponent } from "../chat/assistant-message";
/** Session display capabilities supplied unchanged by the interactive host. */
export interface AssistantMessageSession {
	readonly model?: Model;
	readonly extensionRunner?: { getAssistantThinkingRenderers(): readonly AssistantThinkingRenderer[] };
}

/** Host state required to construct and refresh assistant transcript segments. */
export interface AssistantMessageHost {
	readonly viewSession: AssistantMessageSession;
	readonly effectiveHideThinkingBlock: boolean;
	readonly proseOnlyThinking: boolean;
	readonly linkUrls: boolean;
	readonly assistantImagesVisible: boolean;
	readonly hideToolActivity: boolean;
	readonly toolOutputExpanded: boolean;
	readonly ui: { requestRender(): void; readonly imageBudget: ImageBudget };
	resolveAssistantMessageLinks(texts: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

const kMarkdownLinkTargets = Symbol("markdownLinkTargets");
type SessionWithMarkdownLinkTargets = AssistantMessageSession & {
	[kMarkdownLinkTargets]?: ReadonlyMap<string, string>;
};

function assistantTextBlocks(messages: readonly AssistantMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		for (const content of message.content) {
			if (content.type === "text") texts.push(content.text);
		}
	}
	return texts;
}

/**
 * Resolve and cache the current session's model-authored prose links. Existing
 * entries remain available to synchronous transcript rebuilds; links present in
 * this batch are replaced atomically so missing resources cannot retain a stale
 * destination.
 */
export async function refreshAssistantMessageLinkTargets(
	ctx: AssistantMessageHost,
	messages: readonly AssistantMessage[],
): Promise<ReadonlyMap<string, string>> {
	const session: SessionWithMarkdownLinkTargets = ctx.viewSession;
	const previous = session[kMarkdownLinkTargets] ?? EMPTY_LINK_TARGETS;
	const texts = assistantTextBlocks(messages);
	const hrefs = new Set<string>();
	for (const text of texts) {
		for (const href of getMarkdownLinkUrls(text)) hrefs.add(href);
	}
	if (hrefs.size === 0) return previous;
	const resolved = await ctx.resolveAssistantMessageLinks(texts);
	let changed = false;
	for (const href of hrefs) {
		if (previous.get(href) !== resolved.get(href)) {
			changed = true;
			break;
		}
	}
	if (!changed) return previous;
	const next = new Map(previous);
	for (const href of hrefs) next.delete(href);
	for (const [href, target] of resolved) next.set(href, target);
	session[kMarkdownLinkTargets] = next;
	return next;
}

/** Current resolved destinations for synchronous component construction. */
export function getAssistantMessageLinkTargets(ctx: AssistantMessageHost): ReadonlyMap<string, string> {
	const session: SessionWithMarkdownLinkTargets = ctx.viewSession;
	return session[kMarkdownLinkTargets] ?? EMPTY_LINK_TARGETS;
}

/** Limit a session snapshot to destinations authored by one rendered segment. */
export function assistantMessageLinkTargets(
	message: AssistantMessage,
	targets: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
	const selected = new Map<string, string>();
	for (const content of message.content) {
		if (content.type !== "text") continue;
		for (const href of getMarkdownLinkUrls(content.text)) {
			const target = targets.get(href);
			if (target) selected.set(href, target);
		}
	}
	return selected;
}

/**
 * Construct an {@link AssistantMessageComponent} wired to the live context's
 * thinking/image settings. `message` is omitted for the streaming placeholder
 * component and supplied when rendering a persisted turn.
 */
export function createAssistantMessageComponent(
	ctx: AssistantMessageHost,
	message?: AssistantMessage,
	linkTargets: ReadonlyMap<string, string> = getAssistantMessageLinkTargets(ctx),
): AssistantMessageComponent {
	const component = new AssistantMessageComponent(
		message,
		ctx.effectiveHideThinkingBlock,
		() => ctx.ui.requestRender(),
		ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers(),
		ctx.ui.imageBudget,
		ctx.proseOnlyThinking,
		linkTargets,
		ctx.linkUrls,
	);
	component.setImagesVisible(ctx.assistantImagesVisible);
	component.linkUrls = ctx.linkUrls;
	component.setToolResultImagesVisible(!ctx.hideToolActivity);
	component.setExpanded(ctx.toolOutputExpanded);
	// A wire the `stream-revision` axis marks `possible` can rewrite text it has
	// already streamed; published rows are unrecoverable once they reach native
	// scrollback, so those wires keep finished lines in the live viewport.
	const compat = ctx.viewSession.model?.compat;
	const wireRevisable = compat !== undefined && "streamRevision" in compat && compat.streamRevision === "possible";
	component.setMidStreamPublication(!wireRevisable);
	return component;
}
