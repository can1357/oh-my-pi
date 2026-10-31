/**
 * Shared work (an OAuth refresh, a saved-reset lookup or redemption) is started by one caller and
 * joined by others, so it lives as long as any caller still waits for it, not as long as the caller
 * that started it. The starter leaving, or its owner ending, ends only the starter's wait; the work is
 * cancelled once every caller has left. A held caller starts none: it may only join work in flight.
 *
 * Each case counts requests at a loopback endpoint. Fixtures reach it through the global `fetch`
 * (Bun's native fetch, plain HTTP): the code under test decides whether a request is made, and with
 * which signal, before any transport is chosen. The cases wait real time where nothing observable
 * marks the moment: a caller joining work in flight, a refresh entering its lease wait, and a held
 * caller that must send nothing, which only a span of silence at the endpoint can show.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, type ResetCreditTarget, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";
import { runInRequestHoldScope } from "../src/request-hold";

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	/** Set when the client gave up on the request before it was answered. */
	aborted: boolean;
}

/** A local endpoint that records each request and answers none until released. */
interface Endpoint {
	readonly url: string;
	readonly requests: RecordedRequest[];
	/** Resolves once the endpoint has received `count` requests. */
	received(count: number): Promise<void>;
	/** Answer the requests received so far, and every later one at once. */
	release(): void;
	stop(): void;
}

function endpoint(answer: (request: Request) => Response, gated = true): Endpoint {
	const requests: RecordedRequest[] = [];
	const gate = Promise.withResolvers<void>();
	if (!gated) gate.resolve();
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const recorded: RecordedRequest = {
				method: request.method,
				path: new URL(request.url).pathname,
				aborted: false,
			};
			requests.push(recorded);
			request.signal.addEventListener("abort", () => {
				recorded.aborted = true;
			});
			for (const waiter of waiters.splice(0)) {
				if (requests.length >= waiter.count) waiter.resolve();
				else waiters.push(waiter);
			}
			await gate.promise;
			return answer(request);
		},
	});
	return {
		url: server.url.origin,
		requests,
		received(count) {
			if (requests.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			return promise;
		},
		release: () => gate.resolve(),
		stop: () => server.stop(true),
	};
}

const settle = <T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> =>
	promise.then(
		value => ({ value }),
		(error: unknown) => ({ error }),
	);

const errorName = (outcome: { value: unknown } | { error: unknown }): string | undefined =>
	"error" in outcome && outcome.error instanceof Error ? outcome.error.name : undefined;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function site(answer: (request: Request) => Response, gated = true): Endpoint {
	const created = endpoint(answer, gated);
	cleanups.push(() => created.stop());
	return created;
}

/** A job scope: `hold()` is its owner beginning to dispose, `end()` its owner finishing, aborting `job`. */
function jobScope() {
	const held = new AbortController();
	const ended = new AbortController();
	const job = new AbortController();
	cleanups.push(() => {
		job.abort();
		ended.abort();
	});
	return {
		signal: job.signal,
		run: <T>(fn: () => T): T => runInRequestHoldScope(held.signal, ended.signal, fn),
		hold: () => held.abort(),
		end: () => {
			job.abort();
			ended.abort();
		},
	};
}

const HOUR = 3_600_000;

