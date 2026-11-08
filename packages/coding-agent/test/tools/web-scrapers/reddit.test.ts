import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleReddit } from "@oh-my-pi/pi-coding-agent/web/scrapers/reddit";
import { asGlobalFetch } from "../../helpers/fetch-mock.js";

const THREAD_URL = "https://www.reddit.com/r/rust/comments/abc123/borrow_checker_tips/";

const POST = {
	title: "Borrow checker tips",
	author: "ferris",
	subreddit: "rust",
	score: 42,
	num_comments: 3,
	created_utc: 1_773_915_404,
	permalink: "/r/rust/comments/abc123/borrow_checker_tips/",
	selftext: "Share your tricks.",
	is_self: true,
	link_flair_text: "Discussion",
};

const COMMENTS = [
	{
		kind: "t1",
		data: {
			author: "alice",
			body: "Clone less.",
			score: 7,
			created_utc: 1_773_977_226,
			replies: {
				kind: "Listing",
				data: {
					children: [
						{
							kind: "t1",
							data: { author: "ferris", body: "Agreed.", score: 1, is_submitter: true, replies: "" },
						},
						{ kind: "more", data: { count: 4, children: ["x1", "x2"] } },
					],
				},
			},
		},
	},
	{ kind: "more", data: { count: 13, children: ["y1"] } },
];

const REDLIB_THREAD = `<html><body>
<div class="post highlighted">
	<p class="post_header">
		<a class="post_subreddit" href="/r/rust">r/rust</a>
		<a class="post_author" href="/user/ferris">u/ferris</a>
		<span class="created" title="Mar 19 2026, 10:16:44 UTC">Mar 19 '26</span>
	</p>
	<h1 class="post_title"><a class="post_flair"><span>Discussion</span></a> Borrow checker tips</h1>
	<a id="post_url" href="https://blog.example/borrowck">https://blog.example/borrowck</a>
	<div class="post_body"><div class="md"><p>Share your <strong>tricks</strong>.</p></div></div>
	<div class="post_score" title="42">42<span class="label"> Upvotes</span></div>
</div>
<div class="thread">
	<div class="comment">
		<div class="comment_left"><p class="comment_score" title="7">7</p></div>
		<details class="comment_right" open>
			<summary class="comment_data"><a class="comment_author" href="/user/alice">u/alice</a>
				<a class="created" title="Mar 20 2026, 03:27:06 UTC">Mar 20 '26</a></summary>
			<div class="comment_body"><div class="md"><p>Clone less.</p></div></div>
			<blockquote class="replies">
				<div class="comment">
					<div class="comment_left"><p class="comment_score" title="1">1</p></div>
					<details class="comment_right" open>
						<summary class="comment_data"><a class="comment_author op" href="/user/ferris">u/ferris</a></summary>
						<div class="comment_body"><div class="md"><p>Agreed.</p></div></div>
						<blockquote class="replies"></blockquote>
					</details>
				</div>
			</blockquote>
		</details>
	</div>
</div>
</body></html>`;

function networkBlock(): Response {
	return new Response("<html><body>You've been blocked by network security.</body></html>", {
		status: 403,
		headers: { "content-type": "text/html" },
	});
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function html(body: string): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Route mocked requests by host; unrouted hosts fail like an unreachable mirror. */
function routeFetch(routes: Record<string, (url: URL) => Response>): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async input => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const route = routes[url.hostname];
			return route ? route(url) : new Response("unreachable", { status: 502 });
		}),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("handleReddit", () => {
	it("renders a thread from the JSON API with nested replies and collapsed counts", async () => {
		routeFetch({
			"www.reddit.com": () =>
				json([
					{ kind: "Listing", data: { children: [{ kind: "t3", data: POST }] } },
					{ kind: "Listing", data: { children: COMMENTS } },
				]),
		});

		const result = await handleReddit(THREAD_URL, 20);

		expect(result?.notes).toEqual(["Fetched via Reddit JSON API"]);
		expect(result?.content).toContain("**r/rust** · u/ferris · 42 points · 3 comments · 2026-03-19 · [Discussion]");
		expect(result?.content).toContain("- **u/alice** · 7 points · 2026-03-20\n  Clone less.");
		expect(result?.content).toContain("  - **u/ferris** (OP) · 1 point\n    Agreed.");
		expect(result?.content).toContain("  - *… 4 more replies*");
		expect(result?.content).toContain("- *… 13 more comments*");
	});

	it("falls back to the Redlib mirror when Reddit blocks the API", async () => {
		routeFetch({
			"www.reddit.com": networkBlock,
			"safereddit.com": url => (url.pathname === "/r/rust/comments/abc123" ? html(REDLIB_THREAD) : html("")),
		});

		const result = await handleReddit(THREAD_URL, 20);

		expect(result?.notes[0]).toContain("Redlib");
		expect(result?.content).toContain("# Borrow checker tips\n");
		expect(result?.content).toContain("**r/rust** · u/ferris · 42 points · 2026-03-19 · [Discussion]");
		expect(result?.content).toContain("**Link:** https://blog.example/borrowck");
		expect(result?.content).toContain("Share your **tricks**.");
		expect(result?.content).toContain("- **u/alice** · 7 points · 2026-03-20\n  Clone less.");
		expect(result?.content).toContain("  - **u/ferris** (OP) · 1 point\n    Agreed.");
	});

	it("falls back to the Arctic Shift archive when the mirror serves a challenge", async () => {
		const archived: string[] = [];
		routeFetch({
			"www.reddit.com": networkBlock,
			"safereddit.com": () => html("<html><title>Making sure you're not a bot!</title></html>"),
			"arctic-shift.photon-reddit.com": url => {
				archived.push(`${url.pathname}${url.search}`);
				if (url.pathname === "/api/posts/ids") return json({ data: [POST] });
				if (url.pathname === "/api/comments/tree") return json({ data: COMMENTS });
				return json({ data: null, error: "not found" });
			},
		});

		const result = await handleReddit(
			"https://old.reddit.com/r/rust/comments/abc123/borrow_checker_tips/def456/",
			20,
		);

		expect(result?.notes[0]).toContain("Arctic Shift");
		expect(archived).toContain("/api/comments/tree?link_id=abc123&limit=500&parent_id=t1_def456");
		expect(result?.content).toContain("## Comment thread");
		expect(result?.content).toContain("- **u/alice** · 7 points · 2026-03-20\n  Clone less.");
	});

	it("returns null when every source fails so the generic fetch path reports the block", async () => {
		routeFetch({ "www.reddit.com": networkBlock });

		expect(await handleReddit(THREAD_URL, 20)).toBeNull();
	});
});
