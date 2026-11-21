import { afterEach, describe, expect, test, vi } from "bun:test";
import { handleGitHub } from "../../src/web/scrapers/github";

const item = {
	title: "Lifecycle example",
	number: 1,
	state: "closed",
	user: { login: "author" },
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-02T00:00:00Z",
	body: "The word merged in this description is not the lifecycle state.",
	labels: [],
	comments: 0,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GitHub lifecycle rendering", () => {
	test.each([
		{ state: "closed", merged: true, expected: "merged" },
		{ state: "closed", merged: false, expected: "closed" },
		{ state: "open", merged: false, expected: "open" },
	])("renders $expected pull requests with their lifecycle outcome", async ({ state, merged, expected }) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...item, state, merged }));

		const result = await handleGitHub("https://github.com/o/r/pull/1", 5);

		expect(result?.content.match(/^\*\*#1\*\* · (\w+) ·/m)?.[1]).toBe(expected);
	});

	test("keeps a closed issue distinct from a merged pull request", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(item));

		const result = await handleGitHub("https://github.com/o/r/issues/1", 5);

		expect(result?.content.match(/^\*\*#1\*\* · (\w+) ·/m)?.[1]).toBe("closed");
	});
});
