/**
 * Small helpers over {@link InteractiveModeContext} shared between
 * {@link UiHelpers} and the input/event controllers, so the live chat surfaces
 * construct components and reset editor state identically.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getMarkdownLinkUrls } from "@oh-my-pi/pi-tui";
import type { AgentSession } from "../../session/agent-session";
import { resolveMarkdownLinkTargets } from "../../tui/hyperlink";
import { AssistantMessageComponent } from "../components/assistant-message";
import type { InteractiveModeContext } from "../types";

const kMarkdownLinkTargets = Symbol("markdownLinkTargets");
const EMPTY_LINK_TARGETS: ReadonlyMap<string, string> = new Map();
type SessionWithMarkdownLinkTargets = AgentSession & {
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
	ctx: InteractiveModeContext,
	messages: readonly AssistantMessage[],
): Promise<ReadonlyMap<string, string>> {
	const session: SessionWithMarkdownLinkTargets = ctx.viewSession;
	const texts = assistantTextBlocks(messages);
	const resolved = await resolveMarkdownLinkTargets(texts, {
		cwd: session.sessionManager.getCwd(),
		sessionFile: session.sessionFile,
		settings: session.settings,
		localProtocolOptions: {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		},
		skills: session.skills,
		rules: session.ttsrManager?.getRules(),
	});
	const previous = session[kMarkdownLinkTargets] ?? EMPTY_LINK_TARGETS;
	const hrefs = new Set<string>();
	for (const text of texts) {
		for (const href of getMarkdownLinkUrls(text)) hrefs.add(href);
	}
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
export function getAssistantMessageLinkTargets(ctx: InteractiveModeContext): ReadonlyMap<string, string> {
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
	ctx: InteractiveModeContext,
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
	);
	component.setImagesVisible(ctx.settings.get("terminal.showImages"));
	component.setToolResultImagesVisible(!ctx.hideToolActivity);
	component.setExpanded(ctx.toolOutputExpanded);
	return component;
}
