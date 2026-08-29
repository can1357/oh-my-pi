import { describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage } from "../src/auth-storage";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { cursorUsageProvider, parseCursorIndividualUsage, parseCursorUsage } from "../src/usage/cursor";

function createCursorAccessToken(sub: string): string {
	const payload = btoa(JSON.stringify({ sub })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `header.${payload}.signature`;
}

describe("cursor usage provider", () => {
	describe("parseCursorUsage", () => {
		it("returns null for non-record payloads", () => {
			expect(parseCursorUsage(null)).toBeNull();
			expect(parseCursorUsage(undefined)).toBeNull();
			expect(parseCursorUsage("invalid")).toBeNull();
			expect(parseCursorUsage([])).toBeNull();
		});

		it("returns null when no recognized quotas are present", () => {
			const payload = {
				someOtherField: "hello",
				startOfMonth: "2026-07-01T00:00:00.000Z",
			};
			expect(parseCursorUsage(payload)).toBeNull();
		});

		it("emits an uncapped used-only bucket when the request limit is null", () => {
			// Exact sanitized payload reported in #6381: the plan has no legacy cap.
			const payload = {
				"gpt-4": {
					numRequests: 0,
					numRequestsTotal: 0,
					numTokens: 0,
					maxTokenUsage: null,
					maxRequestUsage: null,
				},
				startOfMonth: "2026-07-23T01:19:45.000Z",
			};

			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			expect(report?.limits).toHaveLength(1);

			const limit = report?.limits[0];
			expect(limit?.id).toBe("cursor:requests:gpt-4");
			expect(limit?.label).toBe("gpt-4 requests");
			expect(limit?.amount).toEqual({ used: 0, unit: "requests" });
			expect(limit?.status).toBeUndefined();
			expect(limit?.window?.resetsAt).toBe(Date.parse("2026-08-23T01:19:45.000Z"));
		});

		it("keeps capped and uncapped buckets side by side", () => {
			const payload = {
				"gpt-4": {
					numRequests: 12,
					maxRequestUsage: null,
				},
				"claude-3-5-sonnet": {
					used: 80,
					limit: 100,
				},
			};

			const report = parseCursorUsage(payload);
			expect(report?.limits.map(limit => limit.id)).toEqual([
				"cursor:requests:gpt-4",
				"cursor:requests:claude-3-5-sonnet",
			]);
			expect(report?.limits[0]?.amount).toEqual({ used: 12, unit: "requests" });
			expect(report?.limits[1]?.amount.limit).toBe(100);
			expect(report?.limits[1]?.status).toBe("ok");
		});

		it("parses request-count buckets with stable IDs and labels", () => {
			const payload = {
				"gpt-4": {
					numRequests: 150,
					maxRequestUsage: 500,
				},
				"claude-3-5-sonnet": {
					used: 80,
					limit: 100,
				},
				startOfMonth: "2026-07-01T00:00:00.000Z",
			};

			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			if (!report) return;

			expect(report.provider).toBe("cursor");
			expect(report.limits).toHaveLength(2);

			const gpt4Limit = report.limits.find(l => l.id === "cursor:requests:gpt-4");
			expect(gpt4Limit).toBeDefined();
			if (gpt4Limit) {
				expect(gpt4Limit.label).toBe("gpt-4 requests");
				expect(gpt4Limit.amount.used).toBe(150);
				expect(gpt4Limit.amount.limit).toBe(500);
				expect(gpt4Limit.amount.remaining).toBe(350);
				expect(gpt4Limit.amount.usedFraction).toBe(0.3);
				expect(gpt4Limit.amount.unit).toBe("requests");
				expect(gpt4Limit.status).toBe("ok");
				expect(gpt4Limit.window).toBeDefined();
				expect(gpt4Limit.window?.id).toBe("monthly");
				expect(gpt4Limit.window?.label).toBe("Monthly");
				// 2026-07-01 + 1 month = 2026-08-01
				expect(gpt4Limit.window?.resetsAt).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
			}

			const sonnetLimit = report.limits.find(l => l.id === "cursor:requests:claude-3-5-sonnet");
			expect(sonnetLimit).toBeDefined();
			if (sonnetLimit) {
				expect(sonnetLimit.label).toBe("claude-3-5-sonnet requests");
				expect(sonnetLimit.amount.used).toBe(80);
				expect(sonnetLimit.amount.limit).toBe(100);
				expect(sonnetLimit.amount.usedFraction).toBe(0.8);
				expect(sonnetLimit.status).toBe("ok");
			}
		});

		it("parses USD/billing plan buckets with stable IDs and labels", () => {
			const payload = {
				planUsage: {
					used: 15.5,
					limit: 20.0,
				},
				"usd-custom": {
					amountUsed: 45,
					amountLimit: 50,
				},
			};

			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			if (!report) return;

			expect(report.limits).toHaveLength(2);

			const planLimit = report.limits.find(l => l.id === "cursor:usd:planusage");
			expect(planLimit).toBeDefined();
			if (planLimit) {
				expect(planLimit.label).toBe("planUsage spend");
				expect(planLimit.amount.used).toBe(15.5);
				expect(planLimit.amount.limit).toBe(20.0);
				expect(planLimit.amount.unit).toBe("usd");
				expect(planLimit.status).toBe("ok");
			}

			const customLimit = report.limits.find(l => l.id === "cursor:usd:usd-custom");
			expect(customLimit).toBeDefined();
			if (customLimit) {
				expect(customLimit.label).toBe("usd-custom spend");
				expect(customLimit.amount.used).toBe(45);
				expect(customLimit.amount.limit).toBe(50);
				expect(customLimit.amount.unit).toBe("usd");
				// 45 / 50 = 0.9 -> warning status
				expect(customLimit.status).toBe("warning");
			}
		});

		it("derives resetsAt from startOfMonth", () => {
			const payload = {
				"gpt-4": {
					numRequests: 10,
					maxRequestUsage: 10,
				},
				startOfMonth: "2026-07-11T12:00:00.000Z",
			};
			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			const limit = report?.limits[0];
			expect(limit?.window?.resetsAt).toBe(Date.parse("2026-08-11T12:00:00.000Z"));
		});

		it("derives resetsAt directly from billingCycleEnd", () => {
			const payload = {
				"gpt-4": {
					numRequests: 10,
					maxRequestUsage: 10,
				},
				billingCycleEnd: "2026-07-20T00:00:00.000Z",
			};
			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			const limit = report?.limits[0];
			expect(limit?.window?.resetsAt).toBe(Date.parse("2026-07-20T00:00:00.000Z"));
		});
	});

	describe("parseCursorIndividualUsage", () => {
		it("parses personal usage cents into a capped monthly dollar limit", () => {
			const payload = {
				individualUsage: {
					overall: {
						enabled: true,
						used: "9000",
						limit: "10000",
						remaining: "1000",
					},
				},
				teamUsage: {
					onDemand: {
						enabled: true,
						used: 900000,
						limit: 1000000,
						remaining: 100000,
					},
				},
				billingCycleEnd: "2026-08-20T00:00:00.000Z",
			};

			const report = parseCursorIndividualUsage(payload, 123);
			expect(report).toEqual({
				provider: "cursor",
				fetchedAt: 123,
				limits: [
					{
						id: "cursor:usd:individual-overall",
						label: "Personal Usage",
						scope: {
							provider: "cursor",
							windowId: "monthly",
						},
						window: {
							id: "monthly",
							label: "Monthly",
							resetsAt: Date.parse("2026-08-20T00:00:00.000Z"),
						},
						amount: {
							used: 90,
							limit: 100,
							remaining: 10,
							usedFraction: 0.9,
							remainingFraction: 0.1,
							unit: "usd",
						},
						status: "warning",
					},
				],
				raw: payload,
			});
		});

		it("maps plan.auto/api percent rails to Cursor Models / Other Models", () => {
			const payload = {
				individualUsage: {
					plan: {
						enabled: true,
						used: 1504,
						limit: 7000,
						remaining: 5496,
						autoPercentUsed: 1.85,
						apiPercentUsed: 0,
						totalPercentUsed: 1.63,
					},
					onDemand: {
						enabled: true,
						used: 0,
						limit: 2000,
						remaining: 2000,
					},
				},
				billingCycleEnd: "2026-09-08T08:00:31.000Z",
			};

			const report = parseCursorIndividualUsage(payload, 123);
			expect(report?.limits.map(limit => ({ id: limit.id, label: limit.label }))).toEqual([
				{ id: "cursor:usd:individual-auto", label: "Cursor Models" },
				{ id: "cursor:usd:individual-api", label: "Other Models" },
				{ id: "cursor:usd:individual-ondemand", label: "On-Demand Usage" },
			]);
			const auto = report?.limits[0]?.amount;
			const api = report?.limits[1]?.amount;
			const onDemand = report?.limits[2]?.amount;
			expect(auto?.unit).toBe("percent");
			expect(auto?.used).toBeCloseTo(1.85);
			expect(auto?.usedFraction).toBeCloseTo(0.0185);
			// Critically: do NOT trust plan.used/limit cents as the dashboard %.
			expect(auto?.usedFraction).not.toBeCloseTo(1504 / 7000);
			expect(api).toEqual({
				used: 0,
				limit: 70,
				remaining: 70,
				usedFraction: 0,
				remainingFraction: 1,
				unit: "usd",
			});
			expect(onDemand).toEqual({
				used: 0,
				limit: 20,
				remaining: 20,
				usedFraction: 0,
				remainingFraction: 1,
				unit: "usd",
			});
		});

		it("prefers individualUsage.overall when both overall and plan exist", () => {
			const report = parseCursorIndividualUsage({
				individualUsage: {
					overall: { enabled: true, used: 100, limit: 1000, remaining: 900 },
					plan: { enabled: true, used: 924, limit: 7000, remaining: 6076 },
				},
			});
			expect(report?.limits.map(limit => limit.id)).toEqual(["cursor:usd:individual-overall"]);
		});

		it("falls back to plan when overall is present but disabled", () => {
			const report = parseCursorIndividualUsage({
				individualUsage: {
					overall: { enabled: false, used: 100, limit: 1000, remaining: 900 },
					plan: {
						enabled: true,
						used: 1504,
						limit: 7000,
						remaining: 5496,
						autoPercentUsed: 1.85,
						apiPercentUsed: 0,
					},
				},
			});
			expect(report?.limits.map(limit => limit.id)).toEqual([
				"cursor:usd:individual-auto",
				"cursor:usd:individual-api",
			]);
		});

		it("rejects disabled plan buckets even when stale percent fields remain", () => {
			expect(
				parseCursorIndividualUsage({
					individualUsage: {
						plan: {
							enabled: false,
							used: 1504,
							limit: 7000,
							autoPercentUsed: 1.85,
							apiPercentUsed: 0,
						},
					},
				}),
			).toBeNull();
		});

		it("keeps on-demand when the included plan bucket is unusable", () => {
			const report = parseCursorIndividualUsage({
				individualUsage: {
					plan: { enabled: false, used: 1504, limit: 7000, autoPercentUsed: 1.85 },
					onDemand: { enabled: true, used: 0, limit: 2000, remaining: 2000 },
				},
			});
			expect(report?.limits.map(limit => limit.id)).toEqual(["cursor:usd:individual-ondemand"]);
		});

		it("rejects disabled, malformed, and non-positive personal usage buckets", () => {
			expect(
				parseCursorIndividualUsage({
					individualUsage: { overall: { enabled: false, used: 100, limit: 1000, remaining: 900 } },
				}),
			).toBeNull();
			expect(
				parseCursorIndividualUsage({ individualUsage: { overall: { limit: null, used: "invalid" } } }),
			).toBeNull();
			expect(
				parseCursorIndividualUsage({ individualUsage: { overall: { used: 0, limit: 0, remaining: 0 } } }),
			).toBeNull();
			expect(
				parseCursorIndividualUsage({ individualUsage: { overall: { used: 0, limit: -100, remaining: 0 } } }),
			).toBeNull();
		});

		it("emits uncapped used-only dollar usage when the limit is null", () => {
			const report = parseCursorIndividualUsage({
				individualUsage: { overall: { enabled: true, used: "2500", limit: null } },
			});
			expect(report?.limits).toEqual([
				{
					id: "cursor:usd:individual-overall",
					label: "Personal Usage",
					scope: {
						provider: "cursor",
						windowId: "monthly",
					},
					window: {
						id: "monthly",
						label: "Monthly",
					},
					amount: {
						used: 25,
						unit: "usd",
					},
				},
			]);
		});

		it("infers positive spend from limit and remaining when reported used is zero", () => {
			const report = parseCursorIndividualUsage({
				individualUsage: {
					overall: {
						used: 0,
						limit: 5000,
						remaining: 1500,
					},
				},
			});
			expect(report?.limits[0]?.amount).toEqual({
				used: 35,
				limit: 50,
				remaining: 15,
				usedFraction: 0.7,
				remainingFraction: 0.3,
				unit: "usd",
			});
			expect(report?.limits[0]?.status).toBe("ok");
		});

		it("derives remaining from selected used when reported values conflict", () => {
			const report = parseCursorIndividualUsage({
				individualUsage: {
					overall: {
						used: 100,
						limit: 1000,
						remaining: 0,
					},
				},
			});
			expect(report?.limits[0]).toMatchObject({
				amount: {
					used: 1,
					limit: 10,
					remaining: 9,
					usedFraction: 0.1,
					remainingFraction: 0.9,
					unit: "usd",
				},
				status: "ok",
			});
		});
	});

	describe("default registration", () => {
		it("registers Cursor in AuthStorage's default usage resolver", async () => {
			const store: AuthCredentialStore = {
				close() {},
				listAuthCredentials() {
					return [];
				},
				updateAuthCredential() {},
				deleteAuthCredential() {},
				tryDisableAuthCredentialIfMatches() {
					return false;
				},
				replaceAuthCredentialsForProvider() {
					return [];
				},
				upsertAuthCredentialForProvider() {
					return [];
				},
				deleteAuthCredentialsForProvider() {},
				getCache() {
					return null;
				},
				setCache() {},
				cleanExpiredCache() {},
			};
			const storage = new AuthStorage(store);
			await storage.reload();
			try {
				expect(storage.usageProviderFor("cursor")).toBe(cursorUsageProvider);
			} finally {
				storage.close();
			}
		});
	});

	describe("cursorUsageProvider", () => {
		it("supports oauth credentials", () => {
			const params: UsageFetchParams = {
				provider: "cursor",
				credential: {
					type: "oauth",
					accessToken: "valid-token",
				},
			};
			expect(cursorUsageProvider.supports?.(params)).toBe(true);
		});

		it("supports api_key credentials", () => {
			const params: UsageFetchParams = {
				provider: "cursor",
				credential: {
					type: "api_key",
					apiKey: "valid-api-key",
				},
			};
			expect(cursorUsageProvider.supports?.(params)).toBe(true);
		});

		it("does not support missing token/key", () => {
			const params1: UsageFetchParams = {
				provider: "cursor",
				credential: {
					type: "oauth",
				},
			};
			const params2: UsageFetchParams = {
				provider: "cursor",
				credential: {
					type: "api_key",
				},
			};
			expect(cursorUsageProvider.supports?.(params1)).toBe(false);
			expect(cursorUsageProvider.supports?.(params2)).toBe(false);
		});

		it("does not support other providers", () => {
			const params: UsageFetchParams = {
				provider: "openai-codex",
				credential: {
					type: "oauth",
					accessToken: "token",
				},
			};
			expect(cursorUsageProvider.supports?.(params)).toBe(false);
		});

		it("fetches and parses usage successfully", async () => {
			const payload = {
				"gpt-4": {
					numRequests: 10,
					maxRequestUsage: 100,
				},
				startOfMonth: "2026-07-01T00:00:00.000Z",
			};

			const mockFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
				const urlStr = typeof input === "string" ? input : input.toString();
				expect(urlStr).toBe("https://api2.cursor.sh/auth/usage");
				expect(init?.headers).toBeDefined();
				const headers = init?.headers as Record<string, string>;
				expect(headers.Accept).toBe("application/json");
				expect(headers.Authorization).toBe("Bearer test-token");

				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const ctx: UsageFetchContext = {
				fetch: mockFetch,
			};

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken: "test-token",
						email: "user@example.com",
						accountId: "acc_123",
					},
				},
				ctx,
			);

			expect(report).not.toBeNull();
			if (!report) return;

			expect(report.provider).toBe("cursor");
			expect(report.limits).toHaveLength(1);
			expect(report.limits[0].id).toBe("cursor:requests:gpt-4");
			expect(report.metadata).toEqual({
				email: "user@example.com",
				accountId: "acc_123",
			});
		});

		it("fetches personal usage and profile email with a WorkOS cookie", async () => {
			const accessToken = createCursorAccessToken("auth0|user_123");
			const authUsagePayload = {
				"gpt-4": {
					numRequests: 0,
					maxRequestUsage: null,
				},
			};
			const usageSummaryPayload = {
				individualUsage: {
					overall: {
						enabled: true,
						used: 2000,
						limit: 10000,
						remaining: 8000,
					},
				},
				teamUsage: {
					onDemand: {
						enabled: true,
						used: 900000,
						limit: 1000000,
						remaining: 100000,
					},
				},
			};
			const seenUrls: string[] = [];
			const mockFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
				const url = typeof input === "string" ? input : input.toString();
				seenUrls.push(url);
				const headers = new Headers(init?.headers);
				if (url === "https://api2.cursor.sh/auth/usage") {
					expect(headers.get("Accept")).toBe("application/json");
					expect(headers.get("Authorization")).toBe(`Bearer ${accessToken}`);
					return Response.json(authUsagePayload);
				}
				expect(["https://cursor.com/api/usage-summary", "https://cursor.com/api/auth/me"]).toContain(url);
				expect(headers.get("Accept")).toBe("application/json");
				expect(headers.get("Cookie")).toBe(
					`WorkosCursorSessionToken=${encodeURIComponent(`user_123::${accessToken}`)}`,
				);
				expect(headers.has("Authorization")).toBe(false);
				if (url === "https://cursor.com/api/auth/me") {
					return Response.json({ email: "person@example.com", sub: "user_123" });
				}
				return Response.json(usageSummaryPayload);
			}) as unknown as typeof fetch;

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken,
						email: "stored@example.com",
						accountId: "account_123",
						projectId: "project_123",
					},
				},
				{ fetch: mockFetch },
			);

			expect(seenUrls).toEqual([
				"https://api2.cursor.sh/auth/usage",
				"https://cursor.com/api/usage-summary",
				"https://cursor.com/api/auth/me",
			]);
			expect(report?.metadata).toEqual({
				email: "person@example.com",
				accountId: "account_123",
				projectId: "project_123",
			});
			// The legacy bucket is uncapped (`maxRequestUsage: null`) but still reported,
			// so it merges ahead of the personal summary instead of vanishing (#6381).
			expect(report?.limits.map(limit => limit.id)).toEqual([
				"cursor:requests:gpt-4",
				"cursor:usd:individual-overall",
			]);
			expect(report?.limits[0]?.amount).toEqual({ used: 0, unit: "requests" });
			expect(report?.limits[1]).toMatchObject({
				id: "cursor:usd:individual-overall",
				amount: {
					used: 20,
					limit: 100,
					remaining: 80,
					unit: "usd",
				},
			});
			expect(report?.raw).toEqual({
				authUsage: authUsagePayload,
				usageSummary: usageSummaryPayload,
			});
		});

		it("ignores a profile email returned for a different subject", async () => {
			const accessToken = createCursorAccessToken("auth0|user_123");
			const mockFetch = (async (input: string | URL): Promise<Response> => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api2.cursor.sh/auth/usage") {
					return Response.json({});
				}
				if (url === "https://cursor.com/api/usage-summary") {
					return Response.json({
						individualUsage: {
							overall: {
								used: 2000,
								limit: 10000,
								remaining: 8000,
							},
						},
					});
				}
				return Response.json({ email: "other@example.com", sub: "different_user" });
			}) as unknown as typeof fetch;

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken,
						email: "stored@example.com",
					},
				},
				{ fetch: mockFetch },
			);

			expect(report?.metadata).toEqual({ email: "stored@example.com" });
		});

		it("merges legacy request usage before personal usage", async () => {
			const accessToken = createCursorAccessToken("workos|user_456");
			const authUsagePayload = {
				"gpt-4": {
					numRequests: 10,
					maxRequestUsage: 100,
				},
			};
			const usageSummaryPayload = {
				individualUsage: {
					overall: {
						used: 2000,
						limit: 10000,
						remaining: 8000,
					},
				},
			};
			const mockFetch = (async (input: string | URL): Promise<Response> => {
				const url = typeof input === "string" ? input : input.toString();
				return Response.json(url === "https://api2.cursor.sh/auth/usage" ? authUsagePayload : usageSummaryPayload);
			}) as unknown as typeof fetch;

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken,
					},
				},
				{ fetch: mockFetch },
			);

			expect(report?.limits.map(limit => limit.id)).toEqual([
				"cursor:requests:gpt-4",
				"cursor:usd:individual-overall",
			]);
			expect(report?.raw).toEqual({
				authUsage: authUsagePayload,
				usageSummary: usageSummaryPayload,
			});
		});

		it("returns legacy usage when the personal summary request fails", async () => {
			const accessToken = createCursorAccessToken("auth0|user_789");
			const authUsagePayload = {
				"gpt-4": {
					numRequests: 10,
					maxRequestUsage: 100,
				},
			};
			const seenUrls: string[] = [];
			const mockFetch = (async (input: string | URL): Promise<Response> => {
				const url = typeof input === "string" ? input : input.toString();
				seenUrls.push(url);
				if (url === "https://cursor.com/api/usage-summary") {
					return new Response("Unavailable", { status: 503 });
				}
				return Response.json(authUsagePayload);
			}) as unknown as typeof fetch;

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken,
						email: "fallback@example.com",
					},
				},
				{ fetch: mockFetch },
			);

			expect(seenUrls).toEqual([
				"https://api2.cursor.sh/auth/usage",
				"https://cursor.com/api/usage-summary",
				"https://cursor.com/api/auth/me",
			]);
			expect(report?.limits.map(limit => limit.id)).toEqual(["cursor:requests:gpt-4"]);
			expect(report?.raw).toEqual(authUsagePayload);
			expect(report?.metadata).toEqual({ email: "fallback@example.com" });
		});

		it("does not send the session cookie outside the default Cursor origin", async () => {
			const accessToken = createCursorAccessToken("auth0|user_123");
			const requests: Array<{ url: string; headers: Headers }> = [];
			const mockFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
				requests.push({
					url: typeof input === "string" ? input : input.toString(),
					headers: new Headers(init?.headers),
				});
				return Response.json({
					"gpt-4": {
						numRequests: 10,
						maxRequestUsage: 100,
					},
				});
			}) as unknown as typeof fetch;

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					baseUrl: "https://cursor-proxy.example.com",
					credential: {
						type: "oauth",
						accessToken,
					},
				},
				{ fetch: mockFetch },
			);

			expect(requests).toHaveLength(1);
			expect(requests[0]?.url).toBe("https://cursor-proxy.example.com/auth/usage");
			expect(requests[0]?.headers.get("Authorization")).toBe(`Bearer ${accessToken}`);
			expect(requests[0]?.headers.has("Cookie")).toBe(false);
			expect(report?.limits.map(limit => limit.id)).toEqual(["cursor:requests:gpt-4"]);
		});

		it("returns null on non-2xx response", async () => {
			const mockFetch = (async () => new Response("Error", { status: 403 })) as unknown as typeof fetch;
			const ctx: UsageFetchContext = {
				fetch: mockFetch,
			};

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken: "test-token",
					},
				},
				ctx,
			);

			expect(report).toBeNull();
		});

		it("returns null on fetch error", async () => {
			const mockFetch = (async () => {
				throw new Error("Network error");
			}) as unknown as typeof fetch;
			const ctx: UsageFetchContext = {
				fetch: mockFetch,
			};

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken: "test-token",
					},
				},
				ctx,
			);

			expect(report).toBeNull();
		});
	});
});
