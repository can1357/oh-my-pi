import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, htmlToBasicMarkdown, loadPage } from "./types";

interface MastodonAccount {
	id: string;
	username: string;
	acct: string;
	display_name: string;
	note: string;
	url: string;
	avatar: string;
	header: string;
	followers_count: number;
	following_count: number;
	statuses_count: number;
	created_at: string;
	bot: boolean;
	fields?: Array<{ name: string; value: string }>;
}

interface MastodonMediaAttachment {
	id: string;
	type: "image" | "video" | "gifv" | "audio" | "unknown";
	url: string;
	preview_url?: string;
	description?: string;
}

interface MastodonStatus {
	id: string;
	created_at: string;
	content: string;
	url: string;
	account: MastodonAccount;
	reblogs_count: number;
	favourites_count: number;
	replies_count: number;
	reblog?: MastodonStatus;
	media_attachments: MastodonMediaAttachment[];
	spoiler_text?: string;
	sensitive: boolean;
	visibility: "public" | "unlisted" | "private" | "direct";
	in_reply_to_id?: string;
	poll?: {
		options: Array<{ title: string; votes_count: number }>;
		votes_count: number;
		expired: boolean;
	};
}

/**
 * Check if a domain is a Mastodon instance by probing the API
 */
async function isMastodonInstance(hostname: string, timeout: number, signal?: AbortSignal): Promise<boolean> {
	try {
		const result = await loadPage(`https://${hostname}/api/v1/instance`, {
			timeout: Math.min(timeout, 5),
			headers: { Accept: "application/json" },
			signal,
		});
		if (!result.ok) return false;
		const data = JSON.parse(result.content);
		// Mastodon instances return uri/domain field
		return !!(data.uri || data.domain || data.title);
	} catch {
		return false;
	}
}

/**
 * Format a date string to readable format
 */
function formatDate(isoDate: string): string {
	try {
		const date = new Date(isoDate);
		return date.toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return isoDate;
	}
}

/**
 * Format a status/post as markdown
 */
async function formatStatus(status: MastodonStatus, isReblog = false): Promise<string> {
	// Handle reblogs (boosts)
	if (status.reblog && !isReblog) {
		let md = `🔁 **${status.account.display_name || status.account.username}** boosted:\n\n`;
		md += await formatStatus(status.reblog, true);
		return md;
	}

	const account = status.account;
	let md = "";

	if (!isReblog) {
		md += `# Post by ${account.display_name || account.username}\n\n`;
	}

	md += `**@${account.acct}**`;
	if (account.bot) md += " 🤖";
	md += ` · ${formatDate(status.created_at)}`;
	if (status.visibility !== "public") md += ` · ${status.visibility}`;
	md += "\n\n";

	// Content warning / spoiler
	if (status.spoiler_text) {
		md += `> ⚠️ **CW:** ${status.spoiler_text}\n\n`;
	}

	// Main content (convert HTML to markdown)
	const content = await htmlToBasicMarkdown(status.content);
	md += `${content}\n\n`;

	// Poll
	if (status.poll) {
		md += "**Poll:**\n";
		for (const option of status.poll.options) {
			const pct =
				status.poll.votes_count > 0 ? ((option.votes_count / status.poll.votes_count) * 100).toFixed(1) : "0";
			md += `- ${option.title} (${pct}%, ${option.votes_count} votes)\n`;
		}
		md += `Total: ${status.poll.votes_count} votes${status.poll.expired ? " (closed)" : ""}\n\n`;
	}

	// Media attachments
	if (status.media_attachments.length > 0) {
		md += "**Attachments:**\n";
		for (const media of status.media_attachments) {
			const desc = media.description ? ` - ${media.description}` : "";
			md += `- [${media.type}](${media.url})${desc}\n`;
		}
		md += "\n";
	}

	// Stats
	md += `---\n`;
	md += `💬 ${formatNumber(status.replies_count)} replies · `;
	md += `🔁 ${formatNumber(status.reblogs_count)} boosts · `;
	md += `⭐ ${formatNumber(status.favourites_count)} favorites\n`;

	return md;
}

