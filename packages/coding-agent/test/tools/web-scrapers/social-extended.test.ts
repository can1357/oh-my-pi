import { describe, expect, it } from "bun:test";
import { handleBluesky } from "@oh-my-pi/pi-coding-agent/web/scrapers/bluesky";
import { handleMastodon } from "@oh-my-pi/pi-coding-agent/web/scrapers/mastodon";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleMastodon", () => {
	it("returns null for non-Mastodon URLs", async () => {
		const result = await handleMastodon("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for URLs without @user pattern", async () => {
		const result = await handleMastodon("https://mastodon.social/about", 20);
		expect(result).toBeNull();
	});

	it(
		"fetches a Mastodon profile",
		async () => {
			// @Gargron is Eugen Rochko, creator of Mastodon - very stable
			const result = await handleMastodon("https://mastodon.social/@Gargron", 20);
			expect(result).not.toBeNull();
			expect(result?.method).toBe("mastodon");
			expect(result?.contentType).toBe("text/markdown");
			expect(result?.content).toContain("Gargron");
			expect(result?.content).toContain("@Gargron");
			expect(result?.content).toContain("**Followers:**");
			expect(result?.content).toContain("**Following:**");
			expect(result?.content).toContain("**Posts:**");
			expect(result?.notes?.[0]).toContain("Mastodon API");
		},
		{ timeout: 30000 },
	);

	it("returns null for non-Mastodon instance with @user pattern", async () => {
		// A site that has @user pattern but isn't Mastodon
		const result = await handleMastodon("https://twitter.com/@jack", 20);
		expect(result).toBeNull();
	});
});

describe.skipIf(SKIP)("handleBluesky", () => {
	it("returns null for non-Bluesky URLs", async () => {
		const result = await handleBluesky("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for bsky.app URLs without profile path", async () => {
		const result = await handleBluesky("https://bsky.app/about", 20);
		expect(result).toBeNull();
	});

	it(
		"fetches a Bluesky profile",
		async () => {
			// bsky.app official account - stable
			const result = await handleBluesky("https://bsky.app/profile/bsky.app", 20);
			expect(result).not.toBeNull();
			expect(result?.method).toBe("bluesky-api");
			expect(result?.contentType).toBe("text/markdown");
			expect(result?.content).toContain("bsky.app");
			expect(result?.content).toContain("@bsky.app");
			expect(result?.content).toContain("**Followers:**");
			expect(result?.content).toContain("**Following:**");
			expect(result?.content).toContain("**Posts:**");
			expect(result?.content).toContain("**DID:**");
			expect(result?.notes).toContain("Fetched via AT Protocol API");
		},
		{ timeout: 30000 },
	);

	it(
		"fetches Jay Graber's profile",
		async () => {
			// Jay Graber - CEO of Bluesky, very stable
			const result = await handleBluesky("https://bsky.app/profile/jay.bsky.team", 20);
			expect(result).not.toBeNull();
			expect(result?.method).toBe("bluesky-api");
			expect(result?.contentType).toBe("text/markdown");
			expect(result?.content).toContain("@jay.bsky.team");
			expect(result?.content).toContain("**Followers:**");
		},
		{ timeout: 30000 },
	);
});