function claudeResetAnswer(request: Request): Response {
	if (request.method === "POST") return Response.json({ result: "reset", resets_left: 1, cleared: ["five_hour"] });
	return Response.json({
		five_hour: { utilization: 100, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
		seven_day: { utilization: 40, resets_at: new Date(Date.now() + 72 * HOUR).toISOString() },
		cedar_ember: {
			eligible: true,
			at_limit: true,
			exhausted: ["five_hour"],
			next_grant_id: "saved-reset",
			grants: [
				{
					id: "saved-reset",
					label: "Saved session reset",
					resets_total: 2,
					resets_left: 2,
					starts_at: new Date(Date.now() - HOUR).toISOString(),
					ends_at: new Date(Date.now() + 24 * HOUR).toISOString(),
					clears: ["five_hour"],
					paused: false,
					usable_now: true,
					use_requires_limit: true,
					percent_used: { five_hour: 100 },
					blocking: [],
				},
			],
		},
		juniper_tide: { eligible: false, in_experiment: false, available: false, arm: "control" },
	});
}

describe("saved resets", () => {
	let storage: AuthStorage;
	let reset: Endpoint;
	let target: ResetCreditTarget;
	const baseUrlResolver = () => reset.url;
	const usageGets = () => reset.requests.filter(request => request.method === "GET").length;
	const resetPosts = () => reset.requests.filter(request => request.method === "POST").length;

	beforeEach(async () => {
		reset = site(claudeResetAnswer);
		storage = await AuthStorage.create(":memory:", {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageProvider : undefined),
			usageFetch: ((input, init) => fetch(input, init)) as typeof fetch,
		});
		cleanups.push(() => storage.close());
		const credential: OAuthCredential = {
			type: "oauth",
			access: "token-org",
			refresh: "refresh-org",
			expires: Date.now() + HOUR,
			accountId: "account",
			email: "same@example.com",
			orgId: "org-a",
		};
		await storage.credentials.set("anthropic", [credential]);
		const account = storage.oauth.accounts("anthropic")[0];
		if (!account) throw new Error("expected the stored account");
		target = { provider: "anthropic", credentialId: account.credentialId, creditId: "saved-reset" };
	});

	describe("redemption", () => {
		for (const ownerEnds of [false, true]) {
			it(`serves a live joiner when its starter's owner ${ownerEnds ? "ends" : "lives"} before the usage reply`, async () => {
				const starterJob = jobScope();
				const starter = settle(
					starterJob.run(() => storage.resets.redeem({ target, baseUrlResolver, signal: starterJob.signal })),
				);
				await reset.received(1);
				// The starter's owner begins disposing while its redemption waits for the usage reply.
				starterJob.hold();
				const live = storage.resets.redeem({ target, baseUrlResolver });
				// The live caller resolves its account, then joins the redemption in flight.
				await Bun.sleep(100);
				if (ownerEnds) starterJob.end();
				reset.release();

				const liveOutcome = await live;
				const starterOutcome = await starter;
				expect({
					live: liveOutcome.code,
					starter: ownerEnds ? errorName(starterOutcome) : "value" in starterOutcome && starterOutcome.value.code,
					usageGets: usageGets(),
					resetPosts: resetPosts(),
				}).toEqual({ live: "reset", starter: ownerEnds ? "AbortError" : "reset", usageGets: 1, resetPosts: 1 });
			});
		}

		it("is not started by a held caller, which a live caller then starts", async () => {
			const heldJob = jobScope();
			heldJob.hold();
			const held = settle(
				heldJob.run(() => storage.resets.redeem({ target, baseUrlResolver, signal: heldJob.signal })),
			);
			await Bun.sleep(150);
			const sentWhileOnlyHeld = reset.requests.length;
			const live = storage.resets.redeem({ target, baseUrlResolver });
			reset.release();
			const liveOutcome = await live;
			heldJob.end();

			expect({
				sentWhileOnlyHeld,
				live: liveOutcome.code,
				held: errorName(await held),
				usageGets: usageGets(),
				resetPosts: resetPosts(),
			}).toEqual({ sentWhileOnlyHeld: 0, live: "reset", held: "AbortError", usageGets: 1, resetPosts: 1 });
		});

		it("is cancelled, spending nothing, once every caller has left", async () => {
			const first = new AbortController();
			const second = new AbortController();
			const firstOutcome = settle(storage.resets.redeem({ target, baseUrlResolver, signal: first.signal }));
			await reset.received(1);
			const secondOutcome = settle(storage.resets.redeem({ target, baseUrlResolver, signal: second.signal }));
			await Bun.sleep(100);
			first.abort();
			second.abort();
			await Bun.sleep(100);
			reset.release();
			await Bun.sleep(100);

			expect({
				first: errorName(await firstOutcome),
				second: errorName(await secondOutcome),
				usageGetAborted: reset.requests[0]?.aborted,
				resetPosts: resetPosts(),
			}).toEqual({ first: "AbortError", second: "AbortError", usageGetAborted: true, resetPosts: 0 });
		});
	});

	describe("lookup", () => {
		it("serves a live joiner after the caller that started it leaves", async () => {
			const starter = new AbortController();
			const started = settle(
				storage.resets.list({ provider: "anthropic", baseUrlResolver, signal: starter.signal }),
			);
			await reset.received(1);
			const joiner = storage.resets.list({
				provider: "anthropic",
				baseUrlResolver,
				signal: AbortSignal.timeout(5_000),
			});
			starter.abort();
			reset.release();

			const statuses = await joiner;
			expect({
				starter: errorName(await started),
				joiner: statuses.map(status => [status.credentialId, status.nextCreditId]),
				usageGets: usageGets(),
			}).toEqual({ starter: "AbortError", joiner: [[target.credentialId, "saved-reset"]], usageGets: 1 });
		});

		it("is cancelled once every caller has left", async () => {
			const first = new AbortController();
			const second = new AbortController();
			const outcomes = [
				settle(storage.resets.list({ provider: "anthropic", baseUrlResolver, signal: first.signal })),
			];
			await reset.received(1);
			outcomes.push(settle(storage.resets.list({ provider: "anthropic", baseUrlResolver, signal: second.signal })));
			first.abort();
			second.abort();
			await Bun.sleep(100);
			reset.release();
			await Bun.sleep(100);

			expect({
				callers: (await Promise.all(outcomes)).map(errorName),
				usageGetAborted: reset.requests[0]?.aborted,
				usageGets: usageGets(),
			}).toEqual({ callers: ["AbortError", "AbortError"], usageGetAborted: true, usageGets: 1 });
		});

		it("gives each caller its own session's accounts", async () => {
			// A runtime key suppresses OAuth for unrestricted sessions; a session restricted to an account
			// pool still lists its accounts. Neither has an active account, so their lookups share one key.
			storage.keys.setRuntime("anthropic", "sk-runtime-key");
			storage.sessions.restrict("anthropic", "pooled", []);
			const list = (sessionId: string) => storage.resets.list({ provider: "anthropic", baseUrlResolver, sessionId });

			const pooledFirst = await Promise.all([list("pooled"), list("plain")]);
			const plainFirst = await Promise.all([list("plain"), list("pooled")]);

			expect({
				pooledFirst: pooledFirst.map(statuses => statuses.length),
				plainFirst: plainFirst.map(statuses => statuses.length),
			}).toEqual({ pooledFirst: [1, 0], plainFirst: [0, 1] });
		});
	});
});

