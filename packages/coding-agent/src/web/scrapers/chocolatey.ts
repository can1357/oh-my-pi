import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, formatNumber, loadPage } from "./types";

interface NuGetODataEntry {
	Id: string;
	Version: string;
	Title?: string;
	Description?: string;
	Summary?: string;
	Authors?: string;
	ProjectUrl?: string;
	PackageSourceUrl?: string;
	Tags?: string;
	DownloadCount?: number;
	VersionDownloadCount?: number;
	Published?: string;
	LicenseUrl?: string;
	ReleaseNotes?: string;
	Dependencies?: string;
}

interface NuGetODataResponse {
	d?: {
		results?: NuGetODataEntry[];
	};
}

function extractXmlField(xml: string, fieldName: string): string | null {
	const pattern = new RegExp(`<d:${fieldName}[^>]*>([\\s\\S]*?)</d:${fieldName}>`, "i");
	const match = xml.match(pattern);
	if (!match) return null;
	return match[1].trim();
}

/**
 * Handle Chocolatey package URLs via NuGet v2 OData API
 */
export const handleChocolatey: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("chocolatey.org")) return null;

		// Extract package name from /packages/{name} or /packages/{name}/{version}
		const match = parsed.pathname.match(/^\/packages\/([^/]+)(?:\/([^/]+))?/);
		if (!match) return null;

		const packageName = decodeURIComponent(match[1]);
		const specificVersion = match[2] ? decodeURIComponent(match[2]) : null;

		const fetchedAt = new Date().toISOString();

		// Build OData query - filter by Id and optionally version
		let apiUrl = `https://community.chocolatey.org/api/v2/Packages()?$filter=Id%20eq%20'${encodeURIComponent(packageName)}'`;
		if (specificVersion) {
			apiUrl += `%20and%20Version%20eq%20'${encodeURIComponent(specificVersion)}'`;
		} else {
			// Get latest version by ordering and taking first
			apiUrl += "&$orderby=Version%20desc&$top=1";
		}

		const result = await loadPage(apiUrl, {
			timeout,
			signal,
			headers: {
				Accept: "application/atom+xml, application/xml",
			},
		});

		if (!result.ok) {
			const fallback = `# ${packageName}\n\nChocolatey package metadata is currently unavailable.\n\n---\n**Install:** \`choco install ${packageName}\`\n`;
			return buildResult(fallback, {
				url,
				method: "chocolatey",
				fetchedAt,
				notes: ["Chocolatey API request failed"],
			});
		}

		let pkg = (() => {
			const data = tryParseJson<NuGetODataResponse>(result.content);
			return data?.d?.results?.[0] ?? null;
		})();

		if (!pkg) {
			const xmlId = extractXmlField(result.content, "Id");
			if (!xmlId) {
				const fallback = `# ${packageName}\n\nChocolatey package metadata could not be parsed.\n\n---\n**Install:** \`choco install ${packageName}\`\n`;
				return buildResult(fallback, {
					url,
					method: "chocolatey",
					fetchedAt,
					notes: ["Chocolatey API response parsing failed"],
				});
			}

			pkg = {
				Id: xmlId,
				Version: extractXmlField(result.content, "Version") || "",
				Title: extractXmlField(result.content, "Title") || undefined,
				Description: extractXmlField(result.content, "Description") || undefined,
				Summary: extractXmlField(result.content, "Summary") || undefined,
				Authors: extractXmlField(result.content, "Authors") || undefined,
				ProjectUrl: extractXmlField(result.content, "ProjectUrl") || undefined,
				PackageSourceUrl: extractXmlField(result.content, "PackageSourceUrl") || undefined,
				Tags: extractXmlField(result.content, "Tags") || undefined,
				DownloadCount: (() => {
					const value = extractXmlField(result.content, "DownloadCount");
					return value ? Number.parseInt(value, 10) : undefined;
				})(),
				VersionDownloadCount: (() => {
					const value = extractXmlField(result.content, "VersionDownloadCount");
					return value ? Number.parseInt(value, 10) : undefined;
				})(),
				Published: extractXmlField(result.content, "Published") || undefined,
				LicenseUrl: extractXmlField(result.content, "LicenseUrl") || undefined,
				ReleaseNotes: extractXmlField(result.content, "ReleaseNotes") || undefined,
				Dependencies: extractXmlField(result.content, "Dependencies") || undefined,
			};
		}

		// Build markdown output
		let md = `# ${pkg.Title || pkg.Id}\n\n`;

		if (pkg.Summary) {
			md += `${pkg.Summary}\n\n`;
		} else if (pkg.Description) {
			// Use first paragraph of description as summary
			const firstPara = pkg.Description.split(/\n\n/)[0];
			md += `${firstPara}\n\n`;
		}

		md += `**Version:** ${pkg.Version}`;
		if (pkg.Authors) md += ` · **Authors:** ${pkg.Authors}`;
		md += "\n";

		if (pkg.DownloadCount !== undefined) {
			md += `**Total Downloads:** ${formatNumber(pkg.DownloadCount)}`;
			if (pkg.VersionDownloadCount !== undefined) {
				md += ` · **Version Downloads:** ${formatNumber(pkg.VersionDownloadCount)}`;
			}
			md += "\n";
		}

		if (pkg.Published) {
			const published = formatIsoDate(pkg.Published);
			if (published) md += `**Published:** ${published}\n`;
		}

		md += "\n";

		if (pkg.ProjectUrl) md += `**Project URL:** ${pkg.ProjectUrl}\n`;
		if (pkg.PackageSourceUrl) md += `**Source:** ${pkg.PackageSourceUrl}\n`;
		if (pkg.LicenseUrl) md += `**License:** ${pkg.LicenseUrl}\n`;

		if (pkg.Tags) {
			const tags = pkg.Tags.split(/\s+/).filter(t => t.length > 0);
			if (tags.length > 0) {
				md += `**Tags:** ${tags.join(", ")}\n`;
			}
		}

		// Full description if different from summary
		if (pkg.Description && pkg.Description !== pkg.Summary) {
			md += `\n## Description\n\n${pkg.Description}\n`;
		}

		if (pkg.ReleaseNotes) {
			md += `\n## Release Notes\n\n${pkg.ReleaseNotes}\n`;
		}

		if (pkg.Dependencies) {
			// Dependencies format: "id:version|id:version"
			const deps = pkg.Dependencies.split("|").filter(d => d.trim().length > 0);
			if (deps.length > 0) {
				md += `\n## Dependencies\n\n`;
				for (const dep of deps) {
					const [depId, depVersion] = dep.split(":");
					if (depId) {
						md += `- ${depId}${depVersion ? `: ${depVersion}` : ""}\n`;
					}
				}
			}
		}

		md += `\n---\n**Install:** \`choco install ${packageName}\`\n`;

		return buildResult(md, { url, method: "chocolatey", fetchedAt, notes: ["Fetched via Chocolatey NuGet API"] });
	} catch {}

	return null;
};
