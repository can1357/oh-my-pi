import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { openaiCodexModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	CODEX_CLIENT_VERSION,
	ensureCodexClientVersion,
	getCodexClientVersion,
	resetCodexClientVersionForTest,
} from "@oh-my-pi/pi-catalog/wire/codex";

const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@openai/codex/dist-tags";
const savedVersion = process.env.PI_AI_CODEX_VERSION;

interface CapturedRequest {
	url: string;
	version: string | null;
}

/** Serves npm dist-tags and a one-model Codex roster, recording every request. */
function codexFetch(latest: () => Response): { fetcher: FetchImpl; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetcher = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = String(input);
			requests.push({ url, version: new Headers(init?.headers).get("version") });
			if (url === DIST_TAGS_URL) return latest();
			return new Response(JSON.stringify({ models: [{ slug: "gpt-6.1-terra", visibility: "list" }] }));
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetcher, requests };
}

const distTags = (latest: string) => () => new Response(JSON.stringify({ latest, alpha: `${latest}-alpha.1` }));

describe("Codex client version lookup", () => {
	beforeEach(() => {
		delete process.env.PI_AI_CODEX_VERSION;
		resetCodexClientVersionForTest();
	});

	afterEach(() => {
		resetCodexClientVersionForTest();
		if (savedVersion === undefined) delete process.env.PI_AI_CODEX_VERSION;
		else process.env.PI_AI_CODEX_VERSION = savedVersion;
	});

	it("adopts the npm `latest` release of @openai/codex", async () => {
		const { fetcher, requests } = codexFetch(distTags("0.999.1"));

		await ensureCodexClientVersion(fetcher);

		expect(requests.map(request => request.url)).toEqual([DIST_TAGS_URL]);
		expect(getCodexClientVersion()).toBe("0.999.1");
	});

	it("falls back to the pinned version when the registry fails", async () => {
		const { fetcher } = codexFetch(() => new Response("unavailable", { status: 503 }));

		await ensureCodexClientVersion(fetcher);

		expect(getCodexClientVersion()).toBe(CODEX_CLIENT_VERSION);
	});

	it("skips the lookup when PI_AI_CODEX_VERSION is set", async () => {
		process.env.PI_AI_CODEX_VERSION = "0.1.2";
		const { fetcher, requests } = codexFetch(distTags("0.999.1"));

		await ensureCodexClientVersion(fetcher);

		expect(requests).toHaveLength(0);
		expect(getCodexClientVersion()).toBe("0.1.2");
	});

	it("asks /models with the npm version in both `client_version` and the `version` header", async () => {
		const { fetcher, requests } = codexFetch(distTags("0.999.1"));

		const result = await fetchCodexModels({ accessToken: "test-token", fetchFn: fetcher });

		expect(result?.models.map(model => model.id)).toEqual(["gpt-6.1-terra"]);
		expect(requests).toEqual([
			{ url: DIST_TAGS_URL, version: null },
			{ url: "https://chatgpt.com/backend-api/codex/models?client_version=0.999.1", version: "0.999.1" },
		]);
	});

	it("keeps an explicit discovery client version without consulting npm", async () => {
		const { fetcher, requests } = codexFetch(distTags("0.999.1"));

		await fetchCodexModels({ accessToken: "test-token", clientVersion: "0.150.0", fetchFn: fetcher });

		expect(requests).toEqual([
			{ url: "https://chatgpt.com/backend-api/codex/models?client_version=0.150.0", version: "0.150.0" },
		]);
	});

	it("keeps the model cache namespace on the pin while discovery sends the npm version", async () => {
		const pinned = resolveModelCacheProviderId("openai-codex");
		const { fetcher, requests } = codexFetch(distTags("0.999.1"));

		await fetchCodexModels({ accessToken: "test-token", fetchFn: fetcher });

		expect(requests.at(-1)?.version).toBe("0.999.1");
		expect(resolveModelCacheProviderId("openai-codex")).toBe(pinned);
		expect(openaiCodexModelManagerOptions().cacheProviderId).toBe(`openai-codex:${CODEX_CLIENT_VERSION}`);
	});
});
