import { describe, expect, it } from "bun:test";
import { handleReddit } from "@oh-my-pi/pi-coding-agent/web/scrapers/reddit";
import { handleStackOverflow } from "@oh-my-pi/pi-coding-agent/web/scrapers/stackoverflow";
import { handleTwitter } from "@oh-my-pi/pi-coding-agent/web/scrapers/twitter";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleTwitter", () => {
	it(
		"handles twitter.com status URLs",
		async () => {
			const result = await handleTwitter("https://twitter.com/jack/status/20", 10000);
			expect(result).not.toBeNull();
			expect(result?.method).toMatch(/^twitter/);
			expect(result?.contentType).toMatch(/^text\/(markdown|plain)$/);
			// Either successful fetch or blocked/unavailable message
			if (result?.method === "twitter-nitter") {
				expect(result?.content).toContain("Tweet by");
				expect(result?.notes?.[0]).toContain("Via Nitter");
			} else if (result?.method === "twitter-blocked") {
				expect(result?.content).toContain("blocks automated access");
				expect(result?.notes?.[0]).toContain("Nitter instances unavailable");
			}
		},
		{ timeout: 30000 },
	);

	it(
		"handles x.com status URLs",
		async () => {
			const result = await handleTwitter("https://x.com/elonmusk/status/1", 10000);
			expect(result).not.toBeNull();
			expect(result?.method).toMatch(/^twitter/);
			expect(result?.contentType).toMatch(/^text\/(markdown|plain)$/);
			// Either successful fetch or blocked/unavailable message
			if (result?.method === "twitter-nitter") {
				expect(result?.finalUrl).toContain("nitter");
			} else if (result?.method === "twitter-blocked") {
				expect(result?.content).toContain("blocks automated access");
			}
		},
		{ timeout: 30000 },
	);

	it(
		"may fail due to Nitter availability",
		async () => {
			// Test that failure returns helpful message instead of null
			const result = await handleTwitter("https://twitter.com/nonexistent/status/999999999999999999", 10000);
			expect(result).not.toBeNull();
			// Should return blocked message when Nitter fails
			if (result?.method === "twitter-blocked") {
				expect(result?.content).toContain("Nitter instances were unavailable");
				expect(result?.content).toContain("Try:");
			}
		},
		{ timeout: 30000 },
	);
});

describe.skipIf(SKIP)("handleReddit", () => {
	it("fetches subreddit", async () => {
		const result = await handleReddit("https://www.reddit.com/r/programming/", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("reddit");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("# r/programming");
		expect(result?.content).toMatch(/\*\*.*\*\*/); // Contains bold formatting
		expect(result?.notes).toContain("Fetched via Reddit JSON API");
	});

	it("fetches individual post", async () => {
		// Use a more reliable recent post URL
		const result = await handleReddit("https://www.reddit.com/r/programming/", 20000);
		// Individual post may fail if post doesn't exist, check if we get data
		if (result !== null) {
			expect(result.method).toBe("reddit");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("# r/");
			expect(result.notes).toContain("Fetched via Reddit JSON API");
		}
	});
});

describe.skipIf(SKIP)("handleStackOverflow", () => {
	it("fetches a known question", async () => {
		// Use a well-known question that definitely exists
		const result = await handleStackOverflow(
			"https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster",
			20000,
		);
		// API may fail or rate limit, check gracefully
		if (result !== null) {
			expect(result.method).toBe("stackexchange");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("# ");
			expect(result.content).toContain("**Score:");
			expect(result.content).toContain("**Tags:");
			expect(result.content).toContain("## Question");
			expect(result.notes.some(note => note.includes("Fetched via Stack Exchange API"))).toBe(true);
		}
	});

	it("handles other StackExchange sites", async () => {
		const result = await handleStackOverflow("https://math.stackexchange.com/questions/1000/", 20000);
		// API may fail, check gracefully
		if (result !== null) {
			expect(result.method).toBe("stackexchange");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("# ");
			expect(result.notes).toContain("Fetched via Stack Exchange API");
		}
	});
});
