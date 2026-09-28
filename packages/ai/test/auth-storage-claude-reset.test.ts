import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, type OAuthCredential, type ResetCreditTarget } from "@oh-my-pi/pi-ai/auth-storage";
import { isRecord } from "@oh-my-pi/pi-ai/utils";

interface ResetPost {
	path: string;
	body: Record<string, unknown>;
	bearer: string | null;
}

interface ResetFixture {
	storage: AuthStorage;
	target: ResetCreditTarget;
	posts: ResetPost[];
	baseUrlResolver: () => string;
	usageRequests: string[];
	state: {
		program: "cedar_ember" | "juniper_tide";
		nextGrant: string;
		usable: boolean;
		remaining: number;
		weeklyUsed: number;
		discoveryStatus?: number;
		genericUsageEnabled?: boolean;
		response: unknown;
		responseStatus: number;
		postGate?: Promise<void>;
		postArrived?: () => void;
		usageGate?: Promise<void>;
		usageArrived?: () => void;
	};
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(): Promise<ResetFixture> {
	const state: ResetFixture["state"] = {
		program: "cedar_ember",
		nextGrant: "saved-reset",
		usable: true,
		remaining: 2,
		weeklyUsed: 40,
		response: { result: "reset", resets_left: 1, cleared: ["five_hour"] },
		responseStatus: 200,
	};
	const posts: ResetPost[] = [];
	const usageRequests: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname.endsWith("/reset_rate_limits")) {
				const body: unknown = await request.json();
				if (!isRecord(body)) return new Response("invalid body", { status: 400 });
				posts.push({ path: url.pathname, body, bearer: request.headers.get("authorization") });
				state.postArrived?.();
				await state.postGate;
				return Response.json(state.response, { status: state.responseStatus });
			}
			if (url.pathname === "/api/oauth/usage") {
				usageRequests.push(url.search);
				state.usageArrived?.();
				await state.usageGate;
				// The incident's generic broker usage path is unavailable; live reset discovery still answers.
				if (!url.search && !state.genericUsageEnabled) return new Response("usage throttled", { status: 429 });
				if (url.search && state.discoveryStatus) {
					return new Response("discovery throttled", {
						status: state.discoveryStatus,
						headers: { "retry-after": "7" },
					});
				}
				const hour = 3_600_000;
				return Response.json({
					five_hour: { utilization: 100, resets_at: new Date(Date.now() + 2 * hour).toISOString() },
					seven_day: { utilization: state.weeklyUsed, resets_at: new Date(Date.now() + 72 * hour).toISOString() },
					limits: [
						{
							kind: "weekly_scoped",
							percent: 100,
							resets_at: new Date(Date.now() + 72 * hour).toISOString(),
							scope: { model: { display_name: "Fable" } },
						},
					],
					cedar_ember: {
						eligible: state.program === "cedar_ember",
						at_limit: true,
						exhausted: ["five_hour"],
						next_grant_id: state.program === "cedar_ember" && state.usable ? state.nextGrant : null,
						grants:
							state.program === "cedar_ember"
								? [
										{
											id: state.nextGrant,
											label: "Saved session reset",
											resets_total: 2,
											resets_left: state.remaining,
											starts_at: new Date(Date.now() - hour).toISOString(),
											ends_at: new Date(Date.now() + 24 * hour).toISOString(),
											clears: ["five_hour"],
											paused: false,
											usable_now: state.usable,
											use_requires_limit: true,
											percent_used: { five_hour: 100 },
											blocking: [],
										},
									]
								: [],
					},
					juniper_tide: {
						eligible: state.program === "juniper_tide",
						in_experiment: state.program === "juniper_tide",
						available: state.usable && state.remaining > 0,
						arm: state.program === "juniper_tide" ? "reset" : "control",
					},
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	cleanups.push(() => server.stop(true));
	const storage = await AuthStorage.create(":memory:");
	cleanups.push(() => storage.close());
	const credentials: OAuthCredential[] = ["org-a", "org-b"].map(orgId => ({
		type: "oauth",
		access: `token-${orgId}`,
		refresh: `refresh-${orgId}`,
		expires: Date.now() + 3_600_000,
		accountId: "shared-account",
		email: "same@example.com",
		orgId,
	}));
	await storage.credentials.set("anthropic", credentials);
	const account = storage.oauth.accounts("anthropic").find(row => row.orgId === "org-b");
	if (!account) throw new Error("Expected independently stored organization credential");
	return {
		storage,
		posts,
		state,
		usageRequests,
		target: { provider: "anthropic", credentialId: account.credentialId, creditId: "saved-reset" },
		baseUrlResolver: () => server.url.origin,
	};
}

describe("Claude saved reset account safety", () => {
	it("spends only the selected durable credential when both organizations share an email", async () => {
		const f = await fixture();
		const statuses = await f.storage.resets.list({ provider: "anthropic", baseUrlResolver: f.baseUrlResolver });
		expect(new Set(statuses.map(status => status.credentialId)).size).toBe(2);
		const outcome = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(outcome.ok).toBe(true);
		expect(f.posts.map(post => [post.path, post.bearer])).toEqual([
			["/api/organizations/org-b/reset_rate_limits", "Bearer token-org-b"],
		]);
		const removed = await f.storage.resets.redeem({
			target: { ...f.target, credentialId: -1, email: "same@example.com" },
			baseUrlResolver: f.baseUrlResolver,
		});
		expect(removed.code).toBe("no_account");
		expect(f.posts.length).toBe(1);
	});

	it("lists exact account quota evidence without a second generic usage request", async () => {
		const f = await fixture();
		const statuses = await f.storage.resets.list({ provider: "anthropic", baseUrlResolver: f.baseUrlResolver });
		for (const status of statuses) {
			expect(status.report?.metadata).toMatchObject({
				accountId: "shared-account",
				email: "same@example.com",
				orgId: status.orgId,
			});
			expect(status.report?.limits.map(limit => [limit.id, limit.amount?.usedFraction])).toEqual([
				["anthropic:5h", 1],
				["anthropic:7d", 0.4],
				["anthropic:7d:fable", 1],
			]);
			expect(Date.now() - (status.report?.fetchedAt ?? 0)).toBeLessThan(5_000);
		}
		expect(f.usageRequests).toEqual(["?cedar_ember=1&skip_spend=1", "?cedar_ember=1&skip_spend=1"]);
	});

	it("coalesces live discovery while one caller aborts without cancelling its peer", async () => {
		const f = await fixture();
		const arrived = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.state.usageArrived = arrived.resolve;
		f.state.usageGate = release.promise;
		const controller = new AbortController();
		const options = { provider: "anthropic", baseUrlResolver: f.baseUrlResolver };
		const cancelled = f.storage.resets.list({ ...options, sessionId: "first-task", signal: controller.signal }).then(
			() => false,
			() => true,
		);
		await arrived.promise;
		const surviving = f.storage.resets.list({
			...options,
			sessionId: "second-task",
			signal: AbortSignal.timeout(5_000),
		});
		controller.abort();
		expect(await cancelled).toBe(true);
		release.resolve();
		const statuses = await surviving;
		expect(statuses.map(status => status.report?.metadata?.orgId).sort()).toEqual(["org-a", "org-b"]);
		expect(f.usageRequests).toEqual(["?cedar_ember=1&skip_spend=1", "?cedar_ember=1&skip_spend=1"]);
	});

	it("returns provider throttle timing without spending or retrying discovery", async () => {
		const f = await fixture();
		f.state.discoveryStatus = 429;
		const statuses = await f.storage.resets.list({ provider: "anthropic", baseUrlResolver: f.baseUrlResolver });
		expect(statuses.map(status => status.retryAfterMs)).toEqual([7_000, 7_000]);
		expect(statuses.every(status => status.error !== undefined)).toBe(true);
		expect(f.usageRequests).toEqual(["?cedar_ember=1&skip_spend=1", "?cedar_ember=1&skip_spend=1"]);
		expect(f.posts).toEqual([]);
	});

	it("allows fresh usage after a confirmed reset despite an earlier failed usage probe", async () => {
		const f = await fixture();
		await f.storage.usage.reports({ baseUrlResolver: f.baseUrlResolver });
		expect(f.usageRequests).toContain("");
		const outcome = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(outcome.ok).toBe(true);
		f.state.genericUsageEnabled = true;
		const reports = await f.storage.usage.reports({ baseUrlResolver: f.baseUrlResolver });
		expect(reports?.some(report => report.metadata?.orgId === "org-b")).toBe(true);
	});

	it("does not spend a new offer under an old confirmation", async () => {
		const f = await fixture();
		f.state.nextGrant = "new-offer";
		const outcome = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(outcome.code).toBe("offer_changed");
		expect(f.posts).toEqual([]);
	});

	it("retains the request ID after an indeterminate response so a multi-use grant cannot double-spend", async () => {
		const f = await fixture();
		f.state.responseStatus = 502;
		f.state.response = { error: "upstream response lost" };
		const first = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(first.ok).toBe(false);
		f.state.responseStatus = 200;
		f.state.response = { result: "cooldown" };
		const waiting = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(waiting.code).toBe("cooldown");
		f.state.response = { result: "reset", resets_left: 1, cleared: ["five_hour"] };
		const retry = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(retry.ok).toBe(true);
		expect(f.posts).toHaveLength(3);
		const requestId = f.posts[0]?.body.request_id;
		expect(typeof requestId).toBe("string");
		expect(f.posts.map(post => post.body.request_id)).toEqual([requestId, requestId, requestId]);
	});

	it("does not spend again when a lost response is reconciled by the grant's lower balance", async () => {
		const f = await fixture();
		f.state.responseStatus = 502;
		f.state.response = { error: "upstream response lost" };
		await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		f.state.remaining = 1;
		const retry = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(retry.code).toBe("already_redeemed");
		expect(f.posts).toHaveLength(1);
	});

	it("spends a new grant once the lost response's grant has left the live offer", async () => {
		const f = await fixture();
		f.state.responseStatus = 502;
		f.state.response = { error: "upstream response lost" };
		await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		// The lost claim consumed its grant; the account later hit a wall again with a new one.
		f.state.nextGrant = "next-grant";
		f.state.responseStatus = 200;
		f.state.response = { result: "reset", resets_left: 1, cleared: ["five_hour"] };
		const retry = await f.storage.resets.redeem({
			target: { ...f.target, creditId: "next-grant" },
			baseUrlResolver: f.baseUrlResolver,
		});
		expect(retry.code).toBe("reset");
		expect(f.posts).toHaveLength(2);
		expect(f.posts[1]?.body.request_id).not.toBe(f.posts[0]?.body.request_id);
	});

	it("does not retry an uncertain Juniper spend without an idempotency key", async () => {
		const f = await fixture();
		f.state.program = "juniper_tide";
		f.target.creditId = "juniper_tide";
		f.state.responseStatus = 502;
		f.state.response = { error: "upstream response lost" };
		const first = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(first.ok).toBe(false);
		const retry = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(retry.code).toBe("reset_unconfirmed");
		expect(f.posts).toHaveLength(1);
		expect(f.posts[0]?.body).toEqual({ program: "juniper_tide" });
	});

	it("coalesces simultaneous manual and automatic attempts into one spend", async () => {
		const f = await fixture();
		const arrived = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.state.postArrived = arrived.resolve;
		f.state.postGate = release.promise;
		const options = { target: f.target, baseUrlResolver: f.baseUrlResolver };
		const first = f.storage.resets.redeem(options);
		await arrived.promise;
		const second = f.storage.resets.redeem(options);
		release.resolve();
		const outcomes = await Promise.all([first, second]);
		expect(outcomes.map(outcome => outcome.code)).toEqual(["reset", "reset"]);
		expect(f.posts).toHaveLength(1);
	});

	it("clears the restored shared block but retains an exhausted uncovered model tier", async () => {
		const f = await fixture();
		for (const blockScope of ["", "tier:fable", "auth", "account-policy"]) {
			f.storage.blocks.upsert({
				credentialId: f.target.credentialId,
				providerKey: "anthropic:oauth",
				blockScope,
				blockedUntilMs: Date.now() + 3_600_000,
			});
		}
		const outcome = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(outcome.ok).toBe(true);
		expect(
			f.storage.blocks
				.list([f.target.credentialId])
				.map(block => block.blockScope)
				.sort(),
		).toEqual(["account-policy", "auth", "tier:fable"]);
		expect(f.usageRequests).toEqual(["?cedar_ember=1&skip_spend=1"]);
	});

	it("preserves an uncovered tier wall even when only a legacy global block existed", async () => {
		const f = await fixture();
		f.storage.blocks.upsert({
			credentialId: f.target.credentialId,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 3_600_000,
		});
		const outcome = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(outcome.ok).toBe(true);
		expect(f.storage.blocks.list([f.target.credentialId]).map(block => block.blockScope)).toEqual(["tier:fable"]);
	});

	it("retains a shared block when a session reset leaves the weekly quota exhausted", async () => {
		const f = await fixture();
		f.state.weeklyUsed = 100;
		f.storage.blocks.upsert({
			credentialId: f.target.credentialId,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 3_600_000,
		});
		const outcome = await f.storage.resets.redeem({ target: f.target, baseUrlResolver: f.baseUrlResolver });
		expect(outcome.ok).toBe(true);
		expect(f.storage.blocks.list([f.target.credentialId]).map(block => block.blockScope)).toEqual([""]);
	});
});
