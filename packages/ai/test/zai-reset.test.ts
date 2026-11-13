/**
 * Wire-contract regressions for the Z.AI coding-plan reset client and its
 * auth-storage integration. The endpoints and request shape are
 * reverse-engineered from zcode's desktop app and live-verified 2026-11-13;
 * these tests pin them so the claim/spend path can't silently drift (and so
 * no real reset is ever spent to verify it):
 *
 *   GET  /api/v1/coding-plan/reset/status
 *   POST /api/v1/coding-plan/reset/opportunity  { idempotency_key }   (UUID-only, server rejects others)
 *   POST /api/v1/coding-plan/reset/use          { idempotency_key, reset_type }
 *
 * Envelope: {code, msg, data}; success code 0 (200 also accepted); ms
 * timestamps everywhere except `server_time` (seconds).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, type OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { zaiMintKeyHook } from "@oh-my-pi/pi-ai/registry/oauth/zai";
import {
	listZaiResetStatus,
	requestZaiResetOpportunity,
	useZaiReset,
	zaiResetCreditId,
	zaiResetStatusToCredits,
	zaiResetStatusToInventory,
	zaiResetTypeFromCreditId,
	zaiResetUsageCredit,
} from "@oh-my-pi/pi-ai/usage/zai-reset";
import type { UsageFetchContext } from "@oh-my-pi/pi-ai/usage";
import { zaiUsageProvider } from "@oh-my-pi/pi-ai/usage/zai";

const BASE = "https://zcode.z.ai";
const AUTH = { zcodeJwt: "zcode-jwt", zaiOauthJwt: "maas-jwt" };
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR = 3_600_000;

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

describe("listZaiResetStatus", () => {
	it("parses offers (epoch ms) and server_time (epoch s) and sends both JWTs", async () => {
		const { fetch, calls } = recordingFetch(200, {
			code: 0,
			data: {
				available_five_hour_resets: [{ expire_at: 1_794_579_398_000 }],
				available_week_resets: [],
				latest_five_hour_reset_history: { used_at: 1_794_395_060_000 },
				latest_week_reset_history: null,
				has_unread_history: false,
				server_time: 1_794_573_282,
			},
		});
		const outcome = await listZaiResetStatus(AUTH, { fetchImpl: fetch });
		if (!outcome.ok) throw new Error("expected a successful listing");
		const status = outcome.status;
		// A seconds/ms mix-up would inflate expiries 1000x: pin both conversions.
		expect(status.availableFiveHourResets).toEqual([{ expireAtMs: 1_794_579_398_000 }]);
		expect(status.serverTimeMs).toBe(1_794_573_282_000);
		expect(status.latestFiveHourUsedAtMs).toBe(1_794_395_060_000);
		expect(status.latestWeekUsedAtMs).toBeUndefined();
		expect(status.hasUnreadHistory).toBe(false);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe(`${BASE}/api/v1/coding-plan/reset/status`);
		expect(calls[0]?.headers.Authorization).toBe("Bearer zcode-jwt");
		expect(calls[0]?.headers["X-Bigmodel-Authorization"]).toBe("Bearer maas-jwt");
		expect(calls[0]?.headers["Bigmodel-Target-Type"]).toBe("PERSONAL");
	});

	it("accepts the code-200 success envelope variant", async () => {
		const { fetch } = recordingFetch(200, {
			code: 200,
			data: { available_five_hour_resets: [], available_week_resets: [{ expire_at: 1_794_579_398_000 }] },
		});
		const outcome = await listZaiResetStatus(AUTH, { fetchImpl: fetch });
		if (!outcome.ok) throw new Error("expected a successful listing");
		expect(outcome.status.availableWeekResets).toHaveLength(1);
	});

	it("maps HTTP 401 to unauthorized so a dead sign-in asks for re-login, not zero resets", async () => {
		const { fetch } = recordingFetch(401, { code: 401, msg: "unauthorized" });
		expect(await listZaiResetStatus(AUTH, { fetchImpl: fetch })).toEqual({ ok: false, code: "unauthorized" });
	});

	it("maps HTTP 403 to unauthorized (a forbidden reset route also needs a fresh sign-in)", async () => {
		const { fetch } = recordingFetch(403, { code: 403, msg: "forbidden" });
		expect(await listZaiResetStatus(AUTH, { fetchImpl: fetch })).toEqual({ ok: false, code: "unauthorized" });
	});

	it("maps a 5xx to failed so an outage is never mistaken for zero resets", async () => {
		const { fetch } = recordingFetch(500, { message: "boom" });
		expect(await listZaiResetStatus(AUTH, { fetchImpl: fetch })).toEqual({ ok: false, code: "failed" });
	});

	it("maps a transport throw to failed", async () => {
		const fetch = (async () => {
			throw new Error("connection reset");
		}) as unknown as FetchImpl;
		expect(await listZaiResetStatus(AUTH, { fetchImpl: fetch })).toEqual({ ok: false, code: "failed" });
	});

	it("returns failed when an offer array is missing (payload drift, not zero resets)", async () => {
		const { fetch } = recordingFetch(200, { code: 0, data: { available_week_resets: [] } });
		expect(await listZaiResetStatus(AUTH, { fetchImpl: fetch })).toEqual({ ok: false, code: "failed" });
	});

	it("normalizes second-precision expire_at values", async () => {
		const { fetch } = recordingFetch(200, {
			code: 0,
			data: { available_five_hour_resets: [{ expire_at: 1_794_579_398 }], available_week_resets: [] },
		});
		const outcome = await listZaiResetStatus(AUTH, { fetchImpl: fetch });
		if (!outcome.ok) throw new Error("expected a successful listing");
		expect(outcome.status.availableFiveHourResets[0]?.expireAtMs).toBe(1_794_579_398_000);
	});

	it("returns failed when the envelope reports a business failure", async () => {
		const { fetch } = recordingFetch(200, { code: 1111, msg: "no coding plan" });
		expect(await listZaiResetStatus(AUTH, { fetchImpl: fetch })).toEqual({ ok: false, code: "failed" });
	});
});

describe("requestZaiResetOpportunity", () => {
	it("claims with the UUID idempotency key and reports a grant", async () => {
		const { fetch, calls } = recordingFetch(200, { code: 0, data: { granted: true } });
		const outcome = await requestZaiResetOpportunity(AUTH, { idempotencyKey: UUID, fetchImpl: fetch });
		expect(outcome).toEqual({ ok: true, granted: true });
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(`${BASE}/api/v1/coding-plan/reset/opportunity`);
		expect(calls[0]?.body).toEqual({ idempotency_key: UUID });
		expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
	});

	it("maps the 3301 refusal to a polite not-granted with the server's retry time", async () => {
		const { fetch } = recordingFetch(200, {
			code: 3301,
			msg: "coding plan reset grant not allowed",
			data: { granted: false, next_try_at: 1_794_574_168_171, server_time: 1_794_573_568 },
		});
		const outcome = await requestZaiResetOpportunity(AUTH, { idempotencyKey: UUID, fetchImpl: fetch });
		// Misreading next_try_at (seconds) would stall claims for ~19 days.
		expect(outcome).toEqual({ ok: true, granted: false, nextTryAtMs: 1_794_574_168_171 });
	});

	it("surfaces HTTP 429 as a throttled failure instead of a bogus refusal", async () => {
		const { fetch } = recordingFetch(429, { msg: "slow down" });
		const outcome = await requestZaiResetOpportunity(AUTH, { idempotencyKey: UUID, fetchImpl: fetch });
		expect(outcome).toEqual({ ok: false, code: "throttled", reason: "HTTP 429" });
	});

	it("maps the live-verified non-UUID rejection (HTTP 400, code 3001) to business_3001", async () => {
		const { fetch } = recordingFetch(400, { code: 3001, msg: "parameter error" });
		const outcome = await requestZaiResetOpportunity(AUTH, { idempotencyKey: UUID, fetchImpl: fetch });
		expect(outcome).toEqual({ ok: false, code: "business_3001", reason: "parameter error" });
	});

	it("rejects a non-UUID idempotency key before any request leaves the process", async () => {
		const { fetch, calls } = recordingFetch(200, { code: 0, data: { granted: true } });
		await expect(
			requestZaiResetOpportunity(AUTH, { idempotencyKey: "omp-live-probe-1", fetchImpl: fetch }),
		).rejects.toThrow();
		await expect(requestZaiResetOpportunity(AUTH, { idempotencyKey: "", fetchImpl: fetch })).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});

describe("useZaiReset", () => {
	it("spends with idempotency_key + reset_type and reports the reset", async () => {
		const { fetch, calls } = recordingFetch(200, { code: 0, data: { used: true } });
		const outcome = await useZaiReset(AUTH, {
			idempotencyKey: UUID,
			resetType: "FIVE_HOUR",
			fetchImpl: fetch,
		});
		expect(outcome).toEqual({ ok: true, code: "reset" });
		expect(calls[0]?.url).toBe(`${BASE}/api/v1/coding-plan/reset/use`);
		expect(calls[0]?.body).toEqual({ idempotency_key: UUID, reset_type: "FIVE_HOUR" });
	});

	it("maps an already-spent offer (used: false) to the terminal no_credit code", async () => {
		const { fetch } = recordingFetch(200, { code: 0, data: { used: false } });
		const outcome = await useZaiReset(AUTH, { idempotencyKey: UUID, resetType: "WEEK", fetchImpl: fetch });
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe("no_credit");
	});

	it("synthesizes http_<status> when the server fails without a business code", async () => {
		const { fetch } = recordingFetch(502, { message: "bad gateway" });
		const outcome = await useZaiReset(AUTH, { idempotencyKey: UUID, resetType: "WEEK", fetchImpl: fetch });
		expect(outcome).toEqual({ ok: false, code: "http_502", reason: "HTTP 502" });
	});

	it("rejects a non-UUID idempotency key locally", async () => {
		const { fetch, calls } = recordingFetch(200, { code: 0, data: { used: true } });
		await expect(
			useZaiReset(AUTH, { idempotencyKey: "nope", resetType: "WEEK", fetchImpl: fetch }),
		).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});

describe("credit ids", () => {
	it("round-trips five_hour/week credit ids", () => {
		expect(zaiResetCreditId("FIVE_HOUR", 1_794_579_398_000)).toBe("five_hour:1794579398000");
		expect(zaiResetTypeFromCreditId("five_hour:1794579398000")).toBe("FIVE_HOUR");
		expect(zaiResetCreditId("WEEK", 42)).toBe("week:42");
		expect(zaiResetTypeFromCreditId("week:42")).toBe("WEEK");
	});

	it("refuses ids from other reset programs or malformed suffixes", () => {
		expect(zaiResetTypeFromCreditId("anthropic:5h")).toBeUndefined();
		expect(zaiResetTypeFromCreditId("five_hour:soon")).toBeUndefined();
		expect(zaiResetTypeFromCreditId("five_hour:")).toBeUndefined();
		expect(zaiResetTypeFromCreditId("week")).toBeUndefined();
		expect(zaiResetTypeFromCreditId("")).toBeUndefined();
	});
});

describe("zaiResetStatusToCredits", () => {
	it("drops expired offers and pins the token-window limits each reset clears", () => {
		const now = 1_794_573_282_000;
		const credits = zaiResetStatusToCredits(
			{
				availableFiveHourResets: [{ expireAtMs: now - 1 }, { expireAtMs: now + HOUR }],
				availableWeekResets: [{ expireAtMs: now + 2 * HOUR }],
				hasUnreadHistory: false,
			},
			now,
		);
		// An expired offer listed as spendable would fail at redeem with no_credit.
		expect(credits.map(credit => credit.id)).toEqual(["five_hour:1794576882000", "week:1794580482000"]);
		expect(credits[0]?.clears).toEqual(["zai:tokens:5h"]);
		expect(credits[1]?.clears).toEqual(["zai:tokens:1w"]);
		expect(credits[0]?.title).toBe("Z.AI 5-hour reset");
		expect(credits[1]?.title).toBe("Z.AI weekly reset");
		expect(credits[0]?.program).toBe("zai-coding-plan");
		expect(credits[0]?.remainingCount).toBe(1);
		expect(credits[0]?.usable).toBe(true);
		expect(credits[0]?.expiresAt).toBe(new Date(now + HOUR).toISOString());
	});

	it("lists credits soonest-expiring first and pins the first as nextCreditId", () => {
		const now = 1_794_573_282_000;
		const inventory = zaiResetStatusToInventory(
			{
				availableFiveHourResets: [{ expireAtMs: now + 2 * HOUR }],
				availableWeekResets: [{ expireAtMs: now + HOUR }],
				hasUnreadHistory: false,
			},
			now,
		);
		// Perishable credits must be spent in expiry order.
		expect(inventory.nextCreditId).toBe("week:1794576882000");
		expect(inventory.availableCount).toBe(2);
		expect(inventory.redeemableCount).toBe(2);
		expect(inventory.eligible).toBe(true);
	});
});

describe("zaiResetUsageCredit", () => {
	it("picks the soonest-expiring offer that is available and unexpired", () => {
		const now = 1_794_573_282_000;
		const credits = [
			{ id: "week:1794580482000", usable: true, expiresAt: new Date(now + 3 * HOUR).toISOString() },
			{ id: "five_hour:1794576882000", usable: true, expiresAt: new Date(now + HOUR).toISOString() },
		];
		// Perishable credits keep the most value when spent in expiry order.
		expect(zaiResetUsageCredit(credits, now)?.id).toBe("five_hour:1794576882000");
	});

	it("never picks expired, unusable, non-available, or expiry-less offers", () => {
		const now = 1_794_573_282_000;
		const credits = [
			{ id: "expired", usable: true, expiresAt: new Date(now - 1).toISOString() },
			{ id: "cooldown", status: "cooldown", usable: true, expiresAt: new Date(now + HOUR).toISOString() },
			{ id: "unusable", usable: false, expiresAt: new Date(now + HOUR).toISOString() },
			{ id: "no-expiry", usable: true },
			// An omitted status defaults to "available".
			{ id: "defaulted", usable: true, expiresAt: new Date(now + 2 * HOUR).toISOString() },
		];
		expect(zaiResetUsageCredit(credits, now)?.id).toBe("defaulted");
		// Past the last expiry nothing is spendable.
		expect(zaiResetUsageCredit(credits, now + 4 * HOUR)).toBeUndefined();
		expect(zaiResetUsageCredit([], now)).toBeUndefined();
	});
});

/** Routed mock of the zcode control plane used by the auth-storage tests. */
interface ZaiServer {
	fetch: FetchImpl;
	calls: Captured[];
	statusReply: () => unknown;
	/** HTTP status the status route replies with (default 200); a `null` statusReply still models a hard 500. */
	statusStatus?: number;
	opportunityReply: () => unknown;
	useReply: () => unknown;
}

