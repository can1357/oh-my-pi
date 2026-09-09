import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

interface MarketplaceProperty {
	key?: string;
	value?: string;
}

interface MarketplaceVersion {
	version?: string;
	properties?: MarketplaceProperty[];
}

interface MarketplaceStatistic {
	statisticName?: string;
	value?: number;
}

interface MarketplacePublisher {
	publisherName?: string;
	displayName?: string;
}

interface MarketplaceExtension {
	extensionName?: string;
	displayName?: string;
	shortDescription?: string;
	description?: string;
	publisher?: MarketplacePublisher;
	versions?: MarketplaceVersion[];
	statistics?: MarketplaceStatistic[];
	categories?: string[];
	tags?: string[];
	properties?: MarketplaceProperty[];
}

interface MarketplaceResponse {
	results?: Array<{ extensions?: MarketplaceExtension[] }>;
}

const MARKETPLACE_HOSTS = new Set(["marketplace.visualstudio.com", "www.marketplace.visualstudio.com"]);

function getItemName(parsed: URL): string | null {
	if (!parsed.pathname.startsWith("/items")) return null;
	const itemName = parsed.searchParams.get("itemName");
	if (!itemName) return null;
	const decoded = decodeURIComponent(itemName);
	if (!decoded.includes(".")) return null;
	return decoded;
}

function toStatMap(stats: MarketplaceStatistic[] | undefined): Map<string, number> {
	const map = new Map<string, number>();
	if (!stats) return map;
	for (const stat of stats) {
		if (!stat.statisticName || typeof stat.value !== "number") continue;
		map.set(stat.statisticName.trim().toLowerCase(), stat.value);
	}
	return map;
}

function formatRating(averageRating?: number, ratingCount?: number): string | null {
	if (averageRating === undefined && ratingCount === undefined) return null;
	if (averageRating !== undefined) {
		const formatted = averageRating.toFixed(2).replace(/\.0+$/, "").replace(/\.$/, "");
		if (ratingCount !== undefined) {
			return `${formatted} (${formatNumber(ratingCount)} ratings)`;
		}
		return formatted;
	}
	if (ratingCount !== undefined) {
		return `${formatNumber(ratingCount)} ratings`;
	}
	return null;
}

function extractRepoLink(properties: MarketplaceProperty[] | undefined): string | null {
	if (!properties) return null;
	for (const prop of properties) {
		const key = prop.key?.trim().toLowerCase();
		const value = prop.value?.trim();
		if (!key || !value) continue;
		if (!value.startsWith("http")) continue;
		if (key.includes("links.source") || key.includes("repository")) return value;
	}
	for (const prop of properties) {
		const key = prop.key?.trim().toLowerCase();
		const value = prop.value?.trim();
		if (!key || !value) continue;
		if (!value.startsWith("http")) continue;
		if (key === "source" || key.endsWith(".source")) return value;
	}
	return null;
}

/**
 * Handle VS Code Marketplace URLs via extension query API
 */
export const handleVscodeMarketplace: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!MARKETPLACE_HOSTS.has(parsed.hostname)) return null;

		const itemName = getItemName(parsed);
		if (!itemName) return null;

		const [publisherFromUrl, ...nameParts] = itemName.split(".");
		const extensionFromUrl = nameParts.join(".");

		const fetchedAt = new Date().toISOString();
		const apiUrl = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
		const payload = JSON.stringify({
			filters: [
				{
					criteria: [{ filterType: 7, value: itemName }],
				},
			],
			flags: 950,
		});

		const result = await loadPage(apiUrl, {
			timeout,
			signal,
			method: "POST",
			body: payload,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json;api-version=7.2-preview.1",
			},
		});

		if (!result.ok) return null;

		const data = tryParseJson<MarketplaceResponse>(result.content);
		if (!data) return null;

		const extension = data.results?.[0]?.extensions?.[0];
		if (!extension) return null;

		const extensionName = extension.extensionName ?? extensionFromUrl;
		const displayName = extension.displayName ?? extensionName ?? itemName;
		const description = extension.shortDescription ?? extension.description;

		const publisherName = extension.publisher?.publisherName ?? publisherFromUrl;
		const publisherDisplayName = extension.publisher?.displayName;
		const publisherLabel =
			publisherDisplayName && publisherName && publisherDisplayName !== publisherName
				? `${publisherDisplayName} (${publisherName})`
				: (publisherDisplayName ?? publisherName);

		const version = extension.versions?.[0]?.version;
		const statMap = toStatMap(extension.statistics);
		const installs = statMap.get("install") ?? statMap.get("installs");
		const averageRating = statMap.get("averagerating");
		const ratingCount = statMap.get("ratingcount");
		const ratingLabel = formatRating(averageRating, ratingCount);

		const repoLink = extractRepoLink(extension.versions?.[0]?.properties) ?? extractRepoLink(extension.properties);

		const identifier = publisherName && extensionName ? `${publisherName}.${extensionName}` : itemName;

		let md = `# ${displayName}\n\n`;
		if (description) md += `${description}\n\n`;
		md += `**Identifier:** ${identifier}\n`;
		if (publisherLabel) md += `**Publisher:** ${publisherLabel}\n`;
		if (version) md += `**Version:** ${version}\n`;
		if (installs !== undefined) md += `**Installs:** ${formatNumber(installs)}\n`;
		if (ratingLabel) md += `**Rating:** ${ratingLabel}\n`;
		if (extension.categories?.length) md += `**Categories:** ${extension.categories.join(", ")}\n`;
		if (extension.tags?.length) md += `**Tags:** ${extension.tags.join(", ")}\n`;
		if (repoLink) md += `**Repository:** ${repoLink}\n`;

		return buildResult(md, {
			url,
			method: "vscode-marketplace",
			fetchedAt,
			notes: ["Fetched via VS Code Marketplace API"],
		});
	} catch {}

	return null;
};
