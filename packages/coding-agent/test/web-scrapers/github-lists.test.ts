import { afterEach, describe, expect, test, vi } from "bun:test";
import { handleGitHub } from "../../src/web/scrapers/github";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GitHub issue lists and trees", () => {
	test("lists the issues the URL's q filters, sorted as it asks", async () => {
		const requests: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			requests.push(String(input));
			return Response.json({
				total_count: 1,
				items: [
					{
						number: 7,
						title: "Closed bug",
						state: "closed",
						user: { login: "a" },
						created_at: "2026-01-01T00:00:00Z",
						comments: 0,
						labels: [],
					},
				],
			});
		}) as typeof fetch);

		const result = await handleGitHub(
			"https://github.com/o/r/issues?q=is%3Aissue+is%3Aclosed+sort%3Aupdated-desc&page=2",
			5,
		);

		const request = new URL(requests[0]!);
		expect(request.pathname).toBe("/search/issues");
		expect(request.searchParams.get("q")).toBe("repo:o/r is:issue is:closed");
		expect(request.searchParams.get("sort")).toBe("updated");
		expect(request.searchParams.get("order")).toBe("desc");
		expect(request.searchParams.get("page")).toBe("2");
		expect(result?.content).toContain("**#7** (closed) Closed bug");
	});

	test("names the API failure when a tree cannot be listed", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.pathname === "/repos/o/r") return Response.json({ full_name: "o/r", default_branch: "main" });
			return Response.json({ message: "Not Found" }, { status: 404 });
		}) as typeof fetch);

		const result = await handleGitHub("https://github.com/o/r/tree/main/missing", 5);

		expect(result?.content).toContain("GitHub could not list missing at main: HTTP 404: Not Found");
	});
});
