import { afterAll, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchPublicWeb } from "@oh-my-pi/pi-coding-agent/web/search/providers/public";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);

function requirePublicModel() {
	const model = modelRegistry.find("web", "public");
	if (!model) throw new Error("Expected bundled web/public model");
	return model;
}

const publicModel = requirePublicModel();

afterAll(() => {
	authStorage.close();
});

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage,
		model: publicModel,
		modelRegistry,
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

/** Dispatch fixtures for every public engine; secondary engines deterministically return no results or fail. */
function makeFetchMock(
	bodies: { ddg: string; google: string },
	seen?: Set<string>,
	secondaryResult: "empty" | "failure" = "empty",
): FetchImpl {
	return input => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.includes("duckduckgo.com")) {
			seen?.add("duckduckgo");
			return Promise.resolve(new Response(bodies.ddg, { status: 200 }));
		}
		if (url.includes("google.com")) {
			seen?.add("google");
			return Promise.resolve(new Response(bodies.google, { status: 200 }));
		}
		const secondary = [
			["startpage.com", "startpage"],
			["ecosia.org", "ecosia"],
			["mojeek.de", "mojeek"],
		] as const;
		for (const [host, engine] of secondary) {
			if (!url.includes(host)) continue;
			seen?.add(engine);
			return Promise.resolve(new Response("", { status: secondaryResult === "empty" ? 200 : 503 }));
		}
		return Promise.reject(new Error(`Unexpected fetch in public web test: ${url}`));
	};
}

const GOOGLE_CHALLENGE = `<html><body>Our systems have detected unusual traffic from your computer network.</body></html>`;
const DDG_CHALLENGE = `<html><body><div class="anomaly-modal"></div></body></html>`;

describe("Public Web aggregate provider", () => {
	it("consolidates engines: dedups URL variants, ranks by consensus, keeps the best snippet", async () => {
		const seen = new Set<string>();
		const fetchMock = makeFetchMock(
			{
				ddg: [
					ddgResult("https://example.com/shared", "Shared result", "short"),
					ddgResult("https://a.example/one", "Alpha", "alpha snippet"),
				].join("\n"),
				google: [
					googleResult("https://www.example.com/shared/", "Shared (google)", "a much longer consolidated snippet"),
					googleResult("https://c.example/three", "Gamma", "gamma snippet"),
				].join("\n"),
			},
			seen,
		);

		const response = await searchPublicWeb(makeParams("consensus ranking", fetchMock));
		expect(seen).toEqual(new Set(["startpage", "google", "duckduckgo", "ecosia", "mojeek"]));

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
		const fetchMock = makeFetchMock({
			ddg: ddgResult("https://a.example/one", "Alpha", "alpha snippet"),
			google: GOOGLE_CHALLENGE,
		});

		const response = await searchPublicWeb(makeParams("partial failure", fetchMock));

		expect(response.sources).toEqual([{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" }]);
	});

	it("returns at the soft deadline with delivered results and aborts stragglers", async () => {
		let stragglerAborted = false;
		const fetchMock: FetchImpl = (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				return Promise.resolve(
					new Response(ddgResult("https://a.example/one", "Alpha", "alpha snippet"), { status: 200 }),
				);
			}
			if (!["startpage.com", "google.com", "ecosia.org", "mojeek.de"].some(host => url.includes(host))) {
				return Promise.reject(new Error(`Unexpected fetch in public web test: ${url}`));
			}
			// Every other public engine hangs until the aggregate cancels its stragglers at the deadline.
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
		const fetchMock: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				await Bun.sleep(60);
				return new Response(ddgResult("https://a.example/one", "Alpha", "alpha snippet"), { status: 200 });
			}
			if (url.includes("google.com")) return new Response(GOOGLE_CHALLENGE, { status: 200 });
			if (["startpage.com", "ecosia.org", "mojeek.de"].some(host => url.includes(host))) {
				return new Response("fixture unavailable", { status: 503 });
			}
			throw new Error(`Unexpected fetch in public web test: ${url}`);
		};

		const response = await searchPublicWeb(makeParams("slow first success", fetchMock), { softMs: 10 });

		expect(response.sources).toEqual([{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" }]);
	});

	it("returns whatever it has at the hard deadline even with zero successes", async () => {
		const fetchMock: FetchImpl = input => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				return Promise.resolve(new Response(DDG_CHALLENGE, { status: 200 }));
			}
			if (!["startpage.com", "google.com", "ecosia.org", "mojeek.de"].some(host => url.includes(host))) {
				return Promise.reject(new Error(`Unexpected fetch in public web test: ${url}`));
			}
			// Every other public engine ignores abort; only the hard cap can end the wait.
			const { promise } = Promise.withResolvers<Response>();
			return promise;
		};

		const response = await searchPublicWeb(makeParams("hard cap", fetchMock), { softMs: 10, hardMs: 40 });

		expect(response.provider).toBe("public");
		expect(response.sources).toEqual([]);
	});

	it("fails with an aggregated provider-tagged error when every engine fails", async () => {
		const fetchMock = makeFetchMock({ ddg: DDG_CHALLENGE, google: GOOGLE_CHALLENGE }, undefined, "failure");

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
});
