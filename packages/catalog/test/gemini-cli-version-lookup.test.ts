import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	DEFAULT_GEMINI_CLI_VERSION,
	ensureGeminiCliVersion,
	getGeminiCliHeaders,
	getGeminiCliUserAgent,
	getGeminiCliVersion,
	resetGeminiCliVersionForTest,
} from "@oh-my-pi/pi-catalog/wire/gemini-headers";

const savedVersion = process.env.PI_AI_GEMINI_CLI_VERSION;

function distTagsFetch(respond: () => Promise<Response>): { fetcher: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetcher = Object.assign(
		(input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
			urls.push(String(input));
			return respond();
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetcher, urls };
}

describe("Gemini CLI version lookup", () => {
	beforeEach(() => {
		delete process.env.PI_AI_GEMINI_CLI_VERSION;
		resetGeminiCliVersionForTest();
	});

	afterEach(() => {
		resetGeminiCliVersionForTest();
		if (savedVersion === undefined) delete process.env.PI_AI_GEMINI_CLI_VERSION;
		else process.env.PI_AI_GEMINI_CLI_VERSION = savedVersion;
	});

	it("reports the npm `latest` release of @google/gemini-cli in the User-Agent", async () => {
		const { fetcher, urls } = distTagsFetch(
			async () => new Response(JSON.stringify({ latest: "0.99.1", preview: "0.100.0-preview.0" }), { status: 200 }),
		);

		await ensureGeminiCliVersion(fetcher);

		expect(urls).toEqual(["https://registry.npmjs.org/-/package/@google/gemini-cli/dist-tags"]);
		expect(getGeminiCliVersion()).toBe("0.99.1");
		expect(getGeminiCliUserAgent("gemini-3.5-flash")).toBe(
			`GeminiCLI/0.99.1/gemini-3.5-flash (${process.platform}; ${process.arch}; terminal)`,
		);
		expect(getGeminiCliHeaders()["User-Agent"]).toStartWith("GeminiCLI/0.99.1/gemini-3.1-pro-preview (");
	});

	it("falls back to the pinned version when the registry fails", async () => {
		const { fetcher } = distTagsFetch(async () => new Response("unavailable", { status: 503 }));

		await ensureGeminiCliVersion(fetcher);

		expect(getGeminiCliVersion()).toBe(DEFAULT_GEMINI_CLI_VERSION);
		expect(getGeminiCliUserAgent()).toStartWith(`GeminiCLI/${DEFAULT_GEMINI_CLI_VERSION}/`);
	});

	it("skips the lookup when PI_AI_GEMINI_CLI_VERSION is set", async () => {
		process.env.PI_AI_GEMINI_CLI_VERSION = "0.1.2";
		const { fetcher, urls } = distTagsFetch(async () => new Response(JSON.stringify({ latest: "0.99.1" })));

		await ensureGeminiCliVersion(fetcher);

		expect(urls).toHaveLength(0);
		expect(getGeminiCliUserAgent()).toStartWith("GeminiCLI/0.1.2/");
	});
});
