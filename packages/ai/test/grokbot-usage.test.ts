import { afterEach, describe, expect, test } from "bun:test";
import { clearGrokbotTokenCache, runWithGrokbotAuthSourceAsync } from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { GrokbotRpcClient, GrokbotRpcError } from "@oh-my-pi/pi-catalog/discovery/grokbot-rpc";
import type { FetchImpl } from "../src/types";
import { grokbotUsageProvider, parseGrokbotUsage } from "../src/usage/grokbot";

afterEach(() => clearGrokbotTokenCache());

describe("Sand allowance reporting", () => {
	test("reports used percentage and reset separately from model entitlement", () => {
		const report = parseGrokbotUsage(
			{
				usagePercent: 5.563001,
				hasAvailableUsage: true,
				grokPlanLabel: "Grok Bot Plan",
				cursorPlanName: "Ultra",
				nextResetTimestampUtc: "2026-10-11T17:39:56.482Z",
				availableBankedResetCount: 2,
				accidentalToken: "secret",
			},
			"grokbot",
			100,
		);
		expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(0.05563001);
		expect(report?.limits[0]?.amount.remaining).toBeCloseTo(94.436999);
		expect(report?.limits[0]?.window?.resetsAt).toBe(Date.parse("2026-10-11T17:39:56.482Z"));
		expect(report?.resetCredits).toEqual({ availableCount: 2 });
		expect(report?.limits[0]?.scope.modelId).toBeUndefined();
		expect(report?.metadata).not.toHaveProperty("accidentalToken");
		expect(report?.raw).toBeUndefined();
	});

	test("honors a server unavailable flag without inventing a percentage", () => {
		const report = parseGrokbotUsage({ hasAvailableUsage: false }, "grokbot-chat");
		expect(report?.limits[0]?.status).toBe("exhausted");
		expect(report?.limits[0]?.amount).toEqual({ unit: "percent" });
		expect(report?.limits[0]?.scope.sharedGroup).toBeUndefined();
		expect(parseGrokbotUsage({ usagePercent: "bad" })).toBeNull();
	});

	test("usage RPC sends the session bearer and never a workload JWT", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const fetch: FetchImpl = async (input, init) => {
			const url = String(input);
			calls.push({ url, headers: new Headers(init?.headers) });
			if (url.endsWith("/inference-credential"))
				return Response.json({
					accessToken: "fixture-session",
					grokBotToken: "fixture-inference",
					expiresAtMs: Date.now() + 300_000,
				});
			return Response.json({ usagePercent: 25, hasAvailableUsage: true });
		};
		const report = await runWithGrokbotAuthSourceAsync(
			{
				secretsPath: "/not-present/grokbot.env",
				env: { GROKBOT_RENEWAL_CREDENTIAL: "fixture-renewal", GROKBOT_MACHINE_ID: "fixture-machine" },
			},
			() =>
				grokbotUsageProvider.fetchUsage(
					{ provider: "grokbot", credential: { type: "api_key", apiKey: "fixture-renewal" } },
					{ fetch },
				),
		);
		expect(report?.limits[0]?.amount.used).toBe(25);
		expect(calls.at(-1)?.url).toEndWith("/aiserver.v1.DashboardService/GetSandUsageStatus");
		expect(calls.at(-1)?.headers.get("authorization")).toBe("Bearer fixture-session");
		expect(calls.at(-1)?.headers.get("x-inference-authentication-jwt")).toBeNull();
	});

	test("RPC authentication retry is once, while permission errors are not retried or echoed", async () => {
		let renewals = 0;
		let rpcs = 0;
		const fetch: FetchImpl = async input => {
			if (String(input).endsWith("/inference-credential")) {
				renewals++;
				return Response.json({ accessToken: `fixture-${renewals}`, expiresAtMs: Date.now() + 300_000 });
			}
			rpcs++;
			return Response.json(
				{ code: rpcs === 1 ? "unauthenticated" : "permission_denied", message: "credential=DO_NOT_ECHO" },
				{ status: rpcs === 1 ? 401 : 403 },
			);
		};
		const client = new GrokbotRpcClient(
			{ renewal: "fixture-renewal", machineId: "fixture-machine", namespace: "prod", clientVersion: "0.69.0" },
			{ fetch, headers: { "x-inference-authentication-jwt": "must-not-forward" } },
		);
		let message = "";
		try {
			await client.rpc("/aiserver.v1.DashboardService/GetSandUsageStatus");
		} catch (error) {
			message = String(error);
		}
		expect([renewals, rpcs]).toEqual([2, 2]);
		expect(message).toContain("permission_denied");
		expect(message).not.toContain("DO_NOT_ECHO");
	});

	test("an untrusted RPC error code cannot leak a credential-shaped value", async () => {
		const fetch: FetchImpl = async input =>
			String(input).endsWith("/inference-credential")
				? Response.json({ accessToken: "fixture-session", expiresAtMs: Date.now() + 300_000 })
				: Response.json({ code: "sbi_this_is_secret" }, { status: 403 });
		const client = new GrokbotRpcClient(
			{ renewal: "fixture-renewal", machineId: "fixture-machine", namespace: "prod", clientVersion: "0.69.0" },
			{ fetch },
		);
		try {
			await client.rpc("/aiserver.v1.DashboardService/GetSandUsageStatus");
		} catch (error) {
			expect(error).toBeInstanceOf(GrokbotRpcError);
			expect(String(error)).not.toContain("sbi_this");
			return;
		}
		throw new Error("Expected RPC rejection");
	});
});
