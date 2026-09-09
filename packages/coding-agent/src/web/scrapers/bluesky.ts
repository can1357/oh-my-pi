import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

const API_BASE = "https://public.api.bsky.app/xrpc";

interface BlueskyProfile {
	did: string;
	handle: string;
	displayName?: string;
	description?: string;
	avatar?: string;
	followersCount?: number;
	followsCount?: number;
	postsCount?: number;
	createdAt?: string;
}

interface BlueskyPost {
	uri: string;
	cid: string;
	author: BlueskyProfile;
	record: {
		text: string;
		createdAt: string;
		embed?: {
			$type: string;
			external?: { uri: string; title?: string; description?: string };
			images?: Array<{ alt?: string; image: unknown }>;
			record?: { uri: string };
		};
		facets?: Array<{
			features: Array<{ $type: string; uri?: string; tag?: string; did?: string }>;
			index: { byteStart: number; byteEnd: number };
		}>;
	};
	likeCount?: number;
	repostCount?: number;
	replyCount?: number;
	quoteCount?: number;
	embed?: {
		$type: string;
		external?: { uri: string; title?: string; description?: string };
		images?: Array<{ alt?: string; fullsize?: string; thumb?: string }>;
		record?: { uri: string; value?: { text?: string }; author?: BlueskyProfile };
	};
}

interface ThreadViewPost {
	post: BlueskyPost;
	parent?: ThreadViewPost | { $type: string };
	replies?: Array<ThreadViewPost | { $type: string }>;
}

/**
 * Resolve a handle to DID using the profile API
 */
async function resolveHandle(handle: string, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const url = `${API_BASE}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`;
	const result = await loadPage(url, {
		timeout,
		headers: { Accept: "application/json" },
		signal,
	});

	if (!result.ok) return null;

	const data = tryParseJson<BlueskyProfile>(result.content);
	if (!data) return null;
	return data.did;
}

/**
 * Format a post as markdown
 */
function formatPost(post: BlueskyPost, isQuote = false): string {
	const author = post.author;
	const name = author.displayName || author.handle;
	const handle = `@${author.handle}`;
	const date = new Date(post.record.createdAt).toLocaleString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

	let md = "";

	if (isQuote) {
		md += `> **${name}** (${handle}) - ${date}\n>\n`;
		md += post.record.text
			.split("\n")
			.map(line => `> ${line}`)
			.join("\n");
		md += "\n";
	} else {
		md += `**${name}** (${handle})\n`;
		md += `*${date}*\n\n`;
		md += `${post.record.text}\n`;
	}

	// Handle embeds
	const embed = post.embed;
	if (embed) {
		if (embed.$type === "app.bsky.embed.external#view" && embed.external) {
			const ext = embed.external;
			md += `\n📎 [${ext.title || ext.uri}](${ext.uri})`;
			if (ext.description) md += `\n*${ext.description}*`;
			md += "\n";
		} else if (embed.$type === "app.bsky.embed.images#view" && embed.images) {
			md += `\n🖼️ ${embed.images.length} image(s)`;
			for (const img of embed.images) {
				if (img.alt) md += `\n- Alt: "${img.alt}"`;
			}
			md += "\n";
		} else if (
			(embed.$type === "app.bsky.embed.record#view" || embed.$type === "app.bsky.embed.recordWithMedia#view") &&
			embed.record
		) {
			const rec = embed.record;
			if (rec.value?.text && rec.author) {
				md += "\n**Quoted post:**\n";
				md += `> **${rec.author.displayName || rec.author.handle}** (@${rec.author.handle})\n`;
				md += rec.value.text
					.split("\n")
					.map(line => `> ${line}`)
					.join("\n");
				md += "\n";
			}
		}
	}

	// Stats
	if (!isQuote) {
		const stats: string[] = [];
		if (post.likeCount) stats.push(`❤️ ${formatNumber(post.likeCount)}`);
		if (post.repostCount) stats.push(`🔁 ${formatNumber(post.repostCount)}`);
		if (post.replyCount) stats.push(`💬 ${formatNumber(post.replyCount)}`);
		if (post.quoteCount) stats.push(`📝 ${formatNumber(post.quoteCount)}`);
		if (stats.length) md += `\n${stats.join(" • ")}\n`;
	}

	return md;
}

/**
 * Handle Bluesky post URLs
 */
export const handleBluesky: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!["bsky.app", "www.bsky.app"].includes(parsed.hostname)) {
			return null;
		}

		const fetchedAt = new Date().toISOString();
		const pathParts = parsed.pathname.split("/").filter(Boolean);

		// /profile/{handle}
		if (pathParts[0] === "profile" && pathParts[1]) {
			const handle = pathParts[1];

			// /profile/{handle}/post/{rkey}
			if (pathParts[2] === "post" && pathParts[3]) {
				const rkey = pathParts[3];

				// First resolve handle to DID
				const did = await resolveHandle(handle, timeout, signal);
				if (!did) return null;

				// Construct AT URI and fetch thread
				const atUri = `at://${did}/app.bsky.feed.post/${rkey}`;
				const threadUrl = `${API_BASE}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=6&parentHeight=3`;

				const result = await loadPage(threadUrl, {
					timeout,
					headers: { Accept: "application/json" },
					signal,
				});

				if (!result.ok) return null;

				const data = JSON.parse(result.content) as { thread: ThreadViewPost };
				const thread = data.thread;

				if (!thread.post) return null;

				let md = `# Bluesky Post\n\n`;

				// Show parent context if exists
				if (thread.parent && "post" in thread.parent) {
					md += "**Replying to:**\n";
					md += formatPost(thread.parent.post, true);
					md += "\n---\n\n";
				}

				// Main post
				md += formatPost(thread.post);

				// Show replies
				if (thread.replies?.length) {
					md += "\n---\n\n## Replies\n\n";
					let replyCount = 0;
					for (const reply of thread.replies) {
						if (replyCount >= 10) break;
						if ("post" in reply) {
							md += formatPost(reply.post);
							md += "\n---\n\n";
							replyCount++;
						}
					}
				}

				return buildResult(md, { url, method: "bluesky-api", fetchedAt, notes: [`AT URI: ${atUri}`] });
			}

			// Profile only
			const profileUrl = `${API_BASE}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`;
			const result = await loadPage(profileUrl, {
				timeout,
				headers: { Accept: "application/json" },
				signal,
			});

			if (!result.ok) return null;

			const profile = JSON.parse(result.content) as BlueskyProfile;

			let md = `# ${profile.displayName || profile.handle}\n\n`;
			md += `**@${profile.handle}**\n\n`;

			if (profile.description) {
				md += `${profile.description}\n\n`;
			}

			md += "---\n\n";
			md += `- **Followers:** ${formatNumber(profile.followersCount || 0)}\n`;
			md += `- **Following:** ${formatNumber(profile.followsCount || 0)}\n`;
			md += `- **Posts:** ${formatNumber(profile.postsCount || 0)}\n`;

			if (profile.createdAt) {
				const joined = new Date(profile.createdAt).toLocaleDateString("en-US", {
					year: "numeric",
					month: "long",
					day: "numeric",
				});
				md += `- **Joined:** ${joined}\n`;
			}

			md += `\n**DID:** \`${profile.did}\`\n`;

			return buildResult(md, { url, method: "bluesky-api", fetchedAt, notes: ["Fetched via AT Protocol API"] });
		}
	} catch {}

	return null;
};
