/**
 * The tab context block every panel prompt starts with, and its inverse for rendering: the agent reads
 * `<chrome-tab target="…" url="…" title="…" viewport="WxH"/>`, the user card shows a tab chip instead.
 */
import type { Size, TabContext } from "../messages";

/** The sentence after each tag; it authorizes the agent to act in a tab it would otherwise only borrow. */
export const TAB_AUTHORIZATION = "This is my tab; navigate, click and type in it as needed.";

/** A `<chrome-tab>` tag as it appears in a prompt. */
export interface TabRef {
	target: string;
	url: string;
	title: string;
	viewport: string;
}

const TAG = /<chrome-tab\b([^>]*?)\/>/g;
const ATTR = /([a-z-]+)="([^"]*)"/g;

function escapeAttr(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replace(/\s+/g, " ");
}

function unescapeAttr(value: string): string {
	return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** The tab's viewport: the worker's measurement, else Chrome's tab size corrected for zoom. */
export async function tabViewport(tab: TabContext): Promise<Size | null> {
	if (tab.viewport !== null) return tab.viewport;
	try {
		const [info, zoom] = await Promise.all([chrome.tabs.get(tab.tabId), chrome.tabs.getZoom(tab.tabId)]);
		if (info.width === undefined || info.height === undefined) return null;
		const factor = zoom > 0 ? zoom : 1;
		return { width: Math.round(info.width / factor), height: Math.round(info.height / factor) };
	} catch {
		return null;
	}
}

/** One context block line pair for `tab`. */
export function tabContextBlock(tab: TabContext, viewport: Size | null): string {
	const attrs = [
		`target="${escapeAttr(tab.targetId ?? "")}"`,
		`url="${escapeAttr(tab.url)}"`,
		`title="${escapeAttr(tab.title)}"`,
	];
	if (viewport !== null) attrs.push(`viewport="${viewport.width}x${viewport.height}"`);
	return `<chrome-tab ${attrs.join(" ")}/>\n${TAB_AUTHORIZATION}`;
}

/** The prompt text the agent receives: one block per attached tab, a blank line, then what the user typed. */
export function composePrompt(blocks: readonly string[], text: string): string {
	return blocks.length === 0 ? text : `${blocks.join("\n")}\n\n${text}`;
}

/** Split a user message into its tab tags and the text the user typed. */
export function parsePrompt(raw: string): { tabs: TabRef[]; text: string } {
	const tabs: TabRef[] = [];
	const stripped = raw.replace(TAG, (_tag, attrs: string) => {
		const ref: TabRef = { target: "", url: "", title: "", viewport: "" };
		for (const match of attrs.matchAll(ATTR)) {
			const value = unescapeAttr(match[2]);
			if (match[1] === "target") ref.target = value;
			else if (match[1] === "url") ref.url = value;
			else if (match[1] === "title") ref.title = value;
			else if (match[1] === "viewport") ref.viewport = value;
		}
		tabs.push(ref);
		return "";
	});
	if (tabs.length === 0) return { tabs, text: raw };
	return { tabs, text: stripped.replaceAll(TAB_AUTHORIZATION, "").trim() };
}

/**
 * Whether the relay can drive a tab showing `url`: web pages, local files and blank tabs. Chrome refuses the debugger
 * on its own pages, the Web Store and other extensions' pages (this panel included), so the panel treats those as no
 * tab at all instead of sending the agent a context block it can't act on.
 */
export function isDrivable(url: string): boolean {
	if (url === "about:blank") return true;
	try {
		const { protocol, hostname } = new URL(url);
		if (hostname === "chromewebstore.google.com" || hostname === "chrome.google.com") return false;
		return protocol === "http:" || protocol === "https:" || protocol === "file:";
	} catch {
		return false;
	}
}

/** The tab the panel may act in: `tab` when the relay can drive it, else none. */
export function drivableTab(tab: TabContext | null): TabContext | null {
	return tab !== null && isDrivable(tab.url) ? tab : null;
}

/** Hostname without `www.`, or the scheme for pages that have none (`chrome://…`, `file://…`). */
export function hostOf(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.hostname === "" ? parsed.protocol.replace(/:$/, "") : parsed.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** Best-effort favicon for a page named in a past prompt (no live tab to ask): the site's `/favicon.ico`. */
export function faviconFor(pageUrl: string): string | undefined {
	try {
		const { origin, protocol } = new URL(pageUrl);
		if (protocol !== "http:" && protocol !== "https:") return undefined;
		return `${origin}/favicon.ico`;
	} catch {
		return undefined;
	}
}