describe("a saved-reset redemption", () => {
	it("ends at its own bound, however long its callers wait", async () => {
		// A consume that never answers. The redemption's requests go through the injected usage fetch, so
		// no transport is involved: the case is about the signal the redemption gives its request.
		const consumes: AbortSignal[] = [];
		const firstConsume = Promise.withResolvers<void>();
		const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected the redemption to give its request a signal");
			consumes.push(signal);
			firstConsume.resolve();
			return new Promise<Response>((_, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		}) as typeof fetch;
		const storage = await AuthStorage.create(":memory:", { usageFetch: hangingFetch });
		cleanups.push(() => storage.close());
		await storage.credentials.set("openai-codex", [
			{ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + HOUR, accountId: "account" },
		]);
		const account = storage.oauth.accounts("openai-codex")[0];
		if (!account) throw new Error("expected the stored account");
		const target: ResetCreditTarget = {
			provider: "openai-codex",
			credentialId: account.credentialId,
			creditId: "saved-reset",
		};
		const baseUrlResolver = () => "https://reset.invalid";

		jest.useFakeTimers();
		try {
			// Neither caller has a signal of its own, and a Codex consume sets no timeout: only the
			// redemption's own bound can end it.
			const outcomes = [
				settle(storage.resets.redeem({ target, baseUrlResolver })),
				settle(storage.resets.redeem({ target, baseUrlResolver })),
			];
			await firstConsume.promise;
			jest.advanceTimersByTime(44_999);
			const abortedBeforeBound = consumes[0]?.aborted;
			jest.advanceTimersByTime(1);
			const settled = await Promise.all(outcomes);

			expect({
				abortedBeforeBound,
				abortedAtBound: consumes[0]?.aborted,
				consumes: consumes.length,
				outcomes: settled.map(errorName),
			}).toEqual({
				abortedBeforeBound: false,
				abortedAtBound: true,
				consumes: 1,
				outcomes: ["TimeoutError", "TimeoutError"],
			});
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("an OAuth refresh", () => {
	const PROVIDER = "unit-shared-lifetime-refresh";
	const SOURCE = "shared-work-lifetime-test";
	const PEER = "peer-process";
	let storage: AuthStorage;
	let peer: SqliteAuthCredentialStore;
	let token: Endpoint;
	let credentialId: number;
	/** The status the token endpoint answers with. */
	let tokenStatus: number;
	/** Runs once the token endpoint's answer has been read, before the refresh acts on it. */
	let afterTokenAnswer: () => void;
	const tokenPosts = () => token.requests.filter(request => request.path === "/token").length;

	async function storeCredential(expires: number): Promise<void> {
		await storage.credentials.set(PROVIDER, [{ type: "oauth", access: "stale", refresh: "refresh", expires }]);
		const account = storage.oauth.accounts(PROVIDER)[0];
		if (!account) throw new Error("expected the stored account");
		credentialId = account.credentialId;
	}

	/** Another process holds the row's refresh lease, so a refresh waits before its token exchange. */
	function peerHoldsLease(): void {
		if (!peer.tryAcquireCredentialRefreshLease(credentialId, PEER, Date.now() + 10_000)) {
			throw new Error("expected the peer to take the refresh lease");
		}
	}

	beforeEach(async () => {
		tokenStatus = 200;
		afterTokenAnswer = () => {};
		token = site(
			() =>
				tokenStatus === 200
					? Response.json({ access: "fresh-access" })
					: new Response("unavailable", { status: tokenStatus }),
			false,
		);
		registerOAuthProvider({
			id: PROVIDER,
			name: "Shared Lifetime Refresh",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: Date.now() + HOUR };
			},
			async refreshToken(credentials, signal) {
				const response = await fetch(`${token.url}/token`, { method: "POST", body: credentials.refresh, signal });
				afterTokenAnswer();
				if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
				const { access } = (await response.json()) as { access: string };
				return { ...credentials, access, refresh: "next-refresh", expires: Date.now() + HOUR };
			},
			getApiKey: credentials => credentials.access,
		});
		cleanups.push(() => unregisterOAuthProviders(SOURCE));
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-lifetime-"));
		cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
		const dbPath = path.join(dir, "agent.db");
		storage = await AuthStorage.create(dbPath);
		cleanups.push(() => storage.close());
		peer = await SqliteAuthCredentialStore.open(dbPath);
		cleanups.push(() => peer.close());
	});

	it("of an expired token serves a live joiner after the caller that started it leaves", async () => {
		await storeCredential(Date.now() - 1_000);
		peerHoldsLease();
		const starter = new AbortController();
		const started = settle(storage.keys.get(PROVIDER, "starter-session", { signal: starter.signal }));
		await Bun.sleep(100);
		const joiner = storage.keys.get(PROVIDER, "joiner-session", { signal: AbortSignal.timeout(5_000) });
		await Bun.sleep(100);
		starter.abort();
		await started;
		peer.releaseCredentialRefreshLease(credentialId, PEER);

		expect({ joiner: await joiner, tokenPosts: tokenPosts() }).toEqual({ joiner: "fresh-access", tokenPosts: 1 });
	});

	it("of a stored row by id serves a live joiner after the caller that started it leaves", async () => {
		await storeCredential(Date.now() + HOUR);
		peerHoldsLease();
		const starter = new AbortController();
		const started = settle(storage.oauth.refresh(credentialId, starter.signal));
		await Bun.sleep(100);
		const joiner = storage.oauth.refresh(credentialId, AbortSignal.timeout(5_000));
		await Bun.sleep(100);
		starter.abort();
		await started;
		peer.releaseCredentialRefreshLease(credentialId, PEER);

		const { credential } = await joiner;
		expect({
			joiner: credential.type === "oauth" ? credential.access : credential.type,
			tokenPosts: tokenPosts(),
		}).toEqual({ joiner: "fresh-access", tokenPosts: 1 });
	});

	it("is cancelled before its token exchange once every caller has left", async () => {
		await storeCredential(Date.now() + HOUR);
		peerHoldsLease();
		const first = new AbortController();
		const second = new AbortController();
		const outcomes = [settle(storage.oauth.refresh(credentialId, first.signal))];
		await Bun.sleep(100);
		outcomes.push(settle(storage.oauth.refresh(credentialId, second.signal)));
		await Bun.sleep(100);
		first.abort();
		second.abort();
		peer.releaseCredentialRefreshLease(credentialId, PEER);
		await Bun.sleep(400);

		expect({ callers: (await Promise.all(outcomes)).map(errorName), tokenPosts: tokenPosts() }).toEqual({
			callers: ["AbortError", "AbortError"],
			tokenPosts: 0,
		});
	});

	it("of an expired token is not started by a held caller; a live caller starts it", async () => {
		await storeCredential(Date.now() - 1_000);
		const heldJob = jobScope();
		heldJob.hold();
		const held = settle(heldJob.run(() => storage.keys.get(PROVIDER, "held-session", { signal: heldJob.signal })));
		await Bun.sleep(200);
		const sentWhileOnlyHeld = tokenPosts();
		const live = await storage.keys.get(PROVIDER, "live-session");
		heldJob.end();
		const heldOutcome = await held;

		// Refused when its owner ends, the held caller gets no key, as any caller that left does.
		expect({
			sentWhileOnlyHeld,
			live,
			tokenPosts: tokenPosts(),
			heldKey: "value" in heldOutcome ? heldOutcome.value : errorName(heldOutcome),
		}).toEqual({
			sentWhileOnlyHeld: 0,
			live: "fresh-access",
			tokenPosts: 1,
			heldKey: undefined,
		});
	});

	it("refused to a held caller leaves the credential unblocked for a live caller", async () => {
		await storeCredential(Date.now() - 1_000);
		const heldJob = jobScope();
		heldJob.hold();
		// No signal of its own: only the end of its owner's scope refuses it.
		const held = settle(heldJob.run(() => storage.keys.get(PROVIDER, "held-session")));
		await Bun.sleep(100);
		heldJob.end();
		const heldOutcome = await held;
		const blocksAfterRefusal = storage.blocks.list([credentialId]).length;
		const live = await storage.keys.get(PROVIDER, "live-session");

		expect({
			heldKey: "value" in heldOutcome ? heldOutcome.value : errorName(heldOutcome),
			blocksAfterRefusal,
			live,
			tokenPosts: tokenPosts(),
		}).toEqual({
			heldKey: undefined,
			blocksAfterRefusal: 0,
			live: "fresh-access",
			tokenPosts: 1,
		});
	});

	it("that fails for another reason still backs the credential off", async () => {
		tokenStatus = 503;
		await storeCredential(Date.now() - 1_000);
		const failed = await storage.keys.get(PROVIDER, "first-session");

		expect({ failed, blocks: storage.blocks.list([credentialId]).length, tokenPosts: tokenPosts() }).toEqual({
			failed: undefined,
			blocks: 1,
			tokenPosts: 1,
		});
	});

	it("that the provider rate-limited still backs the credential off when its caller left after the answer", async () => {
		// The caller's signal aborts after the provider's 429 was read, before the refresh raises it, so
		// the caller's own wait ends first. The answer is still the provider's: the credential is blocked.
		tokenStatus = 429;
		await storeCredential(Date.now() - 1_000);
		const caller = new AbortController();
		afterTokenAnswer = () => caller.abort();
		const failed = await storage.keys.get(PROVIDER, "first-session", { signal: caller.signal });
		// The caller returned at once; the refresh it left records the provider's answer as it lands.
		for (let tick = 0; tick < 100 && storage.blocks.list([credentialId]).length === 0; tick++) await Bun.sleep(10);

		expect({ failed, blocks: storage.blocks.list([credentialId]).length, tokenPosts: tokenPosts() }).toEqual({
			failed: undefined,
			blocks: 1,
			tokenPosts: 1,
		});
	});

	it("that the provider refused as a dead grant still disables the credential when its caller left after the answer", async () => {
		// A 401 from the token endpoint is a dead grant; the caller's signal aborts after it was read.
		tokenStatus = 401;
		await storeCredential(Date.now() - 1_000);
		const caller = new AbortController();
		afterTokenAnswer = () => caller.abort();
		const failed = await storage.keys.get(PROVIDER, "first-session", { signal: caller.signal });
		for (let tick = 0; tick < 100 && storage.credentials.has(PROVIDER); tick++) await Bun.sleep(10);

		expect({ failed, stillStored: storage.credentials.has(PROVIDER), tokenPosts: tokenPosts() }).toEqual({
			failed: undefined,
			stillStored: false,
			tokenPosts: 1,
		});
	});

	it("whose caller left before the provider answered leaves the credential unblocked (control)", async () => {
		await storeCredential(Date.now() - 1_000);
		peerHoldsLease();
		const caller = new AbortController();
		const pending = settle(storage.keys.get(PROVIDER, "first-session", { signal: caller.signal }));
		await Bun.sleep(100);
		caller.abort();
		await pending;
		// Long enough for a block recorded late, once the abandoned refresh settles, to show.
		await Bun.sleep(150);

		expect({ blocks: storage.blocks.list([credentialId]).length, tokenPosts: tokenPosts() }).toEqual({
			blocks: 0,
			tokenPosts: 0,
		});
	});
});
