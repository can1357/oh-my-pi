import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

interface BiorxivPaper {
	biorxiv_doi?: string;
	medrxiv_doi?: string;
	title?: string;
	authors?: string;
	author_corresponding?: string;
	author_corresponding_institution?: string;
	abstract?: string;
	date?: string;
	category?: string;
	version?: string;
	type?: string;
	license?: string;
	jatsxml?: string;
	published?: string; // Journal DOI if published
	server?: string;
}

interface BiorxivResponse {
	collection?: BiorxivPaper[];
	messages?: { status: string; count: number }[];
}

/**
 * Handle bioRxiv and medRxiv preprint URLs via their API
 */
export const handleBiorxiv: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();

		// Check if it's bioRxiv or medRxiv
		const isBiorxiv = hostname === "www.biorxiv.org" || hostname === "biorxiv.org";
		const isMedrxiv = hostname === "www.medrxiv.org" || hostname === "medrxiv.org";

		if (!isBiorxiv && !isMedrxiv) return null;

		// Extract DOI from URL path: /content/10.1101/2024.01.01.123456
		const match = parsed.pathname.match(/\/content\/(10\.\d{4,}\/[^\s?#]+)/);
		if (!match) return null;

		let doi = match[1];
		// Remove version suffix if present (e.g., v1, v2)
		doi = doi.replace(/v\d+$/, "");
		// Remove trailing .full or .full.pdf
		doi = doi.replace(/\.full(\.pdf)?$/, "");

		const server = isBiorxiv ? "biorxiv" : "medrxiv";
		const apiUrl = `https://api.${server}.org/details/${server}/${doi}/na/json`;

		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) return null;

		const data = tryParseJson<BiorxivResponse>(result.content);
		if (!data) return null;

		if (!data.collection || data.collection.length === 0) return null;

		// Get the latest version (last in array)
		const paper = data.collection[data.collection.length - 1];
		if (!paper) return null;

		const serverName = isBiorxiv ? "bioRxiv" : "medRxiv";
		const paperDoi = paper.biorxiv_doi || paper.medrxiv_doi || doi;

		// Build markdown output
		let md = `# ${paper.title || "Untitled Preprint"}\n\n`;

		// Metadata section
		if (paper.authors) {
			md += `**Authors:** ${paper.authors}\n`;
		}
		if (paper.author_corresponding) {
			let correspondingLine = `**Corresponding Author:** ${paper.author_corresponding}`;
			if (paper.author_corresponding_institution) {
				correspondingLine += ` (${paper.author_corresponding_institution})`;
			}
			md += `${correspondingLine}\n`;
		}
		if (paper.date) {
			md += `**Posted:** ${paper.date}\n`;
		}
		if (paper.category) {
			md += `**Category:** ${paper.category}\n`;
		}
		if (paper.version) {
			md += `**Version:** ${paper.version}\n`;
		}
		if (paper.license) {
			md += `**License:** ${paper.license}\n`;
		}
		md += `**DOI:** [${paperDoi}](https://doi.org/${paperDoi})\n`;
		md += `**Server:** ${serverName}\n`;

		// Published status
		if (paper.published) {
			md += `\n> **Published in journal:** [${paper.published}](https://doi.org/${paper.published})\n`;
		}

		// Abstract
		md += `\n---\n\n## Abstract\n\n${paper.abstract || "No abstract available."}\n`;

		// Links section
		md += `\n---\n\n## Links\n\n`;
		md += `- [View on ${serverName}](https://www.${server}.org/content/${paperDoi})\n`;
		md += `- [PDF](https://www.${server}.org/content/${paperDoi}.full.pdf)\n`;
		if (paper.jatsxml) {
			md += `- [JATS XML](${paper.jatsxml})\n`;
		}

		return buildResult(md, {
			url,
			method: server,
			fetchedAt: new Date().toISOString(),
			notes: [`Fetched via ${serverName} API`],
		});
	} catch {}

	return null;
};
