import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { SpecialHandler } from "./types";
import { buildResult, decodeHtmlEntities, formatIsoDate, loadPage } from "./types";

interface HNItem {
	id: number;
	deleted?: boolean;
	type?: "job" | "story" | "comment" | "poll" | "pollopt";
	by?: string;
	time?: number;
	text?: string;
	dead?: boolean;
	parent?: number;
	poll?: number;
	kids?: number[];
	url?: string;
	score?: number;
	title?: string;
	parts?: number[];
	descendants?: number;
}

const API_BASE = "https://hacker-news.firebaseio.com/v0";

async function fetchItem(id: number, timeout: number, signal?: AbortSignal): Promise<HNItem | null> {
	const url = `${API_BASE}/item/${id}.json`;
	const { content, ok } = await loadPage(url, { timeout, signal });
	if (!ok) return null;
	return tryParseJson<HNItem>(content);
}

async function fetchItems(ids: number[], timeout: number, limit = 20, signal?: AbortSignal): Promise<HNItem[]> {
	const promises = ids.slice(0, limit).map(id => fetchItem(id, timeout, signal));
	const results = await Promise.all(promises);
	return results.filter((item): item is HNItem => item !== null && !item.deleted && !item.dead);
}

function decodeHNText(html: string): string {
	return decodeHtmlEntities(
		html
			.replace(/<p>/g, "\n\n")
			.replace(/<\/p>/g, "")
			.replace(/<pre><code>/g, "\n```\n")
			.replace(/<\/code><\/pre>/g, "\n```\n")
			.replace(/<code>/g, "`")
			.replace(/<\/code>/g, "`")
			.replace(/<i>/g, "*")
			.replace(/<\/i>/g, "*")
			.replace(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g, "[$2]($1)")
			.replace(/<[^>]+>/g, ""),
	).trim();
}

function formatTimestamp(unixTime: number): string {
	const date = new Date(unixTime * 1000);
	const now = Date.now();
	const diff = now - date.getTime();
	const hours = Math.floor(diff / (1000 * 60 * 60));
	const days = Math.floor(hours / 24);

	if (days > 7) return formatIsoDate(unixTime * 1000);
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	const minutes = Math.floor(diff / (1000 * 60));
	return `${minutes}m ago`;
}

async function renderStory(item: HNItem, timeout: number, depth = 0, signal?: AbortSignal): Promise<string> {
	let output = "";

	if (depth === 0) {
		output += `# ${item.title}\n\n`;
		if (item.url) {
			output += `**URL:** ${item.url}\n\n`;
		}
		output += `**Posted by:** ${item.by} | **Score:** ${item.score ?? 0} | **Time:** ${formatTimestamp(item.time ?? 0)}`;
		if (item.descendants) {
			output += ` | **Comments:** ${item.descendants}`;
		}
		output += "\n\n";
	}

	if (item.text) {
		output += `${decodeHNText(item.text)}\n\n`;
	}

	if (item.kids && item.kids.length > 0 && depth < 2) {
		const topComments = item.kids.slice(0, depth === 0 ? 20 : 10);
		const comments = await fetchItems(topComments, timeout, topComments.length, signal);

		if (comments.length > 0) {
			if (depth === 0) output += "---\n\n## Comments\n\n";

			for (const comment of comments) {
				const indent = "  ".repeat(depth);
				output += `${indent}**${comment.by}** (${formatTimestamp(comment.time ?? 0)})`;
				if (comment.score !== undefined) output += ` [${comment.score}]`;
				output += "\n";
				if (comment.text) {
					const text = decodeHNText(comment.text);
					const lines = text.split("\n");
					output += `${lines.map(line => `${indent}${line}`).join("\n")}\n\n`;
				}

				if (comment.kids && comment.kids.length > 0 && depth < 1) {
					const childOutput = await renderStory(comment, timeout, depth + 1, signal);
					output += childOutput;
				}
			}
		}
	}

	return output;
}

async function renderListing(ids: number[], timeout: number, title: string, signal?: AbortSignal): Promise<string> {
	let output = `# ${title}\n\n`;
	const stories = await fetchItems(ids, timeout, 20, signal);

	for (let i = 0; i < stories.length; i++) {
		const story = stories[i];
		output += `${i + 1}. **${story.title}**\n`;
		if (story.url) {
			output += `   ${story.url}\n`;
		}
		output += `   ${story.score ?? 0} points by ${story.by} | ${formatTimestamp(story.time ?? 0)}`;
		if (story.descendants) {
			output += ` | ${story.descendants} comments`;
		}
		output += `\n   https://news.ycombinator.com/item?id=${story.id}\n\n`;
	}

	return output;
}

export const handleHackerNews: SpecialHandler = async (url, timeout, signal) => {
	const parsed = new URL(url);
	if (!parsed.hostname.includes("news.ycombinator.com")) return null;

	const notes: string[] = [];
	let content = "";
	const fetchedAt = new Date().toISOString();

	try {
		const itemId = parsed.searchParams.get("id");

		if (itemId) {
			const item = await fetchItem(parseInt(itemId, 10), timeout, signal);
			if (!item) throw new Error(`Failed to fetch item ${itemId}`);

			content = await renderStory(item, timeout, 0, signal);
			notes.push(`Fetched HN item ${itemId} with top-level comments (depth 2)`);
		} else if (parsed.pathname === "/" || parsed.pathname === "/news") {
			const { content: raw, ok } = await loadPage(`${API_BASE}/topstories.json`, { timeout, signal });
			if (!ok) throw new Error("Failed to fetch top stories");
			const ids = tryParseJson<number[]>(raw);
			if (!ids) throw new Error("Failed to parse top stories");
			content = await renderListing(ids, timeout, "Hacker News - Top Stories", signal);
			notes.push("Fetched top 20 stories from HN front page");
		} else if (parsed.pathname === "/newest") {
			const { content: raw, ok } = await loadPage(`${API_BASE}/newstories.json`, { timeout, signal });
			if (!ok) throw new Error("Failed to fetch new stories");
			const ids = tryParseJson<number[]>(raw);
			if (!ids) throw new Error("Failed to parse new stories");
			content = await renderListing(ids, timeout, "Hacker News - New Stories", signal);
			notes.push("Fetched top 20 new stories");
		} else if (parsed.pathname === "/best") {
			const { content: raw, ok } = await loadPage(`${API_BASE}/beststories.json`, { timeout, signal });
			if (!ok) throw new Error("Failed to fetch best stories");
			const ids = tryParseJson<number[]>(raw);
			if (!ids) throw new Error("Failed to parse best stories");
			content = await renderListing(ids, timeout, "Hacker News - Best Stories", signal);
			notes.push("Fetched top 20 best stories");
		} else {
			return null;
		}

		return buildResult(content, { url, method: "hackernews", fetchedAt, notes });
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		notes.push(`Error: ${errorMsg}`);
		return buildResult(`# Error fetching Hacker News content\n\n${errorMsg}`, {
			url,
			method: "hackernews",
			fetchedAt,
			notes,
		});
	}
};
