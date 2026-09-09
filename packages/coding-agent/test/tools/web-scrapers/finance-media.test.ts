import { describe, expect, it } from "bun:test";
import { handleArtifactHub } from "@oh-my-pi/pi-coding-agent/web/scrapers/artifacthub";
import { handleCoinGecko } from "@oh-my-pi/pi-coding-agent/web/scrapers/coingecko";
import { handleDiscogs } from "@oh-my-pi/pi-coding-agent/web/scrapers/discogs";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleCoinGecko", () => {
	it("returns null for non-CoinGecko URLs", async () => {
		const result = await handleCoinGecko("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for CoinGecko homepage", async () => {
		const result = await handleCoinGecko("https://www.coingecko.com/", 20);
		expect(result).toBeNull();
	});

	it("returns null for CoinGecko categories page", async () => {
		const result = await handleCoinGecko("https://www.coingecko.com/en/categories", 20);
		expect(result).toBeNull();
	});

	it("fetches Bitcoin data", async () => {
		const result = await handleCoinGecko("https://www.coingecko.com/en/coins/bitcoin", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("coingecko");
		expect(result?.content).toMatch(/bitcoin/i);
		if (!result?.content.includes("currently unavailable")) {
			expect(result?.content).toContain("BTC");
			expect(result?.content).toContain("Price");
		}
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches Ethereum data", async () => {
		const result = await handleCoinGecko("https://www.coingecko.com/en/coins/ethereum", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("coingecko");
		expect(result?.content).toMatch(/ethereum/i);
		if (!result?.content.includes("currently unavailable")) {
			expect(result?.content).toContain("ETH");
			expect(result?.content).toContain("Market Cap");
		}
	});

	it("handles URL without locale prefix", async () => {
		const result = await handleCoinGecko("https://www.coingecko.com/coins/bitcoin", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("coingecko");
	});
});

describe.skipIf(SKIP)("handleDiscogs", () => {
	it("returns null for non-Discogs URLs", async () => {
		const result = await handleDiscogs("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for Discogs homepage", async () => {
		const result = await handleDiscogs("https://www.discogs.com/", 20);
		expect(result).toBeNull();
	});

	it("returns null for Discogs search page", async () => {
		const result = await handleDiscogs("https://www.discogs.com/search/", 20);
		expect(result).toBeNull();
	});

	it("fetches Daft Punk Discovery release", async () => {
		// Release 249504: Daft Punk - Discovery
		const result = await handleDiscogs("https://www.discogs.com/release/249504-Daft-Punk-Discovery", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("discogs");
		expect(result?.content).toContain("Tracklist");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches master release", async () => {
		// Master 96559: Rick Astley - Never Gonna Give You Up
		const result = await handleDiscogs("https://www.discogs.com/master/96559", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("discogs");
		expect(result?.content).toContain("Master Release");
	});

	it("handles release URL with just ID", async () => {
		const result = await handleDiscogs("https://www.discogs.com/release/249504", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("discogs");
	});
});

describe.skipIf(SKIP)("handleArtifactHub", () => {
	it("returns null for non-ArtifactHub URLs", async () => {
		const result = await handleArtifactHub("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for ArtifactHub homepage", async () => {
		const result = await handleArtifactHub("https://artifacthub.io/", 20);
		expect(result).toBeNull();
	});

	it("returns null for ArtifactHub search page", async () => {
		const result = await handleArtifactHub("https://artifacthub.io/packages/search", 20);
		expect(result).toBeNull();
	});

	it("fetches bitnami/nginx helm chart", async () => {
		const result = await handleArtifactHub("https://artifacthub.io/packages/helm/bitnami/nginx", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("artifacthub");
		expect(result?.content).toContain("nginx");
		expect(result?.content).toContain("Helm Chart");
		expect(result?.content).toContain("Version");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches prometheus-community/prometheus helm chart", async () => {
		const result = await handleArtifactHub(
			"https://artifacthub.io/packages/helm/prometheus-community/prometheus",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("artifacthub");
		expect(result?.content).toContain("prometheus");
		expect(result?.content).toContain("Repository");
	});

	it("handles www subdomain", async () => {
		const result = await handleArtifactHub("https://www.artifacthub.io/packages/helm/bitnami/nginx", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("artifacthub");
	});
});
