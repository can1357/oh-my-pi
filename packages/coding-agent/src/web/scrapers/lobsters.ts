import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { SpecialHandler } from "./types";
import { buildResult, formatIsoDate, loadPage } from "./types";

// =============================================================================
// Lobste.rs Types
// =============================================================================

interface LobstersStory {
	short_id: string;
	title: string;
	url?: string;
	description?: string;
	submitter_user: string;
	score: number;
	comment_count: number;
	created_at: string;
	tags: string[];
}

interface LobstersComment {
	short_id: string;
	comment: string;
	commenting_user: string;
	score: number;
	created_at: string;
	indent_level: number;
	comments?: LobstersComment[];
}

interface LobstersStoryResponse {
	short_id: string;
	title: string;
	url?: string;
	description?: string;
	submitter_user: string;
	score: number;
	comment_count: number;
	created_at: string;
	tags: string[];
	comments: LobstersComment[];
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Render comments recursively
 */
function renderComments(comments: LobstersComment[], maxDepth = 5): string {
	let md = "";
	for (const comment of comments) {
		if (comment.indent_level >= maxDepth) continue;

		const indent = "  ".repeat(comment.indent_level);
		md += `${indent}### ${comment.commenting_user} · ${comment.score} points\n\n`;
		md += `${indent}${comment.comment.split("\n").join(`\n${indent}`)}\n\n`;

		if (comment.comments && comment.comments.length > 0) {
			md += renderComments(comment.comments, maxDepth);
		}

		md += `${indent}---\n\n`;
	}
	return md;
}

/**
 * Handle Lobste.rs URLs via JSON API
 */
export const handleLobsters: SpecialHandler = async (url: string, timeout: number, signal?: AbortSignal) => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("lobste.rs")) return null;

		const fetchedAt = new Date().toISOString();
		let jsonUrl = "";
		let md = "";

		// Story page: lobste.rs/s/{short_id}/{slug}
		const storyMatch = parsed.pathname.match(/^\/s\/([^/]+)/);
		if (storyMatch) {
			jsonUrl = `https://lobste.rs/s/${storyMatch[1]}.json`;
			const result = await loadPage(jsonUrl, { timeout, signal });
			if (!result.ok) return null;

			const story = tryParseJson<LobstersStoryResponse>(result.content);
			if (!story) return null;

			md = `# ${story.title}\n\n`;
			md += `**${story.submitter_user}** · ${story.score} points · ${story.comment_count} comments`;
			if (story.tags.length > 0) {
				md += ` · [${story.tags.join(", ")}]`;
			}
			md += `\n`;
			md += `*${formatIsoDate(story.created_at)}*\n\n`;

			if (story.description) {
				md += `---\n\n${story.description}\n\n`;
			} else if (story.url) {
				md += `**Link:** ${story.url}\n\n`;
			}

			// Add comments
			if (story.comments && story.comments.length > 0) {
				md += `---\n\n## Comments\n\n`;
				md += renderComments(story.comments);
			}

			return buildResult(md, {
				url,
				finalUrl: jsonUrl,
				method: "lobsters",
				fetchedAt,
				notes: ["Fetched via Lobste.rs JSON API"],
			});
		}

		// Front page, newest, or tag page
		if (parsed.pathname === "/" || parsed.pathname === "/newest" || parsed.pathname.startsWith("/t/")) {
			if (parsed.pathname === "/") {
				jsonUrl = "https://lobste.rs/hottest.json";
			} else if (parsed.pathname === "/newest") {
				jsonUrl = "https://lobste.rs/newest.json";
			} else {
				const tagMatch = parsed.pathname.match(/^\/t\/([^/]+)/);
				if (tagMatch) {
					jsonUrl = `https://lobste.rs/t/${tagMatch[1]}.json`;
				}
			}

			if (!jsonUrl) return null;

			const result = await loadPage(jsonUrl, { timeout, signal });
			if (!result.ok) return null;

			const stories = tryParseJson<LobstersStory[]>(result.content);
			if (!stories) return null;
			const listingStories = stories.slice(0, 20);

			const title =
				parsed.pathname === "/"
					? "Lobste.rs Front Page"
					: parsed.pathname === "/newest"
						? "Lobste.rs Newest"
						: `Lobste.rs Tag: ${parsed.pathname.split("/")[2]}`;

			md = `# ${title}\n\n`;

			for (const story of listingStories) {
				md += `- **${story.title}** (${story.score} pts, ${story.comment_count} comments)\n`;
				md += `  by ${story.submitter_user}`;
				if (story.tags.length > 0) {
					md += ` · [${story.tags.join(", ")}]`;
				}
				md += `\n`;
				if (story.url) {
					md += `  ${story.url}\n`;
				}
				md += `  https://lobste.rs/s/${story.short_id}\n\n`;
			}

			return buildResult(md, {
				url,
				finalUrl: jsonUrl,
				method: "lobsters",
				fetchedAt,
				notes: ["Fetched via Lobste.rs JSON API"],
			});
		}
	} catch {}

	return null;
};
