import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

interface LemmyCreator {
	name: string;
	actor_id?: string;
}

interface LemmyCommunity {
	name: string;
	actor_id?: string;
}

interface LemmyCounts {
	score: number;
	comments?: number;
}

interface LemmyPost {
	id: number;
	name: string;
	body?: string;
	url?: string;
}

interface LemmyPostView {
	post: LemmyPost;
	creator: LemmyCreator;
	community: LemmyCommunity;
	counts: LemmyCounts;
}

interface LemmyPostResponse {
	post_view?: LemmyPostView;
}

interface LemmyComment {
	id: number;
	content?: string;
	path?: string;
	parent_id?: number | null;
	post_id?: number;
}

interface LemmyCommentView {
	comment: LemmyComment;
	creator: LemmyCreator;
	counts: LemmyCounts;
}

interface LemmyCommentListResponse {
	comments?: LemmyCommentView[];
}

interface LemmyCommentResponse {
	comment_view?: LemmyCommentView;
}

function formatCommunity(community: LemmyCommunity): string {
	if (community.actor_id) {
		try {
			const host = new URL(community.actor_id).hostname;
			return `!${community.name}@${host}`;
		} catch {}
	}
	return `!${community.name}`;
}

function formatAuthor(creator: LemmyCreator): string {
	if (creator.actor_id) {
		try {
			const host = new URL(creator.actor_id).hostname;
			return `@${creator.name}@${host}`;
		} catch {}
	}
	return creator.name;
}

function indentBlock(text: string, indent: string): string {
	return text
		.split("\n")
		.map(line => `${indent}${line}`)
		.join("\n");
}

function renderComments(comments: LemmyCommentView[]): string {
	const childrenByParent = new Map<number, LemmyCommentView[]>();

	const commentIds = new Set(comments.map(view => view.comment.id));

	for (const commentView of comments) {
		const parentId = commentView.comment.parent_id;
		const resolvedParent = parentId && commentIds.has(parentId) ? parentId : 0;
		const list = childrenByParent.get(resolvedParent);
		if (list) {
			list.push(commentView);
		} else {
			childrenByParent.set(resolvedParent, [commentView]);
		}
	}

	const renderThread = (parentId: number, depth: number): string => {
		const items = childrenByParent.get(parentId) ?? [];
		let output = "";

		for (const view of items) {
			const author = view.creator?.name ? formatAuthor(view.creator) : "unknown";
			const score = view.counts?.score ?? 0;
			const content = (view.comment.content ?? "").trim();
			const indent = "  ".repeat(depth);

			output += `${indent}- **${author}** · ${score} points\n`;
			if (content) {
				output += `${indentBlock(content, `${indent}  `)}\n`;
			}

			output += renderThread(view.comment.id, depth + 1);
			output += "\n";
		}

		return output;
	};

	return renderThread(0, 0).trim();
}

export const handleLemmy: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		const match = parsed.pathname.match(/^\/(post|comment)\/(\d+)/);
		if (!match) return null;

		const kind = match[1];
		const id = Number.parseInt(match[2], 10);
		if (!Number.isFinite(id)) return null;

		const baseUrl = parsed.origin;
		const fetchedAt = new Date().toISOString();

		let postId = id;
		if (kind === "comment") {
			const commentUrl = `${baseUrl}/api/v3/comment?id=${id}`;
			const commentResult = await loadPage(commentUrl, { timeout, signal });
			if (!commentResult.ok) return null;

			const commentData = tryParseJson<LemmyCommentResponse>(commentResult.content);
			const commentView = commentData?.comment_view;
			const commentPostId = commentView?.comment?.post_id;
			if (!commentPostId) return null;
			postId = commentPostId;
		}

		const postUrl = `${baseUrl}/api/v3/post?id=${postId}`;
		const commentsUrl = `${baseUrl}/api/v3/comment/list?post_id=${postId}`;

		const [postResult, commentsResult] = await Promise.all([
			loadPage(postUrl, { timeout, signal }),
			loadPage(commentsUrl, { timeout, signal }),
		]);

		if (!postResult.ok || !commentsResult.ok) return null;

		const postData = tryParseJson<LemmyPostResponse>(postResult.content);
		const postView = postData?.post_view;
		if (!postView) return null;

		const commentsData = tryParseJson<LemmyCommentListResponse>(commentsResult.content);
		const comments = commentsData?.comments ?? [];

		let md = `# ${postView.post.name}\n\n`;

		const communityLabel = formatCommunity(postView.community);
		const authorLabel = formatAuthor(postView.creator);
		const score = postView.counts?.score ?? 0;
		const commentCount = postView.counts?.comments ?? comments.length;

		md += `**Community:** ${communityLabel} · **Author:** ${authorLabel} · **Score:** ${score} · **Comments:** ${commentCount}\n`;
		if (postView.post.url) {
			md += `**Link:** ${postView.post.url}\n`;
		}
		md += "\n";

		if (postView.post.body) {
			md += `---\n\n${postView.post.body}\n\n`;
		}

		if (comments.length > 0) {
			const threadedComments = renderComments(comments);
			if (threadedComments) {
				md += `---\n\n## Comments\n\n${threadedComments}\n`;
			}
		}

		return buildResult(md, { url, method: "lemmy-api", fetchedAt, notes: ["Fetched via Lemmy API"] });
	} catch {}

	return null;
};
