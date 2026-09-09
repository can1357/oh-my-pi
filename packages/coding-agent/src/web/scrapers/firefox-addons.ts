import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { LocalizedText, RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, getLocalizedText, htmlToBasicMarkdown, loadPage } from "./types";

type AddonFile = {
	permissions?: string[];
	host_permissions?: string[];
	optional_permissions?: string[];
	optional_host_permissions?: string[];
};

type AddonLicense = {
	name?: LocalizedText;
	slug?: string;
	url?: string;
};

type AddonVersion = {
	version?: string;
	license?: AddonLicense;
	file?: AddonFile;
};

type AddonHomepage = {
	url?: LocalizedText;
	outgoing?: LocalizedText;
};

type AddonData = {
	name?: LocalizedText;
	summary?: LocalizedText;
	description?: LocalizedText;
	default_locale?: string;
	authors?: Array<{ name?: string | null }>;
	average_daily_users?: number;
	weekly_downloads?: number;
	ratings?: { average?: number; count?: number };
	current_version?: AddonVersion;
	categories?: string[] | Record<string, string[]>;
	homepage?: AddonHomepage;
	url?: string;
};

function normalizeCategories(categories?: string[] | Record<string, string[]>): string[] {
	if (!categories) return [];
	if (Array.isArray(categories)) return categories.filter(Boolean);

	const values: string[] = [];
	for (const list of Object.values(categories)) {
		if (Array.isArray(list)) {
			for (const item of list) {
				if (item) values.push(item);
			}
		}
	}

	const seen = new Set<string>();
	return values.filter(item => {
		if (seen.has(item)) return false;
		seen.add(item);
		return true;
	});
}

function collectPermissions(file?: AddonFile): string[] {
	if (!file) return [];
	const permissions: string[] = [];
	const seen = new Set<string>();

	const add = (items?: string[]) => {
		for (const item of items ?? []) {
			if (!item || seen.has(item)) continue;
			seen.add(item);
			permissions.push(item);
		}
	};

	add(file.permissions);
	add(file.host_permissions);
	add(file.optional_permissions);
	add(file.optional_host_permissions);

	return permissions;
}

export const handleFirefoxAddons: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "addons.mozilla.org") return null;

		const segments = parsed.pathname.split("/").filter(Boolean);
		const addonIndex = segments.indexOf("addon");
		if (addonIndex === -1) return null;

		const slug = segments[addonIndex + 1] ? decodeURIComponent(segments[addonIndex + 1]) : "";
		if (!slug) return null;

		const apiUrl = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(slug)}/`;
		const result = await loadPage(apiUrl, { timeout, headers: { Accept: "application/json" }, signal });
		if (!result.ok) return null;

		const data = tryParseJson<AddonData>(result.content);
		if (!data) return null;

		const fetchedAt = new Date().toISOString();
		const defaultLocale = data.default_locale || "en-US";

		const name = getLocalizedText(data.name, defaultLocale) ?? slug;
		const summary = getLocalizedText(data.summary, defaultLocale);
		const descriptionRaw = getLocalizedText(data.description, defaultLocale);
		const description = descriptionRaw ? await htmlToBasicMarkdown(descriptionRaw) : undefined;

		const authors = (data.authors ?? [])
			.map(author => author.name ?? "")
			.map(author => author.trim())
			.filter(Boolean);

		const ratingAverage = data.ratings?.average;
		const ratingCount = data.ratings?.count;
		const users = data.average_daily_users ?? data.weekly_downloads;
		const version = data.current_version?.version;
		const categories = normalizeCategories(data.categories);

		const licenseName =
			getLocalizedText(data.current_version?.license?.name, defaultLocale) ?? data.current_version?.license?.slug;
		const licenseUrl = data.current_version?.license?.url;

		const homepage =
			getLocalizedText(data.homepage?.url, defaultLocale) ??
			getLocalizedText(data.homepage?.outgoing, defaultLocale);

		const permissions = collectPermissions(data.current_version?.file);

		let md = `# ${name}\n\n`;
		if (summary) md += `${summary}\n\n`;

		if (authors.length > 0) {
			md += `**Author${authors.length > 1 ? "s" : ""}:** ${authors.join(", ")}\n`;
		}

		if (ratingAverage !== undefined) {
			md += `**Rating:** ${ratingAverage.toFixed(2)}`;
			if (ratingCount !== undefined) md += ` (${formatNumber(ratingCount)} reviews)`;
			md += "\n";
		}

		if (users !== undefined) md += `**Users:** ${formatNumber(users)}\n`;
		if (version) md += `**Version:** ${version}\n`;
		if (categories.length > 0) md += `**Categories:** ${categories.join(", ")}\n`;

		if (licenseName && licenseUrl) {
			md += `**License:** [${licenseName}](${licenseUrl})\n`;
		} else if (licenseName) {
			md += `**License:** ${licenseName}\n`;
		} else if (licenseUrl) {
			md += `**License:** ${licenseUrl}\n`;
		}

		if (homepage) md += `**Homepage:** ${homepage}\n`;

		if (description) {
			md += `\n## Description\n\n${description}\n`;
		}

		if (permissions.length > 0) {
			const preview = permissions.slice(0, 40);
			md += `\n## Permissions (${permissions.length})\n\n`;
			for (const permission of preview) {
				md += `- ${permission}\n`;
			}
			if (permissions.length > preview.length) {
				md += `\n[…${permissions.length - preview.length} permissions elided…]\n`;
			}
		}

		const finalUrl = data.url ?? result.finalUrl ?? url;
		return buildResult(md, {
			url,
			finalUrl,
			method: "firefox-addons",
			fetchedAt,
			notes: ["Fetched via Firefox Add-ons API"],
		});
	} catch {}

	return null;
};
