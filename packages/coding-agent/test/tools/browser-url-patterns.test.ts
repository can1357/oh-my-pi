/**
 * URL patterns as `tab.waitForUrl`, `tab.waitForResponse` and the `tab.requests()` filter read them on every
 * backend: a string with `*` is a glob (as `tab.route()` takes), any other string a substring.
 */
import { describe, expect, it } from "bun:test";
import { parseUrlPattern } from "@oh-my-pi/pi-coding-agent/tools/browser/navigation";
import { matchesRequest, urlMatcher } from "@oh-my-pi/pi-coding-agent/tools/browser/network";

const PAGE_URL = "https://www.stardoll.com/en/starplaza.php";

describe("browser URL patterns", () => {
	it("matches a ** glob against the whole URL instead of searching for it as text", () => {
		// The glob never occurs in the URL as a substring, so a substring test waited out its whole timeout.
		const matches = urlMatcher(parseUrlPattern("**/starplaza.php"));
		expect(matches(PAGE_URL)).toBe(true);
		expect(matches("https://www.stardoll.com/en/starplaza.php?tab=sale")).toBe(false);
		expect(urlMatcher("https://*.stardoll.com/en/*")(PAGE_URL)).toBe(true);
		expect(urlMatcher("https://*.stardoll.com/*")(PAGE_URL)).toBe(false);
	});

	it("keeps a string without * a substring and a RegExp a RegExp", () => {
		expect(urlMatcher(parseUrlPattern("starplaza"))(PAGE_URL)).toBe(true);
		expect(urlMatcher(parseUrlPattern("/en/user/"))(PAGE_URL)).toBe(false);
		const sticky = /plaza/g;
		const matches = urlMatcher(parseUrlPattern(sticky));
		// A global RegExp's lastIndex must not make every other test fail.
		expect([matches(PAGE_URL), matches(PAGE_URL)]).toEqual([true, true]);
	});

	it("refuses a predicate before anything waits", () => {
		expect(() => parseUrlPattern((url: string) => url.includes("x"))).toThrow(/not a function/);
	});

	it("filters the request log with the same glob rule", () => {
		const record = {
			id: "1",
			seq: 1,
			ts: 0,
			method: "POST",
			url: "https://www.stardoll.com/en/com/user/photoContest.php",
			resourceType: "xhr",
			requestHeaders: {},
			sizes: {},
		};
		expect(matchesRequest(record, { filter: "**/photoContest.php" })).toBe(true);
		expect(matchesRequest(record, { filter: "photoContest" })).toBe(true);
		expect(matchesRequest(record, { filter: "**/buyItems.php" })).toBe(false);
	});
});
