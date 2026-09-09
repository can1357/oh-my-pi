import { describe, expect, it } from "bun:test";
import { handleNvd } from "@oh-my-pi/pi-coding-agent/web/scrapers/nvd";
import { handleOsv } from "@oh-my-pi/pi-coding-agent/web/scrapers/osv";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleNvd", () => {
	it("returns null for non-NVD URLs", async () => {
		const result = await handleNvd("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for NVD URLs without CVE detail path", async () => {
		const result = await handleNvd("https://nvd.nist.gov/", 20);
		expect(result).toBeNull();
	});

	it("returns null for NVD search URLs", async () => {
		const result = await handleNvd("https://nvd.nist.gov/vuln/search/results?query=log4j", 20);
		expect(result).toBeNull();
	});

	it("fetches CVE-2021-44228 (Log4Shell)", async () => {
		const result = await handleNvd("https://nvd.nist.gov/vuln/detail/CVE-2021-44228", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("nvd");
		expect(result?.content).toContain("CVE-2021-44228");
		expect(result?.content).toContain("Log4j");
		expect(result?.content).toContain("CVSS");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches CVE-2014-0160 (Heartbleed)", async () => {
		const result = await handleNvd("https://nvd.nist.gov/vuln/detail/CVE-2014-0160", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("nvd");
		expect(result?.content).toContain("CVE-2014-0160");
		expect(result?.content).toContain("OpenSSL");
	});

	it("handles lowercase CVE IDs", async () => {
		const result = await handleNvd("https://nvd.nist.gov/vuln/detail/cve-2021-44228", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("nvd");
		expect(result?.content).toContain("CVE-2021-44228");
	});
});

describe.skipIf(SKIP)("handleOsv", () => {
	it("returns null for non-OSV URLs", async () => {
		const result = await handleOsv("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for OSV homepage", async () => {
		const result = await handleOsv("https://osv.dev/", 20);
		expect(result).toBeNull();
	});

	it("returns null for OSV list URLs", async () => {
		const result = await handleOsv("https://osv.dev/list", 20);
		expect(result).toBeNull();
	});

	it("fetches GHSA-jfh8-c2jp-5v3q (log4j RCE)", async () => {
		const result = await handleOsv("https://osv.dev/vulnerability/GHSA-jfh8-c2jp-5v3q", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("osv");
		expect(result?.content).toContain("GHSA-jfh8-c2jp-5v3q");
		expect(result?.content).toContain("log4j");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches CVE-2021-44228 via OSV", async () => {
		const result = await handleOsv("https://osv.dev/vulnerability/CVE-2021-44228", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("osv");
		expect(result?.content).toContain("CVE-2021-44228");
	});

	it("fetches PYSEC vulnerability", async () => {
		// PYSEC-2021-19 is a well-known pillow vulnerability
		const result = await handleOsv("https://osv.dev/vulnerability/PYSEC-2021-19", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("osv");
		expect(result?.content).toContain("PYSEC-2021-19");
		expect(result?.content).toContain("Affected Packages");
	});

	it("fetches RUSTSEC vulnerability", async () => {
		// RUSTSEC-2021-0119 is a well-known actix-web vulnerability
		const result = await handleOsv("https://osv.dev/vulnerability/RUSTSEC-2021-0119", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("osv");
		expect(result?.content).toContain("RUSTSEC-2021-0119");
	});
});
