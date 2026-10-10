/** Shared assistant transcript construction and model-authored link caching. */
import type { AssistantMessage, Model, TextContent } from "@oh-my-pi/pi-ai";
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
	readonly expandThinkingBlocks: boolean;
	readonly assistantImagesVisible: boolean;
	/** Whether the viewed session's tables get charts: the main session's do, a focused subagent's do not. */
	readonly tableChartsVisible: boolean;
	readonly hideToolActivity: boolean;
	readonly toolOutputExpanded: boolean;
	readonly ui: { requestRender(): void; readonly imageBudget: ImageBudget };
	/** Resolve already-extracted Markdown link destinations to local targets. */
	resolveAssistantMessageLinkHrefs(hrefs: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

const kMarkdownLinkTargets = Symbol("markdownLinkTargets");
type SessionWithMarkdownLinkTargets = AssistantMessageSession & {
	[kMarkdownLinkTargets]?: ReadonlyMap<string, string>;
};

/** Link destinations per text block, revalidated against the block's text (streaming blocks grow in place). */
const textBlockHrefs = new WeakMap<TextContent, { text: string; hrefs: readonly string[] }>();

/**
 * Distinct Markdown link destinations authored in `message`'s text blocks.
 * Each block is lexed once per text revision; transcript rebuilds and the
 * message_end refresh reuse the result.
 */
function assistantMessageLinkHrefs(message: AssistantMessage): string[] {
	const hrefs = new Set<string>();
	for (const content of message.content) {
		if (content.type !== "text") continue;
		let memo = textBlockHrefs.get(content);
		if (memo?.text !== content.text) {
			memo = { text: content.text, hrefs: getMarkdownLinkUrls(content.text) };
			textBlockHrefs.set(content, memo);
		}
		for (const href of memo.hrefs) hrefs.add(href);
	}
	return [...hrefs];
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
	const hrefs = new Set<string>();
	for (const message of messages) {
		for (const href of assistantMessageLinkHrefs(message)) hrefs.add(href);
	}
	if (hrefs.size === 0) return previous;
	const resolved = await ctx.resolveAssistantMessageLinkHrefs([...hrefs]);
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

/**
 * Forget every resolved destination of the current session. They were resolved against a place the view no longer
 * reads from (another host, session, or location), and a link that appears before the next refresh must not open them.
 */
export function clearAssistantMessageLinkTargets(ctx: Pick<AssistantMessageHost, "viewSession">): void {
	const session: SessionWithMarkdownLinkTargets = ctx.viewSession;
	delete session[kMarkdownLinkTargets];
}

/** Limit a session snapshot to destinations authored by one rendered segment. */
export function assistantMessageLinkTargets(
	message: AssistantMessage,
	targets: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
	const selected = new Map<string, string>();
	for (const href of assistantMessageLinkHrefs(message)) {
		const target = targets.get(href);
		if (target) selected.set(href, target);
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
		ctx.expandThinkingBlocks,
	);
	component.setImagesVisible(ctx.assistantImagesVisible);
	component.setTableChartsVisible(ctx.tableChartsVisible);
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
