import { describe, expect, it } from "bun:test";
import { handleOpenCorporates } from "@oh-my-pi/pi-coding-agent/web/scrapers/opencorporates";
import { handleSecEdgar } from "@oh-my-pi/pi-coding-agent/web/scrapers/sec-edgar";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleSecEdgar", () => {
	it("returns null for non-matching URLs", async () => {
		const result = await handleSecEdgar("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for SEC URLs without valid CIK", async () => {
		const result = await handleSecEdgar("https://www.sec.gov/about.html", 20);
		expect(result).toBeNull();
	});

	it("fetches Apple Inc filings by CIK query param", async () => {
		const result = await handleSecEdgar(
			"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("sec-edgar");
		expect(result?.content).toMatch(/apple inc/i);
		expect(result?.content).toContain("0000320193");
		expect(result?.content).toContain("10-K"); // Apple files 10-K annually
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches via data.sec.gov submissions URL", async () => {
		const result = await handleSecEdgar("https://data.sec.gov/submissions/CIK0000320193.json", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("sec-edgar");
		expect(result?.content).toMatch(/apple inc/i);
	});

	it("fetches via Archives path", async () => {
		// Any filing URL with CIK in Archives path
		const result = await handleSecEdgar(
			"https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("sec-edgar");
		expect(result?.content).toMatch(/apple inc/i);
	});
});

describe.skipIf(SKIP)("handleOpenCorporates", () => {
	it("returns null for non-matching URLs", async () => {
		const result = await handleOpenCorporates("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for OpenCorporates URLs without company path", async () => {
		const result = await handleOpenCorporates("https://opencorporates.com/about", 20);
		expect(result).toBeNull();
	});

	it("fetches Apple Inc Delaware registration", async () => {
		const result = await handleOpenCorporates("https://opencorporates.com/companies/us_de/2927442", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("opencorporates");
		expect(result?.content).toContain("2927442");
		expect(result?.content).toContain("US_DE");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches Microsoft Corporation", async () => {
		// Microsoft is registered in Washington state
		const result = await handleOpenCorporates("https://opencorporates.com/companies/us_wa/600413485", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("opencorporates");
		expect(result?.content).toContain("600413485");
		expect(result?.content).toContain("US_WA");
	});
});
