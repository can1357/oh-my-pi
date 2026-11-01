import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type AuthGatewayServerHandle, startAuthGateway } from "../src/auth-gateway";
import { buildGatewayApiKeyResolver, resolveGatewayAccount, resolveGatewayApiKey } from "../src/auth-gateway/dispatch";
import type { ResolvedApiKey } from "../src/auth-retry";
import { AuthStorage } from "../src/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/registry/oauth";
import type { OAuthCredentials } from "../src/registry/oauth/types";
import { __providerInFlightForTesting, configureProviderMaxInFlightRequests, streamSimple } from "../src/stream";
import type { FetchImpl } from "../src/types";
import { nextTurn, ProbedGate } from "./helpers/probed-gate";

/**
 * The gateway hands a pi-ai client a resolver seeded with the credential it
 * resolved for the request, and the client asks that resolver again later:
 * each re-sample of a completion that stalled in a thinking loop is a new
 * operation that resolves afresh, and a request that waited before dispatch
 * past the time a resolved key is trusted for (behind a provider's in-flight
 * cap, or a dispatch hold) is resolved again at the chokepoint. The resolver
 * used to answer every such ask with the seed, so a request sent after its
 * token's expiry carried the expired token and only the 401 it drew recovered
 * it. It now asks storage for the session's credential again, which keeps a
 * token with life left and refreshes one without.
 *
 * `omp auth-gateway serve` never applies `providers.maxInFlightRequests`: it
 * reads settings without binding them to effects. The re-sample is the ask it
 * makes; the in-flight cap is the one `omp auth-gateway stdio` adds.
 */

const PROVIDER = "gateway-credential-after-wait";
const SOURCE_ID = "gateway-credential-after-wait-test";
const SESSION = "gateway-credential-after-wait-session";
const MINTED = Date.parse("2026-10-30T10:00:00Z");
/** Life the stored access token has left when the gateway first resolves it. */
const TOKEN_LIFE_MS = 5 * 60_000;
/** A wait longer than the token's life. */
const LONG_WAIT_MS = 10 * 60_000;
/** A wait past the chokepoint's reuse window but well inside the token's life. */
const SHORT_WAIT_MS = 2 * 60_000;

const MODEL = buildModel({
	id: "gateway-model",
	name: "Gateway Model",
	api: "openai-completions",
	provider: PROVIDER,
	baseUrl: "https://llm.example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
});

const COMPLETION_STREAM = completionStream("ok");
/** An answer that repeats itself until the loop guard stops it. */
const LOOPING_STREAM = completionStream("I will check the answer once more now. ".repeat(24));

function completionStream(content: string): string {
	return `${[
		{ id: "chatcmpl-test", choices: [{ index: 0, delta: { content } }] },
		{ id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]
		.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
		.join("")}data: [DONE]\n\n`;
}

