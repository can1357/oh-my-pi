import { tryParseJson } from "@oh-my-pi/pi-utils";
import { buildResult, formatNumber, loadPage, type RenderResult, type SpecialHandler } from "./types";

interface RubyGemsDependency {
	name: string;
	requirements: string;
}

interface RubyGemsResponse {
	name: string;
	version: string;
	version_created_at?: string;
	authors?: string;
	info?: string;
	licenses?: string[];
	homepage_uri?: string;
	source_code_uri?: string;
	documentation_uri?: string;
	project_uri?: string;
	downloads: number;
	version_downloads?: number;
	gem_uri?: string;
	dependencies?: {
		development?: RubyGemsDependency[];
		runtime?: RubyGemsDependency[];
	};
	metadata?: Record<string, string>;
}

/**
 * Handle RubyGems URLs via API
 */
export const handleRubyGems: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "rubygems.org" && parsed.hostname !== "www.rubygems.org") return null;

		// Extract gem name from /gems/{name}
		const match = parsed.pathname.match(/^\/gems\/([^/]+)/);
		if (!match) return null;

		const gemName = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();

		// Fetch from RubyGems API
		const apiUrl = `https://rubygems.org/api/v1/gems/${encodeURIComponent(gemName)}.json`;
		const result = await loadPage(apiUrl, {
			timeout,
			signal,
			headers: { Accept: "application/json" },
		});

		if (!result.ok) return null;

		const gem = tryParseJson<RubyGemsResponse>(result.content);
		if (!gem) return null;

		let md = `# ${gem.name}\n\n`;
		if (gem.info) md += `${gem.info}\n\n`;

		// Version and license
		md += `**Version:** ${gem.version}`;
		if (gem.licenses?.length) md += ` · **License:** ${gem.licenses.join(", ")}`;
		md += "\n";

		// Downloads
		md += `**Total Downloads:** ${formatNumber(gem.downloads)}`;
		if (gem.version_downloads) md += ` · **Version Downloads:** ${formatNumber(gem.version_downloads)}`;
		md += "\n\n";

		// Links
		if (gem.homepage_uri) md += `**Homepage:** ${gem.homepage_uri}\n`;
		if (gem.source_code_uri) md += `**Source Code:** ${gem.source_code_uri}\n`;
		if (gem.documentation_uri) md += `**Documentation:** ${gem.documentation_uri}\n`;
		if (gem.authors) md += `**Authors:** ${gem.authors}\n`;

		// Runtime dependencies
		const runtimeDeps = gem.dependencies?.runtime;
		if (runtimeDeps && runtimeDeps.length > 0) {
			md += `\n## Runtime Dependencies\n\n`;
			for (const dep of runtimeDeps) {
				md += `- ${dep.name} ${dep.requirements}\n`;
			}
		}

		// Development dependencies
		const devDeps = gem.dependencies?.development;
		if (devDeps && devDeps.length > 0) {
			md += `\n## Development Dependencies\n\n`;
			for (const dep of devDeps) {
				md += `- ${dep.name} ${dep.requirements}\n`;
			}
		}

		return buildResult(md, { url, method: "rubygems", fetchedAt, notes: ["Fetched via RubyGems API"] });
	} catch {}

	return null;
};
