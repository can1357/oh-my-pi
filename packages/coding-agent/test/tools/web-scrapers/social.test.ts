import { describe, expect, it } from "bun:test";
import { handleReddit } from "@oh-my-pi/pi-coding-agent/web/scrapers/reddit";
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
});
