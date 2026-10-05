import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleGitHub } from "../../src/web/scrapers/github";

const realFetch = globalThis.fetch;

function stubGitHubApi(routes: Record<string, unknown>): void {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const path = url.replace("https://api.github.com", "");
		if (!(path in routes)) return new Response("not found", { status: 404 });
		return Response.json(routes[path]);
	}) as typeof fetch;
}

describe("GitHub scraper with deleted (null) authors", () => {
	beforeEach(() => {
		globalThis.fetch = realFetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("renders issue and comment authored by deleted accounts as @ghost", async () => {
		stubGitHubApi({
			"/repos/o/r/issues/1": {
				title: "Orphaned issue",
				number: 1,
				state: "open",
				user: null,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-02T00:00:00Z",
				body: "body",
				labels: [],
				comments: 1,
				html_url: "https://github.com/o/r/issues/1",
			},
			"/repos/o/r/issues/1/comments?per_page=100&page=1": [
				{ user: null, created_at: "2026-01-03T00:00:00Z", body: "orphaned comment" },
			],
		});

		const result = await handleGitHub("https://github.com/o/r/issues/1", 5);
		expect(result?.content).toContain("opened by @ghost");
		expect(result?.content).toContain("### @ghost · 2026-01-03T00:00:00Z");
	});

	test("renders issue-list entries authored by deleted accounts as @ghost", async () => {
		stubGitHubApi({
			"/repos/o/r/issues?state=open&per_page=30": [
				{
					number: 2,
					title: "Orphaned list entry",
					state: "open",
					user: null,
					created_at: "2026-01-01T00:00:00Z",
					comments: 0,
					labels: [],
				},
			],
		});

		const result = await handleGitHub("https://github.com/o/r/issues", 5);
		expect(result?.content).toContain("by @ghost · 0 comments");
	});
});
