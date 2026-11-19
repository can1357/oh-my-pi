import { compareVersions, tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

interface HackageVersionMap {
	[version: string]: string;
}

interface ParsedCabal {
	name?: string;
	version?: string;
	synopsis?: string;
	description?: string;
	license?: string;
	author?: string;
	maintainer?: string;
	homepage?: string;
	bugReports?: string;
	category?: string;
	stability?: string;
}

function extractCabalField(content: string, fieldName: string): string | undefined {
	const pattern = new RegExp(`^${fieldName}:\\s*(.*)$`, "im");
	const match = content.match(pattern);
	if (!match) return undefined;
	return match[1].trim();
}

function extractCabalDescription(content: string): string | undefined {
	const lines = content.split("\n");
	const start = lines.findIndex(line => line.toLowerCase().startsWith("description:"));
	if (start < 0) return undefined;
	const value = lines[start].replace(/^description:\s*/i, "").trim();
	const chunks: string[] = [value];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.startsWith("  ")) break;
		chunks.push(line.trim());
	}
	const description = chunks.join("\n").trim();
	return description || undefined;
}

function parseCabal(content: string): ParsedCabal {
	return {
		name: extractCabalField(content, "name"),
		version: extractCabalField(content, "version"),
		synopsis: extractCabalField(content, "synopsis"),
		description: extractCabalDescription(content),
		license: extractCabalField(content, "license"),
		author: extractCabalField(content, "author"),
		maintainer: extractCabalField(content, "maintainer"),
		homepage: extractCabalField(content, "homepage"),
		bugReports: extractCabalField(content, "bug-reports"),
		category: extractCabalField(content, "category"),
		stability: extractCabalField(content, "stability"),
	};
}

/**
 * Handle Hackage (Haskell package registry) URLs via JSON API
 */
export const handleHackage: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "hackage.haskell.org") return null;

		// Match /package/{name} or /package/{name}-{version}
		const match = parsed.pathname.match(/^\/package\/([^/]+)(?:\/|$)/);
		if (!match) return null;

		const packageId = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();

		// Version endpoint returns a map of version -> status.
		const versionUrl = `https://hackage.haskell.org/package/${encodeURIComponent(packageId)}.json`;
		const versionResult = await loadPage(versionUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!versionResult.ok) return null;

		const versionMap = tryParseJson<HackageVersionMap>(versionResult.content);
		if (!versionMap) return null;
		const latestVersion = Object.keys(versionMap).sort(compareVersions).at(-1);
		if (!latestVersion) return null;

		// Fetch the latest cabal file for package metadata.
		const cabalUrl = `https://hackage.haskell.org/package/${encodeURIComponent(packageId)}-${latestVersion}/${encodeURIComponent(packageId)}.cabal`;
		const cabalResult = await loadPage(cabalUrl, {
			timeout,
			headers: { Accept: "text/plain" },
			signal,
		});

		if (!cabalResult.ok) return null;

		const pkg = parseCabal(cabalResult.content);

		let md = `# ${pkg.name || packageId}\n\n`;
		if (pkg.synopsis) md += `${pkg.synopsis}\n\n`;

		md += `**Version:** ${pkg.version || latestVersion}`;
		if (pkg.license) md += ` · **License:** ${pkg.license}`;
		md += "\n";

		if (pkg.author) md += `**Author:** ${pkg.author}\n`;
		if (pkg.maintainer) md += `**Maintainer:** ${pkg.maintainer}\n`;
		if (pkg.category) md += `**Category:** ${pkg.category}\n`;
		if (pkg.stability) md += `**Stability:** ${pkg.stability}\n`;
		if (pkg.homepage) md += `**Homepage:** ${pkg.homepage}\n`;
		if (pkg.bugReports) md += `**Bug Reports:** ${pkg.bugReports}\n`;

		if (pkg.description) {
			md += `\n## Description\n\n${pkg.description}\n`;
		}

		return buildResult(md, { url, method: "hackage", fetchedAt, notes: ["Fetched via Hackage API"] });
	} catch {}

	return null;
};
