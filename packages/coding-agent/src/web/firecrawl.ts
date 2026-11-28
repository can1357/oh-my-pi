/**
 * Firecrawl API Client
 *
 * Endpoint and credential configuration for Firecrawl web search and the
 * native reader backend, including self-hosted base URL overrides.
 */
import { getEnvApiKey } from "@oh-my-pi/pi-ai";
import type { AgentStorageApi } from "../session/agent-storage";
import { findCredential } from "./search/providers/utils";

const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev/v2";

/** Self-hosted Firecrawl base URL from `FIRECRAWL_BASE_URL` (or its `FIRECRAWL_API_URL` alias), if configured. */
export function configuredFirecrawlBaseUrl(): string | undefined {
	return (process.env.FIRECRAWL_BASE_URL ?? process.env.FIRECRAWL_API_URL)?.trim() || undefined;
}

/**
 * Resolve a Firecrawl endpoint URL, applying the `FIRECRAWL_BASE_URL` (or its
 * `FIRECRAWL_API_URL` alias) self-hosting override when set. A configured base
 * keeps an explicit `/v1` or `/v2` suffix and is otherwise defaulted to `/v2`.
 */
export function resolveFirecrawlUrl(endpoint: "/search" | "/scrape"): string {
	const configured = configuredFirecrawlBaseUrl();
	if (!configured) return `${FIRECRAWL_DEFAULT_BASE_URL}${endpoint}`;
	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		throw new Error("Invalid Firecrawl base URL: expected an HTTP or HTTPS URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Invalid Firecrawl base URL: expected an HTTP or HTTPS URL");
	}
	if (url.username || url.password) {
		throw new Error("Invalid Firecrawl base URL: URL credentials are not allowed");
	}
	url.search = "";
	url.hash = "";
	// Build the path in a local string: assigning "" to `URL.pathname` normalizes
	// straight back to "/", so a bare origin would otherwise yield "//v2/scrape".
	let basePath = url.pathname.replace(/\/+$/, "");
	if (!/\/v[12]$/i.test(basePath)) basePath += "/v2";
	url.pathname = basePath + endpoint;
	return url.toString();
}

export function findFirecrawlApiKey(storage: AgentStorageApi | null | undefined): Promise<string | null> {
	return findCredential(storage, getEnvApiKey("firecrawl"), "firecrawl");
}
