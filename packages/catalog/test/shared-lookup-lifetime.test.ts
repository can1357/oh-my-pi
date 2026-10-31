/**
 * Catalog lookups shared by concurrent callers (the Antigravity client version, the models.dev catalog,
 * Ollama model metadata) are never started by a held caller (its owner began disposing): it may only
 * join a lookup already in flight. The Antigravity version lookup also runs on the transport its own
 * callers asked for, lives as long as any caller still waits for it, and is cancelled once every caller
 * has left, without that cancellation counting as a failed lookup.
 *
 * Fixtures reach loopback endpoints through the global `fetch` (Bun's native fetch, plain HTTP). Every
 * Antigravity manifest answer fails, so the process-wide discovered version stays unset for other
 * tests. The cases wait real time where nothing observable marks the moment: a caller joining a lookup
 * in flight, and a held caller that must send nothing, which only a span of silence can show.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runInRequestHoldScope } from "@oh-my-pi/pi-ai/request-hold";
import { fetchWellKnownModels, ollamaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { __resetAntigravityVersionForTests, ensureAntigravityVersion } from "@oh-my-pi/pi-catalog/wire/gemini-headers";

interface RecordedRequest {
	readonly path: string;
	/** Set when the client gave up on the request before it was answered. */
	aborted: boolean;
}

/** A local endpoint that records each request and answers none it gates until released. */
interface Endpoint {
	readonly requests: RecordedRequest[];
	received(count: number): Promise<void>;
	release(): void;
	/**
	 * A new fetch (a distinct transport) that sends every request here, keeping its path, and calls
	 * `onResponse` once a response has arrived, before handing it back.
	 */
	fetch(onResponse?: (pathname: string) => void): FetchImpl;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function endpoint(
	answer: (request: Request, body: string) => Response,
	gated: (pathname: string) => boolean = () => true,
): Endpoint {
	const requests: RecordedRequest[] = [];
	const gate = Promise.withResolvers<void>();
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = await request.text();
			const recorded: RecordedRequest = { path: new URL(request.url).pathname, aborted: false };
			requests.push(recorded);
			request.signal.addEventListener("abort", () => {
				recorded.aborted = true;
			});
			for (const waiter of waiters.splice(0)) {
				if (requests.length >= waiter.count) waiter.resolve();
				else waiters.push(waiter);
			}
			if (gated(recorded.path)) await gate.promise;
			return answer(request, body);
		},
	});
	cleanups.push(() => server.stop(true));
	return {
		requests,
		received(count) {
			if (requests.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			return promise;
		},
		release: () => gate.resolve(),
		fetch: (onResponse = () => {}) =>
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
					const response = await fetch(`${server.url.origin}${pathname}`, init);
					onResponse(pathname);
					return response;
				},
				{ preconnect: fetch.preconnect },
			),
	};
}

/** A hold scope whose owner began disposing once `hold()` runs; `end()` is that owner finishing. */
function jobScope() {
	const held = new AbortController();
	const ended = new AbortController();
	cleanups.push(() => ended.abort());
	return {
		run: <T>(fn: () => T): T => runInRequestHoldScope(held.signal, ended.signal, fn),
		hold: () => held.abort(),
		end: () => ended.abort(),
	};
}

const unavailable = () => new Response("unavailable", { status: 503 });

