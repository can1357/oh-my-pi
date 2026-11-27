/**
 * Model-authored prose links in assistant replies: the destinations each reply's
 * text blocks link to, resolved to local targets once per session and cached so
 * synchronous transcript rebuilds reuse them.
 */
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { lexMarkdown } from "@oh-my-pi/pi-tui/text/markdown/lexer";
import { Marked } from "@oh-my-pi/pi-utils/marked";

/** What resolving and caching links needs from the interactive host. */
export interface LinkTargetHost {
	/** The session the transcript shows; the cache lives on it. */
	readonly viewSession: object;
	/** Resolve already-extracted Markdown link destinations to local targets. */
	resolveAssistantMessageLinkHrefs(hrefs: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

const EMPTY_LINK_TARGETS: ReadonlyMap<string, string> = new Map();
const walker = new Marked();
/** The viewed session's resolved targets. */
const kLinkTargets = Symbol("linkTargets");
/** A text block's link destinations, revalidated against its text (streaming blocks grow in place). */
const kHrefs = Symbol("linkHrefs");

type SessionWithTargets = { [kLinkTargets]?: ReadonlyMap<string, string> };
type TextWithHrefs = TextContent & { [kHrefs]?: { text: string; hrefs: readonly string[] } };

/** Distinct hyperlink destinations of a Markdown document (images and code excluded). */
function markdownLinkUrls(text: string): string[] {
	const urls = new Set<string>();
	walker.walkTokens(lexMarkdown(text), token => {
		if (token.type === "link" && typeof token.href === "string") urls.add(token.href);
	});
	return [...urls];
}

/** Distinct Markdown link destinations authored in `message`'s text blocks (each block lexed once per revision). */
function assistantMessageLinkHrefs(message: AssistantMessage): string[] {
	const hrefs = new Set<string>();
	for (const content of message.content) {
		if (content.type !== "text") continue;
		const block: TextWithHrefs = content;
		let memo = block[kHrefs];
		if (memo?.text !== block.text) {
			memo = { text: block.text, hrefs: markdownLinkUrls(block.text) };
			block[kHrefs] = memo;
		}
		for (const href of memo.hrefs) hrefs.add(href);
	}
	return [...hrefs];
}

/**
 * Resolve and cache the viewed session's model-authored prose links in `messages`. Entries for
 * other links stay available to synchronous rebuilds; links in this batch are replaced at once so
 * a missing resource cannot keep a stale destination.
 */
export async function refreshAssistantMessageLinkTargets(
	host: LinkTargetHost,
	messages: readonly AssistantMessage[],
): Promise<ReadonlyMap<string, string>> {
	const session = host.viewSession as SessionWithTargets;
	const previous = session[kLinkTargets] ?? EMPTY_LINK_TARGETS;
	const hrefs = new Set<string>();
	for (const message of messages) {
		for (const href of assistantMessageLinkHrefs(message)) hrefs.add(href);
	}
	if (hrefs.size === 0) return previous;
	const resolved = await host.resolveAssistantMessageLinkHrefs([...hrefs]);
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
	session[kLinkTargets] = next;
	return next;
}

/** The viewed session's resolved destinations so far (for synchronous construction). */
export function getAssistantMessageLinkTargets(host: Pick<LinkTargetHost, "viewSession">): ReadonlyMap<string, string> {
	return (host.viewSession as SessionWithTargets)[kLinkTargets] ?? EMPTY_LINK_TARGETS;
}

/** `targets` limited to the destinations `message` links to. */
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
