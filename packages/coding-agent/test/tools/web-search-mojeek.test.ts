import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchMojeek } from "@oh-my-pi/pi-coding-agent/web/search/providers/mojeek";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("Mojeek search must not request API keys");
	},
	resolver() {
		throw new Error("Mojeek search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("Mojeek search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Mojeek search test prompt",
		fetch,
	};
}

/** One organic result row in the shape Mojeek's results page renders live. */
function resultItem(href: string, title: string, snippet?: string, liClass = "r1"): string {
	return `<li class="${liClass}"><a title="${href}" href="${href}" class="ob"><p class="i"><span class="url">${href}</span></p></a><h2><a class="title" title="${href}" href="${href}">${title}</a></h2>${snippet ? `<p class="s">${snippet}</p>` : ""}</li>`;
}

function resultsPage(items: string): string {
	return `<!DOCTYPE html><html><body><div class="results"><ul class="results-standard">${items}</ul></div></body></html>`;
}

describe("Mojeek web search provider", () => {
	it("requests the configured public search route with browser navigation headers, locale, count, and recency", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return Promise.resolve(
				new Response(resultsPage(resultItem("https://example.com/result", "Result", "Search snippet")), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);
		};

		const response = await searchMojeek({
			...makeParams("browser headers & parsing", fetchMock),
			numSearchResults: 99,
			recency: "week",
		});

		const url = new URL(capturedUrl);
		expect(url.origin + url.pathname).toBe("https://www.mojeek.de/search");
		expect(url.searchParams.get("q")).toBe("browser headers & parsing");
		expect(url.searchParams.get("t")).toBe("20");
		expect(url.searchParams.get("arc")).toBe("none");
		expect(url.searchParams.get("lang")).toBe("en");
		expect(url.searchParams.get("lb")).toBe("en");
		expect(url.searchParams.get("theme")).toBe("dark");
		expect(url.searchParams.get("since")).toBe("week");
		expect(capturedInit?.method).toBeUndefined();
		const headers = new Headers(capturedInit?.headers);
		expect(headers.get("accept")).toContain("text/html");
		expect(headers.get("user-agent")).toMatch(/Chrome\/\d+\.0\.0\.0/);
		expect(headers.get("referer")).toBe("https://www.mojeek.de/?arc=none&lang=en&lb=en&theme=dark");
		expect(headers.get("sec-fetch-dest")).toBe("document");
		expect(headers.get("sec-fetch-mode")).toBe("navigate");
		expect(headers.get("sec-fetch-site")).toBe("same-origin");
		expect(response.sources).toEqual([
			{ title: "Result", url: "https://example.com/result", snippet: "Search snippet" },
		]);
	});

	it("omits the since filter and requests the default count when recency is absent", async () => {
		let capturedUrl = "";
		const fetchMock: FetchImpl = input => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			return Promise.resolve(new Response(resultsPage(""), { status: 200 }));
		};

		await searchMojeek(makeParams("plain query", fetchMock));

		const url = new URL(capturedUrl);
		expect(url.searchParams.get("t")).toBe("10");
		expect(url.searchParams.get("since")).toBeNull();
	});

	it("re-emits supported operators (phrases, -, site:) and strips unsupported date bounds from the query", async () => {
		let capturedUrl = "";
		const fetchMock: FetchImpl = input => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			return Promise.resolve(new Response(resultsPage(""), { status: 200 }));
		};

		await searchMojeek(makeParams("independent index site:mojeek.com after:2024", fetchMock));

		const url = new URL(capturedUrl);
		expect(url.searchParams.get("q")).toBe("independent index site:mojeek.com");
	});

	it("parses result rows, deduplicates targets, and skips junk and intra-Mojeek rows", async () => {
		const html = resultsPage(
			[
				resultItem(
					"https://bun.sh/",
					"Bun &amp; friends — a <em>fast</em> runtime",
					"<strong>Bun</strong> is a <strong>JavaScript</strong>\n\t runtime. ... built from scratch.",
				),
				resultItem("https://bun.com/docs/runtime", "Bun Runtime - Bun", "Execute files with Bun.", "r2 clu-result"),
				resultItem("https://bun.sh/", "Duplicate of the first target", "duplicate"),
				`<li class="r4"><p class="s">Row without a title anchor is skipped</p></li>`,
				resultItem("/search?q=bun&s=11", "Next page"),
				resultItem("https://www.mojeek.com/about/", "About Mojeek"),
				resultItem("https://www.mojeek.de/about/", "German About Mojeek"),
				resultItem("https://example.com/bare", "Bare result without snippet"),
			].join(""),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchMojeek({ ...makeParams("bun", fetchMock), numSearchResults: 10 });

		expect(response.provider).toBe("mojeek");
		expect(response.sources).toEqual([
			{
				title: "Bun & friends — a fast runtime",
				url: "https://bun.sh/",
				snippet: "Bun is a JavaScript runtime. ... built from scratch.",
			},
			{
				title: "Bun Runtime - Bun",
				url: "https://bun.com/docs/runtime",
				snippet: "Execute files with Bun.",
			},
			{
				title: "Bare result without snippet",
				url: "https://example.com/bare",
				snippet: undefined,
			},
		]);
	});

	it("surfaces the ALTCHA captcha interstitial as a provider-tagged 429", async () => {
		const captcha = `<!DOCTYPE html><html><head><title>Captcha</title></head><body><div class="captcha-wrap"><div class="captcha-box"><h1>Verification required</h1><p>Please complete the challenge to continue.</p><form id="altcha-form" method="post" action="/captcha/verify"><altcha-widget id="altcha-widget" challenge="/captcha/challenge" name="altcha"></altcha-widget></form></div></div></body></html>`;
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(captcha, { status: 200 }));

		try {
			await searchMojeek(makeParams("blocked", fetchMock));
			expect.unreachable("Mojeek captcha interstitial should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "mojeek", status: 429 });
			expect((error as SearchProviderError).message).toContain("Mojeek");
		}
	});

	it("maps the 403 automated-queries wall to the robot 429 rather than a generic 403", async () => {
		const refusal = `<!DOCTYPE html><html><head><title>403 - Forbidden</title></head><body><h1>403 - Forbidden</h1><h2>Sorry your network appears to be sending automated queries so we can't process your search at this time.</h2></body></html>`;
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(refusal, { status: 403 }));

		try {
			await searchMojeek(makeParams("rate limited", fetchMock));
			expect.unreachable("Mojeek automated-queries wall should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "mojeek", status: 429 });
		}
	});
});