describe("the Antigravity client version lookup", () => {
	const saved = process.env.PI_AI_ANTIGRAVITY_VERSION;
	beforeEach(() => {
		// Another file's successful lookup must not skip these.
		__resetAntigravityVersionForTests();
		delete process.env.PI_AI_ANTIGRAVITY_VERSION;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		else process.env.PI_AI_ANTIGRAVITY_VERSION = saved;
	});

	it("runs on each caller's own fetch", async () => {
		const first = endpoint(unavailable);
		const second = endpoint(unavailable);
		const firstCaller = ensureAntigravityVersion(first.fetch());
		await first.received(1);
		const secondCaller = ensureAntigravityVersion(second.fetch());
		await Bun.sleep(100);
		first.release();
		second.release();
		await Promise.all([firstCaller, secondCaller]);

		expect({ first: first.requests.length, second: second.requests.length }).toEqual({ first: 1, second: 1 });
	});

	it("that failed through one fetch does not suppress a lookup through another", async () => {
		const failing = endpoint(unavailable, () => false);
		const other = endpoint(unavailable, () => false);
		await ensureAntigravityVersion(failing.fetch());
		await ensureAntigravityVersion(other.fetch());

		expect({ failing: failing.requests.length, other: other.requests.length }).toEqual({ failing: 1, other: 1 });
	});

	it("is cancelled once every caller has left, and a later caller looks up again", async () => {
		const site = endpoint(unavailable);
		const fetcher = site.fetch();
		const first = new AbortController();
		const second = new AbortController();
		const callers = [ensureAntigravityVersion(fetcher, first.signal)];
		await site.received(1);
		callers.push(ensureAntigravityVersion(fetcher, second.signal));
		first.abort();
		second.abort();
		await Promise.all(callers);
		await Bun.sleep(100);
		const abortedWhenLeft = site.requests[0]?.aborted;
		site.release();
		await ensureAntigravityVersion(fetcher);

		expect({ abortedWhenLeft, requests: site.requests.length }).toEqual({ abortedWhenLeft: true, requests: 2 });
	});

	it("is not started by a held caller, which a live caller then starts", async () => {
		const site = endpoint(unavailable);
		const fetcher = site.fetch();
		const job = jobScope();
		job.hold();
		const held = job.run(() => ensureAntigravityVersion(fetcher)).then(() => "settled");
		await Bun.sleep(150);
		const sentWhileOnlyHeld = site.requests.length;
		const live = ensureAntigravityVersion(fetcher);
		site.release();
		await live;

		expect({ sentWhileOnlyHeld, held: await held, requests: site.requests.length }).toEqual({
			sentWhileOnlyHeld: 0,
			held: "settled",
			requests: 1,
		});
	});
});

describe("the models.dev catalog", () => {
	it("is not started by a held caller, which a live caller then starts", async () => {
		const site = endpoint(() => Response.json({ source: "live" }, { headers: { etag: '"live"' } }));
		const fetcher = site.fetch();
		const job = jobScope();
		job.hold();
		const held = job.run(() => fetchWellKnownModels(fetcher));
		await Bun.sleep(150);
		const sentWhileOnlyHeld = site.requests.length;
		const live = fetchWellKnownModels(fetcher);
		site.release();
		const liveCatalog = await live;
		job.end();

		// Refused when its owner ends, the held caller falls back to the payload the live lookup cached, as
		// any caller does when a lookup fails; it sent nothing itself.
		expect({ sentWhileOnlyHeld, live: liveCatalog, held: await held, requests: site.requests.length }).toEqual({
			sentWhileOnlyHeld: 0,
			live: { source: "live" },
			held: { source: "live" },
			requests: 1,
		});
	});
});

describe("Ollama model metadata", () => {
	it("is not started by a held caller, which a live caller then starts", async () => {
		// Each caller's own model listing is answered at once; the shared metadata lookup waits.
		const site = endpoint(
			(request, body) => {
				if (new URL(request.url).pathname === "/v1/models") {
					return Response.json({ object: "list", data: [{ id: "mystery:1b", object: "model" }] });
				}
				const { model } = JSON.parse(body) as { model?: string };
				return Response.json(model === "mystery:1b" ? { model_info: { "llama.context_length": 4096 } } : {});
			},
			pathname => pathname === "/api/show",
		);
		const job = jobScope();
		// The held job's listing is its own request and is answered; its owner begins disposing before the
		// metadata lookup would start.
		let listings = 0;
		const options = ollamaModelManagerOptions({
			fetch: site.fetch(pathname => {
				if (pathname === "/v1/models" && ++listings === 1) job.hold();
			}),
		});
		const metadataLookups = () => site.requests.filter(request => request.path === "/api/show").length;
		const held = job
			.run(() => options.fetchDynamicModels!())
			.then(
				() => "answered",
				(error: unknown) => (error instanceof Error ? error.name : "refused"),
			);
		await Bun.sleep(150);
		const sentWhileOnlyHeld = metadataLookups();
		const live = options.fetchDynamicModels!();
		await Bun.sleep(50);
		site.release();
		const liveModels = await live;
		job.end();

		expect({
			sentWhileOnlyHeld,
			live: liveModels?.find(model => model.id === "mystery:1b")?.contextWindow,
			held: await held,
			metadataLookups: metadataLookups(),
		}).toEqual({ sentWhileOnlyHeld: 0, live: 4096, held: "AbortError", metadataLookups: 1 });
	});
});
