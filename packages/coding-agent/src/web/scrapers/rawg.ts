import { tryParseJson } from "@oh-my-pi/pi-utils";
import { buildResult, htmlToBasicMarkdown, loadPage, type RenderResult, type SpecialHandler } from "./types";

interface RawgPlatformEntry {
	platform?: {
		name?: string;
	};
}

interface RawgGenreEntry {
	name?: string;
}

interface RawgGameResponse {
	name?: string;
	released?: string;
	rating?: number;
	platforms?: RawgPlatformEntry[];
	genres?: RawgGenreEntry[];
	description?: string;
	description_raw?: string;
	detail?: string;
	error?: string;
}

export const handleRawg: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!isRawgHostname(parsed.hostname)) return null;

		const slug = extractGameSlug(parsed.pathname);
		if (!slug) return null;

		const fetchedAt = new Date().toISOString();
		const apiUrl = `https://api.rawg.io/api/games/${encodeURIComponent(slug)}`;
		const result = await loadPage(apiUrl, { timeout, signal, headers: { Accept: "application/json" } });

		if (!result.ok) return null;

		const game = tryParseJson<RawgGameResponse>(result.content);
		if (!game) return null;

		if (requiresApiKey(game)) return null;

		const title = game.name?.trim() || slug;
		let md = `# ${title}\n\n`;

		if (game.released) md += `**Released:** ${game.released}\n`;
		if (typeof game.rating === "number" && !Number.isNaN(game.rating)) {
			md += `**Rating:** ${game.rating.toFixed(2)} / 5\n`;
		}

		const platforms = collectNames(game.platforms?.map(entry => entry.platform?.name));
		if (platforms.length) md += `**Platforms:** ${platforms.join(", ")}\n`;

		const genres = collectNames(game.genres?.map(entry => entry.name));
		if (genres.length) md += `**Genres:** ${genres.join(", ")}\n`;

		md += `**RAWG:** https://rawg.io/games/${encodeURIComponent(slug)}\n`;
		md += "\n";

		const description = await extractDescription(game);
		if (description) {
			md += `## Description\n\n${description}\n`;
		}

		return buildResult(md, { url, method: "rawg", fetchedAt, notes: ["Fetched via RAWG API"] });
	} catch {}

	return null;
};

function isRawgHostname(hostname: string): boolean {
	return hostname === "rawg.io" || hostname === "www.rawg.io";
}

function extractGameSlug(pathname: string): string | null {
	const match = pathname.match(/^\/games\/([^/?#]+)/);
	if (!match) return null;

	const slug = decodeURIComponent(match[1]);
	return slug ? slug.trim() : null;
}

function requiresApiKey(game: RawgGameResponse): boolean {
	const detail = `${game.detail ?? ""} ${game.error ?? ""}`.toLowerCase();
	return detail.includes("api key") || detail.includes("key is required") || detail.includes("apikey");
}

async function extractDescription(game: RawgGameResponse): Promise<string | null> {
	if (game.description_raw) return game.description_raw.trim();
	if (!game.description) return null;

	const markdown = (await htmlToBasicMarkdown(game.description)).trim();
	return markdown || null;
}

function collectNames(values?: Array<string | undefined>): string[] {
	if (!values?.length) return [];
	const names = new Set<string>();
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) names.add(trimmed);
	}
	return Array.from(names);
}
