import { describe, expect, it } from "bun:test";
import { fetchGeminiCliQuotaModels } from "@oh-my-pi/pi-catalog/discovery/gemini-cli";
import { googleGeminiCliModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/google";

const CCA = "https://cloudcode-pa.googleapis.com";

/**
 * Builds a fetch stub that emulates a Gemini Code Assist Standard credential:
 * the Antigravity `fetchAvailableModels` endpoint is forbidden, while the
 * account's own `loadCodeAssist` / `retrieveUserQuota` calls on Cloud Code
 * Assist succeed. `quotaStatus` overrides the quota response status.
 */
function standardTierFetcher(
	quotaModelIds: string[],
	options: { recorded?: string[]; quotaStatus?: number } = {},
): typeof fetch {
	const buckets = quotaModelIds.map(modelId => ({ tokenType: "REQUESTS", modelId, remainingFraction: 1 }));
	return Object.assign(
		(input: string | URL | Request, _init?: RequestInit) => {
			const url = String(input);
			options.recorded?.push(url);
			if (url.includes(":fetchAvailableModels")) {
				return Promise.resolve(new Response("Forbidden", { status: 403 }));
			}
			if (url.includes(":loadCodeAssist")) {
				return Promise.resolve(
					new Response(JSON.stringify({ cloudaicompanionProject: "acme-gcp" }), { status: 200 }),
				);
			}
			if (url.includes(":retrieveUserQuota")) {
				return Promise.resolve(new Response(JSON.stringify({ buckets }), { status: options.quotaStatus ?? 200 }));
			}
			return Promise.resolve(new Response("Not Found", { status: 404 }));
		},
		{ preconnect: fetch.preconnect },
	);
}

describe("gemini-cli quota discovery fallback", () => {
	it("surfaces quota-listed models when Antigravity discovery is forbidden (#9315)", async () => {
		const recorded: string[] = [];
		const fetcher = standardTierFetcher(["gemini-3.5-flash", "gemini-2.5-pro"], { recorded });
		const options = googleGeminiCliModelManagerOptions({ oauthToken: "t", endpoint: CCA, fetch: fetcher });

		const models = await options.fetchDynamicModels?.();

		// Antigravity path was attempted first, then the quota fallback ran.
		expect(recorded.some(url => url.includes(":fetchAvailableModels"))).toBe(true);
		expect(recorded.some(url => url.startsWith(`${CCA}/v1internal:retrieveUserQuota`))).toBe(true);
		expect(models?.map(m => m.id).sort()).toEqual(["gemini-2.5-pro", "gemini-3.5-flash"]);
		expect(models?.every(m => m.provider === "google-gemini-cli")).toBe(true);
		expect(models?.every(m => m.baseUrl === CCA)).toBe(true);
	});

	it("reuses bundled metadata for known ids and infers it for unknown ids", async () => {
		const fetcher = standardTierFetcher(["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.0-flash"]);

		const models = await fetchGeminiCliQuotaModels({ token: "t", endpoint: CCA, fetcher });

		// Known bundled id keeps its real 1M context window (not a synthesized default).
		const bundled = models?.find(m => m.id === "gemini-2.5-flash");
		expect(bundled?.contextWindow).toBe(1_048_576);
		expect(bundled?.reasoning).toBe(true);
		// Unknown ids: reasoning inferred from the parsed Gemini version (>= 2.5).
		expect(models?.find(m => m.id === "gemini-3.5-flash")?.reasoning).toBe(true);
		expect(models?.find(m => m.id === "gemini-2.0-flash")?.reasoning).toBe(false);
	});

	it("drops non-Gemini quota entries", async () => {
		const fetcher = standardTierFetcher(["gemini-3.5-flash", "claude-sonnet-4-6", "gpt-oss-120b"]);

		const models = await fetchGeminiCliQuotaModels({ token: "t", endpoint: CCA, fetcher });

		expect(models?.map(m => m.id)).toEqual(["gemini-3.5-flash"]);
	});

	it("returns null when the quota endpoint fails so bundled models remain", async () => {
		const fetcher = standardTierFetcher(["gemini-3.5-flash"], { quotaStatus: 403 });

		const models = await fetchGeminiCliQuotaModels({ token: "t", endpoint: CCA, fetcher });

		expect(models).toBeNull();
	});

	it("forwards an explicit project id and skips project-less loadCodeAssist (#9316 review)", async () => {
		const bodies: Record<string, unknown> = {};
		let loadCodeAssistCalled = false;
		const fetcher = Object.assign(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				if (url.includes(":loadCodeAssist")) {
					loadCodeAssistCalled = true;
					return Promise.resolve(new Response("{}", { status: 200 }));
				}
				if (url.includes(":retrieveUserQuota")) {
					bodies.quota = body;
					return Promise.resolve(
						new Response(JSON.stringify({ buckets: [{ modelId: "gemini-3.5-flash" }] }), { status: 200 }),
					);
				}
				return Promise.resolve(new Response("nf", { status: 404 }));
			},
			{ preconnect: fetch.preconnect },
		);

		const models = await fetchGeminiCliQuotaModels({
			token: "t",
			projectId: "workspace-gcp",
			endpoint: CCA,
			fetcher,
		});

		expect(loadCodeAssistCalled).toBe(false);
		expect(bodies.quota).toEqual({ project: "workspace-gcp" });
		expect(models?.map(m => m.id)).toEqual(["gemini-3.5-flash"]);
	});
});
