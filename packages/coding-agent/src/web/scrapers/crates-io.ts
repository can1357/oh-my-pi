import { tryParseJson, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage, looksLikeHtml } from "./types";

/**
 * Handle crates.io URLs via API
 */
export const handleCratesIo: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "crates.io" && parsed.hostname !== "www.crates.io") return null;

		// Extract crate name from /crates/name or /crates/name/version
		const match = parsed.pathname.match(/^\/crates\/([^/]+)/);
		if (!match) return null;

		const crateName = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();

		// Fetch from crates.io API
		const apiUrl = `https://crates.io/api/v1/crates/${crateName}`;
		const result = await loadPage(apiUrl, {
			timeout,
			signal,
			headers: { "User-Agent": USER_AGENT },
		});

		if (!result.ok) return null;

		const data = tryParseJson<{
			crate: {
				name: string;
				description: string | null;
				downloads: number;
				recent_downloads: number;
				max_version: string;
				repository: string | null;
				homepage: string | null;
				documentation: string | null;
				categories: string[];
				keywords: string[];
				created_at: string;
				updated_at: string;
			};
			versions: Array<{
				num: string;
				downloads: number;
				created_at: string;
				license: string | null;
				rust_version: string | null;
			}>;
		}>(result.content);
		if (!data) return null;

		const crate = data.crate;
		const latestVersion = data.versions?.[0];

		let md = `# ${crate.name}\n\n`;
		if (crate.description) md += `${crate.description}\n\n`;

		md += `**Latest:** ${crate.max_version}`;
		if (latestVersion?.license) md += ` · **License:** ${latestVersion.license}`;
		if (latestVersion?.rust_version) md += ` · **MSRV:** ${latestVersion.rust_version}`;
		md += "\n";
		md += `**Downloads:** ${formatNumber(crate.downloads)} total · ${formatNumber(crate.recent_downloads)} recent\n\n`;

		if (crate.repository) md += `**Repository:** ${crate.repository}\n`;
		if (crate.homepage && crate.homepage !== crate.repository) md += `**Homepage:** ${crate.homepage}\n`;
		if (crate.documentation) md += `**Docs:** ${crate.documentation}\n`;
		if (crate.keywords?.length) md += `**Keywords:** ${crate.keywords.join(", ")}\n`;
		if (crate.categories?.length) md += `**Categories:** ${crate.categories.join(", ")}\n`;

		// Show recent versions
		if (data.versions?.length > 0) {
			md += `\n## Recent Versions\n\n`;
			for (const ver of data.versions.slice(0, 5)) {
				const date = ver.created_at.split("T")[0];
				md += `- **${ver.num}** (${date}) - ${formatNumber(ver.downloads)} downloads\n`;
			}
		}

		// Try to fetch README from docs.rs or repository
		const docsRsUrl = `https://docs.rs/crate/${crateName}/${crate.max_version}/source/README.md`;
		const readmeResult = await loadPage(docsRsUrl, { timeout: Math.min(timeout, 5), signal });
		if (readmeResult.ok && readmeResult.content.length > 100 && !looksLikeHtml(readmeResult.content)) {
			md += `\n---\n\n## README\n\n${readmeResult.content}\n`;
		}

		return buildResult(md, { url, method: "crates.io", fetchedAt, notes: ["Fetched via crates.io API"] });
	} catch {}

	return null;
};
