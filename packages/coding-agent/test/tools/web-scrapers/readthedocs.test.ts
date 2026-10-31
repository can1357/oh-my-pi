import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleReadTheDocs } from "@oh-my-pi/pi-coding-agent/web/scrapers/readthedocs";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";

const PAGE_URL = "https://niquests.readthedocs.io/en/v3.18.5/user/quickstart.html";

function pageHtml(editHref: string): string {
	return `<html><body><div class="document"><h1>Quickstart</h1><p>Versioned v3.18.5 quickstart content.</p></div><a href="${editHref}">Edit on GitHub</a></body></html>`;
}

function stubLoadPage(pageBody: string, rawBody: string) {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => {
		if (requestedUrl.includes("github.com")) {
			return {
				ok: true,
				status: 200,
				finalUrl: requestedUrl,
				contentType: "text/plain",
				content: rawBody,
			};
		}
		return {
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/html",
			content: pageBody,
		};
	});
}

describe("handleReadTheDocs versioned source guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to versioned HTML when the Edit link targets another branch", async () => {
		// Regression for #16835: a /en/v3.18.5/ page whose Edit link points at
		// blob/main must keep the requested version's HTML, not main's source.
		const loadPage = stubLoadPage(
			pageHtml("https://github.com/jawah/niquests/blob/main/docs/user/quickstart.rst"),
			"MAIN BRANCH RST SOURCE",
		);

		const result = await handleReadTheDocs(PAGE_URL, 20);

		expect(result).not.toBeNull();
		expect(result?.method).toBe("readthedocs");
		expect(result?.contentType).toBe("text/html");
		expect(result?.content).toContain("Versioned v3.18.5");
		expect(result?.content).not.toContain("MAIN BRANCH RST SOURCE");
		expect(result?.notes.join("\n")).not.toContain("Fetched raw source");
		expect(loadPage).toHaveBeenCalledTimes(1);
	});

	it("fetches raw source when the Edit link ref matches the requested version", async () => {
		stubLoadPage(
			pageHtml("https://github.com/jawah/niquests/blob/v3.18.5/docs/user/quickstart.rst"),
			"VERSIONED RAW SOURCE",
		);

		const result = await handleReadTheDocs(PAGE_URL, 20);

		expect(result?.contentType).toBe("text/plain");
		expect(result?.content).toContain("VERSIONED RAW SOURCE");
	});

	it("fetches raw source for floating latest versions", async () => {
		stubLoadPage(
			pageHtml("https://github.com/jawah/niquests/blob/main/docs/user/quickstart.rst"),
			"MAIN BRANCH RST SOURCE",
		);

		const result = await handleReadTheDocs("https://niquests.readthedocs.io/en/latest/user/quickstart.html", 20);

		expect(result?.contentType).toBe("text/plain");
		expect(result?.content).toContain("MAIN BRANCH RST SOURCE");
	});
});
