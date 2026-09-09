import { describe, expect, test } from "bun:test";
import { type AuthCredentialStore, AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { minimaxCodeUsageProvider } from "@oh-my-pi/pi-ai/usage/minimax-code";

const INTERVAL_START = 1_785_009_600_000;
const INTERVAL_END = 1_785_024_000_000;
const WEEKLY_START = 1_784_505_600_000;
const WEEKLY_END = 1_785_110_400_000;

function params(provider: "minimax-code" = "minimax-code", apiKey = "sk-cp-test"): UsageFetchParams {
	return { provider, credential: { type: "api_key", apiKey }, accountKey: "account-1" };
}

function emptyStore(): AuthCredentialStore {
	return {
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
}

/** One `model_remains[]` entry: percentages and statuses are optional because the endpoint omits them. */
interface RemainsBucket {
	model_name: string;
	start_time: number;
	end_time: number;
	current_interval_total_count: number;
	current_interval_usage_count: number;
	current_interval_remaining_percent?: number;
	current_interval_status?: number;
	weekly_start_time: number;
	weekly_end_time: number;
	current_weekly_total_count: number;
	current_weekly_usage_count: number;
	current_weekly_remaining_percent?: number;
	current_weekly_status?: number;
}

interface RemainsPayload {
	model_remains: RemainsBucket[];
	base_resp: { status_code: number; status_msg: string };
}

/** A live plan bucket: zero totals with status 1 still carry a real remaining percentage. */
function generalBucket(): RemainsBucket {
	return {
		model_name: "general",
		start_time: INTERVAL_START,
		end_time: INTERVAL_END,
		current_interval_total_count: 0,
		current_interval_usage_count: 0,
		current_interval_remaining_percent: 90,
		current_interval_status: 1,
		weekly_start_time: WEEKLY_START,
		weekly_end_time: WEEKLY_END,
		current_weekly_total_count: 0,
		current_weekly_usage_count: 0,
		current_weekly_remaining_percent: 78,
		current_weekly_status: 1,
	};
}

/** A metered bucket: request counts on both windows. */
function videoBucket(): RemainsBucket {
	return {
		model_name: "video",
		start_time: INTERVAL_END - 86_400_000,
		end_time: INTERVAL_END,
		current_interval_total_count: 3,
		current_interval_usage_count: 1,
		current_interval_remaining_percent: 100,
		current_interval_status: 1,
		weekly_start_time: WEEKLY_START,
		weekly_end_time: WEEKLY_END,
		current_weekly_total_count: 21,
		current_weekly_usage_count: 1,
		current_weekly_remaining_percent: 100,
		current_weekly_status: 1,
	};
}

function payloadOf(...buckets: RemainsBucket[]): RemainsPayload {
	return { model_remains: buckets, base_resp: { status_code: 0, status_msg: "success" } };
}

function remainsPayload(): RemainsPayload {
	return payloadOf(generalBucket(), videoBucket());
}

/** The bucket shape MiniMax returns for a model the plan does not include (MiniMax-AI/cli#173). */
function notInPlanBucket(modelName: string): RemainsBucket {
	return {
		model_name: modelName,
		start_time: INTERVAL_START,
		end_time: INTERVAL_END,
		current_interval_total_count: 0,
		current_interval_usage_count: 0,
		current_interval_remaining_percent: 100,
		current_interval_status: 3,
		weekly_start_time: WEEKLY_START,
		weekly_end_time: WEEKLY_END,
		current_weekly_total_count: 0,
		current_weekly_usage_count: 0,
		current_weekly_remaining_percent: 100,
		current_weekly_status: 3,
	};
}

describe("MiniMax Token Plan usage", () => {
	test("maps each quota bucket to its rolling and weekly windows", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchMock: FetchImpl = (input, init) => {
			requests.push({ url: String(input), init });
			return Promise.resolve(Response.json(remainsPayload()));
		};

		const report = await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.minimax.io/v1/token_plan/remains");
		expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer sk-cp-test");
		expect(report?.provider).toBe("minimax-code");
		expect(report?.metadata).toMatchObject({ source: "minimax-token-plan", models: ["general", "video"] });
		expect(report?.limits.map(limit => limit.id)).toEqual(["general:4h", "general:7d", "video:24h", "video:7d"]);

		const [intervalLimit, weeklyLimit, videoInterval, videoWeekly] = report?.limits ?? [];
		expect(intervalLimit?.label).toBe("General 4 Hour");
		expect(intervalLimit?.window).toEqual({
			id: "4h",
			label: "4 Hour",
			durationMs: 14_400_000,
			resetsAt: INTERVAL_END,
		});
		expect(intervalLimit?.amount).toEqual({
			used: 10,
			usedFraction: 0.1,
			remaining: 90,
			remainingFraction: 0.9,
			unit: "percent",
		});
		expect(intervalLimit?.status).toBe("ok");
		expect(intervalLimit?.notes).toBeUndefined();

		expect(weeklyLimit?.window).toEqual({ id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt: WEEKLY_END });
		expect(weeklyLimit?.amount).toEqual({
			used: 22,
			usedFraction: 0.22,
			remaining: 78,
			remainingFraction: 0.78,
			unit: "percent",
		});

		expect(videoInterval?.label).toBe("Video 24 Hour");
		expect(videoInterval?.amount.usedFraction).toBe(0);
		expect(videoInterval?.notes).toEqual(["Requests: 1/3"]);
		expect(videoWeekly?.notes).toEqual(["Requests: 1/21"]);
	});

	test("honors a configured base URL for the quota request", async () => {
		// One case per trim the provider applies: trailing slash, trailing `/v1`, and both together.
		for (const configured of ["https://proxy.example", "https://proxy.example/", "https://proxy.example/v1/"]) {
			let requestedUrl = "";
			const fetchMock: FetchImpl = input => {
				requestedUrl = String(input);
				return Promise.resolve(Response.json(remainsPayload()));
			};
			const request: UsageFetchParams = { ...params("minimax-code"), baseUrl: configured };

			const report = await minimaxCodeUsageProvider.fetchUsage(request, { fetch: fetchMock });

			expect(requestedUrl).toBe("https://proxy.example/v1/token_plan/remains");
			expect(report?.provider).toBe("minimax-code");
		}
	});

	test("fails closed when MiniMax rejects the key inside a 200 response", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				Response.json({
					base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key" },
				}),
			);

		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock })).toBeNull();
	});

	test("does not fetch without an API key credential", async () => {
		let fetched = false;
		const fetchMock: FetchImpl = () => {
			fetched = true;
			return Promise.resolve(Response.json(remainsPayload()));
		};
		const request: UsageFetchParams = { provider: "minimax-code", credential: { type: "oauth" } };

		expect(minimaxCodeUsageProvider.supports?.(request)).toBe(false);
		expect(await minimaxCodeUsageProvider.fetchUsage(request, { fetch: fetchMock })).toBeNull();
		expect(fetched).toBe(false);
	});

	test("marks a spent window exhausted and drops buckets with no percentage", async () => {
		const spentGeneral: RemainsBucket = { ...generalBucket(), current_interval_remaining_percent: 0 };
		const videoWithoutPercentages: RemainsBucket = {
			model_name: "video",
			start_time: INTERVAL_END - 86_400_000,
			end_time: INTERVAL_END,
			current_interval_total_count: 3,
			current_interval_usage_count: 1,
			current_interval_status: 1,
			weekly_start_time: WEEKLY_START,
			weekly_end_time: WEEKLY_END,
			current_weekly_total_count: 21,
			current_weekly_usage_count: 1,
			current_weekly_status: 1,
		};
		const fetchMock: FetchImpl = () =>
			Promise.resolve(Response.json(payloadOf(spentGeneral, videoWithoutPercentages)));

		const report = await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock });

		expect(report?.limits.map(limit => limit.id)).toEqual(["general:4h", "general:7d"]);
		expect(report?.limits[0]?.status).toBe("exhausted");
		expect(report?.limits[0]?.amount.usedFraction).toBe(1);
	});

	test("returns null when the plan reports no quota buckets", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(Response.json({ model_remains: [], base_resp: { status_code: 0 } }));

		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock })).toBeNull();
	});

	test("reports a window the endpoint marks exhausted, percentage or not", async () => {
		const noPercentage: RemainsBucket = {
			...generalBucket(),
			current_interval_status: 2,
			current_interval_remaining_percent: undefined,
		};
		const stalePercentage: RemainsBucket = { ...generalBucket(), current_interval_status: 2 };

		for (const bucket of [noPercentage, stalePercentage]) {
			const fetchMock: FetchImpl = () => Promise.resolve(Response.json(payloadOf(bucket)));

			const report = await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock });

			const interval = report?.limits.find(limit => limit.id === "general:4h");
			expect(interval?.status).toBe("exhausted");
			expect(interval?.amount).toMatchObject({ usedFraction: 1, remainingFraction: 0 });
			expect(report?.limits.find(limit => limit.id === "general:7d")?.status).toBe("ok");
		}
	});

	test("keeps a model that is not in the plan out of the reported quota", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(Response.json(payloadOf(generalBucket(), notInPlanBucket("video"))));

		const report = await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock });

		expect(report?.limits.map(limit => limit.id)).toEqual(["general:4h", "general:7d"]);
		expect(report?.metadata).toMatchObject({ models: ["general", "video"], unavailableModels: ["video"] });
	});

	test("returns null when every model is outside the plan", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(Response.json(payloadOf(notInPlanBucket("general"), notInPlanBucket("video"))));

		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock })).toBeNull();
	});

	test("keeps a bucket whose windows disagree about being in the plan", async () => {
		const meteredWeekly: RemainsBucket = {
			...notInPlanBucket("video"),
			current_weekly_status: 1,
			current_weekly_total_count: 21,
			current_weekly_usage_count: 1,
			current_weekly_remaining_percent: 40,
		};
		const meteredInterval: RemainsBucket = {
			...notInPlanBucket("video"),
			current_interval_status: 1,
			current_interval_total_count: 3,
			current_interval_usage_count: 1,
			current_interval_remaining_percent: 40,
		};

		for (const bucket of [meteredWeekly, meteredInterval]) {
			const fetchMock: FetchImpl = () => Promise.resolve(Response.json(payloadOf(bucket)));

			const report = await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock });

			expect(report?.limits.map(limit => limit.id)).toEqual(["video:4h", "video:7d"]);
			expect(report?.metadata).not.toHaveProperty("unavailableModels");
		}
	});

	test("rejects a payload with no base_resp envelope", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(Response.json({ model_remains: remainsPayload().model_remains }));

		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock })).toBeNull();
	});

	test("registers the Token Plan id in AuthStorage's default usage resolver", async () => {
		const storage = new AuthStorage(emptyStore());
		await storage.reload();
		try {
			expect(storage.usageProviderFor("minimax-code")).toBe(minimaxCodeUsageProvider);
			expect(storage.usageProviderFor("minimax-code-cn")).toBeUndefined();
		} finally {
			storage.close();
		}
	});

	test("reports the shared plan quota against catalog model ids", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(Response.json(remainsPayload()));

		const report = await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock });
		if (!report) throw new Error("expected a usage report");

		const general = report.limits.find(limit => limit.id === "general:4h");
		expect(general?.scope).toEqual({ provider: "minimax-code", shared: true, windowId: "4h" });
		const video = report.limits.find(limit => limit.id === "video:24h");
		expect(video?.scope).toEqual({ provider: "minimax-code", modelId: "video", windowId: "24h" });

		// Without a MiniMax ranking strategy AuthStorage matches `shared` or an exact
		// catalog id, so a bucket-name scope would report no models at all.
		const storage = new AuthStorage(emptyStore());
		await storage.reload();
		try {
			expect(storage.getUsageReportingModelIds("minimax-code", ["MiniMax-M3", "MiniMax-M2"], [report])).toEqual([
				"MiniMax-M3",
				"MiniMax-M2",
			]);
		} finally {
			storage.close();
		}
	});
});
