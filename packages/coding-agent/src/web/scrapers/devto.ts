import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, formatNumber, htmlToBasicMarkdown, loadPage } from "./types";

interface DevToArticle {
	title: string;
	description?: string;
	published_at: string;
	published_timestamp?: string;
	tags: string[];
	tag_list?: string[];
	reading_time_minutes?: number;
	public_reactions_count?: number;
	positive_reactions_count?: number;
	comments_count?: number;
	user?: {
		name: string;
		username: string;
	};
	body_markdown?: string;
	body_html?: string;
}

/**
 * Handle dev.to URLs via API
 */
export const handleDevTo: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "dev.to") return null;

		const fetchedAt = new Date().toISOString();
		const notes: string[] = [];

		// Parse URL patterns
		const pathParts = parsed.pathname.split("/").filter(Boolean);

		// Tag page: /t/{tag}
		if (pathParts[0] === "t" && pathParts.length >= 2) {
			const tag = pathParts[1];
			const apiUrl = `https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&per_page=20`;

			const result = await loadPage(apiUrl, { timeout, signal });
			if (!result.ok) return null;

			const articles = JSON.parse(result.content) as DevToArticle[];
			if (!articles?.length) return null;

			let md = `# dev.to/t/${tag}\n\n`;
			md += `## Recent Articles (${articles.length})\n\n`;

			for (const article of articles) {
				const tags = article.tag_list || article.tags || [];
				const reactions = article.positive_reactions_count ?? article.public_reactions_count ?? 0;
				const readTime = article.reading_time_minutes ? ` · ${article.reading_time_minutes} min read` : "";
				const reactStr = reactions > 0 ? ` · ${formatNumber(reactions)} reactions` : "";

				md += `### ${article.title}\n\n`;
				md += `by **${article.user?.name || "Unknown"}** (@${article.user?.username || "unknown"})`;
				md += `${readTime}${reactStr}\n`;
				md += `*${formatIsoDate(article.published_at || article.published_timestamp || "")}*\n`;
				if (tags.length > 0) md += `Tags: ${tags.map(t => `#${t}`).join(", ")}\n`;
				if (article.description) md += `\n${article.description}\n`;
				md += `\n---\n\n`;
			}

			notes.push("Fetched via dev.to API");
			return buildResult(md, { url, method: "devto", fetchedAt, notes });
		}

		// User profile: /{username} (only if single path segment)
		if (pathParts.length === 1) {
			const username = pathParts[0];
			const apiUrl = `https://dev.to/api/articles?username=${encodeURIComponent(username)}&per_page=20`;

			const result = await loadPage(apiUrl, { timeout, signal });
			if (!result.ok) return null;

			const articles = JSON.parse(result.content) as DevToArticle[];
			if (!articles?.length) return null;

			let md = `# dev.to/${username}\n\n`;
			md += `## Recent Articles (${articles.length})\n\n`;

			for (const article of articles) {
				const tags = article.tag_list || article.tags || [];
				const reactions = article.positive_reactions_count ?? article.public_reactions_count ?? 0;
				const readTime = article.reading_time_minutes ? ` · ${article.reading_time_minutes} min read` : "";
				const reactStr = reactions > 0 ? ` · ${formatNumber(reactions)} reactions` : "";

				md += `### ${article.title}\n\n`;
				md += `${readTime.substring(3)}${reactStr}\n`;
				md += `*${formatIsoDate(article.published_at || article.published_timestamp || "")}*\n`;
				if (tags.length > 0) md += `Tags: ${tags.map(t => `#${t}`).join(", ")}\n`;
				if (article.description) md += `\n${article.description}\n`;
				md += `\n---\n\n`;
			}

			notes.push("Fetched via dev.to API");
			return buildResult(md, { url, method: "devto", fetchedAt, notes });
		}

		// Article: /{username}/{slug}
		if (pathParts.length >= 2) {
			const username = pathParts[0];
			const slug = pathParts[1];
			const apiUrl = `https://dev.to/api/articles/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`;

			const result = await loadPage(apiUrl, { timeout, signal });
			if (!result.ok) return null;

			const article = JSON.parse(result.content) as DevToArticle;
			if (!article?.title) return null;

			const tags = article.tag_list || article.tags || [];
			const reactions = article.positive_reactions_count ?? article.public_reactions_count ?? 0;
			const comments = article.comments_count ?? 0;
			const readTime = article.reading_time_minutes ?? 0;

			let md = `# ${article.title}\n\n`;
			md += `**Author:** ${article.user?.name || "Unknown"} (@${article.user?.username || username})\n`;
			md += `**Published:** ${formatIsoDate(article.published_at || article.published_timestamp || "")}\n`;
			if (readTime > 0) md += `**Reading time:** ${readTime} min\n`;
			if (reactions > 0) md += `**Reactions:** ${formatNumber(reactions)}\n`;
			if (comments > 0) md += `**Comments:** ${formatNumber(comments)}\n`;
			if (tags.length > 0) md += `**Tags:** ${tags.map(t => `#${t}`).join(", ")}\n`;
			md += `\n---\n\n`;

			// Prefer body_markdown over body_html
			if (article.body_markdown) {
				md += article.body_markdown;
			} else if (article.body_html) {
				md += await htmlToBasicMarkdown(article.body_html);
			}

			notes.push("Fetched via dev.to API");
			return buildResult(md, { url, method: "devto", fetchedAt, notes });
		}

		return null;
	} catch {
		return null;
	}
};
