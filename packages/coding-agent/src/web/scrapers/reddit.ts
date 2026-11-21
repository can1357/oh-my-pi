/**
 * Reddit reader for posts, comment threads, subreddit listings and user pages.
 *
 * Reddit refuses its JSON API to many networks ("blocked by network security"), so a read tries
 * three sources in order and renders the first that answers:
 * 1. Reddit's JSON API: live and authoritative.
 * 2. A Redlib mirror: live HTML of the same path, scraped.
 * 3. The Arctic Shift archive: Reddit-shaped JSON; scores and the newest comments may lag.
 */
import { logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { type Element, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { ToolAbortError } from "../../tools/tool-errors";
import { buildResult, formatIsoDate, htmlToBasicMarkdown, loadPage, type SpecialHandler } from "./types";

const REDDIT_ORIGIN = "https://www.reddit.com";
/** Serves non-browser user agents; most public Redlib instances answer with an Anubis challenge or 429. */
const REDLIB_HOST = "safereddit.com";
const ARCTIC_SHIFT_API = "https://arctic-shift.photon-reddit.com/api";
/** Archive comments per thread; past it the archive collapses replies into "more" stubs. */
const ARCHIVE_COMMENT_LIMIT = 500;
const ARCHIVE_LISTING_LIMIT = 25;

const SUBREDDIT_SORT = /^(hot|new|top|rising|controversial|best)$/;
const USER_TAB = /^(overview|submitted|comments)$/;
const THING_ID = /^[a-z0-9]+$/i;

/** What a Reddit URL points at; `path` is the canonical path every source requests. */
interface Target {
	/** Path without trailing slash; empty for the front page. */
	path: string;
	search: string;
	postId?: string;
	commentId?: string;
	subreddit?: string;
	user?: string;
	userTab?: string;
}

interface Post {
	title: string;
	author: string;
	subreddit: string;
	permalink: string;
	/** Markdown. */
	body: string;
	score?: number;
	comments?: number;
	/** Epoch milliseconds. */
	created?: number;
	/** Target of a link post. */
	link?: string;
	flair?: string;
}

interface Comment {
	author: string;
	/** Markdown. */
	body: string;
	score?: number;
	/** Epoch milliseconds. */
	created?: number;
	isOp?: boolean;
	replies: Comment[];
	/** Replies the source collapsed instead of returning. */
	hidden: number;
	/** Thread a comment listed outside it (user pages) belongs to. */
	context?: { postTitle?: string; subreddit?: string; permalink?: string };
}

type Entry = { post: Post } | { comment: Comment };

type Page = { kind: "thread"; post: Post; comments: Comment[]; hidden: number } | { kind: "listing"; entries: Entry[] };

interface Source {
	note: string;
	read(target: Target, timeout: number, signal?: AbortSignal): Promise<Page | null>;
}

/** Reddit "thing" payload fields shared by the JSON API and Arctic Shift. */
interface ThingData {
	author?: string;
	subreddit?: string;
	score?: number;
	created_utc?: number;
	permalink?: string;
	// Posts (t3)
	title?: string;
	selftext?: string;
	url?: string;
	is_self?: boolean;
	num_comments?: number;
	link_flair_text?: string | null;
	// Comments (t1)
	body?: string;
	is_submitter?: boolean;
	link_title?: string;
	replies?: Listing | "";
	// Collapsed replies ("more")
	count?: number;
	children?: string[];
}

interface Thing {
	kind: string;
	data: ThingData;
}

interface Listing {
	kind: "Listing";
	data: { children: Thing[] };
}

function parseTarget(url: URL): Target | null {
	const host = url.hostname.toLowerCase();
	const segments = url.pathname.split("/").filter(Boolean);

	if (host === "redd.it") {
		const [id] = segments;
		if (segments.length !== 1 || !THING_ID.test(id)) return null;
		return { path: `/comments/${id}`, search: "", postId: id };
	}
	if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
	// An explicit `.json`/`.rss` URL asks for the raw document, not a rendering.
	if (segments.some(segment => /\.(json|rss|xml)$/i.test(segment))) return null;

	const lower = segments.map(segment => segment.toLowerCase());
	const owner = lower[0] === "r" || lower[0] === "u" || lower[0] === "user" ? 2 : 0;
	const subreddit = lower[0] === "r" ? segments[1] : undefined;

	// /comments/<id>, /r/<sub>/comments/<id>/<slug>/<comment>, /user/<name>/comments/<id>/<slug>
	const postId = lower[owner] === "comments" ? segments[owner + 1] : undefined;
	if (postId && THING_ID.test(postId)) {
		const commentId = segments[owner + 3];
		const focus = commentId && THING_ID.test(commentId) ? commentId : undefined;
		const prefix = subreddit ? `/r/${subreddit}` : "";
		return {
			path: `${prefix}/comments/${postId}${focus ? `/_/${focus}` : ""}`,
			search: "",
			postId,
			commentId: focus,
			subreddit,
		};
	}

	const path = `/${segments.join("/")}`.replace(/^\/$/, "");
	if (subreddit && (segments.length === 2 || (segments.length === 3 && SUBREDDIT_SORT.test(lower[2])))) {
		return { path, search: url.search, subreddit };
	}
	if (owner === 2 && lower[0] !== "r" && segments[1] && segments.length <= 3) {
		const tab = lower[2];
		if (tab && !USER_TAB.test(tab)) return { path, search: url.search };
		return { path: `/user/${segments.slice(1).join("/")}`, search: url.search, user: segments[1], userTab: tab };
	}
	return { path, search: url.search };
}

function absoluteUrl(href: string | null | undefined): string {
	if (!href) return "";
	return href.startsWith("/") ? `${REDDIT_ORIGIN}${href}` : href;
}

function postFromData(data: ThingData): Post | null {
	if (!data.title) return null;
	const permalink = absoluteUrl(data.permalink);
	return {
		title: data.title,
		author: data.author ?? "[deleted]",
		subreddit: data.subreddit ?? "",
		permalink,
		body: data.selftext ?? "",
		score: data.score,
		comments: data.num_comments,
		created: data.created_utc && data.created_utc * 1000,
		link: data.is_self === false && data.url && data.url !== permalink ? data.url : undefined,
		flair: data.link_flair_text ?? undefined,
	};
}

function commentFromData(data: ThingData): Comment {
	const nested = data.replies ? commentsFromThings(data.replies.data.children) : { comments: [], hidden: 0 };
	return {
		author: data.author ?? "[deleted]",
		body: data.body ?? "",
		score: data.score,
		created: data.created_utc && data.created_utc * 1000,
		isOp: data.is_submitter,
		replies: nested.comments,
		hidden: nested.hidden,
	};
}

function commentsFromThings(things: Thing[]): { comments: Comment[]; hidden: number } {
	const comments: Comment[] = [];
	let hidden = 0;
	for (const thing of things) {
		if (thing.kind === "t1") comments.push(commentFromData(thing.data));
		else if (thing.kind === "more") hidden += thing.data.count || thing.data.children?.length || 0;
	}
	return { comments, hidden };
}

function threadFromThings(postData: ThingData | undefined, commentThings: Thing[]): Page | null {
	const post = postData && postFromData(postData);
	if (!post) return null;
	return { kind: "thread", post, ...commentsFromThings(commentThings) };
}

function listingFromThings(things: Thing[]): Page | null {
	const entries: Entry[] = [];
	for (const { kind, data } of things) {
		if (kind === "t3") {
			const post = postFromData(data);
			if (post) entries.push({ post });
		} else if (kind === "t1") {
			const comment = commentFromData(data);
			comment.context = {
				postTitle: data.link_title,
				subreddit: data.subreddit,
				permalink: absoluteUrl(data.permalink),
			};
			entries.push({ comment });
		}
	}
	return entries.length > 0 ? { kind: "listing", entries } : null;
}

const redditApi: Source = {
	note: "Fetched via Reddit JSON API",
	async read(target, timeout, signal) {
		const params = new URLSearchParams(target.search);
		params.set("raw_json", "1");
		const result = await loadPage(`${REDDIT_ORIGIN}${target.path}/.json?${params}`, {
			timeout,
			signal,
			headers: { Accept: "application/json" },
		});
		if (!result.ok) return null;
		const data = tryParseJson<Listing | Listing[]>(result.content);
		if (Array.isArray(data)) return threadFromThings(data[0]?.data.children[0]?.data, data[1]?.data.children ?? []);
		return data?.data?.children ? listingFromThings(data.data.children) : null;
	},
};

async function archive<T>(query: string, timeout: number, signal?: AbortSignal): Promise<T | null> {
	const result = await loadPage(`${ARCTIC_SHIFT_API}/${query}`, {
		timeout,
		signal,
		headers: { Accept: "application/json" },
	});
	if (!result.ok) return null;
	return tryParseJson<{ data: T | null }>(result.content)?.data ?? null;
}

function archiveSearch(kind: "posts" | "comments", filter: Record<string, string>): string {
	const params = new URLSearchParams({ ...filter, sort: "desc", limit: String(ARCHIVE_LISTING_LIMIT) });
	return `${kind}/search?${params}`;
}

const arcticShift: Source = {
	note: "Fetched from the Arctic Shift archive (Reddit and Redlib unavailable): scores and the newest comments may lag, listings are newest-first",
	async read(target, timeout, signal) {
		if (target.postId) {
			const tree = new URLSearchParams({ link_id: target.postId, limit: String(ARCHIVE_COMMENT_LIMIT) });
			if (target.commentId) tree.set("parent_id", `t1_${target.commentId}`);
			const [posts, comments] = await Promise.all([
				archive<ThingData[]>(`posts/ids?ids=${target.postId}`, timeout, signal),
				archive<Thing[]>(`comments/tree?${tree}`, timeout, signal),
			]);
			return threadFromThings(posts?.[0], comments ?? []);
		}
		if (target.subreddit) {
			const posts = await archive<ThingData[]>(
				archiveSearch("posts", { subreddit: target.subreddit }),
				timeout,
				signal,
			);
			return listingFromThings((posts ?? []).map(data => ({ kind: "t3", data })));
		}
		if (target.user) {
			const author = { author: target.user };
			const [posts, comments] = await Promise.all([
				target.userTab === "comments" ? [] : archive<ThingData[]>(archiveSearch("posts", author), timeout, signal),
				target.userTab === "submitted"
					? []
					: archive<ThingData[]>(archiveSearch("comments", author), timeout, signal),
			]);
			const things: Thing[] = [
				...(posts ?? []).map(data => ({ kind: "t3", data })),
				...(comments ?? []).map(data => ({ kind: "t1", data })),
			];
			things.sort((a, b) => (b.data.created_utc ?? 0) - (a.data.created_utc ?? 0));
			return listingFromThings(things.slice(0, ARCHIVE_LISTING_LIMIT));
		}
		return null;
	},
};

function childByClass(element: Element, className: string): Element | undefined {
	return element.children.find(child => child.classList.contains(className));
}

function textOf(element: Element | null | undefined): string {
	return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function withoutPrefix(text: string, prefix: string): string {
	return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** Redlib carries exact counts and timestamps in `title` attributes; the visible text is abbreviated. */
function titleNumber(element: Element | null | undefined): number | undefined {
	const value = Number.parseInt(element?.getAttribute("title") ?? "", 10);
	return Number.isNaN(value) ? undefined : value;
}

function titleDate(element: Element | null | undefined): number | undefined {
	const value = Date.parse(element?.getAttribute("title") ?? "");
	return Number.isNaN(value) ? undefined : value;
}

async function markdownOf(element: Element | null | undefined): Promise<string> {
	return element ? htmlToBasicMarkdown(element.innerHTML) : "";
}

/** A Redlib `.post` card or highlighted post, without its body. */
function redlibPost(element: Element): Post {
	const heading = element.querySelector(".post_title");
	const flair = heading?.querySelector(".post_flair");
	const flairText = textOf(flair);
	flair?.remove();
	// Listing cards link the title to the thread; a thread's own title is bare text.
	const titleLink = heading?.querySelector("a");
	return {
		title: textOf(heading),
		author: withoutPrefix(textOf(element.querySelector(".post_author")), "u/"),
		subreddit: withoutPrefix(textOf(element.querySelector(".post_subreddit")), "r/"),
		permalink: absoluteUrl(titleLink?.getAttribute("href")),
		body: "",
		score: titleNumber(element.querySelector(".post_score")),
		comments: titleNumber(element.querySelector(".post_comments")),
		created: titleDate(element.querySelector(".post_header .created")),
		link: element.querySelector("#post_url")?.getAttribute("href") ?? undefined,
		flair: flairText || undefined,
	};
}

/** A Redlib `.comment`, in a thread (nested replies) or on a user page (thread link). */
async function redlibComment(element: Element): Promise<Comment> {
	const details = childByClass(element, "comment_right");
	const summary = details && childByClass(details, "comment_data");
	const author = summary?.querySelector(".comment_author");
	const replies = details && childByClass(details, "replies");
	// User pages wrap the body in a <p>, which the parser closes before the body's <div class="md">.
	const body = details && (childByClass(details, "comment_body")?.querySelector(".md") ?? childByClass(details, "md"));
	const threadLink = summary?.querySelector(".comment_link");
	return {
		author: withoutPrefix(textOf(author), "u/"),
		body: await markdownOf(body),
		score: titleNumber(childByClass(element, "comment_left")?.querySelector(".comment_score")),
		created: titleDate(summary?.querySelector(".created")),
		isOp: author?.classList.contains("op"),
		replies: replies
			? await Promise.all(replies.children.filter(child => child.classList.contains("comment")).map(redlibComment))
			: [],
		hidden: 0,
		context: threadLink
			? {
					postTitle: textOf(threadLink),
					subreddit: withoutPrefix(textOf(summary?.querySelector(".comment_subreddit")), "r/"),
					permalink: absoluteUrl(threadLink.getAttribute("href")),
				}
			: undefined,
	};
}

const redlib: Source = {
	note: `Fetched via Redlib mirror ${REDLIB_HOST} (Reddit API unavailable)`,
	async read(target, timeout, signal) {
		const result = await loadPage(`https://${REDLIB_HOST}${target.path || "/"}${target.search}`, { timeout, signal });
		if (!result.ok) return null;
		const document = parseHTML(result.content).document;

		const focus = document.querySelector(".post.highlighted");
		if (focus) {
			const post = redlibPost(focus);
			post.body = await markdownOf(focus.querySelector(".post_body .md"));
			const threads = document.querySelectorAll(".thread");
			const roots = threads.flatMap(thread => thread.children.filter(child => child.classList.contains("comment")));
			return { kind: "thread", post, comments: await Promise.all(roots.map(redlibComment)), hidden: 0 };
		}

		const entries: Entry[] = [];
		for (const element of document.querySelectorAll(".post, .user-comment")) {
			if (element.classList.contains("post")) {
				entries.push({ post: redlibPost(element) });
				continue;
			}
			const comment = await redlibComment(element);
			// A user page names no author on the user's own comments.
			comment.author ||= target.user ?? "[unknown]";
			entries.push({ comment });
		}
		return entries.length > 0 ? { kind: "listing", entries } : null;
	},
};

const SOURCES: Source[] = [redditApi, redlib, arcticShift];

function counted(count: number | undefined, singular: string, plural = `${singular}s`): string | undefined {
	return count === undefined ? undefined : `${count} ${count === 1 ? singular : plural}`;
}

function byline(parts: Array<string | undefined>): string {
	return parts.filter(Boolean).join(" · ");
}

function indent(text: string, prefix: string): string {
	return text
		.split("\n")
		.map(line => (line ? `${prefix}${line}` : line))
		.join("\n");
}

function renderComment(comment: Comment, depth: number): string {
	const prefix = "  ".repeat(depth);
	const author = `**u/${comment.author}**${comment.isOp ? " (OP)" : ""}`;
	let md = `${prefix}- ${byline([author, counted(comment.score, "point"), formatIsoDate(comment.created)])}\n`;
	if (comment.body) md += `${indent(comment.body.trim(), `${prefix}  `)}\n`;
	md += "\n";
	for (const reply of comment.replies) md += renderComment(reply, depth + 1);
	if (comment.hidden > 0) md += `${prefix}  - *… ${counted(comment.hidden, "more reply", "more replies")}*\n`;
	return md;
}

function renderThread(page: Extract<Page, { kind: "thread" }>, target: Target): string {
	const { post } = page;
	let md = `# ${post.title}\n\n`;
	md += `${byline([
		post.subreddit && `**r/${post.subreddit}**`,
		`u/${post.author}`,
		counted(post.score, "point"),
		counted(post.comments, "comment"),
		formatIsoDate(post.created),
		post.flair && `[${post.flair}]`,
	])}\n\n`;
	if (post.link) md += `**Link:** ${post.link}\n\n`;
	if (post.body.trim()) md += `---\n\n${post.body.trim()}\n\n`;
	if (page.comments.length > 0 || page.hidden > 0) {
		md += `---\n\n## ${target.commentId ? "Comment thread" : "Comments"}\n\n`;
		for (const comment of page.comments) md += renderComment(comment, 0);
		if (page.hidden > 0) md += `- *… ${counted(page.hidden, "more comment")}*\n`;
	}
	return md;
}

function listingTitle(target: Target): string {
	if (target.subreddit) return `r/${target.subreddit}`;
	if (target.user) return `u/${target.user}`;
	return `reddit.com${target.path || "/"}`;
}

function renderEntry(entry: Entry): string {
	if ("post" in entry) {
		const { post } = entry;
		const line = byline([
			`**${post.title}**`,
			post.subreddit && `r/${post.subreddit}`,
			`u/${post.author}`,
			counted(post.score, "point"),
			counted(post.comments, "comment"),
			formatIsoDate(post.created),
			post.flair && `[${post.flair}]`,
		]);
		return `- ${line}\n  ${post.permalink}\n`;
	}
	const { comment } = entry;
	const context = comment.context;
	const line = byline([
		`Comment by **u/${comment.author}**${context?.postTitle ? ` on "${context.postTitle}"` : ""}`,
		context?.subreddit && `r/${context.subreddit}`,
		counted(comment.score, "point"),
		formatIsoDate(comment.created),
	]);
	let md = `- ${line}\n`;
	if (context?.permalink) md += `  ${context.permalink}\n`;
	if (comment.body) md += `${indent(comment.body.trim(), "  ")}\n`;
	return md;
}

function renderPage(page: Page, target: Target): string {
	if (page.kind === "thread") return renderThread(page, target);
	return `# ${listingTitle(target)}\n\n${page.entries.map(renderEntry).join("\n")}`;
}

/**
 * Render Reddit posts, threads, subreddits and user pages, falling back from Reddit's JSON API
 * to a Redlib mirror and then the Arctic Shift archive when a source is blocked or down.
 */
export const handleReddit: SpecialHandler = async (url, timeout, signal) => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const target = parseTarget(parsed);
	if (!target) return null;

	const fetchedAt = new Date().toISOString();
	for (const source of SOURCES) {
		let page: Page | null;
		try {
			page = await source.read(target, timeout, signal);
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			logger.debug("Reddit source failed", { url, source: source.note, error: String(error) });
			continue;
		}
		if (page) {
			return buildResult(renderPage(page, target), { url, method: "reddit", fetchedAt, notes: [source.note] });
		}
	}
	return null;
};
