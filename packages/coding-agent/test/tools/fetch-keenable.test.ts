import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import {
	fetchKeenablePage,
	KEENABLE_FETCH_PUBLIC_URL,
	KEENABLE_FETCH_URL,
} from "@oh-my-pi/pi-coding-agent/web/keenable";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { asGlobalFetch, mockFetch } from "../helpers/fetch-mock";

const originalKeenableApiKey = process.env.KEENABLE_API_KEY;

describe("renderHtmlToText: Keenable reader", () => {
	afterEach(() => {
		if (originalKeenableApiKey === undefined) delete process.env.KEENABLE_API_KEY;
		else process.env.KEENABLE_API_KEY = originalKeenableApiKey;
	});

	const markdown = `# Authenticated article\n\n${"Substantive reader content. ".repeat(8)}`.trim();

	it("sends KEENABLE_API_KEY and live=true to the keyed fetch endpoint", async () => {
		process.env.KEENABLE_API_KEY = "env-keenable-key";
		const settings = Settings.isolated({ "providers.fetch": "keenable" });
		let requestUrl = "";
		let requestHeaders: Headers | undefined;
		const fetchMock = asGlobalFetch((input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			return new Response(JSON.stringify({ content: markdown }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await renderHtmlToText(
			"https://example.com/article",
			"<html><body>short</body></html>",
			1,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(result.method).toBe("keenable");
		expect(result.content).toBe(markdown);
		expect(requestUrl.startsWith(`${KEENABLE_FETCH_URL}?`)).toBe(true);
		const parsed = new URL(requestUrl);
		expect(parsed.searchParams.get("url")).toBe("https://example.com/article");
		expect(parsed.searchParams.get("live")).toBe("true");
		expect(requestHeaders?.get("x-api-key")).toBe("env-keenable-key");
	});

	it("uses the public fetch endpoint when explicitly selected without a key", async () => {
		delete process.env.KEENABLE_API_KEY;
		const settings = Settings.isolated({ "providers.fetch": "keenable" });
		let requestUrl = "";
		let requestHeaders: Headers | undefined;
		const fetchMock = asGlobalFetch((input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			return new Response(JSON.stringify({ content: markdown }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await renderHtmlToText(
			"https://example.com/article",
			"<html><body>short</body></html>",
			1,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(result.method).toBe("keenable");
		expect(requestUrl.startsWith(`${KEENABLE_FETCH_PUBLIC_URL}?`)).toBe(true);
		expect(requestHeaders?.get("x-api-key")).toBeNull();
		expect(requestHeaders?.get("x-keenable-title")).toBe(APP_NAME);
	});

	it("skips Keenable on auto when no key is configured so later backends can run", async () => {
		delete process.env.KEENABLE_API_KEY;
		const settings = Settings.isolated({ "providers.fetch": "auto" });
		let keenableCalled = false;
		const fetchMock = asGlobalFetch(input => {
			if (String(input).includes("api.keenable.ai")) keenableCalled = true;
			return new Response("nope", { status: 500 });
		});

		const result = await renderHtmlToText(
			"https://example.com/article",
			"<html><body><p>short</p></body></html>",
			1,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(keenableCalled).toBe(false);
		expect(result.method).not.toBe("keenable");
	});
});

describe("fetchKeenablePage", () => {
	it("returns null when a 200 response is not JSON", async () => {
		const result = await fetchKeenablePage({
			url: "https://example.com/article",
			apiKey: "test-keenable-key",
			fetch: mockFetch(() => new Response("not json", { status: 200 })),
		});
		expect(result).toBeNull();
	});
});
