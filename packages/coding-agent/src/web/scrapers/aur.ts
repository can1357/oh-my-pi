import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, formatNumber, loadPage } from "./types";

interface AurPackage {
	Name: string;
	Version: string;
	Description?: string;
	Maintainer?: string;
	NumVotes: number;
	Popularity: number;
	Depends?: string[];
	MakeDepends?: string[];
	OptDepends?: string[];
	CheckDepends?: string[];
	LastModified: number;
	FirstSubmitted: number;
	URL?: string;
	URLPath?: string;
	PackageBase: string;
	OutOfDate?: number | null;
	License?: string[];
	Keywords?: string[];
	Conflicts?: string[];
	Provides?: string[];
	Replaces?: string[];
}

interface AurResponse {
	version: number;
	type: string;
	resultcount: number;
	results: AurPackage[];
}

/**
 * Handle AUR (Arch User Repository) URLs via RPC API
 */
export const handleAur: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "aur.archlinux.org") return null;

		// Extract package name from /packages/{name}
		const match = parsed.pathname.match(/^\/packages\/([^/?#]+)/);
		if (!match) return null;

		const packageName = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();

		// Fetch from AUR RPC API
		const apiUrl = `https://aur.archlinux.org/rpc/?v=5&type=info&arg=${encodeURIComponent(packageName)}`;
		const result = await loadPage(apiUrl, { timeout, signal });

		if (!result.ok) return null;

		const data = tryParseJson<AurResponse>(result.content);
		if (!data) return null;

		if (data.resultcount === 0 || !data.results[0]) return null;

		const pkg = data.results[0];

		let md = `# ${pkg.Name}\n\n`;
		if (pkg.Description) md += `${pkg.Description}\n\n`;

		// Package info
		md += `**Version:** ${pkg.Version}`;
		if (pkg.OutOfDate) {
			const outOfDateDate = formatIsoDate(pkg.OutOfDate * 1000);
			md += ` (flagged out-of-date: ${outOfDateDate})`;
		}
		md += "\n";

		if (pkg.Maintainer) {
			md += `**Maintainer:** [${pkg.Maintainer}](https://aur.archlinux.org/account/${pkg.Maintainer})\n`;
		} else {
			md += "**Maintainer:** Orphaned\n";
		}

		md += `**Votes:** ${formatNumber(pkg.NumVotes)} · **Popularity:** ${pkg.Popularity.toFixed(2)}\n`;

		// Timestamps
		const lastModified = formatIsoDate(pkg.LastModified * 1000);
		const firstSubmitted = formatIsoDate(pkg.FirstSubmitted * 1000);
		md += `**Last Updated:** ${lastModified} · **First Submitted:** ${firstSubmitted}\n`;

		if (pkg.License?.length) md += `**License:** ${pkg.License.join(", ")}\n`;
		if (pkg.URL) md += `**Upstream:** ${pkg.URL}\n`;
		if (pkg.Keywords?.length) md += `**Keywords:** ${pkg.Keywords.join(", ")}\n`;

		// Dependencies
		if (pkg.Depends?.length) {
			md += `\n## Dependencies (${pkg.Depends.length})\n\n`;
			for (const dep of pkg.Depends) {
				md += `- ${dep}\n`;
			}
		}

		if (pkg.MakeDepends?.length) {
			md += `\n## Make Dependencies (${pkg.MakeDepends.length})\n\n`;
			for (const dep of pkg.MakeDepends) {
				md += `- ${dep}\n`;
			}
		}

		if (pkg.OptDepends?.length) {
			md += `\n## Optional Dependencies\n\n`;
			for (const dep of pkg.OptDepends) {
				md += `- ${dep}\n`;
			}
		}

		if (pkg.CheckDepends?.length) {
			md += `\n## Check Dependencies\n\n`;
			for (const dep of pkg.CheckDepends) {
				md += `- ${dep}\n`;
			}
		}

		// Package relationships
		if (pkg.Provides?.length) {
			md += `\n## Provides\n\n`;
			for (const p of pkg.Provides) {
				md += `- ${p}\n`;
			}
		}

		if (pkg.Conflicts?.length) {
			md += `\n## Conflicts\n\n`;
			for (const c of pkg.Conflicts) {
				md += `- ${c}\n`;
			}
		}

		if (pkg.Replaces?.length) {
			md += `\n## Replaces\n\n`;
			for (const r of pkg.Replaces) {
				md += `- ${r}\n`;
			}
		}

		// Installation instructions
		md += `\n---\n\n## Installation\n\n`;
		md += "```bash\n";
		md += `# Using an AUR helper (e.g., yay, paru)\n`;
		md += `yay -S ${pkg.Name}\n\n`;
		md += `# Manual installation\n`;
		md += `git clone https://aur.archlinux.org/${pkg.PackageBase}.git\n`;
		md += `cd ${pkg.PackageBase}\n`;
		md += `makepkg -si\n`;
		md += "```\n";

		return buildResult(md, { url, method: "aur", fetchedAt, notes: ["Fetched via AUR RPC API"] });
	} catch {}

	return null;
};
