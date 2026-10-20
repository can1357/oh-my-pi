import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { handleDiscourse } from "../../src/web/scrapers/discourse";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const origin = "https://meta.discourse.org";

// Recorded from meta.discourse.org (topic 184189, post 12) on 2026-10-14; no live network in tests.
const postFixture = await Bun.file(path.join(FIXTURES, "discourse-post-184189-12.json")).text();
const topicFixture = await Bun.file(path.join(FIXTURES, "discourse-topic-184189.json")).text();

let requested: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
	requested = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		requested.push(url);
		const pathname = new URL(url).pathname;
		const body =
			pathname === "/posts/by_number/184189/12.json"
				? postFixture
				: pathname === "/t/184189.json"
					? topicFixture
					: null;
		if (body === null) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
		return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("discourse post-number URLs", () => {
	test("a URL with a trailing post number returns that post's author, date and text first", async () => {
		const result = await handleDiscourse(`${origin}/t/community-network-visualisation/184189/12`, 5);
		expect(result).not.toBeNull();
		const content = result!.content;
		expect(requested.some(u => u.includes("/posts/by_number/184189/12.json"))).toBe(true);
		expect(content.startsWith("# Post 12 - Jakke Flemming (@Jagster) - 2021-09-08")).toBe(true);
		expect(content).toContain("No problem, take your time.");
		expect(content.indexOf("No problem, take your time.")).toBeLessThan(
			content.indexOf("Community Network Visualisation"),
		);
		expect(content).toContain("## Topic: Community Network Visualisation");
		// The topic's first post must not be dumped in place of the requested one.
		expect(content).not.toContain("## Posts");
	});

	test("slug-less /t/<topic>/<post> also resolves the post", async () => {
		const result = await handleDiscourse(`${origin}/t/184189/12`, 5);
		expect(result?.content).toContain("# Post 12 - Jakke Flemming");
	});

	test("negative control: a bare topic URL keeps the topic-from-post-1 output", async () => {
		const result = await handleDiscourse(`${origin}/t/community-network-visualisation/184189`, 5);
		expect(result).not.toBeNull();
		expect(requested.some(u => u.includes("/posts/by_number/"))).toBe(false);
		expect(result!.content.startsWith("# Community Network Visualisation")).toBe(true);
		expect(result!.content).toContain("## Posts");
		expect(result!.content).toContain("### Post 1 - ");
		expect(result!.content).not.toContain("No problem, take your time.");
	});
});
