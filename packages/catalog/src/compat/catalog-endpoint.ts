import { getBundledModels, isGeneratedProvider } from "../models";
import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

const bundledHosts = new Map<string, string | null>();

/** Hostname of the provider's bundled base URL; every provider bundles one origin. */
function bundledHost(provider: string): string | null {
	let host = bundledHosts.get(provider);
	if (host !== undefined) return host;
	host = null;
	if (isGeneratedProvider(provider)) {
		for (const row of getBundledModels(provider)) {
			try {
				host = new URL(row.baseUrl).hostname;
				break;
			} catch {}
		}
	}
	bundledHosts.set(provider, host);
	return host;
}

/**
 * Whether {@link url} is HTTPS to {@link model}'s provider's own endpoint: the
 * host of its bundled base URL or one of its `endpoint-hosts`. A custom model
 * or provider override that keeps a catalog provider id but points `baseUrl`
 * at a gateway, proxy, or local server is not.
 */
export function isCatalogEndpointUrl(model: Model, url: string | undefined): boolean {
	if (!url) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	if (parsed.hostname === bundledHost(model.provider)) return true;
	// The rule compiler validates `endpoint-hosts` as an array of strings.
	const hosts = resolveCatalogPolicy(model).endpointHosts as readonly string[] | undefined;
	return hosts?.includes(parsed.hostname) === true;
}
