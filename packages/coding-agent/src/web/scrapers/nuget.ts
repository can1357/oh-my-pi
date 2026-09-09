import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, formatNumber, loadPage } from "./types";

interface NuGetCatalogEntry {
	id: string;
	version: string;
	description?: string;
	authors?: string;
	projectUrl?: string;
	licenseUrl?: string;
	licenseExpression?: string;
	tags?: string[];
	dependencyGroups?: Array<{
		targetFramework?: string;
		dependencies?: Array<{
			id: string;
			range: string;
		}>;
	}>;
	published?: string;
}

interface NuGetRegistrationItem {
	catalogEntry: NuGetCatalogEntry;
	packageContent?: string;
}

interface NuGetRegistrationPage {
	items?: NuGetRegistrationItem[];
	"@id"?: string;
}

interface NuGetRegistrationIndex {
	items: NuGetRegistrationPage[];
}

/**
 * Handle NuGet URLs via API
 */
export const handleNuGet: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "www.nuget.org" && parsed.hostname !== "nuget.org") return null;

		// Extract package name and optional version from /packages/name or /packages/name/version
		const match = parsed.pathname.match(/^\/packages\/([^/]+)(?:\/([^/]+))?/i);
		if (!match) return null;

		const packageName = decodeURIComponent(match[1]);
		const requestedVersion = match[2] ? decodeURIComponent(match[2]) : null;
		const fetchedAt = new Date().toISOString();

		// Fetch from NuGet registration API (package name must be lowercase)
		const apiUrl = `https://api.nuget.org/v3/registration5-gz-semver2/${packageName.toLowerCase()}/index.json`;
		const result = await loadPage(apiUrl, { timeout, signal });

		if (!result.ok) return null;

		const index = tryParseJson<NuGetRegistrationIndex>(result.content);
		if (!index) return null;

		if (!index.items?.length) return null;

		// Get the latest page (or fetch it if not inlined)
		let latestPage = index.items[index.items.length - 1];

		// If items are not inlined, fetch the page
		if (!latestPage.items && latestPage["@id"]) {
			const pageResult = await loadPage(latestPage["@id"], { timeout, signal });
			if (!pageResult.ok) return null;
			const fetched = tryParseJson<NuGetRegistrationPage>(pageResult.content);
			if (!fetched) return null;
			latestPage = fetched;
		}

		if (!latestPage.items?.length) return null;

		// Find the requested version or get the latest
		let targetEntry: NuGetCatalogEntry | null = null;

		if (requestedVersion) {
			// Search all pages for the requested version
			for (const page of index.items) {
				let pageItems = page.items;

				// Fetch page if items not inlined
				if (!pageItems && page["@id"]) {
					const pageResult = await loadPage(page["@id"], { timeout: Math.min(timeout, 5), signal });
					if (pageResult.ok) {
						const fetchedPage = tryParseJson<NuGetRegistrationPage>(pageResult.content);
						if (fetchedPage) pageItems = fetchedPage.items;
					}
				}

				if (pageItems) {
					const found = pageItems.find(
						item => item.catalogEntry.version.toLowerCase() === requestedVersion.toLowerCase(),
					);
					if (found) {
						targetEntry = found.catalogEntry;
						break;
					}
				}
			}
		}

		// If no specific version requested or not found, use the latest
		if (!targetEntry) {
			const latestItem = latestPage.items[latestPage.items.length - 1];
			targetEntry = latestItem.catalogEntry;
		}

		// Fetch download stats via search API
		let totalDownloads: number | null = null;
		const searchUrl = `https://api.nuget.org/v3/query?q=packageid:${encodeURIComponent(packageName)}&prerelease=true&take=1`;
		const searchResult = await loadPage(searchUrl, { timeout: Math.min(timeout, 5), signal });

		if (searchResult.ok) {
			const searchData = tryParseJson<{ data?: Array<{ totalDownloads?: number }> }>(searchResult.content);
			if (searchData) totalDownloads = searchData.data?.[0]?.totalDownloads ?? null;
		}

		// Format markdown output
		let md = `# ${targetEntry.id}\n\n`;
		if (targetEntry.description) md += `${targetEntry.description}\n\n`;

		md += `**Version:** ${targetEntry.version}`;
		if (targetEntry.licenseExpression) {
			md += ` · **License:** ${targetEntry.licenseExpression}`;
		} else if (targetEntry.licenseUrl) {
			md += ` · **License:** [View](${targetEntry.licenseUrl})`;
		}
		md += "\n";

		if (totalDownloads !== null) {
			md += `**Total Downloads:** ${formatNumber(totalDownloads)}\n`;
		}

		if (targetEntry.authors) md += `**Authors:** ${targetEntry.authors}\n`;
		if (targetEntry.projectUrl) md += `**Project URL:** ${targetEntry.projectUrl}\n`;
		if (targetEntry.tags?.length) md += `**Tags:** ${targetEntry.tags.join(", ")}\n`;
		if (targetEntry.published) {
			md += `**Published:** ${formatIsoDate(targetEntry.published)}\n`;
		}

		// Show dependencies by target framework
		if (targetEntry.dependencyGroups?.length) {
			const hasAnyDeps = targetEntry.dependencyGroups.some(g => g.dependencies?.length);
			if (hasAnyDeps) {
				md += `\n## Dependencies\n\n`;
				for (const group of targetEntry.dependencyGroups) {
					if (!group.dependencies?.length) continue;
					const framework = group.targetFramework || "All Frameworks";
					md += `### ${framework}\n\n`;
					for (const dep of group.dependencies) {
						md += `- ${dep.id} (${dep.range})\n`;
					}
					md += "\n";
				}
			}
		}

		// Show recent versions from the latest page
		if (latestPage.items && latestPage.items.length > 1) {
			md += `## Recent Versions\n\n`;
			const recentVersions = latestPage.items.slice(-5).reverse();
			for (const item of recentVersions) {
				const entry = item.catalogEntry;
				const pubDate = formatIsoDate(entry.published) || "unknown";
				md += `- **${entry.version}** (${pubDate})\n`;
			}
		}

		return buildResult(md, { url, method: "nuget", fetchedAt, notes: ["Fetched via NuGet API"] });
	} catch {}

	return null;
};
