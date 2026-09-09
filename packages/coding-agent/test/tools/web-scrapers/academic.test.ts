import { describe, expect, it } from "bun:test";
import { handleArxiv } from "@oh-my-pi/pi-coding-agent/web/scrapers/arxiv";
import { handleIacr } from "@oh-my-pi/pi-coding-agent/web/scrapers/iacr";
import { handlePubMed } from "@oh-my-pi/pi-coding-agent/web/scrapers/pubmed";
import { handleSemanticScholar } from "@oh-my-pi/pi-coding-agent/web/scrapers/semantic-scholar";
import type { RenderResult } from "@oh-my-pi/pi-coding-agent/web/scrapers/types";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleSemanticScholar", () => {
	it("fetches a known paper", async () => {
		// "Attention Is All You Need" paper
		const result = await handleSemanticScholar(
			"https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani-Shazeer/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("semantic-scholar");
		// API may be rate-limited or fail, verify handler structure
		if (
			!result?.content.includes("Too Many Requests") &&
			!result?.content.includes("Failed to fetch") &&
			!result?.content.includes("Failed to parse")
		) {
			expect(result?.content).toContain("Attention");
			expect(result?.contentType).toBe("text/markdown");
		}
		expect(result?.truncated).toBe(false);
	});

	it("handles invalid paper ID format", async () => {
		const result = await handleSemanticScholar("https://www.semanticscholar.org/paper/invalid", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("semantic-scholar");
		expect(result?.content).toContain("Failed to extract paper ID");
		expect(result?.notes).toContain("Invalid URL format");
	});

	it("extracts paper ID from various URL formats", async () => {
		const paperId = "204e3073870fae3d05bcbc2f6a8e263d9b72e776";
		const urls = [
			`https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani-Shazeer/${paperId}`,
			`https://www.semanticscholar.org/paper/${paperId}`,
		];

		for (const url of urls) {
			const result = await handleSemanticScholar(url, 20);
			expect(result).not.toBeNull();
			expect(result?.method).toBe("semantic-scholar");
			// API may be rate-limited or fail
			if (
				!result?.content.includes("Too Many Requests") &&
				!result?.content.includes("Failed to fetch") &&
				!result?.content.includes("Failed to parse")
			) {
				expect(result?.content).toContain("Attention");
			}
		}
	});

	it("includes metadata in formatted output", async () => {
		const result = await handleSemanticScholar(
			"https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani-Shazeer/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
			20,
		);
		expect(result).not.toBeNull();
		// Only check metadata if API call succeeded (not rate-limited)
		if (!result?.content.includes("Too Many Requests") && !result?.content.includes("Failed to fetch")) {
			expect(result?.content).toMatch(/Year:/);
			expect(result?.content).toMatch(/Citations:/);
			expect(result?.content).toMatch(/Authors:/);
			expect(result?.content).toContain("Vaswani");
		}
	});
});

