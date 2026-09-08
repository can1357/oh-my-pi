import { describe, expect, it } from "bun:test";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const BASE_URL = "https://copilot.example.com";

// Account expansion, routing, deduplication, and pruning are exercised through
// ModelRegistry in coding-agent/test/model-discovery.test.ts.
describe("github-copilot multi-account discovery failures", () => {
	it.each([
		["HTTP rejection", async () => new Response("forbidden", { status: 403 })],
		[
			"transport failure",
			async () => {
				throw new Error("connection reset");
			},
		],
		["malformed payload", async () => Response.json({ unexpected: true })],
	] satisfies [string, () => Promise<Response>][])("aborts the partial union on %s", async (_name, failedFetch) => {
		const options = githubCopilotModelManagerOptions({
			baseUrl: BASE_URL,
			resolveAccounts: async () => [
				{ apiKey: "healthy", accountId: "healthy-account" },
				{ apiKey: "unavailable", accountId: "unavailable-account" },
			],
			fetch: async (_input, init) =>
				new Headers(init?.headers).get("Authorization") === "Bearer healthy"
					? Response.json({ data: [{ id: "healthy-model" }] })
					: failedFetch(),
		});

		// Null preserves the previous/bundled catalog instead of pruning models
		// available only to the account whose catalog could not be determined.
		expect(await options.fetchDynamicModels?.()).toBeNull();
	});

	it("distinguishes successful empty grants from an unavailable catalog", async () => {
		const options = githubCopilotModelManagerOptions({
			baseUrl: BASE_URL,
			resolveAccounts: async () => [{ apiKey: "account-a" }, { apiKey: "account-b" }],
			fetch: async () => Response.json({ data: [{ id: "disabled-model", policy: { state: "disabled" } }] }),
		});

		expect(await options.fetchDynamicModels?.()).toEqual([]);
	});

	it("aborts when account resolution is incomplete instead of using the peeked key", async () => {
		let requests = 0;
		const options = githubCopilotModelManagerOptions({
			apiKey: "peeked-token",
			baseUrl: BASE_URL,
			resolveAccounts: async () => null,
			fetch: async () => {
				requests++;
				return Response.json({ data: [] });
			},
		});

		expect(await options.fetchDynamicModels?.()).toBeNull();
		expect(requests).toBe(0);
	});
});