/**
 * Format an account/profile as markdown
 */
async function formatAccount(account: MastodonAccount): Promise<string> {
	let md = `# ${account.display_name || account.username}\n\n`;

	md += `**@${account.acct}**`;
	if (account.bot) md += " 🤖 Bot";
	md += "\n\n";

	// Bio
	if (account.note) {
		const bio = await htmlToBasicMarkdown(account.note);
		if (bio && bio !== account.display_name) {
			md += `${bio}\n\n`;
		}
	}

	// Stats
	md += `**Followers:** ${formatNumber(account.followers_count)} · `;
	md += `**Following:** ${formatNumber(account.following_count)} · `;
	md += `**Posts:** ${formatNumber(account.statuses_count)}\n\n`;

	md += `**Joined:** ${formatDate(account.created_at)}\n`;
	md += `**Profile:** ${account.url}\n`;

	// Profile fields (links, pronouns, etc.)
	if (account.fields && account.fields.length > 0) {
		md += "\n**Profile Fields:**\n";
		for (const field of account.fields) {
			const value = await htmlToBasicMarkdown(field.value);
			md += `- **${field.name}:** ${value}\n`;
		}
	}

	return md;
}

/**
 * Handle Mastodon/Fediverse URLs
 */
export const handleMastodon: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);

		// Check for @user/postid or @user pattern
		const postMatch = parsed.pathname.match(/^\/@([^/]+)\/(\d+)$/);
		const profileMatch = parsed.pathname.match(/^\/@([^/]+)$/);

		if (!postMatch && !profileMatch) return null;

		// Verify this is a Mastodon instance
		if (!(await isMastodonInstance(parsed.hostname, timeout, signal))) {
			return null;
		}

		const fetchedAt = new Date().toISOString();
		const instance = parsed.hostname;

		if (postMatch) {
			// Fetch status/post
			const [, , statusId] = postMatch;
			const apiUrl = `https://${instance}/api/v1/statuses/${statusId}`;

			const result = await loadPage(apiUrl, {
				timeout,
				headers: { Accept: "application/json" },
				signal,
			});

			if (!result.ok) return null;

			const status = tryParseJson<MastodonStatus>(result.content);
			if (!status) return null;

			const md = await formatStatus(status);

			return buildResult(md, {
				url,
				finalUrl: status.url || url,
				method: "mastodon",
				fetchedAt,
				notes: [`Fetched via Mastodon API (${instance})`],
			});
		}

		if (profileMatch) {
			// Fetch account by username lookup
			const [, username] = profileMatch;
			const lookupUrl = `https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`;

			const result = await loadPage(lookupUrl, {
				timeout,
				headers: { Accept: "application/json" },
				signal,
			});

			if (!result.ok) return null;

			const account = tryParseJson<MastodonAccount>(result.content);
			if (!account) return null;

			// Fetch recent statuses
			const statusesUrl = `https://${instance}/api/v1/accounts/${account.id}/statuses?limit=5&exclude_replies=true`;
			const statusesResult = await loadPage(statusesUrl, {
				timeout,
				headers: { Accept: "application/json" },
				signal,
			});

			let md = await formatAccount(account);

			if (statusesResult.ok) {
				const statuses = tryParseJson<MastodonStatus[]>(statusesResult.content);
				if (statuses && statuses.length > 0) {
					md += "\n---\n\n## Recent Posts\n\n";
					for (const status of statuses.slice(0, 5)) {
						md += `### ${formatDate(status.created_at)}\n\n`;
						const content = await htmlToBasicMarkdown(status.content);
						md += `${content}\n\n`;
						md += `💬 ${status.replies_count} · 🔁 ${status.reblogs_count} · ⭐ ${status.favourites_count}\n\n`;
					}
				}
			}

			return buildResult(md, {
				url,
				finalUrl: account.url || url,
				method: "mastodon",
				fetchedAt,
				notes: [`Fetched via Mastodon API (${instance})`],
			});
		}
	} catch {}

	return null;
};
