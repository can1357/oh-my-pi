import { describe, expect, it } from "bun:test";
import { handleWikipedia } from "@oh-my-pi/pi-coding-agent/web/scrapers/wikipedia";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleWikipedia", () => {
	it("returns null for non-Wikipedia URLs", async () => {
		const result = await handleWikipedia("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for Wikipedia URLs without /wiki/ path", async () => {
		const result = await handleWikipedia("https://en.wikipedia.org/", 10);
		expect(result).toBeNull();
	});

	it("fetches a known article with full metadata", async () => {
		// "Computer" is a stable, well-established article
		const result = await handleWikipedia("https://en.wikipedia.org/wiki/Computer", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("wikipedia");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Computer");
		expect(result?.url).toBe("https://en.wikipedia.org/wiki/Computer");
		expect(result?.finalUrl).toBe("https://en.wikipedia.org/wiki/Computer");
		expect(result?.truncated).toBe(false);
		expect(result?.notes).toContain("Fetched via Wikipedia API");
		const content = result?.content ?? "";
		const hasReferencesHeading = /^## References$/m.test(content);
		const hasExternalLinksHeading = /^## External links$/m.test(content);
		// At least one of these should be filtered out
		expect(hasReferencesHeading || hasExternalLinksHeading).toBe(false);
	});

	it("handles different language wikis", async () => {
		// German Wikipedia article for "Computer"
		const result = await handleWikipedia("https://de.wikipedia.org/wiki/Computer", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("wikipedia");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Computer");
	});

	it("handles article with special characters in title", async () => {
		// Article with special characters: "C++"
		const result = await handleWikipedia("https://en.wikipedia.org/wiki/C%2B%2B", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("wikipedia");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toMatch(/C\+\+/);
	});

	it("handles article with spaces and parentheses in title", async () => {
		// Artificial intelligence uses underscores for spaces
		const result = await handleWikipedia("https://en.wikipedia.org/wiki/Artificial_intelligence", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("wikipedia");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toMatch(/[Aa]rtificial intelligence/);
	});

	it("handles non-existent articles gracefully", async () => {
		const result = await handleWikipedia(
			"https://en.wikipedia.org/wiki/ThisArticleDefinitelyDoesNotExist123456789",
			20,
		);
		expect(result).toBeNull();
	});
});