describe.skipIf(SKIP)("handlePubMed", () => {
	let cachedKnownPubMed: RenderResult | null | undefined;

	const fetchKnownPubMed = async (): Promise<RenderResult | null> => {
		if (cachedKnownPubMed === undefined) {
			cachedKnownPubMed = await handlePubMed("https://pubmed.ncbi.nlm.nih.gov/33782455/", 20);
			if (cachedKnownPubMed === null) {
				cachedKnownPubMed = await handlePubMed("https://pubmed.ncbi.nlm.nih.gov/33782455/", 20);
			}
		}
		return cachedKnownPubMed;
	};

	it("fetches a known article from pubmed.ncbi.nlm.nih.gov", async () => {
		// PMID 33782455 - COVID-19 vaccine paper
		const result = await fetchKnownPubMed();
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pubmed");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.truncated).toBe(false);
	}, 60000);

	it("fetches from ncbi.nlm.nih.gov/pubmed format", async () => {
		const result = await handlePubMed("https://ncbi.nlm.nih.gov/pubmed/33782455", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pubmed");
	}, 20000);

	it("includes PMID in output", async () => {
		const result = await fetchKnownPubMed();
		expect(result).not.toBeNull();
		expect(result?.content).toContain("PMID:");
		expect(result?.content).toContain("33782455");
	});

	it("includes abstract section", async () => {
		const result = await fetchKnownPubMed();
		expect(result).not.toBeNull();
		expect(result?.content).toContain("## Abstract");
	});

	it("includes metadata fields", async () => {
		const result = await fetchKnownPubMed();
		expect(result).not.toBeNull();
		if (result?.content.includes("Authors:")) {
			expect(result.content).toMatch(/Journal:/);
		} else {
			expect(result?.content).toContain("PMID:");
		}
	});

	it("returns null for invalid PMID format", async () => {
		const result = await handlePubMed("https://pubmed.ncbi.nlm.nih.gov/invalid/", 20);
		expect(result).toBeNull();
	});

	it("handles non-existent PMID gracefully", async () => {
		const result = await handlePubMed("https://pubmed.ncbi.nlm.nih.gov/99999999999/", 20);
		// NCBI API returns a response even for non-existent PMIDs with minimal data
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pubmed");
	});
});

describe.skipIf(SKIP)("handleArxiv", () => {
	it("fetches a known paper", async () => {
		// "Attention Is All You Need" paper
		const result = await handleArxiv("https://arxiv.org/abs/1706.03762", 30000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("arxiv");
		expect(result?.contentType).toBe("text/markdown");
		// API may be rate-limited or fail
		if (!result?.content.includes("Too Many Requests") && !result?.content.includes("Failed to fetch")) {
			expect(result?.content).toContain("Attention");
			expect(result?.content).toContain("arXiv:");
			expect(result?.content).toContain("1706.03762");
		}
		expect(result?.truncated).toBe(false);
	});

	it("handles /pdf/ URLs", async () => {
		const result = await handleArxiv("https://arxiv.org/pdf/1706.03762", 30000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("arxiv");
		if (!result?.content.includes("Too Many Requests") && !result?.content.includes("Failed to fetch")) {
			expect(result?.content).toContain("Attention");
			expect(result?.notes?.some(n => n.includes("PDF"))).toBe(true);
		}
	});

	it("includes paper metadata", async () => {
		const result = await handleArxiv("https://arxiv.org/abs/1706.03762", 30000);
		expect(result).not.toBeNull();
		if (!result?.content.includes("Too Many Requests") && !result?.content.includes("Failed to fetch")) {
			expect(result?.content).toMatch(/Authors:/);
			expect(result?.content).toContain("Vaswani");
			expect(result?.content).toMatch(/Abstract/);
			expect(result?.content).toMatch(/Published:/);
		}
	});
});

describe.skipIf(SKIP)("handleIacr", () => {
	it("fetches a known ePrint", async () => {
		// Using a well-known paper
		const result = await handleIacr("https://eprint.iacr.org/2023/123", 30000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("iacr");
		expect(result?.contentType).toBe("text/markdown");
		if (!result?.content.includes("Too Many Requests") && !result?.content.includes("Failed to fetch")) {
			expect(result?.content).toContain("ePrint:");
			expect(result?.content).toContain("2023/123");
		}
		expect(result?.truncated).toBe(false);
	});

	it("includes paper metadata", async () => {
		const result = await handleIacr("https://eprint.iacr.org/2023/123", 30000);
		expect(result).not.toBeNull();
		if (!result?.content.includes("Too Many Requests") && !result?.content.includes("Failed to fetch")) {
			expect(result?.content).toContain("ePrint:");
			expect(result?.content).toMatch(/Abstract/);
		}
	});

	it("handles PDF URLs", async () => {
		const result = await handleIacr("https://eprint.iacr.org/2023/123.pdf", 30000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("iacr");
		if (!result?.content.includes("Too Many Requests") && !result?.content.includes("Failed to fetch")) {
			expect(result?.notes?.some(n => n.includes("PDF"))).toBe(true);
		}
	});
});
