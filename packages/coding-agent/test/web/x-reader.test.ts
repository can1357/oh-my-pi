import { describe, expect, it } from "bun:test";
import { parseXUrl, type XTarget } from "@oh-my-pi/pi-coding-agent/web/x";

describe("parseXUrl", () => {
	it.each<[string, XTarget | null]>([
		["https://x.com/jack/status/20/photo/1", { kind: "post", id: "20" }],
		["https://twitter.com/i/web/status/20", { kind: "post", id: "20" }],
		["https://mobile.x.com/jack", { kind: "profile", handle: "jack", tab: "posts" }],
		["https://x.com/jack/with_replies", { kind: "profile", handle: "jack", tab: "replies" }],
		["https://x.com/search?q=omp%20tern&f=live", { kind: "search", query: "omp tern", latest: true }],
		["https://x.com/search?q=omp&f=media", { kind: "search", query: "omp filter:media", latest: true }],
		["https://x.com/search?q=can&f=user", { kind: "users", query: "can" }],
		["https://x.com/hashtag/rustlang", { kind: "search", query: "#rustlang", latest: false }],
		["https://x.com/home", { kind: "unsupported" }],
		["https://x.com/jack/followers", { kind: "unsupported" }],
		["https://developer.x.com/en/docs", null],
		["https://example.com/jack/status/20", null],
	])("classifies %s", (url, target) => {
		expect(parseXUrl(url)).toEqual(target);
	});
});
