import { describe, expect, it } from "bun:test";
import { buildBrowserNavigationHeaders } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-headers";

const CHROME_FALLBACK_HEADERS: Record<string, string> = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "max-age=0",
	Priority: "u=0, i",
	"Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"macOS"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

describe("browser navigation headers", () => {
	it("returns the stable Mac Chrome profile when randomization is disabled", () => {
		expect(buildBrowserNavigationHeaders({ randomized: false })).toEqual(CHROME_FALLBACK_HEADERS);
	});

	it("returns a complete randomized navigation profile", () => {
		const headers = buildBrowserNavigationHeaders();

		expect(headers["User-Agent"]).toMatch(/^Mozilla\/5\.0 /);
		expect(headers.Accept).toContain("text/html");
		expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
		expect(headers["Accept-Encoding"]).toContain("gzip");
		expect(headers["Upgrade-Insecure-Requests"]).toBe("1");
		expect(headers["Sec-Fetch-Dest"]).toBe("document");
		expect(headers["Sec-Fetch-Mode"]).toBe("navigate");
		expect(headers["Sec-Fetch-Site"]).toBe("none");
		expect(headers["Sec-Fetch-User"]).toBe("?1");
	});
});
