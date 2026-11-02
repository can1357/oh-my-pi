import { describe, expect, it } from "bun:test";
import { handleMDN } from "@oh-my-pi/pi-coding-agent/web/scrapers/mdn";
import { handleReadTheDocs } from "@oh-my-pi/pi-coding-agent/web/scrapers/readthedocs";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleMDN", () => {
	it("returns null for non-MDN URLs", async () => {
		const result = await handleMDN("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for non-docs MDN URLs", async () => {
		const result = await handleMDN("https://developer.mozilla.org/en-US/", 20);
		expect(result).toBeNull();
	});

	it("fetches Array.map documentation", async () => {
		const result = await handleMDN(
			"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("mdn");
		expect(result?.content).toContain("map");
		expect(result?.contentType).toBe("text/markdown");
	});
});

describe.skipIf(SKIP)("handleReadTheDocs", () => {
	it("fetches requests docs", async () => {
		const result = await handleReadTheDocs("https://requests.readthedocs.io/en/latest/", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("readthedocs");
	});

	it("returns null for non-readthedocs sites", async () => {
		// These sites use Sphinx/RTD theme but aren't hosted on readthedocs.io
		expect(await handleReadTheDocs("https://www.sphinx-doc.org/en/master/", 20)).toBeNull();
		expect(await handleReadTheDocs("https://docs.pytest.org/en/stable/", 20)).toBeNull();
		expect(await handleReadTheDocs("https://pip.pypa.io/en/stable/", 20)).toBeNull();
	});
});
