import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, type ResetCreditTarget } from "@oh-my-pi/pi-ai/auth-storage";
import type { CodexResetCredit } from "@oh-my-pi/pi-ai/usage/openai-codex-reset";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
	const state = {
		credits: [
			{ id: "A", status: "available", expiresAt: "2099-01-03T00:00:00Z" },
			{ id: "B", status: "available", expiresAt: "2099-01-10T00:00:00Z" },
		] as CodexResetCredit[],
		listStatus: 200,
		availableCount: 2,
	};
	const requests: { method: string; path: string; body?: unknown }[] = [];
	const usageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		const path = new URL(request.url).pathname;
		const body: unknown = request.method === "POST" ? await request.json() : undefined;
		requests.push({ method: request.method, path, body });
		if (request.method === "GET" && path.endsWith("/rate-limit-reset-credits")) {
			return Response.json(
				{
					available_count: state.availableCount,
					credits: state.credits.map(credit => ({
						id: credit.id,
						status: credit.status,
						expires_at: credit.expiresAt,
						redeem_started_at: credit.redeemStartedAt,
						redeemed_at: credit.redeemedAt,
					})),
				},
				{ status: state.listStatus },
			);
		}
		if (request.method === "POST" && path.endsWith("/rate-limit-reset-credits/consume")) {
			return Response.json({ code: "reset" });
		}
		throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
	}) as typeof fetch;
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined, usageFetch });
	cleanups.push(() => storage.close());
	await storage.credentials.set("openai-codex", {
		type: "oauth",
		access: "fixture-token",
		refresh: "fixture-refresh",
		expires: Date.now() + 3_600_000,
		accountId: "fixture-account",
	});
	const account = storage.oauth.accounts("openai-codex")[0];
	if (!account) throw new Error("Expected fixture account");
	const target: ResetCreditTarget = { provider: "openai-codex", credentialId: account.credentialId };
	return { storage, target, state, requests };
}

describe("Codex saved reset credit safety", () => {
	it("refuses a disappeared pinned credit without consuming the remaining replacement", async () => {
		const f = await fixture();
		const [initial] = await f.storage.resets.list();
		expect(initial?.credits.map(credit => credit.id)).toEqual(["A", "B"]);
		f.state.credits = f.state.credits.filter(credit => credit.id !== "A");
		f.state.availableCount = 1;
		f.requests.length = 0;
		const outcome = await f.storage.resets.redeem({
			target: { ...f.target, creditId: "A" },
		});
		expect(outcome).toMatchObject({ ok: false, code: "offer_changed", creditId: "A" });
		expect(f.requests.map(request => request.method)).toEqual(["GET"]);
	});

	it("honors a later-expiring explicit pin only after live validation", async () => {
		const f = await fixture();
		const outcome = await f.storage.resets.redeem({
			target: { ...f.target, creditId: "B" },
		});
		expect(outcome).toMatchObject({ ok: true, code: "reset", creditId: "B" });
		expect(f.requests.map(request => request.method)).toEqual(["GET", "POST"]);
		expect(f.requests[1]).toMatchObject({
			path: "/backend-api/wham/rate-limit-reset-credits/consume",
			body: { credit_id: "B", account_id: "fixture-account" },
		});
	});

	it("fetches the live offer and spends the soonest-expiring available credit without a pin", async () => {
		const f = await fixture();
		f.state.credits = [
			{ id: "late", status: "available", expiresAt: "2099-01-10T00:00:00Z" },
			{ id: "soon", status: "available", expiresAt: "2099-01-03T00:00:00Z" },
			{ id: "mid", status: "available", expiresAt: "2099-01-07T00:00:00Z" },
		];
		const outcome = await f.storage.resets.redeem({ target: f.target });
		expect(outcome).toMatchObject({ ok: true, code: "reset", creditId: "soon" });
		expect(f.requests.map(request => request.method)).toEqual(["GET", "POST"]);
		expect(f.requests[1]?.body).toMatchObject({ credit_id: "soon" });
	});

	for (const [reason, changed] of [
		["redeemed", { status: "redeemed" }],
		["expired", { expiresAt: "2000-01-01T00:00:00Z" }],
		["redemption started", { redeemStartedAt: "2099-01-01T00:00:00Z" }],
	] as const) {
		it(`refuses a pinned credit whose live offer is ${reason}`, async () => {
			const f = await fixture();
			Object.assign(f.state.credits[0]!, changed);
			const outcome = await f.storage.resets.redeem({
				target: { ...f.target, creditId: "A" },
			});
			expect(outcome).toMatchObject({ ok: false, code: "offer_changed", creditId: "A" });
			expect(f.requests.map(request => request.method)).toEqual(["GET"]);
		});
	}

	it("spends nothing when live validation fails", async () => {
		const f = await fixture();
		f.state.listStatus = 401;
		const outcome = await f.storage.resets.redeem({
			target: { ...f.target, creditId: "B" },
		});
		expect(outcome).toMatchObject({ ok: false, code: "credit_list_failed" });
		expect(f.requests.map(request => request.method)).toEqual(["GET"]);
	});
});
