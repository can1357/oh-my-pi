import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, htmlToBasicMarkdown, loadPage } from "./types";
import { isNonJsonApiResponse, PlatformProbeCache } from "./utils";

/** Forum bases known (not) to serve the Discourse JSON API; skips doomed API calls elsewhere. */
const discourseBases = new PlatformProbeCache();

interface DiscourseUser {
	username?: string;
	name?: string;
}

interface DiscoursePost {
	id: number;
	username?: string;
	name?: string;
	created_at?: string;
	cooked?: string;
	raw?: string;
	like_count?: number;
	post_number?: number;
}

interface DiscoursePostResponse extends DiscoursePost {
	topic_id?: number;
}

interface DiscourseTopic {
	id?: number;
	title?: string;
	fancy_title?: string;
	posts_count?: number;
	created_at?: string;
	views?: number;
	like_count?: number;
	tags?: string[];
	category_id?: number;
	category_slug?: string;
	category?: { id?: number; name?: string; slug?: string };
	excerpt?: string;
	details?: { created_by?: DiscourseUser };
	post_stream?: { posts?: DiscoursePost[] };
}

const MAX_POSTS = 20;

function normalizeBasePath(basePath: string): string {
	if (!basePath || basePath === "/") return "";
	return basePath.replace(/\/$/, "");
}

