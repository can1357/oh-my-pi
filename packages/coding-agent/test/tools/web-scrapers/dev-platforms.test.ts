import { describe, expect, it } from "bun:test";
import { handleDevTo } from "@oh-my-pi/pi-coding-agent/web/scrapers/devto";
import { handleGitLab } from "@oh-my-pi/pi-coding-agent/web/scrapers/gitlab";
import { handleHackerNews } from "@oh-my-pi/pi-coding-agent/web/scrapers/hackernews";
import { handleLobsters } from "@oh-my-pi/pi-coding-agent/web/scrapers/lobsters";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

// =============================================================================
// HackerNews Tests
// =============================================================================

describe.skipIf(SKIP)("handleHackerNews", () => {
	it("returns null for non-HN URLs", async () => {
		const result = await handleHackerNews("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("returns null for other domains", async () => {
		const result = await handleHackerNews("https://lobste.rs/", 10000);
		expect(result).toBeNull();
	});

	it("fetches front page", async () => {
		const result = await handleHackerNews("https://news.ycombinator.com/", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("hackernews");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Hacker News - Top Stories");
		expect(result?.content).toContain("points by");
		expect(result?.content).toContain("comments");
	});

	it("fetches individual story", async () => {
		const result = await handleHackerNews("https://news.ycombinator.com/item?id=1", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("hackernews");
		expect(result?.content).toContain("Y Combinator");
	});

	it("fetches newest page", async () => {
		const result = await handleHackerNews("https://news.ycombinator.com/newest", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("hackernews");
		expect(result?.content).toContain("Hacker News - New Stories");
	});

	it("fetches best page", async () => {
		const result = await handleHackerNews("https://news.ycombinator.com/best", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("hackernews");
		expect(result?.content).toContain("Hacker News - Best Stories");
	});

	it("handles news alias", async () => {
		const result = await handleHackerNews("https://news.ycombinator.com/news", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("hackernews");
		expect(result?.content).toContain("Hacker News - Top Stories");
	});

	it("returns null for unsupported paths", async () => {
		const result = await handleHackerNews("https://news.ycombinator.com/submit", 10000);
		expect(result).toBeNull();
	});
});

// =============================================================================
// Lobsters Tests
// =============================================================================

describe.skipIf(SKIP)("handleLobsters", () => {
	it("returns null for non-Lobsters URLs", async () => {
		const result = await handleLobsters("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("returns null for other domains", async () => {
		const result = await handleLobsters("https://news.ycombinator.com/", 10000);
		expect(result).toBeNull();
	});

	it("fetches front page", async () => {
		const result = await handleLobsters("https://lobste.rs/", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("lobsters");
		expect(result?.content).toContain("Lobste.rs Front Page");
		expect(result?.content).not.toContain("by undefined");
	});

	it("fetches newest page", async () => {
		const result = await handleLobsters("https://lobste.rs/newest", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("lobsters");
		expect(result?.content).toContain("Lobste.rs Newest");
	});

	it("fetches tag page", async () => {
		const result = await handleLobsters("https://lobste.rs/t/programming", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("lobsters");
		expect(result?.content).toContain("Lobste.rs Tag: programming");
	});

	it("fetches individual story", async () => {
		const result = await handleLobsters("https://lobste.rs/s/1uubbb", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("lobsters");
		expect(result?.content).toContain("points");
	});

	it("handles tag with multiple path segments", async () => {
		const result = await handleLobsters("https://lobste.rs/t/rust", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("lobsters");
		expect(result?.content).toContain("Lobste.rs Tag: rust");
	});

	it("returns null for invalid paths", async () => {
		const result = await handleLobsters("https://lobste.rs/invalid", 20000);
		expect(result).toBeNull();
	});
});

// =============================================================================
// dev.to Tests
// =============================================================================

describe.skipIf(SKIP)("handleDevTo", () => {
	it("returns null for non-dev.to URLs", async () => {
		const result = await handleDevTo("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("returns null for other domains", async () => {
		const result = await handleDevTo("https://medium.com/@test", 10000);
		expect(result).toBeNull();
	});

	it("fetches tag page", async () => {
		const result = await handleDevTo("https://dev.to/t/javascript", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("devto");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("dev.to/t/javascript");
		expect(result?.content).toContain("Recent Articles");
	});

	it("fetches another tag page", async () => {
		const result = await handleDevTo("https://dev.to/t/rust", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("devto");
		expect(result?.content).toContain("dev.to/t/rust");
	});

	it("fetches user profile", async () => {
		const result = await handleDevTo("https://dev.to/ben", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("devto");
		expect(result?.content).toContain("dev.to/ben");
		expect(result?.content).toContain("Recent Articles");
	});

	it("fetches individual article", async () => {
		const result = await handleDevTo("https://dev.to/ben/test", 20000);
		// May return null if article doesn't exist, but should not throw
		if (result !== null) {
			expect(result.method).toBe("devto");
			expect(result.contentType).toBe("text/markdown");
		}
		expect(result).toBeDefined();
	});

	it("handles tag with extra segments", async () => {
		const result = await handleDevTo("https://dev.to/t/webdev/top/week", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("devto");
		expect(result?.content).toContain("dev.to/t/webdev");
	});
});

// =============================================================================
// GitLab Tests
// =============================================================================

describe.skipIf(SKIP)("handleGitLab", () => {
	it("returns null for non-GitLab URLs", async () => {
		const result = await handleGitLab("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("returns null for github.com", async () => {
		const result = await handleGitLab("https://github.com/user/repo", 10000);
		expect(result).toBeNull();
	});

	it("fetches repository root", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-repo");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Stars:");
		expect(result?.content).toContain("Forks:");
	});

	it("fetches another repository", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab-runner", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-repo");
	});

	it("fetches file blob", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab/-/blob/master/README.md", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-raw");
		expect(result?.contentType).toBe("text/plain");
		expect(result?.content.length).toBeGreaterThan(0);
	});

	it("fetches directory tree", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab/-/tree/master", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-tree");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Directory:");
	});

	it("fetches issue", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab/-/issues/1", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-issue");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Issue #1:");
		expect(result?.content).toContain("State:");
	});

	it("fetches merge request", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab/-/merge_requests/1", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-mr");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("MR !1:");
		expect(result?.content).toContain("State:");
	});

	it("returns null for invalid URL structure", async () => {
		const result = await handleGitLab("https://gitlab.com/", 10000);
		expect(result).toBeNull();
	});

	it("returns null for malformed paths", async () => {
		const result = await handleGitLab("https://gitlab.com/user", 10000);
		expect(result).toBeNull();
	});
});
