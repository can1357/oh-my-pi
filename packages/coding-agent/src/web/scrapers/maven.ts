import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, formatNumber, loadPage } from "./types";

interface MavenDoc {
	id: string;
	g: string; // groupId
	a: string; // artifactId
	latestVersion: string;
	repositoryId: string;
	p: string; // packaging
	timestamp: number;
	versionCount: number;
	text?: string[];
	ec?: string[]; // extensions/classifiers
}

interface MavenResponse {
	response: {
		numFound: number;
		docs: MavenDoc[];
	};
}

/**
 * Handle Maven Central URLs via Solr API
 * Supports: search.maven.org/artifact/... and mvnrepository.com/artifact/...
 */
export const handleMaven: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname;

		// Check if this is a Maven URL
		const isSearchMaven = hostname === "search.maven.org";
		const isMvnRepository = hostname === "mvnrepository.com" || hostname === "www.mvnrepository.com";

		if (!isSearchMaven && !isMvnRepository) return null;

		let groupId: string | null = null;
		let artifactId: string | null = null;
		let version: string | null = null;

		if (isSearchMaven) {
			// Pattern: /artifact/{groupId}/{artifactId}[/{version}[/{packaging}]]
			const match = parsed.pathname.match(/^\/artifact\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
			if (!match) return null;
			groupId = match[1];
			artifactId = match[2];
			version = match[3] || null;
		} else if (isMvnRepository) {
			// Pattern: /artifact/{groupId}/{artifactId}[/{version}]
			const match = parsed.pathname.match(/^\/artifact\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
			if (!match) return null;
			groupId = match[1];
			artifactId = match[2];
			version = match[3] || null;
		}

		if (!groupId || !artifactId) return null;

		const fetchedAt = new Date().toISOString();

		// Query Maven Central API
		const apiUrl = `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(groupId)}+AND+a:${encodeURIComponent(artifactId)}&wt=json&rows=1`;
		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) return null;

		const data = tryParseJson<MavenResponse>(result.content);
		if (!data) return null;

		if (data.response.numFound === 0) return null;

		const doc = data.response.docs[0];
		const displayVersion = version || doc.latestVersion;

		let md = `# ${doc.g}:${doc.a}\n\n`;
		md += `**Group ID:** ${doc.g}\n`;
		md += `**Artifact ID:** ${doc.a}\n`;
		md += `**Latest Version:** ${doc.latestVersion}`;
		if (version && version !== doc.latestVersion) {
			md += ` (viewing ${version})`;
		}
		md += "\n";

		if (doc.p) md += `**Packaging:** ${doc.p}\n`;
		if (doc.versionCount) md += `**Versions:** ${formatNumber(doc.versionCount)}\n`;
		if (doc.timestamp) {
			md += `**Last Updated:** ${formatIsoDate(doc.timestamp)}\n`;
		}

		// Add dependency snippets
		md += `\n## Maven Dependency\n\n`;
		md += "```xml\n";
		md += `<dependency>\n`;
		md += `    <groupId>${doc.g}</groupId>\n`;
		md += `    <artifactId>${doc.a}</artifactId>\n`;
		md += `    <version>${displayVersion}</version>\n`;
		md += `</dependency>\n`;
		md += "```\n";

		md += `\n## Gradle Dependency\n\n`;
		md += "```groovy\n";
		md += `implementation '${doc.g}:${doc.a}:${displayVersion}'\n`;
		md += "```\n";

		md += `\n## Gradle (Kotlin DSL)\n\n`;
		md += "```kotlin\n";
		md += `implementation("${doc.g}:${doc.a}:${displayVersion}")\n`;
		md += "```\n";

		// Add available classifiers/extensions if present
		if (doc.ec && doc.ec.length > 0) {
			const extensions = doc.ec.filter(e => e && e !== "-");
			if (extensions.length > 0) {
				md += `\n## Available Extensions\n\n`;
				md += `${extensions.map(e => `- ${e}`).join("\n")}\n`;
			}
		}

		md += `\n## Links\n\n`;
		md += `- [Maven Central](https://search.maven.org/artifact/${doc.g}/${doc.a}/${displayVersion}/jar)\n`;
		md += `- [MVN Repository](https://mvnrepository.com/artifact/${doc.g}/${doc.a}/${displayVersion})\n`;

		return buildResult(md, { url, method: "maven", fetchedAt, notes: ["Fetched via Maven Central API"] });
	} catch {}

	return null;
};
