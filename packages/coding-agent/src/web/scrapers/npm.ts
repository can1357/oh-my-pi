import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

/**
 * Handle npm URLs via registry API
 */
export const handleNpm: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "www.npmjs.com" && parsed.hostname !== "npmjs.com") return null;

		// Extract package name from /package/[scope/]name
		const match = parsed.pathname.match(/^\/package\/(.+?)(?:\/|$)/);
		if (!match) return null;

		let packageName = decodeURIComponent(match[1]);
		// Handle scoped packages: /package/@scope/name
		if (packageName.startsWith("@")) {
			const scopeMatch = parsed.pathname.match(/^\/package\/(@[^/]+\/[^/]+)/);
			if (scopeMatch) packageName = decodeURIComponent(scopeMatch[1]);
		}

		const fetchedAt = new Date().toISOString();

		// Fetch from npm registry - use /latest endpoint for smaller response
		const latestUrl = `https://registry.npmjs.org/${packageName}/latest`;
		const downloadsUrl = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(packageName)}`;

		// Fetch package info and download stats in parallel
		const [result, downloadsResult] = await Promise.all([
			loadPage(latestUrl, { timeout, signal }),
			loadPage(downloadsUrl, { timeout: Math.min(timeout, 5), signal }),
		]);

		if (!result.ok) return null;

		// Parse download stats
		let weeklyDownloads: number | null = null;
		if (downloadsResult.ok) {
			const dlData = tryParseJson<{ downloads?: number }>(downloadsResult.content);
			if (dlData) weeklyDownloads = dlData.downloads ?? null;
		}

		const pkg = tryParseJson<{
			name: string;
			version: string;
			description?: string;
			license?: string | { type: string };
			homepage?: string;
			repository?: { url: string } | string;
			keywords?: string[];
			maintainers?: Array<{ name: string }>;
			dependencies?: Record<string, string>;
			readme?: string;
		}>(result.content);
		if (!pkg) return null;

		let md = `# ${pkg.name}\n\n`;
		if (pkg.description) md += `${pkg.description}\n\n`;

		md += `**Latest:** ${pkg.version || "unknown"}`;
		if (pkg.license) {
			const license = typeof pkg.license === "string" ? pkg.license : (pkg.license.type ?? String(pkg.license));
			md += ` · **License:** ${license}`;
		}
		md += "\n";
		if (weeklyDownloads !== null) {
			md += `**Weekly Downloads:** ${formatNumber(weeklyDownloads)}\n`;
		}
		md += "\n";

		if (pkg.homepage) md += `**Homepage:** ${pkg.homepage}\n`;
		const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
		if (repoUrl) md += `**Repository:** ${repoUrl.replace(/^git\+/, "").replace(/\.git$/, "")}\n`;
		if (pkg.keywords?.length) md += `**Keywords:** ${pkg.keywords.join(", ")}\n`;
		if (pkg.maintainers?.length) md += `**Maintainers:** ${pkg.maintainers.map(m => m.name).join(", ")}\n`;

		if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
			md += `\n## Dependencies\n\n`;
			for (const [dep, version] of Object.entries(pkg.dependencies)) {
				md += `- ${dep}: ${version}\n`;
			}
		}

		if (pkg.readme) {
			md += `\n---\n\n## README\n\n${pkg.readme}\n`;
		}

		return buildResult(md, { url, method: "npm", fetchedAt, notes: ["Fetched via npm registry"] });
	} catch {}

	return null;
};
