import { tryParseJson } from "@oh-my-pi/pi-utils";
import { buildResult, loadPage, type RenderResult, type SpecialHandler } from "./types";

interface RfcMetadata {
	doc_id: string;
	title: string;
	authors?: Array<{ name: string; affiliation?: string }>;
	pub_status?: string;
	current_status?: string;
	stream?: string;
	area?: string;
	wg_acronym?: string;
	pub_date?: string;
	page_count?: number;
	abstract?: string;
	keywords?: string[];
	obsoletes?: string[];
	obsoleted_by?: string[];
	updates?: string[];
	updated_by?: string[];
	see_also?: string[];
	errata_url?: string;
}

/**
 * Extract RFC number from various URL patterns
 */
function extractRfcNumber(url: URL): string | null {
	const { hostname, pathname } = url;

	// https://www.rfc-editor.org/rfc/rfc{number}
	// https://www.rfc-editor.org/rfc/rfc{number}.html
	// https://www.rfc-editor.org/rfc/rfc{number}.txt
	if (hostname === "www.rfc-editor.org" || hostname === "rfc-editor.org") {
		const match = pathname.match(/\/rfc\/rfc(\d+)(?:\.(?:html|txt|pdf))?$/i);
		if (match) return match[1];
	}

	// https://datatracker.ietf.org/doc/rfc{number}/
	// https://datatracker.ietf.org/doc/html/rfc{number}
	if (hostname === "datatracker.ietf.org") {
		const match = pathname.match(/\/doc\/(?:html\/)?rfc(\d+)\/?$/i);
		if (match) return match[1];
	}

	// https://tools.ietf.org/html/rfc{number}
	if (hostname === "tools.ietf.org") {
		const match = pathname.match(/\/html\/rfc(\d+)$/i);
		if (match) return match[1];
	}

	return null;
}

/**
 * Clean up RFC plain text - remove page headers/footers and extra formatting
 */
function cleanRfcText(text: string): string {
	const lines = text.split("\n");
	const cleaned: string[] = [];
	let skipNext = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Skip lines we've marked to skip (form feeds and surrounding blank lines)
		if (skipNext > 0) {
			skipNext--;
			continue;
		}

		// Skip form feed characters and page headers (RFC NNNN ... Month Year pattern)
		if (line.includes("\f")) {
			// Skip the form feed line and typically 2-3 following header lines
			skipNext = 3;
			continue;
		}

		// Skip page footer lines (typically just a page number or "[Page N]")
		if (/^\s*\[Page \d+\]\s*$/.test(line)) {
			continue;
		}

		cleaned.push(line);
	}

	return cleaned.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

/**
 * Handle RFC Editor URLs - fetches IETF RFCs
 */
export const handleRfc: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		const rfcNumber = extractRfcNumber(parsed);

		if (!rfcNumber) return null;

		const fetchedAt = new Date().toISOString();
		const notes: string[] = [];

		// Fetch metadata JSON and plain text in parallel
		const metadataUrl = `https://www.rfc-editor.org/rfc/rfc${rfcNumber}.json`;
		const textUrl = `https://www.rfc-editor.org/rfc/rfc${rfcNumber}.txt`;

		const [metaResult, textResult] = await Promise.all([
			loadPage(metadataUrl, { timeout: Math.min(timeout, 10), signal }),
			loadPage(textUrl, { timeout, signal }),
		]);

		// We need at least the text content
		if (!textResult.ok) return null;

		let metadata: RfcMetadata | null = null;
		if (metaResult.ok) {
			metadata = tryParseJson<RfcMetadata>(metaResult.content);
			if (metadata) notes.push("Metadata from RFC Editor JSON API");
		}

		// Build markdown output
		let md = "";

		if (metadata) {
			md += `# RFC ${rfcNumber}: ${metadata.title}\n\n`;

			// Authors
			if (metadata.authors?.length) {
				const authorList = metadata.authors
					.map(a => (a.affiliation ? `${a.name} (${a.affiliation})` : a.name))
					.join(", ");
				md += `**Authors:** ${authorList}\n`;
			}

			// Publication info
			if (metadata.pub_date) md += `**Published:** ${metadata.pub_date}\n`;
			if (metadata.current_status) md += `**Status:** ${metadata.current_status}\n`;
			if (metadata.stream) md += `**Stream:** ${metadata.stream}\n`;
			if (metadata.area) md += `**Area:** ${metadata.area}\n`;
			if (metadata.wg_acronym) md += `**Working Group:** ${metadata.wg_acronym}\n`;
			if (metadata.page_count) md += `**Pages:** ${metadata.page_count}\n`;

			// Related RFCs
			if (metadata.obsoletes?.length) {
				md += `**Obsoletes:** ${metadata.obsoletes.join(", ")}\n`;
			}
			if (metadata.obsoleted_by?.length) {
				md += `**Obsoleted by:** ${metadata.obsoleted_by.join(", ")}\n`;
			}
			if (metadata.updates?.length) {
				md += `**Updates:** ${metadata.updates.join(", ")}\n`;
			}
			if (metadata.updated_by?.length) {
				md += `**Updated by:** ${metadata.updated_by.join(", ")}\n`;
			}

			// Keywords
			if (metadata.keywords?.length) {
				md += `**Keywords:** ${metadata.keywords.join(", ")}\n`;
			}

			// Errata
			if (metadata.errata_url) {
				md += `**Errata:** ${metadata.errata_url}\n`;
			}

			md += "\n";

			// Abstract from metadata
			if (metadata.abstract) {
				md += `## Abstract\n\n${metadata.abstract}\n\n`;
			}

			md += "---\n\n";
		} else {
			// No metadata, use simple header
			md += `# RFC ${rfcNumber}\n\n`;
			notes.push("Metadata not available, showing plain text only");
		}

		// Add full text content
		md += "## Full Text\n\n";
		md += "```\n";
		md += cleanRfcText(textResult.content);
		md += "\n```\n";

		return buildResult(md, {
			url,
			finalUrl: `https://www.rfc-editor.org/rfc/rfc${rfcNumber}`,
			method: "rfc",
			fetchedAt,
			notes: notes.length ? notes : ["Fetched from RFC Editor"],
		});
	} catch {}

	return null;
};
