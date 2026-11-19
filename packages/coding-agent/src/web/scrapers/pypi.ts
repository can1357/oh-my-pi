import { tryParseJson } from "@oh-my-pi/pi-utils";
import { buildResult, formatNumber, loadPage, type RenderResult, type SpecialHandler } from "./types";

/**
 * Handle PyPI URLs via JSON API
 */
export const handlePyPI: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "pypi.org" && parsed.hostname !== "www.pypi.org") return null;

		// Extract package name from /project/{package} or /project/{package}/{version}
		const match = parsed.pathname.match(/^\/project\/([^/]+)/);
		if (!match) return null;

		const packageName = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();

		// Fetch from PyPI JSON API
		const apiUrl = `https://pypi.org/pypi/${packageName}/json`;
		const downloadsUrl = `https://pypistats.org/api/packages/${packageName}/recent`;

		// Fetch package info and download stats in parallel
		const [result, downloadsResult] = await Promise.all([
			loadPage(apiUrl, { timeout, signal }),
			loadPage(downloadsUrl, { timeout: Math.min(timeout, 5), signal }),
		]);

		if (!result.ok) return null;

		// Parse download stats
		let weeklyDownloads: number | null = null;
		if (downloadsResult.ok) {
			const dlData = tryParseJson<{ data?: { last_week?: number } }>(downloadsResult.content);
			if (dlData) weeklyDownloads = dlData.data?.last_week ?? null;
		}

		const pkg = tryParseJson<{
			info: {
				name: string;
				version: string;
				summary?: string;
				description?: string;
				author?: string;
				author_email?: string;
				license?: string;
				home_page?: string;
				project_urls?: Record<string, string>;
				requires_python?: string;
				keywords?: string;
				classifiers?: string[];
			};
			urls?: Array<{ filename: string; size: number; upload_time: string }>;
			releases?: Record<string, unknown>;
			requires_dist?: string[];
		}>(result.content);
		if (!pkg) return null;

		const info = pkg.info;
		let md = `# ${info.name}\n\n`;
		if (info.summary) md += `${info.summary}\n\n`;

		md += `**Latest:** ${info.version}`;
		if (info.license) md += ` · **License:** ${info.license}`;
		md += "\n";

		if (weeklyDownloads !== null) {
			md += `**Weekly Downloads:** ${formatNumber(weeklyDownloads)}\n`;
		}

		md += "\n";

		if (info.author) {
			md += `**Author:** ${info.author}`;
			if (info.author_email) md += ` <${info.author_email}>`;
			md += "\n";
		}

		if (info.requires_python) md += `**Python:** ${info.requires_python}\n`;
		if (info.home_page) md += `**Homepage:** ${info.home_page}\n`;

		if (info.project_urls && Object.keys(info.project_urls).length > 0) {
			md += "\n**Project URLs:**\n";
			for (const [label, url] of Object.entries(info.project_urls)) {
				md += `- ${label}: ${url}\n`;
			}
		}

		if (info.keywords) md += `\n**Keywords:** ${info.keywords}\n`;

		// Dependencies
		if (pkg.requires_dist && pkg.requires_dist.length > 0) {
			md += `\n## Dependencies\n\n`;
			for (const dep of pkg.requires_dist) {
				md += `- ${dep}\n`;
			}
		}

		// README/Description
		if (info.description) {
			md += `\n---\n\n## Description\n\n${info.description}\n`;
		}

		return buildResult(md, { url, method: "pypi", fetchedAt, notes: ["Fetched via PyPI JSON API"] });
	} catch {}

	return null;
};
