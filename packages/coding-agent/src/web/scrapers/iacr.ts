import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";
import { convertWithMarkit, fetchBinary } from "./utils";

/**
 * Handle IACR ePrint Archive URLs
 */
export const handleIacr: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "eprint.iacr.org") return null;

		// Extract paper ID from /year/number or /year/number.pdf
		const match = parsed.pathname.match(/\/(\d{4})\/(\d+)(?:\.pdf)?$/);
		if (!match) return null;

		const [, year, number] = match;
		const paperId = `${year}/${number}`;
		const fetchedAt = new Date().toISOString();
		const notes: string[] = [];

		// Fetch the HTML page for metadata
		const pageUrl = `https://eprint.iacr.org/${paperId}`;
		const result = await loadPage(pageUrl, { timeout, signal });

		if (!result.ok) return null;

		const { parseHTML } = await import("@oh-my-pi/pi-utils/dom");
		const doc = parseHTML(result.content).document;

		// Extract metadata from the page
		const title =
			doc.querySelector("h3.mb-3")?.textContent?.trim() ||
			doc.querySelector('meta[name="citation_title"]')?.getAttribute("content");
		const authors = Array.from(
			doc.querySelectorAll('meta[name="citation_author"]') as Iterable<{
				getAttribute: (name: string) => string | null;
			}>,
		)
			.map(m => m.getAttribute("content"))
			.filter((author): author is string => Boolean(author));
		// Abstract is in <p> after <h5>Abstract</h5>
		const abstractHeading = Array.from(
			doc.querySelectorAll("h5") as Iterable<{
				textContent: string | null;
				parentElement?: { querySelector: (selector: string) => { textContent: string | null } | null } | null;
			}>,
		).find(h => h.textContent?.includes("Abstract"));
		const abstract =
			abstractHeading?.parentElement?.querySelector("p")?.textContent?.trim() ||
			doc.querySelector('meta[name="description"]')?.getAttribute("content");
		const keywords = doc.querySelector(".keywords")?.textContent?.replace("Keywords:", "").trim();
		const pubDate = doc.querySelector('meta[name="citation_publication_date"]')?.getAttribute("content");

		let md = `# ${title || "IACR ePrint Paper"}\n\n`;
		if (authors.length) md += `**Authors:** ${authors.join(", ")}\n`;
		if (pubDate) md += `**Date:** ${pubDate}\n`;
		md += `**ePrint:** ${paperId}\n`;
		if (keywords) md += `**Keywords:** ${keywords}\n`;
		md += `\n---\n\n## Abstract\n\n${abstract || "No abstract available."}\n\n`;

		// If it was a PDF link, try to fetch and convert PDF
		if (parsed.pathname.endsWith(".pdf")) {
			const pdfUrl = `https://eprint.iacr.org/${paperId}.pdf`;
			notes.push("Fetching PDF for full content...");
			const pdfResult = await fetchBinary(pdfUrl, timeout, signal);
			if (pdfResult.ok) {
				const converted = await convertWithMarkit(pdfResult.buffer, ".pdf", timeout, signal);
				if (converted.ok && converted.content.length > 500) {
					md += `---\n\n## Full Paper\n\n${converted.content}\n`;
					notes.push("PDF converted via markit");
				}
			}
		}

		return buildResult(md, {
			url,
			method: "iacr",
			fetchedAt,
			notes: notes.length ? notes : ["Fetched from IACR ePrint Archive"],
		});
	} catch {}

	return null;
};
