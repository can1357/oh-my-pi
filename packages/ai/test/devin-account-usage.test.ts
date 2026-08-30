import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { devinUsageProvider } from "@oh-my-pi/pi-ai/usage/devin";
import {
	BillingStrategy,
	DevinPlanInfoSchema,
	GetUserStatusRequestSchema,
	GetUserStatusResponseSchema,
	type Metadata,
	PlanInfoSchema,
	PlanStatusSchema,
	TeamsTier,
	TimestampSchema,
	UserStatusSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const USER_STATUS_URL = "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const PLAN_START_MS = 1_767_225_600_000;
const PLAN_END_MS = 1_769_904_000_000;
const DAILY_RESET_SECONDS = 1_767_312_000n;
const WEEKLY_RESET_SECONDS = 1_767_830_400n;

function timestampFromMs(timestamp: number) {
	return create(TimestampSchema, {
		seconds: BigInt(Math.floor(timestamp / 1_000)),
		nanos: (timestamp % 1_000) * 1_000_000,
	});
}
/** Mirrors the provider's `Metadata.os` mapping so the assertion holds on every host. */
const EXPECTED_OS = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";

interface PlanFixture {
	planName?: string;
	teamsTier?: TeamsTier;
	billingStrategy?: BillingStrategy;
	monthlyPromptCredits?: number;
	monthlyFlowCredits?: number;
	monthlyFlexCreditPurchaseAmount?: number;
	hideDailyQuota?: boolean;
	hideWeeklyQuota?: boolean;
	orgId?: string;
	accountDisplayName?: string;
}

interface StatusFixture {
	email?: string;
	userId?: string;
	teamId?: string;
	usedPromptCredits?: number;
	availablePromptCredits?: number;
	usedFlowCredits?: number;
	availableFlowCredits?: number;
	usedFlexCredits?: number;
	availableFlexCredits?: number;
	dailyQuotaRemainingPercent?: number;
	dailyQuotaResetAtUnix?: bigint;
	weeklyQuotaRemainingPercent?: number;
	weeklyQuotaResetAtUnix?: bigint;
	overageBalanceMicros?: bigint;
	withPlanPeriod?: boolean;
}

function userStatusPayload(plan: PlanFixture, status: StatusFixture): Uint8Array {
	const planInfo = create(PlanInfoSchema, {
		planName: plan.planName ?? "",
		teamsTier: plan.teamsTier ?? TeamsTier.UNSPECIFIED,
		billingStrategy: plan.billingStrategy ?? BillingStrategy.UNSPECIFIED,
		monthlyPromptCredits: plan.monthlyPromptCredits ?? 0,
		monthlyFlowCredits: plan.monthlyFlowCredits ?? 0,
		monthlyFlexCreditPurchaseAmount: plan.monthlyFlexCreditPurchaseAmount ?? 0,
		hideDailyQuota: plan.hideDailyQuota ?? false,
		hideWeeklyQuota: plan.hideWeeklyQuota ?? false,
		isDevin: true,
		devinInfo: create(DevinPlanInfoSchema, {
			orgId: plan.orgId ?? "",
			accountDisplayName: plan.accountDisplayName ?? "",
		}),
	});
	const planStatus = create(PlanStatusSchema, {
		...(status.withPlanPeriod === false
			? {}
			: { planStart: timestampFromMs(PLAN_START_MS), planEnd: timestampFromMs(PLAN_END_MS) }),
		usedPromptCredits: status.usedPromptCredits ?? 0,
		availablePromptCredits: status.availablePromptCredits ?? 0,
		usedFlowCredits: status.usedFlowCredits ?? 0,
		availableFlowCredits: status.availableFlowCredits ?? 0,
		usedFlexCredits: status.usedFlexCredits ?? 0,
		availableFlexCredits: status.availableFlexCredits ?? 0,
		dailyQuotaRemainingPercent: status.dailyQuotaRemainingPercent ?? 0,
		dailyQuotaResetAtUnix: status.dailyQuotaResetAtUnix ?? 0n,
		weeklyQuotaRemainingPercent: status.weeklyQuotaRemainingPercent ?? 0,
		weeklyQuotaResetAtUnix: status.weeklyQuotaResetAtUnix ?? 0n,
		overageBalanceMicros: status.overageBalanceMicros ?? 0n,
	});
	const response = create(GetUserStatusResponseSchema, {
		userStatus: create(UserStatusSchema, {
			email: status.email ?? "",
			userId: status.userId ?? "",
			teamId: status.teamId ?? "",
			teamsTier: plan.teamsTier ?? TeamsTier.UNSPECIFIED,
			planStatus,
		}),
		planInfo,
	});
	return toBinary(GetUserStatusResponseSchema, response);
}

interface Capture {
	url?: string;
	headers?: Headers;
	metadata?: Metadata;
}

function mockFetch(payload: Uint8Array, capture: Capture, init?: { gzip?: boolean; status?: number }): FetchImpl {
	return (input, requestInit) => {
		capture.url = String(input);
		capture.headers = new Headers(requestInit?.headers);
		const body = requestInit?.body as Uint8Array;
		capture.metadata = fromBinary(GetUserStatusRequestSchema, new Uint8Array(body)).metadata;
		const status = init?.status ?? 200;
		const bytes = init?.gzip ? new Uint8Array(gzipSync(payload)) : payload;
		return Promise.resolve(
			new Response(status === 200 ? bytes : "denied", {
				status,
				headers: { "content-type": "application/proto" },
			}),
		);
	};
}

function params(token: string, type: "oauth" | "api_key" = "oauth"): UsageFetchParams {
	return {
		provider: "devin",
		credential: type === "oauth" ? { type, accessToken: token } : { type, apiKey: token },
		accountKey: "devin-account",
	};
}

function limitById(report: UsageReport, id: string): UsageLimit {
	const limit = report.limits.find(entry => entry.id === id);
	if (!limit) throw new Error(`missing limit ${id}: ${report.limits.map(entry => entry.id).join(", ")}`);
	return limit;
}

describe("Devin account usage", () => {
	test("sends the native CLI identity and maps credits, quota windows and account metadata", async () => {
		const payload = userStatusPayload(
			{
				planName: "Devin Teams",
				teamsTier: TeamsTier.DEVIN_TEAMS,
				billingStrategy: BillingStrategy.QUOTA,
				monthlyPromptCredits: 500,
				monthlyFlowCredits: 1000,
				monthlyFlexCreditPurchaseAmount: 200,
				orgId: "org-42",
				accountDisplayName: "Acme Robotics",
			},
			{
				email: "will@example.com",
				userId: "user-7",
				teamId: "team-9",
				usedPromptCredits: 125,
				availablePromptCredits: 375,
				usedFlowCredits: 250,
				availableFlowCredits: 800,
				usedFlexCredits: 50,
				availableFlexCredits: 150,
				dailyQuotaRemainingPercent: 40,
				dailyQuotaResetAtUnix: DAILY_RESET_SECONDS,
				weeklyQuotaRemainingPercent: 75,
				weeklyQuotaResetAtUnix: WEEKLY_RESET_SECONDS,
				overageBalanceMicros: 2_500_000n,
			},
		);
		const capture: Capture = {};

		const report = await devinUsageProvider.fetchUsage(params("raw-token"), {
			fetch: mockFetch(payload, capture),
		});

		expect(capture.url).toBe(USER_STATUS_URL);
		expect(capture.headers?.get("content-type")).toBe("application/proto");
		expect(capture.headers?.get("connect-protocol-version")).toBe("1");
		expect(capture.metadata?.apiKey).toBe("devin-session-token$raw-token");
		expect(capture.metadata?.ideName).toBe("devin-cli");
		expect(capture.metadata?.ideType).toBe("chisel");
		expect(capture.metadata?.extensionName).toBe("chisel");
		expect(capture.metadata?.ideVersion).toBe("3000.6.2");
		expect(capture.metadata?.extensionVersion).toBe("3000.6.2");
		expect(capture.metadata?.locale).toBe("en");
		expect(capture.metadata?.os).toBe(EXPECTED_OS);

		if (!report) throw new Error("expected a usage report");
		const prompt = limitById(report, "devin:credits:prompt");
		expect(prompt.amount).toEqual({
			used: 125,
			remaining: 375,
			limit: 500,
			usedFraction: 0.25,
			remainingFraction: 0.75,
			unit: "unknown",
		});
		expect(prompt.window).toEqual({
			id: "monthly",
			label: "Plan Period",
			durationMs: PLAN_END_MS - PLAN_START_MS,
			resetsAt: PLAN_END_MS,
		});
		expect(prompt.scope).toEqual({
			provider: "devin",
			accountId: "user-7",
			orgId: "org-42",
			tier: "Devin Teams",
			windowId: "monthly",
		});
		expect(prompt.status).toBe("ok");
		expect(limitById(report, "devin:credits:flow").amount.usedFraction).toBe(0.25);
		expect(limitById(report, "devin:credits:flex").amount.usedFraction).toBe(0.25);

		const daily = limitById(report, "devin:quota:daily");
		expect(daily.amount).toEqual({
			used: 60,
			limit: 100,
			remaining: 40,
			usedFraction: 0.6,
			remainingFraction: 0.4,
			unit: "percent",
		});
		expect(daily.window?.resetsAt).toBe(Number(DAILY_RESET_SECONDS) * 1000);
		expect(daily.window?.durationMs).toBe(24 * 60 * 60 * 1000);
		const weekly = limitById(report, "devin:quota:weekly");
		expect(weekly.amount.usedFraction).toBe(0.25);
		expect(weekly.scope.windowId).toBe("7d");
		expect(weekly.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(weekly.window?.resetsAt).toBe(Number(WEEKLY_RESET_SECONDS) * 1000);

		expect(report.metadata).toEqual({
			source: "seat-management",
			email: "will@example.com",
			accountId: "user-7",
			orgId: "org-42",
			orgName: "Acme Robotics",
			planType: "Devin Teams",
			planEnd: PLAN_END_MS,
			overageBalanceUsd: 2.5,
		});
		expect(report.notes).toEqual(["Overage balance: $2.50"]);
	});

	test("decodes a gzip-encoded response body and keeps an already-prefixed session token", async () => {
		const payload = userStatusPayload(
			{ planName: "Devin Pro", monthlyPromptCredits: 400 },
			{ userId: "user-1", usedPromptCredits: 400, availablePromptCredits: 0 },
		);
		const capture: Capture = {};

		const report = await devinUsageProvider.fetchUsage(params("devin-session-token$already", "api_key"), {
			fetch: mockFetch(payload, capture, { gzip: true }),
		});

		expect(capture.metadata?.apiKey).toBe("devin-session-token$already");
		if (!report) throw new Error("expected a usage report");
		expect(limitById(report, "devin:credits:prompt").status).toBe("exhausted");
	});

	test("omits percent windows for credit-billed plans and falls back to the tier label", async () => {
		const payload = userStatusPayload(
			{
				teamsTier: TeamsTier.DEVIN_PRO,
				billingStrategy: BillingStrategy.CREDITS,
				monthlyPromptCredits: 500,
			},
			{ userId: "user-3", usedPromptCredits: 10, availablePromptCredits: 490 },
		);

		const report = await devinUsageProvider.fetchUsage(params("raw-token"), {
			fetch: mockFetch(payload, {}),
		});

		if (!report) throw new Error("expected a usage report");
		expect(report.limits.map(limit => limit.id)).toEqual(["devin:credits:prompt"]);
		expect(report.metadata?.planType).toBe("Devin Pro");
		expect(report.notes).toBeUndefined();
	});

	test("hides a quota window the plan marks hidden", async () => {
		const payload = userStatusPayload(
			{ billingStrategy: BillingStrategy.QUOTA, hideDailyQuota: true },
			{
				userId: "user-4",
				dailyQuotaRemainingPercent: 90,
				dailyQuotaResetAtUnix: DAILY_RESET_SECONDS,
				weeklyQuotaRemainingPercent: 50,
				weeklyQuotaResetAtUnix: WEEKLY_RESET_SECONDS,
			},
		);

		const report = await devinUsageProvider.fetchUsage(params("raw-token"), {
			fetch: mockFetch(payload, {}),
		});

		if (!report) throw new Error("expected a usage report");
		expect(report.limits.map(limit => limit.id)).toEqual(["devin:quota:weekly"]);
	});

	test("returns null when the seat-management call is rejected", async () => {
		const warnings: string[] = [];
		const report = await devinUsageProvider.fetchUsage(params("raw-token"), {
			fetch: mockFetch(userStatusPayload({}, {}), {}, { status: 401 }),
			logger: {
				debug: () => {},
				warn: message => {
					warnings.push(message);
				},
			},
		});

		expect(report).toBeNull();
		expect(warnings).toEqual(["Devin user status fetch failed"]);
	});

	test("supports only devin credentials that carry a session token", () => {
		expect(devinUsageProvider.supports?.(params("raw-token"))).toBe(true);
		expect(devinUsageProvider.supports?.(params("raw-token", "api_key"))).toBe(true);
		expect(devinUsageProvider.supports?.(params(""))).toBe(false);
		expect(devinUsageProvider.supports?.({ ...params("raw-token"), provider: "cursor" })).toBe(false);
	});
});
