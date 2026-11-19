import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, loadPage } from "./types";

interface OsvSeverity {
	type: string;
	score: string;
}

interface OsvAffectedRange {
	type: string;
	events?: Array<{ introduced?: string; fixed?: string; last_affected?: string; limit?: string }>;
}

interface OsvAffected {
	package?: {
		ecosystem: string;
		name: string;
		purl?: string;
	};
	ranges?: OsvAffectedRange[];
	versions?: string[];
	severity?: OsvSeverity[];
	database_specific?: Record<string, unknown>;
	ecosystem_specific?: Record<string, unknown>;
}

interface OsvReference {
	type: string;
	url: string;
}

interface OsvVulnerability {
	id: string;
	summary?: string;
	details?: string;
	aliases?: string[];
	modified?: string;
	published?: string;
	withdrawn?: string;
	severity?: OsvSeverity[];
	affected?: OsvAffected[];
	references?: OsvReference[];
	credits?: Array<{ name: string; contact?: string[]; type?: string }>;
	database_specific?: Record<string, unknown>;
}

/**
 * Handle OSV (Open Source Vulnerabilities) URLs
 */
export const handleOsv: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "osv.dev") return null;

		// Extract vulnerability ID from /vulnerability/{id}
		const match = parsed.pathname.match(/^\/vulnerability\/([A-Za-z0-9-]+)$/);
		if (!match) return null;

		const vulnId = match[1];
		const fetchedAt = new Date().toISOString();

		// Fetch from OSV API
		const apiUrl = `https://api.osv.dev/v1/vulns/${vulnId}`;
		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) return null;

		const vuln = tryParseJson<OsvVulnerability>(result.content);
		if (!vuln) return null;

		let md = `# ${vuln.id}\n\n`;

		// Summary
		if (vuln.summary) {
			md += `${vuln.summary}\n\n`;
		}

		// Metadata section
		md += "## Metadata\n\n";
		if (vuln.aliases?.length) {
			md += `**Aliases:** ${vuln.aliases.join(", ")}\n`;
		}
		if (vuln.published) {
			md += `**Published:** ${formatIsoDate(vuln.published)}\n`;
		}
		if (vuln.modified) {
			md += `**Modified:** ${formatIsoDate(vuln.modified)}\n`;
		}
		if (vuln.withdrawn) {
			md += `**Withdrawn:** ${formatIsoDate(vuln.withdrawn)}\n`;
		}

		// Severity
		const severities = vuln.severity || vuln.affected?.flatMap(a => a.severity || []) || [];
		if (severities.length) {
			const formatted = severities.map(s => `${s.type}: ${s.score}`).join(", ");
			md += `**Severity:** ${formatted}\n`;
		}
		md += "\n";

		// Details
		if (vuln.details) {
			md += `## Details\n\n${vuln.details}\n\n`;
		}

		// Affected packages
		if (vuln.affected?.length) {
			md += "## Affected Packages\n\n";
			for (const affected of vuln.affected) {
				const pkg = affected.package;
				if (!pkg) continue;

				md += `### ${pkg.ecosystem}: ${pkg.name}\n\n`;

				// Version ranges
				if (affected.ranges?.length) {
					for (const range of affected.ranges) {
						if (!range.events?.length) continue;
						const parts: string[] = [];
						for (const event of range.events) {
							if (event.introduced) parts.push(`introduced: ${event.introduced}`);
							if (event.fixed) parts.push(`fixed: ${event.fixed}`);
							if (event.last_affected) parts.push(`last_affected: ${event.last_affected}`);
							if (event.limit) parts.push(`limit: ${event.limit}`);
						}
						if (parts.length) {
							md += `- **${range.type}:** ${parts.join(" → ")}\n`;
						}
					}
				}

				// Specific versions
				if (affected.versions?.length) {
					const versions =
						affected.versions.length > 10
							? `${affected.versions.slice(0, 10).join(", ")}… (${affected.versions.length} total)`
							: affected.versions.join(", ");
					md += `- **Versions:** ${versions}\n`;
				}

				md += "\n";
			}
		}

		// References
		if (vuln.references?.length) {
			md += "## References\n\n";
			for (const ref of vuln.references) {
				md += `- [${ref.type}](${ref.url})\n`;
			}
			md += "\n";
		}

		// Credits
		if (vuln.credits?.length) {
			md += "## Credits\n\n";
			for (const credit of vuln.credits) {
				const type = credit.type ? ` (${credit.type})` : "";
				md += `- ${credit.name}${type}\n`;
			}
		}

		return buildResult(md, { url, method: "osv", fetchedAt, notes: ["Fetched via OSV API"] });
	} catch {}

	return null;
};