function parseTopicPath(pathname: string): { basePath: string; topicId: string; postNumber: string | null } | null {
	const match = pathname.match(/^(.*?)\/t\/([^?#]*)$/);
	if (!match) return null;
	const segments = (match[2] ?? "")
		.replace(/\.json$/, "")
		.split("/")
		.filter(Boolean);
	// Shapes: <slug>/<id>[/<post>], <id>[/<post>]. Slugs are never purely numeric ids followed by nothing else.
	const idIndex =
		/^\d+$/.test(segments[0] ?? "") && (segments.length === 1 || /^\d+$/.test(segments[1] ?? "")) ? 0 : 1;
	const topicId = segments[idIndex];
	if (!topicId || !/^\d+$/.test(topicId)) return null;
	const postNumber = segments[idIndex + 1];
	return { basePath: match[1] ?? "", topicId, postNumber: postNumber && /^\d+$/.test(postNumber) ? postNumber : null };
}

function parsePostPath(pathname: string): { basePath: string; postId: string } | null {
	const match = pathname.match(/^(.*?)(?:\/posts\/)(\d+)(?:\.json)?(?:\/|$)/);
	if (!match) return null;
	return { basePath: match[1] ?? "", postId: match[2] };
}

function formatAuthor(user?: DiscourseUser | null): string {
	if (!user) return "unknown";
	const name = user.name?.trim();
	const username = user.username?.trim();
	if (name && username && name !== username) return `${name} (@${username})`;
	if (username) return `@${username}`;
	if (name) return name;
	return "unknown";
}

function formatCategory(topic: DiscourseTopic): string | null {
	const parts: string[] = [];
	const name = topic.category?.name ?? topic.category_slug;
	if (name) parts.push(name);
	const id = topic.category?.id ?? topic.category_id;
	if (id != null) parts.push(`#${id}`);
	return parts.length ? parts.join(" ") : null;
}

async function formatPostBody(post: DiscoursePost): Promise<string> {
	const raw = post.raw?.trim();
	if (raw) return raw;
	const cooked = post.cooked?.trim();
	if (!cooked) return "";
	return await htmlToBasicMarkdown(cooked);
}

function buildTopicUrl(baseUrl: string, topicId: string): string {
	const topicUrl = new URL(`${baseUrl}/t/${topicId}.json`);
	topicUrl.searchParams.set("include_raw", "1");
	return topicUrl.toString();
}

function buildPostByNumberUrl(baseUrl: string, topicId: string, postNumber: string): string {
	const postUrl = new URL(`${baseUrl}/posts/by_number/${topicId}/${postNumber}.json`);
	postUrl.searchParams.set("include_raw", "1");
	return postUrl.toString();
}

function buildPostUrl(baseUrl: string, postId: string): string {
	const postUrl = new URL(`${baseUrl}/posts/${postId}.json`);
	postUrl.searchParams.set("include_raw", "1");
	return postUrl.toString();
}

/** Requested post first (author, date, text), then the topic title and counters for context. */
async function renderRequestedPost(topic: DiscourseTopic, title: string, post: DiscoursePost): Promise<string> {
	const author = formatAuthor({ name: post.name, username: post.username });
	const content = await formatPostBody(post);
	let md = `# Post ${post.post_number} - ${author} - ${formatIsoDate(post.created_at)}\n\n`;
	md += content ? `${content}\n\n---\n\n` : "_No content available._\n\n---\n\n";
	md += `## Topic: ${title}\n\n`;
	const metaParts: string[] = [];
	if (topic.id != null) metaParts.push(`**Topic ID:** ${topic.id}`);
	if (topic.posts_count != null) metaParts.push(`**Posts:** ${topic.posts_count}`);
	if (metaParts.length) md += `${metaParts.join(" | ")}\n`;
	const categoryLabel = formatCategory(topic);
	if (categoryLabel) md += `**Category:** ${categoryLabel}\n`;
	if (topic.tags?.length) md += `**Tags:** ${topic.tags.join(", ")}\n`;
	return md;
}

/**
 * Handle Discourse forum URLs via API
 */
export const handleDiscourse: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		const topicMatch = parseTopicPath(parsed.pathname);
		const postMatch = topicMatch ? null : parsePostPath(parsed.pathname);
		if (!topicMatch && !postMatch) return null;

		const basePath = normalizeBasePath(topicMatch?.basePath ?? postMatch?.basePath ?? "");
		const baseUrl = `${parsed.origin}${basePath}`;
		if ((await discourseBases.get(baseUrl)) === false) return null;

		let requestedPost: DiscoursePost | null = null;
		let topicId = topicMatch?.topicId ?? null;
		// A trailing post number (/t/<slug>/<topic>/<n>) names one post: fetch it directly, because the
		// topic JSON window starts at post 1 and need not contain it.
		let postFromNumber = false;
		if (topicMatch?.postNumber && topicMatch.postNumber !== "1") {
			const postResult = await loadPage(buildPostByNumberUrl(baseUrl, topicMatch.topicId, topicMatch.postNumber), {
				timeout,
				signal,
			});
			if (postResult.ok) {
				const postData = tryParseJson<DiscoursePostResponse>(postResult.content);
				if (postData && postData.post_number === Number(topicMatch.postNumber)) {
					requestedPost = postData;
					postFromNumber = true;
				}
			}
		}

		if (!topicId && postMatch) {
			const postResult = await loadPage(buildPostUrl(baseUrl, postMatch.postId), { timeout, signal });
			if (!postResult.ok) {
				if (isNonJsonApiResponse(postResult)) discourseBases.record(baseUrl, false);
				return null;
			}

			const postData = tryParseJson<DiscoursePostResponse>(postResult.content);
			if (!postData) {
				discourseBases.record(baseUrl, false);
				return null;
			}

			if (!postData.topic_id) return null;
			topicId = String(postData.topic_id);
			requestedPost = postData;
		}

		if (!topicId) return null;

		const topicResult = await loadPage(buildTopicUrl(baseUrl, topicId), { timeout, signal });
		if (!topicResult.ok) {
			if (isNonJsonApiResponse(topicResult)) discourseBases.record(baseUrl, false);
			return null;
		}

		const topic = tryParseJson<DiscourseTopic>(topicResult.content);
		if (!topic) {
			discourseBases.record(baseUrl, false);
			return null;
		}

		const title = topic.title || topic.fancy_title;
		if (!title) return null;
		// Only negatives gate requests; a positive overwrites a negative a concurrent request recorded.
		discourseBases.record(baseUrl, true);

		const fetchedAt = new Date().toISOString();

		const posts: DiscoursePost[] = [...(topic.post_stream?.posts ?? [])];
		if (postFromNumber && requestedPost) {
			return buildResult(await renderRequestedPost(topic, title, requestedPost), {
				url,
				method: "discourse-api",
				fetchedAt,
				notes: [`Fetched post ${requestedPost.post_number} via Discourse API`],
			});
		}
		if (requestedPost && !posts.some(post => post.id === requestedPost?.id)) {
			posts.unshift(requestedPost);
		}

		let md = `# ${title}\n\n`;

		const metaParts: string[] = [];
		if (topic.id != null) metaParts.push(`**Topic ID:** ${topic.id}`);
		if (topic.posts_count != null) metaParts.push(`**Posts:** ${topic.posts_count}`);
		if (topic.views != null) metaParts.push(`**Views:** ${topic.views}`);
		if (topic.like_count != null) metaParts.push(`**Likes:** ${topic.like_count}`);
		if (metaParts.length) md += `${metaParts.join(" | ")}\n`;

		const categoryLabel = formatCategory(topic);
		if (categoryLabel) md += `**Category:** ${categoryLabel}\n`;
		if (topic.tags?.length) md += `**Tags:** ${topic.tags.join(", ")}\n`;

		const createdBy = formatAuthor(topic.details?.created_by ?? null);
		if (createdBy !== "unknown" || topic.created_at) {
			md += `**Created by:** ${createdBy} - ${formatIsoDate(topic.created_at)}\n`;
		}

		md += "\n";

		const description = topic.excerpt
			? await htmlToBasicMarkdown(topic.excerpt)
			: posts.length
				? await formatPostBody(posts[0])
				: "";
		if (description) {
			md += `## Description\n\n${description}\n\n`;
		}

		if (posts.length) {
			md += "## Posts\n\n";
			for (const post of posts.slice(0, MAX_POSTS)) {
				const author = formatAuthor({ name: post.name, username: post.username });
				const date = formatIsoDate(post.created_at);
				const likes = post.like_count ?? 0;
				const content = await formatPostBody(post);
				const postLabel = post.post_number != null ? `Post ${post.post_number}` : `Post ${post.id}`;

				md += `### ${postLabel} - ${author} - ${date} - Likes: ${likes}\n\n`;
				md += content ? `${content}\n\n---\n\n` : "_No content available._\n\n---\n\n";
			}
		}

		return buildResult(md, { url, method: "discourse-api", fetchedAt, notes: ["Fetched via Discourse API"] });
	} catch {}

	return null;
};
