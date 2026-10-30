import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { OAUTH_REFRESH_SKEW_MS } from "../src/auth/refresh";
import type { ApiKeyResolver } from "../src/auth-retry";
import { RESOLVED_CREDENTIAL_REUSE_MS, streamSimple } from "../src/stream";
import type { Api, DispatchHold, FetchImpl, Model } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

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

function registerRecordingApi(): void {
	registerCustomApi(
		customApi,
		(model, _context, options) => {
			customWire.push(typeof options?.apiKey === "string" ? options.apiKey : undefined);
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
