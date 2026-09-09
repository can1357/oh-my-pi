import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai/types";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };

// Pins the invariant: the committed `models.json` must never carry a
// local/self-hosted provider's catalog. Those providers default to an endpoint
// on the developer's own machine (e.g. LiteLLM at `http://localhost:4000/v1`),
// so bundling whatever happens to be running there leaks machine-specific
// endpoints into the shipped snapshot and pollutes the catalog for every user.
// They are discovered dynamically at runtime instead.
//
// This guards against the litellm leak (1202 localhost:4000 models committed)
// and any future regression. Local providers are excluded from generation via
// DISCOVERY_ONLY_PROVIDERS in scripts/generate-models.ts.
//
// Failure here means: a local provider slipped into models.json — add it to
// DISCOVERY_ONLY_PROVIDERS, then `bun run gen:models` and commit the diff.
describe("models.json local-endpoint leak guard (regression)", () => {
	const catalog = MODELS_JSON as unknown as Record<string, Record<string, Model>>;

	// Providers whose default endpoint is the local machine. They must never
	// appear as a top-level key in the bundled catalog.
	const LOCAL_ONLY_PROVIDERS = ["ollama", "vllm", "lm-studio", "litellm"] as const;

	it("does not bundle any local-only provider block", () => {
		const leaked = LOCAL_ONLY_PROVIDERS.filter(provider => provider in catalog);
		expect(leaked, `local provider(s) leaked into models.json: ${leaked.join(", ")}`).toEqual([]);
	});

	it("contains no loopback or private-network baseUrls", () => {
		const offenders: string[] = [];
		for (const provider in catalog) {
			const models = catalog[provider];
			for (const id in models) {
				const baseUrl = models[id].baseUrl;
				if (!baseUrl) continue;
				let host: string;
				try {
					host = new URL(baseUrl).hostname.toLowerCase();
				} catch {
					offenders.push(`${provider}/${id}: unparseable baseUrl "${baseUrl}"`);
					continue;
				}
				if (isLocalHost(host)) {
					offenders.push(`${provider}/${id}: ${baseUrl}`);
				}
			}
		}
		expect(offenders, `local endpoints leaked into models.json:\n${offenders.join("\n")}`).toEqual([]);
	});
});

// Loopback, unspecified, link-local, and RFC 1918 private hosts — anything that
// resolves to the machine that ran the generator rather than a public endpoint.
function isLocalHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host === "0.0.0.0" || host === "::" || host === "::1" || host === "[::1]" || host === "[::]") return true;
	if (host === "127.0.0.1" || host.startsWith("127.")) return true;
	if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
	// 172.16.0.0 – 172.31.255.255
	const match = /^172\.(\d{1,3})\./.exec(host);
	if (match) {
		const second = Number(match[1]);
		if (second >= 16 && second <= 31) return true;
	}
	return false;
}
