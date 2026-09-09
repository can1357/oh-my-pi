import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

/**
 * Handle Packagist URLs via JSON API
 */
export const handlePackagist: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "packagist.org" && parsed.hostname !== "www.packagist.org") return null;

		// Extract vendor/package from /packages/{vendor}/{name}
		const match = parsed.pathname.match(/^\/packages\/([^/]+)\/([^/]+)/);
		if (!match) return null;

		const vendor = decodeURIComponent(match[1]);
		const packageName = decodeURIComponent(match[2]);
		const fetchedAt = new Date().toISOString();

		// Fetch from Packagist JSON API
		const apiUrl = `https://packagist.org/packages/${vendor}/${packageName}.json`;
		const result = await loadPage(apiUrl, { timeout, signal });

		if (!result.ok) return null;

		const data = tryParseJson<{
			package: {
				name: string;
				description?: string;
				time?: string;
				maintainers?: Array<{ name: string; avatar_url?: string }>;
				versions?: Record<
					string,
					{
						name: string;
						version: string;
						version_normalized?: string;
						description?: string;
						license?: string[];
						homepage?: string;
						source?: { url: string; type: string };
						require?: Record<string, string>;
						"require-dev"?: Record<string, string>;
						authors?: Array<{ name: string; email?: string }>;
						time?: string;
					}
				>;
				type?: string;
				repository?: string;
				github_stars?: number;
				github_watchers?: number;
				github_forks?: number;
				github_open_issues?: number;
				language?: string;
				dependents?: number;
				suggesters?: number;
				downloads?: {
					total: number;
					monthly: number;
					daily: number;
				};
				favers?: number;
			};
		}>(result.content);
		if (!data) return null;

		const pkg = data.package;
		if (!pkg) return null;

		// Find latest stable version (prefer non-dev)
		type VersionInfo = NonNullable<typeof pkg.versions>[string];
		let latestVersion: VersionInfo | null = null;
		let latestVersionKey = "";

		if (pkg.versions) {
			// Look for latest stable version first
			for (const [key, ver] of Object.entries(pkg.versions)) {
				if (key === "dev-master" || key === "dev-main" || key.includes("-dev")) continue;
				if (!latestVersion || (ver.time && latestVersion.time && ver.time > latestVersion.time)) {
					latestVersion = ver;
					latestVersionKey = key;
				}
			}
			// Fallback to dev-master/dev-main if no stable version
			if (!latestVersion) {
				latestVersion = pkg.versions["dev-master"] || pkg.versions["dev-main"] || Object.values(pkg.versions)[0];
				latestVersionKey = latestVersion?.version || "";
			}
		}

		let md = `# ${pkg.name}\n\n`;
		if (pkg.description) md += `${pkg.description}\n\n`;

		md += `**Latest:** ${latestVersionKey || "unknown"}`;
		if (latestVersion?.license?.length) md += ` · **License:** ${latestVersion.license.join(", ")}`;
		if (pkg.type) md += ` · **Type:** ${pkg.type}`;
		md += "\n";

		if (pkg.downloads) {
			md += `**Downloads:** ${formatNumber(pkg.downloads.total)} total · ${formatNumber(pkg.downloads.monthly)}/month\n`;
		}
		if (pkg.favers) md += `**Stars:** ${formatNumber(pkg.favers)}\n`;
		md += "\n";

		// Authors
		if (latestVersion?.authors?.length) {
			const authorList = latestVersion.authors
				.map((a: { name: string; email?: string }) => (a.email ? `${a.name} <${a.email}>` : a.name))
				.join(", ");
			md += `**Authors:** ${authorList}\n`;
		}

		// Maintainers
		if (pkg.maintainers?.length) {
			md += `**Maintainers:** ${pkg.maintainers.map(m => m.name).join(", ")}\n`;
		}

		// Links
		if (latestVersion?.homepage) md += `**Homepage:** ${latestVersion.homepage}\n`;
		if (pkg.repository) md += `**Repository:** ${pkg.repository}\n`;
		else if (latestVersion?.source?.url) {
			const repoUrl = latestVersion.source.url.replace(/\.git$/, "");
			md += `**Repository:** ${repoUrl}\n`;
		}

		// GitHub stats
		if (pkg.github_stars || pkg.github_forks) {
			const stats: string[] = [];
			if (pkg.github_stars) stats.push(`${formatNumber(pkg.github_stars)} stars`);
			if (pkg.github_forks) stats.push(`${formatNumber(pkg.github_forks)} forks`);
			if (pkg.github_open_issues) stats.push(`${pkg.github_open_issues} open issues`);
			md += `**GitHub:** ${stats.join(" · ")}\n`;
		}

		// Dependencies
		if (latestVersion?.require && Object.keys(latestVersion.require).length > 0) {
			md += `\n## Requirements\n\n`;
			for (const [dep, version] of Object.entries(latestVersion.require)) {
				md += `- ${dep}: ${version}\n`;
			}
		}

		// Dev dependencies (brief)
		if (latestVersion?.["require-dev"] && Object.keys(latestVersion["require-dev"]).length > 0) {
			md += `\n## Dev Requirements\n\n`;
			for (const [dep, version] of Object.entries(latestVersion["require-dev"])) {
				md += `- ${dep}: ${version}\n`;
			}
		}

		return buildResult(md, { url, method: "packagist", fetchedAt, notes: ["Fetched via Packagist API"] });
	} catch {}

	return null;
};