function sse(body: string): Response {
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** One inference request as the provider saw it. */
interface WireRequest {
	bearer: string;
	/** Whether the provider found the bearer expired when the request arrived. */
	expired: boolean;
}

/**
 * The provider: it records each request's bearer, refuses the stored token
 * once that token's life is over, and answers anything else with a one-word
 * stream, or with what `first` gives for the first request.
 */
function provider(wire: WireRequest[], first?: () => Promise<Response>): FetchImpl {
	return async (_input, init) => {
		const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
		const expired = bearer === "access-0" && Date.now() >= MINTED + TOKEN_LIFE_MS;
		wire.push({ bearer, expired });
		if (expired) return Response.json({ error: { message: "access token expired" } }, { status: 401 });
		if (wire.length === 1 && first) return first();
		return sse(COMPLETION_STREAM);
	};
}

/** One non-streaming chat completion through the gateway's OpenAI route. */
function chat(gateway: AuthGatewayServerHandle, content: string): Promise<Response> {
	return fetch(`${gateway.url}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: "Bearer gw-token", "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL.id, messages: [{ role: "user", content }], stream: false }),
	});
}

/** Lets the async chains run until `ready` holds. */
async function until(ready: () => boolean): Promise<void> {
	const deadline = Bun.nanoseconds() + 5e9;
	while (!ready() && Bun.nanoseconds() < deadline) await nextTurn();
	expect(ready()).toBe(true);
}

describe("a gateway request that waits past its token's life", () => {
	let storage: AuthStorage;
	let inFlightRoot: string;
	let refreshCalls = 0;

	beforeEach(async () => {
		setSystemTime(new Date(MINTED));
		refreshCalls = 0;
		registerOAuthProvider({
			id: PROVIDER,
			name: "Gateway credential after wait",
			sourceId: SOURCE_ID,
			async login() {
				throw new Error("not used");
			},
			async refreshToken(credentials: OAuthCredentials) {
				refreshCalls += 1;
				return { ...credentials, access: `access-${refreshCalls}`, expires: Date.now() + 60 * 60_000 };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		await storage.credentials.set(PROVIDER, {
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: MINTED + TOKEN_LIFE_MS,
		});
		inFlightRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-credential-after-wait-"));
		__providerInFlightForTesting.setRoot(inFlightRoot);
	});

	afterEach(async () => {
		setSystemTime();
		configureProviderMaxInFlightRequests(undefined);
		__providerInFlightForTesting.setWaitObserver(undefined);
		__providerInFlightForTesting.setRoot(undefined);
		unregisterOAuthProviders(SOURCE_ID);
		storage.close();
		await fs.rm(inFlightRoot, { recursive: true, force: true });
	});

	it("through the chat route: a completion re-sampled after a thinking-loop stall sends a live token", async () => {
		const backoff = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const wire: WireRequest[] = [];
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-token"],
			storage,
			resolveModel: () => MODEL,
			fetch: provider(wire, async () => {
				// The stalled attempt ran past the token's life before the guard stopped it.
				setSystemTime(new Date(MINTED + LONG_WAIT_MS));
				return sse(LOOPING_STREAM);
			}),
			version: "test",
		});
		try {
			const response = await chat(gateway, "loop");

			expect(response.status).toBe(200);
			expect(wire).toEqual([
				{ bearer: "access-0", expired: false },
				{ bearer: "access-1", expired: false },
			]);
			expect(refreshCalls).toBe(1);
		} finally {
			backoff.mockRestore();
			await gateway.close();
		}
	});

	it("through the chat route: a request queued behind the provider's in-flight cap sends a live token", async () => {
		configureProviderMaxInFlightRequests({ [PROVIDER]: 1 });
		const waiting = Promise.withResolvers<void>();
		__providerInFlightForTesting.setWaitObserver(() => waiting.resolve());
		const firstDone = Promise.withResolvers<void>();
		const wire: WireRequest[] = [];
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-token"],
			storage,
			resolveModel: () => MODEL,
			fetch: provider(wire, async () => {
				await firstDone.promise;
				return sse(COMPLETION_STREAM);
			}),
			version: "test",
		});
		try {
			// The first request takes the only slot and stays on the wire.
			const first = chat(gateway, "first");
			await until(() => wire.length === 1);
			// The second resolves its credential at once and queues for the slot.
			const second = chat(gateway, "second");
			await waiting.promise;
			setSystemTime(new Date(MINTED + LONG_WAIT_MS));
			firstDone.resolve();
			const secondResponse = await second;
			await first;

			expect(secondResponse.status).toBe(200);
			expect(wire).toEqual([
				{ bearer: "access-0", expired: false },
				{ bearer: "access-1", expired: false },
			]);
			expect(refreshCalls).toBe(1);
		} finally {
			await gateway.close();
		}
	});

	describe("behind a dispatch hold", () => {
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

		/** Sends one request through `streamSimple` with the gateway's resolver, held past `waitMs`. */
		async function sendAfterHold(
			waitMs: number,
		): Promise<{ wire: WireRequest[]; accounts: string[]; initial: ResolvedApiKey; stopReason: string }> {
			const initial = await resolveGatewayApiKey({ storage }, MODEL, SESSION, new AbortController().signal, "peer");
			if (!("apiKey" in initial)) throw new Error(`expected a credential, got ${initial.message}`);
			const accounts: string[] = [];
			const wire: WireRequest[] = [];
			const gate = new ProbedGate();
			gate.close();
			const result = streamSimple(MODEL, context, {
				apiKey: buildGatewayApiKeyResolver(
					{ storage },
					MODEL,
					SESSION,
					initial,
					new AbortController().signal,
					"openai-completions",
					"peer",
					resolved => accounts.push(resolveGatewayAccount(resolved)),
				),
				beforeDispatch: gate.hold,
				fetch: provider(wire),
			}).result();
			for (let turn = 0; turn < 10; turn++) await nextTurn();
			expect(wire).toEqual([]);
			setSystemTime(new Date(MINTED + waitMs));
			gate.open();
			const message = await result;
			return { wire, accounts, initial, stopReason: message.stopReason };
		}

		it("a hold longer than the token's life sends the token storage refreshed, on the same account", async () => {
			const { wire, accounts, initial, stopReason } = await sendAfterHold(LONG_WAIT_MS);

			expect(wire).toEqual([{ bearer: "access-1", expired: false }]);
			expect(refreshCalls).toBe(1);
			expect(accounts).toEqual([resolveGatewayAccount(initial)]);
			expect(stopReason).toBe("stop");
		});

		it("a hold inside the token's life keeps the token it has", async () => {
			const { wire, accounts, initial, stopReason } = await sendAfterHold(SHORT_WAIT_MS);

			expect(wire).toEqual([{ bearer: "access-0", expired: false }]);
			expect(refreshCalls).toBe(0);
			expect(accounts).toEqual([resolveGatewayAccount(initial)]);
			expect(stopReason).toBe("stop");
		});

		it("when storage cannot answer again, the expired token goes out and its 401 recovers the request", async () => {
			// The first lookup is the gateway's own; the second is the chokepoint's.
			const getWithCredential = storage.keys.getWithCredential.bind(storage.keys);
			let lookups = 0;
			const lookup = spyOn(storage.keys, "getWithCredential").mockImplementation(async (...args) => {
				lookups++;
				if (lookups === 2) throw new Error("credential store unreachable");
				return getWithCredential(...args);
			});
			try {
				const { wire, stopReason } = await sendAfterHold(LONG_WAIT_MS);

				expect(lookups).toBe(3);
				expect(wire).toEqual([
					{ bearer: "access-0", expired: true },
					{ bearer: "access-1", expired: false },
				]);
				expect(stopReason).toBe("stop");
			} finally {
				lookup.mockRestore();
			}
		});
	});
});
