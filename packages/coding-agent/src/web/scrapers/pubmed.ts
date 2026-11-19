/**
 * PubMed handler for web-fetch
 */
import { tryParseJson, USER_AGENT } from "@oh-my-pi/pi-utils";
import { buildResult, loadPage, type RenderResult, type SpecialHandler } from "./types";

const NCBI_HEADERS = {
	Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
	"User-Agent": USER_AGENT,
};

/**
 * Handle PubMed URLs - fetch article metadata, abstract, MeSH terms
 */
export const handlePubMed: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);

		// Match pubmed.ncbi.nlm.nih.gov/{pmid} or ncbi.nlm.nih.gov/pubmed/{pmid}
		if (
			parsed.hostname !== "pubmed.ncbi.nlm.nih.gov" &&
			!(parsed.hostname === "ncbi.nlm.nih.gov" && parsed.pathname.startsWith("/pubmed"))
		) {
			return null;
		}

		// Extract PMID from URL
		let pmid: string | null = null;
		if (parsed.hostname === "pubmed.ncbi.nlm.nih.gov") {
			// Format: pubmed.ncbi.nlm.nih.gov/12345678/
			const match = parsed.pathname.match(/\/(\d+)/);
			if (match) pmid = match[1];
		} else {
			// Format: ncbi.nlm.nih.gov/pubmed/12345678
			const match = parsed.pathname.match(/\/pubmed\/(\d+)/);
			if (match) pmid = match[1];
		}

		if (!pmid) return null;

		const fetchedAt = new Date().toISOString();
		const notes: string[] = [];
		const buildFallback = (fallbackNotes: string[]) =>
			buildResult(`# PubMed Article\n\n**PMID:** ${pmid}\n\n---\n\n## Abstract\n\nNo abstract available.\n`, {
				url,
				method: "pubmed",
				fetchedAt,
				notes: fallbackNotes,
			});

		const fetchWithRetry = async (requestUrl: string, acceptJson = true) => {
			let response = await loadPage(requestUrl, {
				timeout,
				signal,
				headers: {
					...NCBI_HEADERS,
					Accept: acceptJson ? "application/json" : "text/plain, */*;q=0.8",
				},
			});
			if (!response.ok) {
				response = await loadPage(requestUrl, {
					timeout,
					signal,
					headers: {
						...NCBI_HEADERS,
						Accept: acceptJson ? "application/json" : "text/plain, */*;q=0.8",
					},
				});
			}
			return response;
		};

		// Fetch summary metadata
		const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`;
		const summaryResult = await fetchWithRetry(summaryUrl);

		if (!summaryResult.ok) {
			return buildFallback(["Failed to fetch PubMed summary metadata"]);
		}

		const summaryData = tryParseJson<{
			result?: {
				[pmid: string]: {
					title?: string;
					authors?: Array<{ name: string }>;
					fulljournalname?: string;
					pubdate?: string;
					volume?: string;
					issue?: string;
					pages?: string;
					elocationid?: string; // DOI
					articleids?: Array<{ idtype: string; value: string }>;
				};
			};
		}>(summaryResult.content);
		if (!summaryData) {
			return buildFallback(["Failed to parse PubMed summary metadata"]);
		}

		const article = summaryData.result?.[pmid];
		if (!article) {
			return buildFallback(["PubMed record unavailable from E-utilities summary endpoint"]);
		}

		// Fetch abstract
		const abstractUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`;
		const abstractResult = await fetchWithRetry(abstractUrl, false);

		let abstractText = "";
		if (abstractResult.ok) {
			abstractText = abstractResult.content.trim();
			notes.push("Fetched abstract via NCBI E-utilities");
		}

		// Extract DOI and PMCID
		let doi = "";
		let pmcid = "";
		if (article.articleids) {
			for (const id of article.articleids) {
				if (id.idtype === "doi") doi = id.value;
				if (id.idtype === "pmc") pmcid = id.value;
			}
		}
		if (!doi && article.elocationid) {
			doi = article.elocationid;
		}

		// Build markdown output
		let md = `# ${article.title || "PubMed Article"}\n\n`;

		// Authors
		if (article.authors && article.authors.length > 0) {
			const authorNames = article.authors.map(a => a.name).join(", ");
			md += `**Authors:** ${authorNames}\n`;
		}

		// Journal info
		if (article.fulljournalname) {
			md += `**Journal:** ${article.fulljournalname}`;
			if (article.pubdate) md += ` (${article.pubdate})`;
			md += "\n";
		}

		// Volume/Issue/Pages
		const citation: string[] = [];
		if (article.volume) citation.push(`Vol ${article.volume}`);
		if (article.issue) citation.push(`Issue ${article.issue}`);
		if (article.pages) citation.push(`pp ${article.pages}`);
		if (citation.length > 0) {
			md += `**Citation:** ${citation.join(", ")}\n`;
		}

		// IDs
		md += `**PMID:** ${pmid}\n`;
		if (doi) md += `**DOI:** ${doi}\n`;
		if (pmcid) md += `**PMCID:** ${pmcid}\n`;

		md += "\n---\n\n";

		// Abstract section
		if (abstractText) {
			md += `## Abstract\n\n${abstractText}\n`;
		} else {
			md += `## Abstract\n\nNo abstract available.\n`;
		}

		// Try to fetch MeSH terms
		try {
			const meshUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=medline&retmode=text`;
			const meshResult = await loadPage(meshUrl, {
				timeout: Math.min(timeout, 5),
				signal,
				headers: { ...NCBI_HEADERS, Accept: "text/plain, */*;q=0.8" },
			});

			if (meshResult.ok) {
				const meshTerms: string[] = [];
				const lines = meshResult.content.split("\n");
				for (const line of lines) {
					if (line.startsWith("MH  - ")) {
						const term = line.slice(6).trim();
						meshTerms.push(term);
					}
				}

				if (meshTerms.length > 0) {
					md += `\n## MeSH Terms\n\n`;
					for (const term of meshTerms) {
						md += `- ${term}\n`;
					}
					notes.push("Fetched MeSH terms via NCBI E-utilities");
				}
			}
		} catch {
			// MeSH terms are optional
		}

		return buildResult(md, {
			url,
			method: "pubmed",
			fetchedAt,
			notes: notes.length > 0 ? notes : ["Fetched via NCBI E-utilities"],
		});
	} catch {
		return null;
	}
};
