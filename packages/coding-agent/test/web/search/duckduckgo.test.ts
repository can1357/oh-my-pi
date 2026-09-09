import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { localeToKl, searchDuckDuckGo } from "@oh-my-pi/pi-coding-agent/web/search/providers/duckduckgo";
import { parseSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search/query";

describe("localeToKl", () => {
	it("maps standard region-qualified locales to documented DDG codes", () => {
		expect(localeToKl("de-de")).toBe("de-de");
		expect(localeToKl("fr-fr")).toBe("fr-fr");
		expect(localeToKl("en-us")).toBe("us-en");
		expect(localeToKl("pt-br")).toBe("br-pt");
		expect(localeToKl("zh-cn")).toBe("cn-zh");
	});

	it("maps locales with provider-specific DDG codes", () => {
		expect(localeToKl("en-gb")).toBe("uk-en");
		expect(localeToKl("ja-jp")).toBe("jp-jp");
		expect(localeToKl("ko-kr")).toBe("kr-kr");
		expect(localeToKl("zh-hk")).toBe("hk-tzh");
		expect(localeToKl("zh-tw")).toBe("tw-tzh");
	});

	it("normalizes case and underscore separators", () => {
		expect(localeToKl("EN_US")).toBe("us-en");
		expect(localeToKl("De-DE")).toBe("de-de");
	});

	it("returns undefined for unsupported, language-only, empty, or malformed values", () => {
		expect(localeToKl(undefined)).toBeUndefined();
		expect(localeToKl("de")).toBeUndefined();
		expect(localeToKl("en")).toBeUndefined();
		expect(localeToKl("en-jp")).toBeUndefined();
		expect(localeToKl("zz-zz")).toBeUndefined();
		expect(localeToKl("english")).toBeUndefined();
		expect(localeToKl("")).toBeUndefined();
	});
});

describe("searchDuckDuckGo kl parameter (integration)", () => {
	const fakeAuthStorage = {} as unknown as AuthStorage;

	async function effectiveForm(query: string, opts: { withParsedQuery?: boolean } = {}): Promise<URLSearchParams> {
		const withParsedQuery = opts.withParsedQuery ?? true;
		let body: string | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			body = init?.body as string;
			return new Response("<html><body></body></html>", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		};
		await searchDuckDuckGo({
			query,
			parsedQuery: withParsedQuery ? parseSearchQuery(query) : undefined,
			systemPrompt: "",
			authStorage: fakeAuthStorage,
			fetch: fetchMock,
		});
		return new URLSearchParams(body ?? "");
	}

	it("honors the lang: directive so distinct locales produce distinct requests", async () => {
		const de = await effectiveForm("weather lang:de-de");
		const fr = await effectiveForm("weather lang:fr-fr");
		expect(de.get("q")).toBe("weather");
		expect(de.get("kl")).toBe("de-de");
		expect(fr.get("kl")).toBe("fr-fr");
	});

	it("uses DDG's provider-specific locale codes", async () => {
		const ja = await effectiveForm("news lang:ja-jp");
		const ko = await effectiveForm("news lang:ko-kr");
		const tw = await effectiveForm("news lang:zh-tw");
		expect(ja.get("kl")).toBe("jp-jp");
		expect(ko.get("kl")).toBe("kr-kr");
		expect(tw.get("kl")).toBe("tw-tzh");
	});

	it("falls back to us-en when no lang: directive is supplied", async () => {
		const form = await effectiveForm("weather");
		expect(form.get("kl")).toBe("us-en");
	});

	it("falls back to us-en for language-only locales", async () => {
		const form = await effectiveForm("weather lang:de");
		expect(form.get("kl")).toBe("us-en");
	});

	it("parses lang: from the raw query when parsedQuery is omitted (direct call)", async () => {
		const form = await effectiveForm("weather lang:de-de", { withParsedQuery: false });
		expect(form.get("q")).toBe("weather");
		expect(form.get("kl")).toBe("de-de");
	});
});
