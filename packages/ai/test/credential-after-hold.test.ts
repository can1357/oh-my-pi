import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { OAUTH_REFRESH_SKEW_MS } from "../src/auth/refresh";
import type { OAuthRequestIdentity } from "../src/auth/types";
import type { ApiKeyResolveContext, ApiKeyResolver } from "../src/auth-retry";
import { RESOLVED_CREDENTIAL_REUSE_MS, streamSimple } from "../src/stream";
import type { Api, DispatchHold, FetchImpl, Model } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";
import {
	type CapturedRequest,
	captureFetch,
	completionsChunks,
	factoryModel,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";
import { afterMicrotasks, nextTurn, PROBE_MAX_DEPTH, ProbedGate } from "./helpers/probed-gate";

/**
 * Round 3 of the PR #17399 review (R3-5) found a request authorized before its
 * dispatch hold carrying that authorization through a pause it had outlived.
 * After the providers' own tokens were moved past the hold, the one credential
 * left was the caller's: an `ApiKeyResolver` resolves the key before the
 * request reaches the provider-dispatch chokepoint, so an OAuth access token
 * resolved just before a ten-minute pause still went out after it, and only a
 * 401 and the auth retry recovered. The chokepoint now asks the resolver again
 * when the wait before dispatch has outlived the time a resolved key is
 * trusted for.
 */

const MINTED = new Date("2026-10-30T10:00:00Z");
const PAUSE_MS = 10 * 60_000;
/** Well inside the reuse window: a pause this short re-resolves nothing. */
const SHORT_PAUSE_MS = 5_000;
const SOURCE_ID = "credential-after-hold-test";

const realSetImmediate = globalThis.setImmediate;

/** Lets every pending async chain run to its next I/O wait. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}

/** Lets the async chains run until `ready` holds; a cold provider module load takes real time. */
async function settleUntil(ready: () => boolean): Promise<void> {
	const deadline = Bun.nanoseconds() + 5e9;
	while (!ready() && Bun.nanoseconds() < deadline) await settle();
	expect(ready()).toBe(true);
}

/** `/pause`: closed, its hold parks until reopened, and its probe says so. */
interface PauseGate {
	hold: DispatchHold;
	close(): void;
	open(): void;
}

function pauseGate(): PauseGate {
	let closed = false;
	let reopened = Promise.withResolvers<void>();
	const hold: DispatchHold = () => (closed ? reopened.promise : undefined);
	hold.isClosed = () => closed;
	return {
		hold,
		close() {
			if (closed) return;
			closed = true;
			reopened = Promise.withResolvers<void>();
		},
		open() {
			closed = false;
			reopened.resolve();
		},
	};
}

/** A resolver that mints `key-HHMM` at the fake clock on each ask; the first ask engages `pause`. */
function mintingResolver(pause: PauseGate): { resolver: ApiKeyResolver; minted: string[] } {
	const minted: string[] = [];
	const resolver: ApiKeyResolver = () => {
		const now = new Date();
		const key = `key-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
		minted.push(key);
		if (minted.length === 1) pause.close();
		return key;
	};
	return { resolver, minted };
}

const common = {
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
};

const customApi = "credential-after-hold" as Api;
const customModel = { ...common, id: "custom", name: "Custom", api: customApi, provider: "custom" } as Model<Api>;

/** The key each dispatch to the custom API carried. */
const customWire: (string | undefined)[] = [];
/** The OAuth identity each dispatch to the custom API carried. */
const customIdentities: (OAuthRequestIdentity | undefined)[] = [];

function registerRecordingApi(): void {
	registerCustomApi(
		customApi,
		(model, _context, options) => {
			customWire.push(typeof options?.apiKey === "string" ? options.apiKey : undefined);
			customIdentities.push(options?.oauthIdentity);
			const events = new AssistantMessageEventStream();
			queueMicrotask(() =>
				events.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: 0,
						stopReason: "stop",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				}),
			);
			return events;
		},
		SOURCE_ID,
	);
}

/** Routes whose key reaches an HTTP request, by the path `streamSimple` takes to the chokepoint. */
const HTTP_ROUTES = [
	{
		route: "a mapped provider (OpenAI completions)",
		model: buildModel({
			...common,
			id: "gpt-4o",
			name: "OpenAI",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		}),
	},
	{
		route: "Kimi Code",
		model: buildModel({
			...common,
			id: "kimi-for-coding",
			name: "Kimi",
			api: "openai-completions",
			provider: "kimi-code",
			baseUrl: "https://api.kimi.com/coding/v1",
		}),
	},
	{
		route: "Synthetic",
		model: buildModel({
			...common,
			id: "hf:zai-org/GLM-4.6",
			name: "Synthetic",
			api: "openai-completions",
			provider: "synthetic",
			baseUrl: "https://api.synthetic.new/openai/v1",
		}),
	},
] as const;

/** Records the bearer every inference request carried and answers it with a terminal 400. */
function recordingFetch(wire: (string | null)[]): FetchImpl {
	return async (_input, init) => {
		wire.push(new Headers(init?.headers).get("authorization"));
		return Response.json({ error: { message: "fixture terminal response" } }, { status: 400 });
	};
}

afterEach(() => {
	setSystemTime();
	unregisterCustomApis(SOURCE_ID);
	customWire.length = 0;
	customIdentities.length = 0;
});

describe("the chokepoint re-resolves a caller's key that a pause may have outlived", () => {
	it("trusts a resolved key for half the refresher's skew, leaving the other half for the trip", () => {
		expect(RESOLVED_CREDENTIAL_REUSE_MS).toBe(OAUTH_REFRESH_SKEW_MS / 2);
	});

	it("a custom API: dispatches with a key resolved after a pause longer than the reuse window", async () => {
		registerRecordingApi();
		setSystemTime(MINTED);
		const pause = pauseGate();
		const { resolver, minted } = mintingResolver(pause);
		const result = streamSimple(
			customModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: resolver,
				beforeDispatch: pause.hold,
			},
		).result();

		await settleUntil(() => minted.length > 0);
		await settle();
		expect(customWire).toEqual([]);
		setSystemTime(new Date(MINTED.getTime() + PAUSE_MS));
		pause.open();
		await result;

		expect(minted).toEqual(["key-1000", "key-1010"]);
		expect(customWire).toEqual(["key-1010"]);
	});

	it("a custom API: a short pause re-resolves nothing", async () => {
		registerRecordingApi();
		setSystemTime(MINTED);
		const pause = pauseGate();
		const { resolver, minted } = mintingResolver(pause);
		const result = streamSimple(
			customModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: resolver,
				beforeDispatch: pause.hold,
			},
		).result();

		await settleUntil(() => minted.length > 0);
		await settle();
		setSystemTime(new Date(MINTED.getTime() + SHORT_PAUSE_MS));
		pause.open();
		await result;

		expect(minted).toEqual(["key-1000"]);
		expect(customWire).toEqual(["key-1000"]);
	});

	// The chokepoint's fast path: no hold, no in-flight cap and nothing to
	// re-resolve dispatches in the same call, so a static key costs nothing.
	it("a static key dispatches in the same call that started the request", () => {
		registerRecordingApi();
		const response = streamSimple(
			customModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "static-key",
			},
		);

		expect(customWire).toEqual(["static-key"]);
		void response.result();
	});

	for (const { route, model } of HTTP_ROUTES) {
		it(`${route}: the request carries a key resolved after a pause longer than the reuse window`, async () => {
			setSystemTime(MINTED);
			const pause = pauseGate();
			const { resolver, minted } = mintingResolver(pause);
			const wire: (string | null)[] = [];
			const result = streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					apiKey: resolver,
					beforeDispatch: pause.hold,
					fetch: recordingFetch(wire),
				},
			).result();

			await settleUntil(() => minted.length > 0);
			await settle();
			expect(wire).toEqual([]);
			setSystemTime(new Date(MINTED.getTime() + PAUSE_MS));
			pause.open();
			await result;

			expect(minted).toEqual(["key-1000", "key-1010"]);
			expect(wire).toEqual(["Bearer key-1010"]);
		});
	}

	it("a mapped provider: a short pause re-resolves nothing", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		const { resolver, minted } = mintingResolver(pause);
		const wire: (string | null)[] = [];
		const result = streamSimple(
			HTTP_ROUTES[0].model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: resolver,
				beforeDispatch: pause.hold,
				fetch: recordingFetch(wire),
			},
		).result();

		await settleUntil(() => minted.length > 0);
		await settle();
		setSystemTime(new Date(MINTED.getTime() + SHORT_PAUSE_MS));
		pause.open();
		await result;

		expect(minted).toEqual(["key-1000"]);
		expect(wire).toEqual(["Bearer key-1000"]);
	});
});

/** What one ask of a resolver was for, in the terms of `ApiKeyResolveContext`. */
type AskStep = "resolve" | "refresh" | "rotate";

/** One ask of a resolver: what it was for, the key it gave, and the failed key it was told about. */
interface Ask {
	step: AskStep;
	key: string | undefined;
	previousKey: string | undefined;
}

function stepOf(context: ApiKeyResolveContext): AskStep {
	if (context.error === undefined) return "resolve";
	return context.lastChance ? "rotate" : "refresh";
}

const COMPLETION_STREAM = `${[
	{ id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "ok" } }] },
	{ id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]
	.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
	.join("")}data: [DONE]\n\n`;

/**
 * OpenAI completions that records the key each request carried, refuses the
 * ones `rejects` names with a 401, and answers the rest with a one-word stream.
 */
function authCheckingFetch(wire: string[], rejects: (key: string) => boolean): FetchImpl {
	return async (_input, init) => {
		const key = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
		wire.push(key);
		if (rejects(key)) return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
		return new Response(COMPLETION_STREAM, { headers: { "content-type": "text/event-stream" } });
	};
}

/**
 * Round 4 of the PR #17399 review found the auth-retry driver counting every
 * key it resolved as one the provider had refused (R4-5), and the chokepoint
 * dropping a refreshed OAuth identity whenever the bearer and the credential
 * row stayed the same (R4-6). A key a refresh replaced before dispatch never
 * reached the provider, so a retry must not reject it as a cycle; a key that
 * did reach it and was refused still must not be sent again.
 */
describe("after a hold, the retry driver and the provider see the credential the request sent", () => {
	const openai = HTTP_ROUTES[0].model;
	const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

	it("a key a refresh replaced before dispatch was never sent, so the auth retry may send it", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		const asks: Ask[] = [];
		const wire: string[] = [];
		const resolver: ApiKeyResolver = ctx => {
			const step = stepOf(ctx);
			let key: string | undefined;
			if (step === "resolve") {
				key = asks.length === 0 ? "valid-A" : "invalid-B";
				if (asks.length === 0) pause.close();
			} else if (step === "refresh") {
				key = "valid-A";
			}
			asks.push({ step, key, previousKey: ctx.previousKey });
			return key;
		};
		const result = streamSimple(openai, context, {
			apiKey: resolver,
			beforeDispatch: pause.hold,
			fetch: authCheckingFetch(wire, key => key === "invalid-B"),
		}).result();

		await settleUntil(() => asks.length > 0);
		await settle();
		setSystemTime(new Date(MINTED.getTime() + PAUSE_MS));
		pause.open();
		const message = await result;

		expect(asks).toEqual([
			{ step: "resolve", key: "valid-A", previousKey: undefined },
			{ step: "resolve", key: "invalid-B", previousKey: undefined },
			{ step: "refresh", key: "valid-A", previousKey: "invalid-B" },
		]);
		expect(wire).toEqual(["invalid-B", "valid-A"]);
		expect(message.stopReason).toBe("stop");
	});

	it("a key the provider refused is still never sent again", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		const asks: Ask[] = [];
		const wire: string[] = [];
		const resolver: ApiKeyResolver = ctx => {
			const step = stepOf(ctx);
			const key = asks.length === 0 ? "valid-A" : "invalid-B";
			if (asks.length === 0) pause.close();
			asks.push({ step, key, previousKey: ctx.previousKey });
			return key;
		};
		const result = streamSimple(openai, context, {
			apiKey: resolver,
			beforeDispatch: pause.hold,
			fetch: authCheckingFetch(wire, key => key === "invalid-B"),
		}).result();

		await settleUntil(() => asks.length > 0);
		await settle();
		setSystemTime(new Date(MINTED.getTime() + PAUSE_MS));
		pause.open();
		const message = await result;

		expect(asks).toEqual([
			{ step: "resolve", key: "valid-A", previousKey: undefined },
			{ step: "resolve", key: "invalid-B", previousKey: undefined },
			{ step: "refresh", key: "invalid-B", previousKey: "invalid-B" },
			{ step: "rotate", key: "invalid-B", previousKey: "invalid-B" },
		]);
		expect(wire).toEqual(["invalid-B"]);
		expect(message.stopReason).toBe("error");
	});

	it("a retry key a refresh replaced before dispatch was never sent either", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		const asks: Ask[] = [];
		const wire: string[] = [];
		const resolver: ApiKeyResolver = ctx => {
			const step = stepOf(ctx);
			const key = step === "resolve" ? (asks.length === 0 ? "k1" : "k3") : "k2";
			// The pause engages as the first 401's refresh answers, so the retry
			// waits it out and its key is replaced before it is sent.
			if (step === "refresh") pause.close();
			asks.push({ step, key, previousKey: ctx.previousKey });
			return key;
		};
		const result = streamSimple(openai, context, {
			apiKey: resolver,
			beforeDispatch: pause.hold,
			fetch: authCheckingFetch(wire, key => key === "k1" || key === "k3"),
		}).result();

		await settleUntil(() => asks.some(ask => ask.step === "refresh"));
		await settle();
		expect(wire).toEqual(["k1"]);
		setSystemTime(new Date(MINTED.getTime() + PAUSE_MS));
		pause.open();
		const message = await result;

		expect(asks).toEqual([
			{ step: "resolve", key: "k1", previousKey: undefined },
			{ step: "refresh", key: "k2", previousKey: "k1" },
			{ step: "resolve", key: "k3", previousKey: undefined },
			{ step: "rotate", key: "k2", previousKey: "k3" },
		]);
		expect(wire).toEqual(["k1", "k3", "k2"]);
		expect(message.stopReason).toBe("stop");
	});

	it("a pause landing anywhere between the hold's answer and the send leaves only the sent key counted", async () => {
		let caught = 0;
		for (let depth = 1; depth <= PROBE_MAX_DEPTH; depth++) {
			let now = MINTED.getTime();
			setSystemTime(new Date(now));
			const gate = new ProbedGate();
			const minted: string[] = [];
			const asks: Ask[] = [];
			const wire: string[] = [];
			const resolver: ApiKeyResolver = ctx => {
				const step = stepOf(ctx);
				let key: string | undefined;
				if (step === "resolve") {
					key = `k${minted.length + 1}`;
					minted.push(key);
					if (minted.length === 1) gate.close();
				} else if (step === "refresh") {
					// The key the last refresh replaced before dispatch.
					key = minted.at(-2);
				}
				asks.push({ step, key, previousKey: ctx.previousKey });
				return key;
			};
			let settled = false;
			const result = streamSimple(openai, context, {
				apiKey: resolver,
				beforeDispatch: gate.hold,
				// The first request is refused; any later one is answered.
				fetch: authCheckingFetch(wire, () => wire.length === 1),
			})
				.result()
				.finally(() => {
					settled = true;
				});

			// Resume as a human would; the first resume pauses again `depth`
			// microtasks later, and every wait that catches the request unsent
			// outlives the key it carries.
			let pauseAgain = true;
			while (!settled) {
				await nextTurn();
				if (!gate.closed) continue;
				if (wire.length === 0) {
					now += PAUSE_MS;
					setSystemTime(new Date(now));
				}
				gate.open();
				if (pauseAgain) {
					pauseAgain = false;
					afterMicrotasks(depth, () => gate.close());
				}
			}
			const message = await result;

			const sent = minted.at(-1)!;
			const replaced = minted.at(-2)!;
			expect({ depth, wire, retry: asks.at(-1), stopReason: message.stopReason }).toEqual({
				depth,
				wire: [sent, replaced],
				retry: { step: "refresh", key: replaced, previousKey: sent },
				stopReason: "stop",
			});
			if (minted.length === 3) caught++;
		}
		// Some depths must land before the send, or the sweep never re-resolved.
		expect(caught).toBeGreaterThan(0);
	});

	it("a custom API: a refresh that keeps the bearer and the row dispatches its new OAuth identity", async () => {
		registerRecordingApi();
		setSystemTime(MINTED);
		const pause = pauseGate();
		let calls = 0;
		const result = streamSimple(customModel, context, {
			apiKey: () => {
				calls++;
				if (calls === 1) pause.close();
				return {
					apiKey: "same-bearer",
					credentialId: 7,
					oauthIdentity: { orgId: calls === 1 ? "old-org" : "new-org" },
				};
			},
			beforeDispatch: pause.hold,
		}).result();

		await settleUntil(() => calls > 0);
		await settle();
		setSystemTime(new Date(MINTED.getTime() + PAUSE_MS));
		pause.open();
		const message = await result;

		expect(calls).toBe(2);
		expect(customWire).toEqual(["same-bearer"]);
		expect(customIdentities).toEqual([{ orgId: "new-org" }]);
		expect(message.credentialId).toBe(7);
	});

	it("Factory: a refresh that keeps the bearer and the row sends the new organization, host and upstream", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		const model = factoryModel("kimi-k3");
		model.factoryDroidApiProviders = ["fireworks", "baseten"];
		const captured: CapturedRequest[] = [];
		let calls = 0;
		const result = streamSimple(model, context, {
			apiKey: () => {
				calls++;
				if (calls === 1) pause.close();
				return {
					apiKey: WORKOS_TOKEN,
					credentialId: 7,
					oauthIdentity:
						calls === 1
							? { orgId: "org-global", region: "global", inferenceRegion: "global" }
							: { orgId: "org-eu", region: "eu", inferenceRegion: "us" },
				};
			},
			beforeDispatch: pause.hold,
			fetch: captureFetch(captured, completionsChunks("OK", model.id)),
		}).result();

		await settleUntil(() => calls > 0);
		await settle();
		setSystemTime(new Date(MINTED.getTime() + PAUSE_MS));
		pause.open();
		const message = await result;

		expect(calls).toBe(2);
		expect(message.stopReason).toBe("stop");
		expect(
			captured.map(request => [
				request.url,
				request.headers["x-factory-org-id"],
				request.headers["x-api-provider"],
				request.headers.authorization,
			]),
		).toEqual([
			["https://api.eu.factory.ai/api/llm/o/v1/chat/completions", "org-eu", "baseten", `Bearer ${WORKOS_TOKEN}`],
		]);
	});
});
