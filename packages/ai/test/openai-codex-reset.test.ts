/**
 * Wire-contract regressions for OpenAI Codex "saved rate limit reset"
 * redemption. The endpoints and request shape are reverse-engineered from the
 * Codex desktop app; these tests pin them so the redeem path can't silently
 * drift (and so we never need to spend a real credit to verify it):
 *
 *   GET  /wham/rate-limit-reset-credits
 *   POST /wham/rate-limit-reset-credits/consume  { credit_id, redeem_request_id, account_id? }
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	consumeCodexResetCredit,
	getUsableCodexResetCredits,
	listCodexResetCredits,
} from "@oh-my-pi/pi-ai/usage/openai-codex-reset";

interface Captured {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: unknown;
}

function recordingFetch(status: number, payload: unknown): { fetch: FetchImpl; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetch = (async (url: string, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers: (init?.headers as Record<string, string>) ?? {},
			body: init?.body ? JSON.parse(init.body as string) : undefined,
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as FetchImpl;
	return { fetch, calls };
}

describe("listCodexResetCredits", () => {
	it("lists credits and surfaces available_count from the dedicated route", async () => {
		const { fetch, calls } = recordingFetch(200, {
			credits: [
				{
					id: "RateLimitResetCredit_abc",
					reset_type: "codex_rate_limits",
					status: "available",
					granted_at: "2026-06-12T02:11:50Z",
					expires_at: "2026-07-12T02:11:50Z",
					title: "One free rate limit reset",
					description: "Thanks for using Codex!",
				},
			],
			available_count: 1,
		});
		const list = await listCodexResetCredits({ accessToken: "tok", accountId: "acct-1", fetch });
		expect(list).not.toBeNull();
		expect(list?.availableCount).toBe(1);
		expect(list?.credits[0]?.id).toBe("RateLimitResetCredit_abc");
		expect(list?.credits[0]?.title).toBe("One free rate limit reset");
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
		expect(calls[0]?.headers["ChatGPT-Account-Id"]).toBe("acct-1");
	});

	it("falls back to counting available credits when available_count is absent", async () => {
		const { fetch } = recordingFetch(200, {
			credits: [
				{ id: "c1", status: "available" },
				{ id: "c2", status: "redeemed" },
			],
		});
		const list = await listCodexResetCredits({ accessToken: "tok", fetch });
		expect(list?.availableCount).toBe(1);
	});

	it("returns null on non-2xx", async () => {
		const { fetch } = recordingFetch(401, { detail: "Unauthorized" });
		expect(await listCodexResetCredits({ accessToken: "tok", fetch })).toBeNull();
	});
});

describe("consumeCodexResetCredit", () => {
	it("POSTs credit_id + redeem_request_id and reports ok on code=reset", async () => {
		const { fetch, calls } = recordingFetch(200, { code: "reset" });
		const result = await consumeCodexResetCredit({
			creditId: "RateLimitResetCredit_abc",
			accessToken: "tok",
			accountId: "acct-1",
			redeemRequestId: "req-123",
			fetch,
		});
		expect(result.ok).toBe(true);
		expect(result.code).toBe("reset");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
		expect(calls[0]?.body).toEqual({
			credit_id: "RateLimitResetCredit_abc",
			redeem_request_id: "req-123",
			account_id: "acct-1",
		});
		expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
	});

	it("generates a redeem_request_id when none is supplied", async () => {
		const { fetch, calls } = recordingFetch(200, { code: "reset" });
		await consumeCodexResetCredit({ creditId: "c1", accessToken: "tok", fetch });
		const body = calls[0]?.body as { redeem_request_id?: string };
		expect(typeof body.redeem_request_id).toBe("string");
		expect(body.redeem_request_id?.length).toBeGreaterThan(0);
	});

	it("reports not-ok for business outcomes like already_redeemed", async () => {
		const { fetch } = recordingFetch(200, { code: "already_redeemed" });
		const result = await consumeCodexResetCredit({ creditId: "c1", accessToken: "tok", fetch });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("already_redeemed");
	});

	it("synthesizes an http_<status> code on unexpected failures", async () => {
		const { fetch } = recordingFetch(500, {});
		const result = await consumeCodexResetCredit({ creditId: "c1", accessToken: "tok", fetch });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("http_500");
	});
});

describe("getUsableCodexResetCredits", () => {
	const nowMs = Date.parse("2026-07-31T12:00:00Z");

	it("orders usable dated credits by expiry before undated and malformed credits", () => {
		const credits = [
			{ id: "undated" },
			{ id: "late", status: "available", expiresAt: "2026-08-12T00:00:00Z" },
			{ id: "malformed", status: "available", expiresAt: "not-a-date" },
			{ id: "soon", expiresAt: "2026-07-31T18:00:00Z" },
			{ id: "mid", status: "available", expiresAt: "2026-08-11T00:00:00Z" },
		];

		expect(getUsableCodexResetCredits(credits, nowMs).map(credit => credit.id)).toEqual([
			"soon",
			"mid",
			"late",
			"undated",
			"malformed",
		]);
	});

	it("excludes expired, unavailable, and in-progress or completed redemptions", () => {
		const credits = [
			{ id: "expired", expiresAt: "2026-07-31T11:59:59Z" },
			{ id: "boundary", expiresAt: "2026-07-31T12:00:00Z" },
			{ id: "redeemed", status: "redeemed" },
			{ id: "unavailable", status: "unavailable" },
			{ id: "started", redeemStartedAt: "2026-07-31T11:00:00Z" },
			{ id: "completed", redeemedAt: "2026-07-31T11:00:00Z" },
			{ id: "live", status: "available", expiresAt: "2026-08-12T00:00:00Z" },
		];

		expect(getUsableCodexResetCredits(credits, nowMs).map(credit => credit.id)).toEqual(["live"]);
		expect(getUsableCodexResetCredits(credits.slice(0, -1), nowMs)).toEqual([]);
		expect(getUsableCodexResetCredits([], nowMs)).toEqual([]);
	});
});
