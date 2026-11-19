import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

interface BrewFormula {
	name: string;
	full_name?: string;
	desc?: string;
	homepage?: string;
	license?: string;
	versions?: {
		stable?: string;
		head?: string;
		bottle?: boolean;
	};
	dependencies?: string[];
	build_dependencies?: string[];
	optional_dependencies?: string[];
	conflicts_with?: string[];
	caveats?: string;
	analytics?: {
		install?: {
			"30d"?: Record<string, number>;
			"90d"?: Record<string, number>;
			"365d"?: Record<string, number>;
		};
	};
}

interface BrewCask {
	token: string;
	name?: string[];
	desc?: string;
	homepage?: string;
	version?: string;
	sha256?: string;
	caveats?: string;
	depends_on?: {
		macos?: Record<string, string[]>;
	};
	conflicts_with?: {
		cask?: string[];
	};
	analytics?: {
		install?: {
			"30d"?: Record<string, number>;
			"90d"?: Record<string, number>;
			"365d"?: Record<string, number>;
		};
	};
}

function getInstallCount(analytics?: { install?: { "30d"?: Record<string, number> } }): number | null {
	if (!analytics?.install?.["30d"]) return null;
	const counts = Object.values(analytics.install["30d"]);
	return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * Handle Homebrew formulae and cask URLs via API
 */
export const handleBrew: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "formulae.brew.sh") return null;

		const formulaMatch = parsed.pathname.match(/^\/formula\/([^/]+)\/?$/);
		const caskMatch = parsed.pathname.match(/^\/cask\/([^/]+)\/?$/);

		if (!formulaMatch && !caskMatch) return null;

		const fetchedAt = new Date().toISOString();
		const isFormula = Boolean(formulaMatch);
		const name = decodeURIComponent(isFormula ? formulaMatch![1] : caskMatch![1]);

		const apiUrl = isFormula
			? `https://formulae.brew.sh/api/formula/${encodeURIComponent(name)}.json`
			: `https://formulae.brew.sh/api/cask/${encodeURIComponent(name)}.json`;

		const result = await loadPage(apiUrl, { timeout, signal });
		if (!result.ok) return null;

		let md: string;

		if (isFormula) {
			const formula: BrewFormula = JSON.parse(result.content);

			md = `# ${formula.full_name || formula.name}\n\n`;
			if (formula.desc) md += `${formula.desc}\n\n`;

			md += `**Version:** ${formula.versions?.stable || "unknown"}`;
			if (formula.license) md += ` · **License:** ${formula.license}`;
			md += "\n";

			const installs = getInstallCount(formula.analytics);
			if (installs !== null) {
				md += `**Installs (30d):** ${formatNumber(installs)}\n`;
			}
			md += "\n";

			md += `\`\`\`bash\nbrew install ${formula.name}\n\`\`\`\n\n`;

			if (formula.homepage) md += `**Homepage:** ${formula.homepage}\n`;

			if (formula.dependencies?.length) {
				md += `\n## Dependencies\n\n`;
				for (const dep of formula.dependencies) {
					md += `- ${dep}\n`;
				}
			}

			if (formula.build_dependencies?.length) {
				md += `\n## Build Dependencies\n\n`;
				for (const dep of formula.build_dependencies) {
					md += `- ${dep}\n`;
				}
			}

			if (formula.conflicts_with?.length) {
				md += `\n## Conflicts With\n\n`;
				for (const conflict of formula.conflicts_with) {
					md += `- ${conflict}\n`;
				}
			}

			if (formula.caveats) {
				md += `\n## Caveats\n\n${formula.caveats}\n`;
			}
		} else {
			const cask: BrewCask = JSON.parse(result.content);

			const displayName = cask.name?.[0] || cask.token;
			md = `# ${displayName}\n\n`;
			if (cask.desc) md += `${cask.desc}\n\n`;

			md += `**Version:** ${cask.version || "unknown"}\n`;

			const installs = getInstallCount(cask.analytics);
			if (installs !== null) {
				md += `**Installs (30d):** ${formatNumber(installs)}\n`;
			}
			md += "\n";

			md += `\`\`\`bash\nbrew install --cask ${cask.token}\n\`\`\`\n\n`;

			if (cask.homepage) md += `**Homepage:** ${cask.homepage}\n`;

			if (cask.conflicts_with?.cask?.length) {
				md += `\n## Conflicts With\n\n`;
				for (const conflict of cask.conflicts_with.cask) {
					md += `- ${conflict}\n`;
				}
			}

			if (cask.caveats) {
				md += `\n## Caveats\n\n${cask.caveats}\n`;
			}
		}

		return buildResult(md, {
			url,
			method: "brew",
			fetchedAt,
			notes: [`Fetched via Homebrew ${isFormula ? "formula" : "cask"} API`],
		});
	} catch {}

	return null;
};
