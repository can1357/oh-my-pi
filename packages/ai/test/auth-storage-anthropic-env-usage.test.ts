import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";
import { withEnv } from "./helpers";

async function probeEnvUsage(apiKey: string) {
	const result: { authorizations: (string | null)[]; reports: UsageReport[] | null } = {
		authorizations: [],
		reports: null,
	};
	await withEnv({ ANTHROPIC_API_KEY: apiKey, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
		const storage = await AuthStorage.create(":memory:", {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageProvider : undefined),
			usageFetch: Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					result.authorizations.push(new Headers(init?.headers).get("authorization"));
					if (new URL(String(input)).pathname !== "/api/oauth/usage") {
						return new Response(null, { status: 404 });
					}
					return Response.json({
						five_hour: { utilization: 38, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
					});
				},
				{ preconnect: fetch.preconnect },
			),
		});
		try {
			result.reports = await storage.usage.reports();
		} finally {
			storage.close();
		}
	});
	return result;
}

describe("Anthropic environment usage", () => {
	it("reports Claude subscription quota for an OAuth bearer in ANTHROPIC_API_KEY", async () => {
		const { authorizations, reports } = await probeEnvUsage("sk-ant-oat-test");
		expect(authorizations).toContain("Bearer sk-ant-oat-test");
		expect(authorizations.every(value => value === "Bearer sk-ant-oat-test")).toBe(true);
		expect(
			reports?.find(report => report.provider === "anthropic")?.limits.find(limit => limit.id === "anthropic:5h")
				?.amount.usedFraction,
		).toBe(0.38);
	});

	it("does not send an ordinary Anthropic API key to the subscription quota endpoint", async () => {
		const { authorizations, reports } = await probeEnvUsage("sk-ant-api-test");
		expect(authorizations).toEqual([]);
		expect(reports?.some(report => report.provider === "anthropic")).toBe(false);
	});
});
