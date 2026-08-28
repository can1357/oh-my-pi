import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

/**
 * Handle Wikipedia URLs via Wikipedia API
 */
export const handleWikipedia: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		// Match *.wikipedia.org
		const wikiMatch = parsed.hostname.match(/^(\w+)\.wikipedia\.org$/);
		if (!wikiMatch) return null;

		const lang = wikiMatch[1];
		const titleMatch = parsed.pathname.match(/\/wiki\/(.+)/);
		if (!titleMatch) return null;

		const title = decodeURIComponent(titleMatch[1]);
		const fetchedAt = new Date().toISOString();

		// Use Wikipedia API to get plain text extract
		const apiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
		const summaryResult = await loadPage(apiUrl, { timeout, signal });

		let md = "";

		if (summaryResult.ok) {
			const summary = JSON.parse(summaryResult.content) as {
				title: string;
				description?: string;
				extract: string;
			};
			md = `# ${summary.title}\n\n`;
			if (summary.description) md += `*${summary.description}*\n\n`;
			md += `${summary.extract}\n\n---\n\n`;
		}

		// Get full article content via mobile-html or parse API
		const contentUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/mobile-html/${encodeURIComponent(title)}`;
		const contentResult = await loadPage(contentUrl, { timeout, signal });

		if (contentResult.ok) {
			const { parseHTML } = await import("@oh-my-pi/pi-utils/dom");
			const doc = parseHTML(contentResult.content).document;

			// Extract main content sections
			const sections = doc.querySelectorAll("section");
			for (const section of sections) {
				const heading = section.querySelector("h2, h3, h4");
				const headingText = heading?.textContent?.trim();
				// Skip certain sections
				if (
					headingText &&
					["References", "External links", "See also", "Notes", "Further reading"].includes(headingText)
				) {
					continue;
				}

				if (headingText) {
					const level = heading?.tagName === "H2" ? "##" : "###";
					md += `${level} ${headingText}\n\n`;
				}

				const paragraphs = section.querySelectorAll("p");
				for (const p of paragraphs) {
					const text = p.textContent?.trim();
					if (text && text.length > 20) {
						md += `${text}\n\n`;
					}
				}
			}
		}

		if (!md) return null;

		return buildResult(md, { url, method: "wikipedia", fetchedAt, notes: ["Fetched via Wikipedia API"] });
	} catch {}

	return null;
};
