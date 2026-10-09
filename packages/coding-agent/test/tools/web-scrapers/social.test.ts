import { describe, expect, it } from "bun:test";
import { handleReddit } from "@oh-my-pi/pi-coding-agent/web/scrapers/reddit";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

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