function zaiServer(): ZaiServer {
	const calls: Captured[] = [];
	const server: ZaiServer = {
		calls,
		statusReply: () => ({ code: 0, data: { available_five_hour_resets: [], available_week_resets: [] } }),
		opportunityReply: () => ({ code: 0, data: { granted: true } }),
		useReply: () => ({ code: 0, data: { used: true } }),
		fetch: (async (url: string, init?: RequestInit) => {
			calls.push({
				url: String(url),
				method: init?.method ?? "GET",
				headers: (init?.headers as Record<string, string>) ?? {},
				body: init?.body ? JSON.parse(init.body as string) : undefined,
			});
			const path = new URL(String(url)).pathname;
			const route = path.endsWith("/reset/status")
				? { reply: server.statusReply(), status: server.statusStatus }
				: path.endsWith("/reset/opportunity")
					? { reply: server.opportunityReply(), status: undefined }
					: path.endsWith("/reset/use")
						? { reply: server.useReply(), status: undefined }
						: { reply: { code: 404, msg: "not found" }, status: undefined };
			// A null reply models the route failing outright (transport/5xx).
			if (route.reply === null) return new Response("upstream unavailable", { status: 500 });
			return new Response(JSON.stringify(route.reply), {
				status: route.status ?? 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as FetchImpl,
	};
	return server;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function storageFixture(server: ZaiServer) {
	const storage = await AuthStorage.create(":memory:", { usageFetch: server.fetch as typeof fetch });
	cleanups.push(() => storage.close());
	const expireAt = Date.now() + 2 * HOUR;
	const credentials: OAuthCredential[] = [
		{
			type: "oauth",
			access: "key-1.secret-1",
			refresh: "refresh-1",
			expires: Number.MAX_SAFE_INTEGER,
			accountId: "zai-account",
			email: "dev@example.com",
			zcodeJwt: "zcode-jwt",
			zaiOauthJwt: "maas-jwt",
		},
		// Signed in before this feature existed: no banked JWTs.
		{
			type: "oauth",
			access: "key-2.secret-2",
			refresh: "refresh-2",
			expires: Number.MAX_SAFE_INTEGER,
			accountId: "zai-legacy",
			email: "legacy@example.com",
		},
	];
	await storage.credentials.set("zai", credentials);
	const accounts = storage.oauth.accounts("zai");
	const full = accounts.find(account => account.email === "dev@example.com");
	const legacy = accounts.find(account => account.email === "legacy@example.com");
	if (!full || !legacy) throw new Error("expected two stored zai credentials");
	return { storage, full, legacy, expireAt };
}

describe("ResetCredits zai integration", () => {
	it("lists banked offers as credits and marks JWT-less sign-ins missing_tokens", async () => {
		const server = zaiServer();
		const { storage, full, legacy, expireAt } = await storageFixture(server);
		server.statusReply = () => ({
			code: 0,
			data: {
				available_five_hour_resets: [{ expire_at: expireAt }],
				available_week_resets: [],
				server_time: Math.floor(Date.now() / 1000),
			},
		});
		const statuses = await storage.resets.list({ provider: "zai" });
		expect(statuses).toHaveLength(2);
		const listed = statuses.find(status => status.credentialId === full.credentialId);
		expect(listed?.error).toBeUndefined();
		expect(listed?.availableCount).toBe(1);
		expect(listed?.credits[0]?.id).toBe(`five_hour:${expireAt}`);
		expect(listed?.credits[0]?.clears).toEqual(["zai:tokens:5h"]);
		// A JWT-less account must degrade explicitly, not fail as a hard error row.
		const withoutTokens = statuses.find(status => status.credentialId === legacy.credentialId);
		expect(withoutTokens?.error).toBe("missing_tokens");
		expect(withoutTokens?.credits).toEqual([]);
	});

	it("reports credit_list_failed (not zero resets) when the status route fails", async () => {
		const server = zaiServer();
		const { storage } = await storageFixture(server);
		server.statusReply = () => null;
		const statuses = await storage.resets.list({ provider: "zai" });
		const byError = Object.fromEntries(statuses.map(status => [status.error, status.availableCount]));
		expect(byError).toEqual({ missing_tokens: 0, credit_list_failed: 0 });
	});

	it("maps an unauthorized listing to reauth_required so a dead sign-in asks for a fresh login", async () => {
		const server = zaiServer();
		server.statusStatus = 401;
		const { storage } = await storageFixture(server);
		const statuses = await storage.resets.list({ provider: "zai" });
		const byError = Object.fromEntries(statuses.map(status => [status.error, status.availableCount]));
		expect(byError).toEqual({ missing_tokens: 0, reauth_required: 0 });
	});

	it("redeem refuses no_credit when the listed offer already left the live status", async () => {
		const server = zaiServer();
		const { storage, full, expireAt } = await storageFixture(server);
		let offersLeft = true;
		server.statusReply = () => ({
			code: 0,
			data: {
				available_five_hour_resets: offersLeft ? [{ expire_at: expireAt }] : [],
				available_week_resets: [],
			},
		});
		const target = { provider: "zai", credentialId: full.credentialId, creditId: `five_hour:${expireAt}` };
		// The offer expired or was spent between listing and confirmation.
		offersLeft = false;
		const outcome = await storage.resets.redeem({ target });
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe("no_credit");
		expect(outcome.creditId).toBe(target.creditId);
		// Nothing may be sent to the spend route once the offer is gone.
		expect(server.calls.filter(call => call.url.endsWith("/reset/use"))).toHaveLength(0);
	});

	it("redeem falls back to a fresh UUID idempotency key when the caller passes none and reports the cleared window", async () => {
		const server = zaiServer();
		const { storage, full, expireAt } = await storageFixture(server);
		server.statusReply = () => ({
			code: 0,
			data: { available_five_hour_resets: [{ expire_at: expireAt }], available_week_resets: [] },
		});
		const outcome = await storage.resets.redeem({
			target: { provider: "zai", credentialId: full.credentialId, creditId: `five_hour:${expireAt}` },
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.code).toBe("reset");
		expect(outcome.cleared).toEqual(["zai:tokens:5h"]);
		const useCall = server.calls.find(call => call.url.endsWith("/reset/use"));
		expect(useCall?.body).toEqual({ idempotency_key: expect.stringMatching(UUID_RE), reset_type: "FIVE_HOUR" });
		// The JWT pair from sign-in, not the minted API key, authenticates the spend.
		expect(useCall?.headers.Authorization).toBe("Bearer zcode-jwt");
		expect(useCall?.headers["X-Bigmodel-Authorization"]).toBe("Bearer maas-jwt");
	});

	it("redeem forwards the caller's idempotencyKey to /use so lost-response retries dedupe server-side", async () => {
		const server = zaiServer();
		const { storage, full, expireAt } = await storageFixture(server);
		server.statusReply = () => ({
			code: 0,
			data: { available_five_hour_resets: [{ expire_at: expireAt }], available_week_resets: [] },
		});
		const outcome = await storage.resets.redeem({
			target: { provider: "zai", credentialId: full.credentialId, creditId: `five_hour:${expireAt}` },
			idempotencyKey: UUID,
		});
		expect(outcome.ok).toBe(true);
		const useCall = server.calls.find(call => call.url.endsWith("/reset/use"));
		// The SAME key must reach the wire verbatim; a retry with it cannot double-reset.
		expect(useCall?.body).toEqual({ idempotency_key: UUID, reset_type: "FIVE_HOUR" });
	});

	it("redeem refuses reauth_required without a spend attempt when the pre-spend listing is unauthorized", async () => {
		const server = zaiServer();
		server.statusStatus = 403;
		const { storage, full, expireAt } = await storageFixture(server);
		const outcome = await storage.resets.redeem({
			target: { provider: "zai", credentialId: full.credentialId, creditId: `five_hour:${expireAt}` },
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe("reauth_required");
		expect(server.calls.filter(call => call.url.endsWith("/reset/use"))).toHaveLength(0);
	});

	it("redeem refuses unknown credit ids and JWT-less accounts without network calls", async () => {
		const server = zaiServer();
		const { storage, full, legacy } = await storageFixture(server);
		const badId = await storage.resets.redeem({
			target: { provider: "zai", credentialId: full.credentialId, creditId: "anthropic:5h" },
		});
		expect(badId.code).toBe("no_credit");
		const noTokens = await storage.resets.redeem({
			target: { provider: "zai", credentialId: legacy.credentialId, creditId: "week:1" },
		});
		expect(noTokens.code).toBe("missing_tokens");
		expect(server.calls).toHaveLength(0);
	});

	it("claimOpportunity maps a 3301 refusal to not_granted with the server's retry time", async () => {
		const server = zaiServer();
		const nextTry = Date.now() + 10 * 60_000;
		server.opportunityReply = () => ({
			code: 3301,
			msg: "coding plan reset grant not allowed",
			data: { granted: false, next_try_at: nextTry },
		});
		const { storage, full } = await storageFixture(server);
		const outcome = await storage.resets.claimOpportunity({
			target: { provider: "zai", credentialId: full.credentialId },
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.granted).toBe(false);
		expect(outcome.code).toBe("not_granted");
		expect(outcome.nextTryAtMs).toBe(nextTry);
		const claim = server.calls.find(call => call.url.endsWith("/reset/opportunity"));
		expect(claim?.body).toEqual({ idempotency_key: expect.stringMatching(UUID_RE) });
	});

	it("claimOpportunity reports granted, unsupported providers, and missing tokens", async () => {
		const server = zaiServer();
		const { storage, full, legacy } = await storageFixture(server);
		const granted = await storage.resets.claimOpportunity({
			target: { provider: "zai", credentialId: full.credentialId },
		});
		expect(granted).toMatchObject({ ok: true, granted: true, code: "granted", provider: "zai" });
		const unsupported = await storage.resets.claimOpportunity({
			target: { provider: "openai-codex", credentialId: full.credentialId },
		});
		expect(unsupported.code).toBe("unsupported_provider");
		const missing = await storage.resets.claimOpportunity({
			target: { provider: "zai", credentialId: legacy.credentialId },
		});
		expect(missing.code).toBe("missing_tokens");
	});
});

describe("zai usage report resetCredits", () => {
	function usageCtx(offers: unknown, failStatus?: number): UsageFetchContext {
		const fetch: FetchImpl = async input => {
			const url = String(input);
			if (url.includes("/api/v1/coding-plan/reset/status")) {
				return failStatus !== undefined
					? new Response("down", { status: failStatus })
					: Response.json({ code: 0, data: offers });
			}
			if (url.includes("/api/monitor/usage/model-usage")) {
				return Response.json({ success: true, data: {} });
			}
			return Response.json({
				success: true,
				data: {
					limits: [{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: Date.now() + HOUR, unit: 3, number: 5 }],
				},
			});
		};
		return { fetch };
	}

	it("surfaces live banked resets on the usage report when the credential carries the JWTs", async () => {
		const expireAt = Date.now() + 2 * HOUR;
		const report = await zaiUsageProvider.fetchUsage!(
			{
				provider: "zai",
				credential: {
					type: "oauth",
					accessToken: "key.secret",
					zcodeJwt: "zcode-jwt",
					zaiOauthJwt: "maas-jwt",
				},
				signal: undefined,
			},
			usageCtx({ available_five_hour_resets: [{ expire_at: expireAt }], available_week_resets: [] }),
		);
		expect(report?.resetCredits?.availableCount).toBe(1);
		expect(report?.resetCredits?.nextCreditId).toBe(`five_hour:${expireAt}`);
		expect(report?.resetCredits?.credits?.[0]?.clears).toEqual(["zai:tokens:5h"]);
	});

	it("leaves resetCredits unset when the status route fails or is unauthorized, and skips it without JWTs", async () => {
		const withJwt = await zaiUsageProvider.fetchUsage!(
			{
				provider: "zai",
				credential: { type: "oauth", accessToken: "key.secret", zcodeJwt: "zcode-jwt", zaiOauthJwt: "maas-jwt" },
				signal: undefined,
			},
			usageCtx([], 500),
		);
		expect(withJwt?.resetCredits).toBeUndefined();
		// An unauthorized listing degrades the same way: the report never fails.
		const unauthorized = await zaiUsageProvider.fetchUsage!(
			{
				provider: "zai",
				credential: { type: "oauth", accessToken: "key.secret", zcodeJwt: "zcode-jwt", zaiOauthJwt: "maas-jwt" },
				signal: undefined,
			},
			usageCtx([], 401),
		);
		expect(unauthorized?.resetCredits).toBeUndefined();
		const withoutJwt = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: { type: "oauth", accessToken: "key.secret" }, signal: undefined },
			usageCtx([{ expire_at: Date.now() + HOUR }]),
		);
		// Without JWTs the reset route is never asked, so no stale offers appear.
		expect(withoutJwt?.resetCredits).toBeUndefined();
	});
});

describe("zaiMintKeyHook", () => {
	function mintFetch(): FetchImpl {
		return (async (url: string, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			if (path.endsWith("/api/auth/z/login")) {
				return Response.json({ code: 200, data: { access_token: "biz-token" } });
			}
			if (path.endsWith("/getCustomerInfo")) {
				return Response.json({
					code: 200,
					data: {
						organizations: [
							{ organizationId: "org-1", isDefault: true, projects: [{ projectId: "proj-1", isDefault: true }] },
						],
					},
				});
			}
			if (path.endsWith("/api_keys") && init?.method !== "POST") {
				return Response.json([{ name: "oh-my-pi", apiKey: "key-1" }]);
			}
			if (/\/api_keys\/copy\//.test(path)) {
				return Response.json({ code: 200, data: { secretKey: "sec-1" } });
			}
			return Response.json({ code: 404, msg: `unexpected ${path}` });
		}) as unknown as FetchImpl;
	}

	it("banks both login JWTs before replacing access with the minted key", async () => {
		const result = await zaiMintKeyHook(
			{ refresh: "refresh-1", access: "maas-oauth-jwt", expires: 123 },
			{
				provider: "zai",
				phase: "login",
				raw: { code: 0, data: { token: "zcode-jwt-255", zai: { access_token: "maas-oauth-jwt" } } },
				fetch: mintFetch(),
			},
		);
		expect(result.access).toBe("key-1.sec-1");
		// Without the capture the reset JWTs were discarded at this exact step.
		expect(result.zcodeJwt).toBe("zcode-jwt-255");
		expect(result.zaiOauthJwt).toBe("maas-oauth-jwt");
	});

	it("still completes login when the exchange response carries no zcode token", async () => {
		const result = await zaiMintKeyHook(
			{ refresh: "refresh-1", access: "maas-oauth-jwt", expires: 123 },
			{
				provider: "zai",
				phase: "login",
				raw: { code: 0, data: { zai: { access_token: "maas-oauth-jwt" } } },
				fetch: mintFetch(),
			},
		);
		expect(result.access).toBe("key-1.sec-1");
		expect("zcodeJwt" in result).toBe(false);
		expect("zaiOauthJwt" in result).toBe(false);
	});
});
