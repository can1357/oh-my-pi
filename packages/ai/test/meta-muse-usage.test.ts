import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { describe, expect, test } from "bun:test";
import { metaMuseUsageProvider } from "@oh-my-pi/pi-ai/usage/meta-muse";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const credential = {
	type: "oauth" as const,
	accessToken: "meta-oauth-access",
	expiresAt: Date.now() + 60_000,
	email: "stored@example.com",
};

describe("Muse Code subscription usage", () => {
	test("maps rolling and weekly plan quota into slash-usage limits", async () => {
		let authorization = "";
		const fetchImpl: FetchImpl = (_input, init) => {
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			return Promise.resolve(
				Response.json({
					api_key: "LLM|subscription-key",
					user_email: "Muse@Example.com",
					is_subs_active: true,
					subs_tier_name: "Power Usage",
					subs_usage: {
						window: { used_percent: 42, resets_at: 1_800_000_000, window_duration_mins: 300 },
						weekly: { used_percent: 75, resets_at: "2030-01-08T00:00:00.000Z" },
					},
				}),
			);
		};

		const report = await metaMuseUsageProvider.fetchUsage({ provider: "meta", credential }, { fetch: fetchImpl });

		expect(authorization).toBe("Bearer meta-oauth-access");
		expect(report?.provider).toBe("meta");
		expect(report?.metadata).toMatchObject({ email: "muse@example.com", tier: "Power Usage" });
		expect(report?.raw).not.toHaveProperty("api_key");
		expect(report?.limits).toHaveLength(2);
		expect(report?.limits[0]).toMatchObject({
			id: "300m",
			label: "5 Hours",
			amount: { used: 42, usedFraction: 0.42, unit: "percent" },
			window: { durationMs: 18_000_000, resetsAt: 1_800_000_000_000 },
			status: "ok",
		});
		expect(report?.limits[1]).toMatchObject({
			id: "1w",
			label: "Weekly",
			amount: { used: 75, usedFraction: 0.75, unit: "percent" },
			window: { durationMs: 604_800_000, resetsAt: Date.parse("2030-01-08T00:00:00.000Z") },
		});
	});

	test("labels non-hour rolling windows in minutes", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				Response.json({
					api_key: "LLM|subscription-key",
					is_subs_active: true,
					subs_usage: {
						window: { used_percent: 20, window_duration_mins: 30 },
					},
				}),
			);

		const report = await metaMuseUsageProvider.fetchUsage({ provider: "meta", credential }, { fetch: fetchImpl });

		expect(report?.limits[0]).toMatchObject({
			id: "30m",
			label: "30 Minutes",
			window: { durationMs: 1_800_000 },
		});
	});

	test("clamps reported quota overages to normalized usage bounds", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				Response.json({
					api_key: "LLM|subscription-key",
					user_email: "muse@example.com",
					is_subs_active: true,
					subs_usage: {
						window: { used_percent: 140, window_duration_mins: 300 },
					},
				}),
			);

		const report = await metaMuseUsageProvider.fetchUsage({ provider: "meta", credential }, { fetch: fetchImpl });

		expect(report?.limits[0]?.amount).toEqual({
			used: 100,
			limit: 100,
			remaining: 0,
			usedFraction: 1,
			remainingFraction: 0,
			unit: "percent",
		});
	});

	test("does not report API-key PAYG credentials as subscription quota", () => {
		expect(
			metaMuseUsageProvider.supports?.({
				provider: "meta",
				credential: { type: "api_key", apiKey: "LLM|payg-key" },
			}),
		).toBe(false);
	});

	test("reports revoked Meta account tokens as invalid credentials", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: provider => (provider === "meta" ? metaMuseUsageProvider : undefined),
			usageFetch: Object.assign(() => Promise.resolve(Response.json({ error: "revoked" }, { status: 401 })), {
				preconnect: fetch.preconnect,
			}),
		});
		try {
			await storage.reload();
			await storage.set("meta", {
				type: "oauth",
				access: "revoked-meta-access",
				refresh: "meta-refresh",
				expires: Date.now() + 3_600_000,
				apiKey: "LLM|subscription-key",
			});

			const [result] = await storage.checkCredentials();
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("401");
		} finally {
			storage.close();
		}
	});

	test("reports inactive Muse subscriptions as invalid credentials", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: provider => (provider === "meta" ? metaMuseUsageProvider : undefined),
			usageFetch: Object.assign(
				() =>
					Promise.resolve(
						Response.json({
							api_key: "LLM|subscription-key",
							is_subs_active: false,
						}),
					),
				{ preconnect: fetch.preconnect },
			),
		});
		try {
			await storage.reload();
			await storage.set("meta", {
				type: "oauth",
				access: "inactive-meta-access",
				refresh: "meta-refresh",
				expires: Date.now() + 3_600_000,
				apiKey: "LLM|subscription-key",
			});

			const [result] = await storage.checkCredentials();
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("inactive");
		} finally {
			storage.close();
		}
	});
});
