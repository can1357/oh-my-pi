import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { setExcludedSearchProviders } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchPublicWeb } from "@oh-my-pi/pi-coding-agent/web/search/providers/public";
import { SearchProviderError, type SearchProviderId } from "@oh-my-pi/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("Public web search must not request API keys");
	},
	resolver() {
		throw new Error("Public web search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("Public web search must not check auth");
	},
} as unknown as AuthStorage;

/** Restrict the fan-out to the two engines these tests provide fixtures for. */
const NON_TEST_ENGINES: readonly SearchProviderId[] = ["ecosia", "startpage", "mojeek"];

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Public web search test prompt",
		fetch,
	};
}

function ddgResult(url: string, title: string, snippet?: string): string {
	return `<div class="result results_links results_links_deep web-result">
		<a class="result__a" href="${url}">${title}</a>
		${snippet ? `<a class="result__snippet" href="${url}">${snippet}</a>` : ""}
	</div>`;
}

function googleResult(url: string, title: string, snippet?: string): string {
	return `<div class="MjjYud"><div class="tF2Cxc">
		<a href="${url}"><h3>${title}</h3></a>
		${snippet ? `<div data-sncf="1"><div class="VwiC3b">${snippet}</div></div>` : ""}
	</div></div>`;
}

/** Dispatch fixture bodies per engine host. */
function makeFetchMock(bodies: { ddg: string; google: string }): FetchImpl {
	return input => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.includes("duckduckgo.com")) {
			return Promise.resolve(new Response(bodies.ddg, { status: 200 }));
		}
		if (url.includes("google.com")) {
			return Promise.resolve(new Response(bodies.google, { status: 200 }));
		}
		return Promise.reject(new Error(`Unexpected fetch in public web test: ${url}`));
	};
}

const GOOGLE_CHALLENGE = `<html><body>Our systems have detected unusual traffic from your computer network.</body></html>`;
const DDG_CHALLENGE = `<html><body><div class="anomaly-modal"></div></body></html>`;

afterEach(() => {
	setExcludedSearchProviders([]);
});

describe("Public Web aggregate provider", () => {
	it("consolidates engines: dedups URL variants, ranks by consensus, keeps the best snippet", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock = makeFetchMock({
			ddg: [
				ddgResult("https://example.com/shared", "Shared result", "short"),
				ddgResult("https://a.example/one", "Alpha", "alpha snippet"),
			].join("\n"),
			google: [
				googleResult("https://www.example.com/shared/", "Shared (google)", "a much longer consolidated snippet"),
				googleResult("https://c.example/three", "Gamma", "gamma snippet"),
			].join("\n"),
		});

		const response = await searchPublicWeb(makeParams("consensus ranking", fetchMock));

		expect(response.provider).toBe("public");
		expect(response.sources).toEqual([
			// Two-engine consensus outranks single-engine results; www/trailing-slash
			// variants merge. Google merges first (higher tiebreak priority), so its
			// title/url win the equal-rank tie; the longer snippet wins regardless.
			{
				title: "Shared (google)",
				url: "https://www.example.com/shared/",
				snippet: "a much longer consolidated snippet",
			},
			{ title: "Gamma", url: "https://c.example/three", snippet: "gamma snippet" },
			{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" },
		]);
	});

	it("tolerates individual engine failures and returns the surviving results", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock = makeFetchMock({
			ddg: ddgResult("https://a.example/one", "Alpha", "alpha snippet"),
			google: GOOGLE_CHALLENGE,
		});

		const response = await searchPublicWeb(makeParams("partial failure", fetchMock));

		expect(response.sources).toEqual([{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" }]);
	});

	it("returns at the soft deadline with delivered results and aborts stragglers", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		let stragglerAborted = false;
		const fetchMock: FetchImpl = (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				return Promise.resolve(
					new Response(ddgResult("https://a.example/one", "Alpha", "alpha snippet"), { status: 200 }),
				);
			}
			// google: hangs until the aggregate cancels it at the deadline.
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => {
				stragglerAborted = true;
				reject(new Error("aborted"));
			});
			return promise;
		};

		const response = await searchPublicWeb(makeParams("deadline race", fetchMock), { softMs: 50 });

		expect(response.sources).toEqual([{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" }]);
		expect(stragglerAborted).toBe(true);
	});

	it("waits past the soft deadline for the first success instead of returning empty", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				await Bun.sleep(60);
				return new Response(ddgResult("https://a.example/one", "Alpha", "alpha snippet"), { status: 200 });
			}
			return new Response(GOOGLE_CHALLENGE, { status: 200 });
		};

		const response = await searchPublicWeb(makeParams("slow first success", fetchMock), { softMs: 10 });

		expect(response.sources).toEqual([{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" }]);
	});

	it("returns whatever it has at the hard deadline even with zero successes", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock: FetchImpl = input => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				return Promise.resolve(new Response(DDG_CHALLENGE, { status: 200 }));
			}
			// google: never settles and ignores abort — only the hard cap can end the wait.
			const { promise } = Promise.withResolvers<Response>();
			return promise;
		};

		const response = await searchPublicWeb(makeParams("hard cap", fetchMock), { softMs: 10, hardMs: 40 });

		expect(response.provider).toBe("public");
		expect(response.sources).toEqual([]);
	});

	it("fails with an aggregated provider-tagged error when every engine fails", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock = makeFetchMock({ ddg: DDG_CHALLENGE, google: GOOGLE_CHALLENGE });

		try {
			await searchPublicWeb(makeParams("all blocked", fetchMock));
			expect.unreachable("all-engine failure should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			const providerError = error as SearchProviderError;
			expect(providerError.provider).toBe("public");
			expect(providerError.status).toBe(503);
			expect(providerError.message).toContain("duckduckgo:");
			expect(providerError.message).toContain("google:");
		}
	});

	it("rejects when settings exclude every credential-free engine", async () => {
		setExcludedSearchProviders([...NON_TEST_ENGINES, "duckduckgo", "google"]);
		const fetchMock: FetchImpl = () => Promise.reject(new Error("no engine should be queried"));

		try {
			await searchPublicWeb(makeParams("nothing left", fetchMock));
			expect.unreachable("fully excluded fan-out should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "public", status: 400 });
		}
	});
});
