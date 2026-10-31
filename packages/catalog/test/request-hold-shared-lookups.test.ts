/**
 * The catalog's lookups that one caller starts and every caller shares (the Antigravity client
 * version, the models.dev catalog, Ollama model metadata) belong to no caller's provider-request
 * hold. When a held job happens to start one, a live caller that joins it gets its result: the shared
 * request is sent, once, instead of waiting for the held job's owner to end and then failing.
 *
 * Each case starts the lookup in a held scope, then has a live caller join it while the endpoint
 * holds its answer, so the live call can only join, never find a cached result. The cases wait real
 * time: only a loopback request shows whether the lookup was sent.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { runInRequestHoldScope } from "@oh-my-pi/pi-ai/request-hold";
import { fetchWellKnownModels, ollamaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { __resetAntigravityVersionForTests, ensureAntigravityVersion } from "@oh-my-pi/pi-catalog/wire/gemini-headers";

/** A local endpoint that records each request and answers none it gates until released. */
interface SharedEndpoint {
	readonly url: string;
	/** The path of each request received. */
	readonly paths: string[];
	/** Answer the requests received so far, and every later one at once. */
	release(): void;
	stop(): void;
}

function sharedEndpoint(
	answer: (request: Request, body: string) => Response,
	gated: (pathname: string) => boolean = () => true,
): SharedEndpoint {
	const paths: string[] = [];
	const gate = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const body = await request.text();
			const { pathname } = new URL(request.url);
			paths.push(pathname);
			if (gated(pathname)) await gate.promise;
			return answer(request, body);
		},
	});
	return { url: server.url.origin, paths, release: () => gate.resolve(), stop: () => server.stop(true) };
}

/** A fetch that sends every request to `site`, keeping its path, through the global fetch. */
function toSite(site: SharedEndpoint, onRequest: (pathname: string) => void = () => {}): FetchImpl {
	return Object.assign(
		(input: string | URL | Request, init?: RequestInit) => {
			const { pathname } = new URL(input instanceof Request ? input.url : String(input));
			const sent = fetch(`${site.url}${pathname}`, init);
			onRequest(pathname);
			return sent;
		},
		{ preconnect: fetch.preconnect },
	);
}

const STILL_WAITING = "still waiting";

describe("a shared catalog lookup a held job starts", () => {
	let held: AbortController;
	let ended: AbortController;
	let site: SharedEndpoint | undefined;

	beforeEach(() => {
		held = new AbortController();
		ended = new AbortController();
	});

	afterEach(() => {
		ended.abort();
		site?.stop();
		site = undefined;
	});

	/**
	 * `heldCall` runs first, in a scope `held` covers; while its lookup is in flight, `liveCall` runs
	 * outside every scope. `site` answers once both were made. Returns what the live call got within 1.5 s.
	 */
	async function liveCallerOf<T>(
		endpoint: SharedEndpoint,
		heldCall: () => Promise<unknown>,
		liveCall: () => Promise<T>,
	): Promise<T | typeof STILL_WAITING> {
		void runInRequestHoldScope(held.signal, ended.signal, heldCall).catch(() => undefined);
		await Bun.sleep(100);
		const live = liveCall();
		void live.catch(() => undefined);
		await Bun.sleep(50);
		endpoint.release();
		return Promise.race([live, Bun.sleep(1_500).then((): typeof STILL_WAITING => STILL_WAITING)]);
	}

	describe("the Antigravity client version", () => {
		const saved = process.env.PI_AI_ANTIGRAVITY_VERSION;

		beforeEach(() => {
			// Another file's successful lookup must not skip this one.
			__resetAntigravityVersionForTests();
			delete process.env.PI_AI_ANTIGRAVITY_VERSION;
			// The lookup's state is process-wide: move past any retry window a failed lookup left.
			setSystemTime(new Date(Date.now() + 24 * 60 * 60_000));
		});

		afterEach(() => {
			setSystemTime();
			if (saved === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
			else process.env.PI_AI_ANTIGRAVITY_VERSION = saved;
		});

		it("settles for a live caller once the shared lookup answers", async () => {
			// A failed manifest keeps the process-wide version unset for the other version tests.
			site = sharedEndpoint(() => new Response("unavailable", { status: 503 }));
			const answered = site;
			const fetcher = toSite(site);
			held.abort();

			const live = await liveCallerOf(
				{
					...site,
					release() {
						// The failure is recorded when the lookup ends: date it long past, so its retry
						// window cannot suppress the other version tests' lookups.
						setSystemTime(new Date("2000-01-01T00:00:00Z"));
						answered.release();
					},
				},
				() => ensureAntigravityVersion(fetcher),
				async () => {
					await ensureAntigravityVersion(fetcher);
					return "settled";
				},
			);

			expect({ live, sent: site.paths.length }).toEqual({ live: "settled", sent: 1 });
		});
	});

	it("the models.dev catalog", async () => {
		site = sharedEndpoint(() => Response.json({ source: "shared" }, { headers: { etag: '"shared"' } }));
		const fetcher = toSite(site);
		held.abort();

		const live = await liveCallerOf(
			site,
			() => fetchWellKnownModels(fetcher),
			() => fetchWellKnownModels(fetcher),
		);

		expect({ live, sent: site.paths.length }).toEqual({ live: { source: "shared" }, sent: 1 });
	});

	it("Ollama model metadata", async () => {
		// Each caller's own model listing is answered at once; the shared metadata lookup waits.
		site = sharedEndpoint(
			(request, body) => {
				if (new URL(request.url).pathname === "/v1/models") {
					return Response.json({ object: "list", data: [{ id: "mystery:1b", object: "model" }] });
				}
				const { model } = JSON.parse(body) as { model?: string };
				return Response.json(model === "mystery:1b" ? { model_info: { "llama.context_length": 4096 } } : {});
			},
			pathname => pathname === "/api/show",
		);
		// The held job's listing is its own request and goes out; its hold begins before the metadata lookup.
		let listings = 0;
		const fetcher = toSite(site, pathname => {
			if (pathname === "/v1/models" && ++listings === 1) held.abort();
		});
		const options = ollamaModelManagerOptions({ fetch: fetcher });

		const live = await liveCallerOf(
			site,
			() => options.fetchDynamicModels!(),
			async () => (await options.fetchDynamicModels!())?.find(model => model.id === "mystery:1b")?.contextWindow,
		);

		expect({ live, metadataLookups: site.paths.filter(entry => entry === "/api/show").length }).toEqual({
			live: 4096,
			metadataLookups: 1,
		});
	});
});
