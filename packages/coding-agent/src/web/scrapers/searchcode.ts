import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

interface SearchcodeResult {
	id?: number | string;
	filename?: string;
	repo?: string;
	language?: string;
	code?: string;
	lines?: number | string | Array<number | string>;
	location?: string;
	url?: string;
}

interface SearchcodeSearchResponse {
	query?: string;
	results?: SearchcodeResult[];
	total?: number;
	total_results?: number;
	nextpage?: number;
}

const VALID_HOSTS = new Set(["searchcode.com", "www.searchcode.com"]);

function parseLineNumbers(lines: SearchcodeResult["lines"]): number[] | null {
	if (typeof lines === "number" && Number.isFinite(lines)) return [lines];

	if (typeof lines === "string") {
		const parts = lines.split(/[,\s]+/).filter(Boolean);
		const parsed = parts.map(part => Number.parseInt(part, 10)).filter(value => Number.isFinite(value));
		return parsed.length ? parsed : null;
	}

	if (Array.isArray(lines)) {
		const parsed = lines.map(part => Number.parseInt(String(part), 10)).filter(value => Number.isFinite(value));
		return parsed.length ? parsed : null;
	}

	return null;
}

function formatLineNumbers(lines: number[] | null): string | null {
	if (!lines || lines.length === 0) return null;
	if (lines.length <= 10) return lines.join(", ");
	const min = Math.min(...lines);
	const max = Math.max(...lines);
	return `${min}-${max} (${lines.length} lines)`;
}

function formatCodeBlock(
	code: string | undefined,
	language: string | undefined,
	lines: number[] | null,
): string | null {
	if (!code) return null;

	const codeLines = code.trimEnd().split(/\r?\n/);
	const languageTag = typeof language === "string" ? language.trim().toLowerCase() : "";

	let displayLines = codeLines;
	if (lines && lines.length === codeLines.length) {
		displayLines = codeLines.map((line, index) => `${lines[index]}: ${line}`);
	}

	const fence = languageTag ? languageTag : "";
	return `\n\n\`\`\`${fence}\n${displayLines.join("\n")}\n\`\`\`\n`;
}

export const handleSearchcode: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!VALID_HOSTS.has(parsed.hostname)) return null;

		const fetchedAt = new Date().toISOString();
		const viewMatch = parsed.pathname.match(/^\/codesearch\/view\/([^/?#]+)/);
		if (viewMatch) {
			const id = viewMatch[1];
			const apiUrl = `https://searchcode.com/api/result/${encodeURIComponent(id)}/`;
			const result = await loadPage(apiUrl, { timeout, signal, headers: { Accept: "application/json" } });
			if (!result.ok) return null;

			const data = tryParseJson<SearchcodeResult>(result.content);
			if (!data) return null;

			const filename = data.filename || data.location || `Result ${id}`;
			const lineNumbers = parseLineNumbers(data.lines);
			const formattedLines = formatLineNumbers(lineNumbers);
			const viewUrl = data.url || `https://searchcode.com/codesearch/view/${id}`;
			const snippetBlock = formatCodeBlock(data.code, data.language, lineNumbers);

			let md = `# ${filename}\n\n`;
			md += `## Description\n\n`;
			md += "Code snippet from searchcode.com.\n\n";
			md += `## Metadata\n\n`;
			if (data.repo) md += `**Repository:** ${data.repo}\n`;
			if (data.language) md += `**Language:** ${data.language}\n`;
			if (data.filename) md += `**File:** ${data.filename}\n`;
			if (data.location) md += `**Location:** ${data.location}\n`;
			if (formattedLines) md += `**Lines:** ${formattedLines}\n`;
			md += `**Result ID:** ${id}\n`;
			md += `**URL:** ${viewUrl}\n`;

			md += `\n## Snippet`;
			if (snippetBlock) {
				md += snippetBlock;
			} else {
				md += "\n\n_No snippet available._\n";
			}

			return buildResult(md, { url, method: "searchcode", fetchedAt, notes: ["Fetched via searchcode API"] });
		}

		const query = parsed.searchParams.get("q");
		const isSearchPage =
			parsed.pathname === "/" || parsed.pathname === "/codesearch" || parsed.pathname === "/codesearch/";
		if (!query || !isSearchPage) return null;

		const pageRaw = parsed.searchParams.get("p") ?? parsed.searchParams.get("page");
		const pageNumber = pageRaw ? Number.parseInt(pageRaw, 10) : 0;
		const page = Number.isFinite(pageNumber) && pageNumber >= 0 ? pageNumber : 0;
		const apiUrl = `https://searchcode.com/api/codesearch_I/?q=${encodeURIComponent(query)}&p=${page}`;
		const result = await loadPage(apiUrl, { timeout, signal, headers: { Accept: "application/json" } });
		if (!result.ok) return null;

		const data = tryParseJson<SearchcodeSearchResponse>(result.content);
		if (!data) return null;

		const results = Array.isArray(data.results) ? data.results : [];
		const total =
			typeof data.total === "number"
				? data.total
				: typeof data.total_results === "number"
					? data.total_results
					: null;

		let md = `# Searchcode Results\n\n`;
		md += `## Description\n\n`;
		md += `Search results for \`${query}\` on searchcode.com.\n\n`;
		md += `## Metadata\n\n`;
		md += `**Query:** \`${query}\`\n`;
		md += `**Page:** ${page}\n`;
		if (total !== null) md += `**Total Results:** ${formatNumber(total)}\n`;
		md += `**Result Count:** ${results.length}\n`;
		if (typeof data.nextpage === "number") md += `**Next Page:** ${data.nextpage}\n`;

		md += `\n## Results\n\n`;

		if (results.length === 0) {
			md += "_No results found._\n";
		} else {
			const maxResults = 10;
			for (const resultItem of results.slice(0, maxResults)) {
				const id = resultItem.id !== undefined ? String(resultItem.id) : null;
				const filename = resultItem.filename || resultItem.location || "Result";
				const lineNumbers = parseLineNumbers(resultItem.lines);
				const formattedLines = formatLineNumbers(lineNumbers);
				const viewUrl = resultItem.url || (id ? `https://searchcode.com/codesearch/view/${id}` : null);
				const snippetBlock = formatCodeBlock(resultItem.code, resultItem.language, lineNumbers);

				md += `### ${filename}\n\n`;
				if (resultItem.repo) md += `**Repository:** ${resultItem.repo}\n`;
				if (resultItem.language) md += `**Language:** ${resultItem.language}\n`;
				if (resultItem.filename) md += `**File:** ${resultItem.filename}\n`;
				if (resultItem.location) md += `**Location:** ${resultItem.location}\n`;
				if (formattedLines) md += `**Lines:** ${formattedLines}\n`;
				if (viewUrl) md += `**URL:** ${viewUrl}\n`;

				if (snippetBlock) {
					md += `${snippetBlock}\n`;
				}

				md += "\n";
			}

			if (results.length > maxResults) {
				md += `\n_Only showing first ${maxResults} results._\n`;
			}
		}

		return buildResult(md, { url, method: "searchcode", fetchedAt, notes: ["Fetched via searchcode API"] });
	} catch {}

	return null;
};
