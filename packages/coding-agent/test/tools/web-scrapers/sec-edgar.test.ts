import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleSecEdgar } from "@oh-my-pi/pi-coding-agent/web/scrapers/sec-edgar";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";

const COMPANY = {
	cik: "0002120882",
	name: "Example Holdings Ltd",
	tickers: [],
	exchanges: [],
	addresses: { business: {}, mailing: {} },
	filings: {
		recent: {
			accessionNumber: ["0001193125-26-356133"],
			filingDate: ["2026-09-28"],
			reportDate: [""],
			acceptanceDateTime: [""],
			form: ["6-K"],
			primaryDocument: ["d428222d6k.htm"],
			primaryDocDescription: ["6-K"],
		},
	},
};

function stubSubmissions() {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType: "application/json",
		content: JSON.stringify(COMPANY),
	}));
}

describe("handleSecEdgar Archives URLs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves filing documents and filing folders to the generic reader", async () => {
		const loadPage = stubSubmissions();
		for (const url of [
			"https://www.sec.gov/Archives/edgar/data/2120882/000119312526356133/d428222d6k.htm",
			"https://www.sec.gov/Archives/edgar/data/2120882/000119312526356133/",
		]) {
			expect(await handleSecEdgar(url, 20)).toBeNull();
		}
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("renders the company profile for the company's filing directory", async () => {
		const loadPage = stubSubmissions();
		const result = await handleSecEdgar("https://www.sec.gov/Archives/edgar/data/2120882/", 20);
		expect(loadPage.mock.calls[0]?.[0]).toBe("https://data.sec.gov/submissions/CIK0002120882.json");
		expect(result?.method).toBe("sec-edgar");
		expect(result?.content).toContain("# Example Holdings Ltd");
	});
});
