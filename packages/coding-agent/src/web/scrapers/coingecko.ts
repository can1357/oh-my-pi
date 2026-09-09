import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

interface CoinGeckoResponse {
	id: string;
	symbol: string;
	name: string;
	description?: { en?: string };
	links?: {
		homepage?: string[];
		blockchain_site?: string[];
		repos_url?: { github?: string[] };
	};
	market_data?: {
		current_price?: { usd?: number };
		market_cap?: { usd?: number };
		total_volume?: { usd?: number };
		price_change_percentage_24h?: number;
		ath?: { usd?: number };
		ath_date?: { usd?: string };
		circulating_supply?: number;
		total_supply?: number;
		max_supply?: number;
	};
	categories?: string[];
	genesis_date?: string;
}

/**
 * Handle CoinGecko cryptocurrency URLs via API
 */
export const handleCoinGecko: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("coingecko.com")) return null;

		// Extract coin ID from /coins/{id} or /en/coins/{id}
		const match = parsed.pathname.match(/^(?:\/[a-z]{2})?\/coins\/([^/?#]+)/);
		if (!match) return null;

		const coinId = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();

		// Fetch from CoinGecko API
		const apiUrl = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`;
		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) {
			const fallback = `# ${coinId}\n\nCoinGecko market data is currently unavailable for this asset.\n`;
			return buildResult(fallback, {
				url,
				method: "coingecko",
				fetchedAt,
				notes: ["CoinGecko API request failed"],
			});
		}

		const coin = tryParseJson<CoinGeckoResponse>(result.content);
		if (!coin) {
			const fallback = `# ${coinId}\n\nCoinGecko response could not be parsed for this asset.\n`;
			return buildResult(fallback, {
				url,
				method: "coingecko",
				fetchedAt,
				notes: ["CoinGecko API response parsing failed"],
			});
		}

		const market = coin.market_data;

		let md = `# ${coin.name} (${coin.symbol.toUpperCase()})\n\n`;

		// Price and market data
		if (market?.current_price?.usd !== undefined) {
			md += `**Price:** $${formatPrice(market.current_price.usd)}`;
			if (market.price_change_percentage_24h !== undefined) {
				const change = market.price_change_percentage_24h;
				const sign = change >= 0 ? "+" : "";
				md += ` (${sign}${change.toFixed(2)}% 24h)`;
			}
			md += "\n";
		}

		if (market?.market_cap?.usd) {
			md += `**Market Cap:** $${formatNumber(market.market_cap.usd)}\n`;
		}

		if (market?.total_volume?.usd) {
			md += `**24h Volume:** $${formatNumber(market.total_volume.usd)}\n`;
		}

		if (market?.ath?.usd !== undefined) {
			md += `**All-Time High:** $${formatPrice(market.ath.usd)}`;
			if (market.ath_date?.usd) {
				const athDate = new Date(market.ath_date.usd).toLocaleDateString("en-US", {
					year: "numeric",
					month: "short",
					day: "numeric",
				});
				md += ` (${athDate})`;
			}
			md += "\n";
		}

		md += "\n";

		// Supply info
		if (market?.circulating_supply) {
			md += `**Circulating Supply:** ${formatNumber(Math.round(market.circulating_supply))}`;
			if (market.max_supply) {
				const percent = ((market.circulating_supply / market.max_supply) * 100).toFixed(1);
				md += ` / ${formatNumber(Math.round(market.max_supply))} (${percent}%)`;
			} else if (market.total_supply) {
				md += ` / ${formatNumber(Math.round(market.total_supply))} total`;
			}
			md += "\n";
		}

		if (coin.genesis_date) {
			md += `**Launch Date:** ${coin.genesis_date}\n`;
		}

		if (coin.categories?.length) {
			md += `**Categories:** ${coin.categories.join(", ")}\n`;
		}

		// Links
		const links: string[] = [];
		if (coin.links?.homepage?.[0]) {
			links.push(`[Website](${coin.links.homepage[0]})`);
		}
		if (coin.links?.blockchain_site?.[0]) {
			links.push(`[Explorer](${coin.links.blockchain_site[0]})`);
		}
		if (coin.links?.repos_url?.github?.[0]) {
			links.push(`[GitHub](${coin.links.repos_url.github[0]})`);
		}
		if (links.length) {
			md += `**Links:** ${links.join(" · ")}\n`;
		}

		// Description
		if (coin.description?.en) {
			const desc = coin.description.en
				.replace(/<[^>]+>/g, "") // Strip HTML
				.replace(/\r\n/g, "\n")
				.trim();
			if (desc) {
				md += `\n## About\n\n${desc}\n`;
			}
		}

		return buildResult(md, { url, method: "coingecko", fetchedAt, notes: ["Fetched via CoinGecko API"] });
	} catch {}

	return null;
};

/**
 * Format price with appropriate decimal places
 */
function formatPrice(price: number): string {
	if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
	if (price >= 1) return price.toFixed(2);
	if (price >= 0.01) return price.toFixed(4);
	if (price >= 0.0001) return price.toFixed(6);
	return price.toFixed(8);
}
