/**
 * A background job that survives its owner's disposal is held from the moment the owner begins
 * disposing. The library enforces that hold where it hands each request to a transport, whatever
 * `globalThis.fetch` is at the time, so a held job sends nothing through:
 *
 * - Cursor's HTTP/2 transport, entered directly or through `complete` after a pending model-header
 *   lookup or a pending payload hook;
 * - a pi-ai completion whose global fetch was put back to the native one after the hold engaged;
 * - a fetch beneath the hold's wrapper that defers its native send past the hold's start;
 * - a raw fetch through a global replaced after the job registered (the manager re-arms the wrapper
 *   when the hold engages).
 *
 * And shared work, which no caller owns, may not send a model request at all; its plain fetches go out.
 *
 * Every endpoint speaks TLS with a self-signed loopback certificate, as production endpoints do: the
 * scheme picks the code path (Anthropic Messages leaves fetch for `node:https` only over HTTPS). It is
 * trusted the way the product trusts one: `NODE_EXTRA_CA_CERTS`, which `transportFetch` applies to each
 * request; for Cursor's `node:http2`, which reads that variable only at process start, the certificate
 * is added to the same default CA store with `tls.setDefaultCACertificates`.
 *
 * Each case counts what a local endpoint receives, beside a live control that sends. The cases wait
 * real time where they assert that nothing arrives: a request is a loopback TLS exchange, which fake
 * time can neither deliver nor rule out.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { type Api, complete, completeSimple, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager, SUBAGENT_TEARDOWN_DECIDES } from "@oh-my-pi/pi-coding-agent/async";
import { runOutsideRequestHold } from "@oh-my-pi/pi-utils";
import { LOOPBACK_CERT, LOOPBACK_TLS } from "./helpers/loopback-tls";

const LOOPBACK_KEY = LOOPBACK_TLS.tls.key;

/** What a fetch outside `transportFetch` passes to trust the loopback certificate. */
const TRUST = { tls: { ca: [LOOPBACK_CERT] } } as RequestInit;

/** One Anthropic streaming response whose text is `done`. */
function anthropicDone(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_gate",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** A request an endpoint received: its path, whether it carried a credential, and its body size. */
interface Arrival {
	path: string;
	credential: boolean;
	bytes: number;
}

/** A local TLS endpoint that counts what it receives. */
interface Site {
	readonly url: string;
	readonly arrivals: Arrival[];
	/** Resolves when the first request (for HTTP/2, its first body bytes) arrives. */
	readonly first: Promise<void>;
	stop(): Promise<void>;
}

/** An HTTPS endpoint answering the model requests (`/v1/messages`) and plain posts (anything else). */
function httpsSite(): Site {
	const arrivals: Arrival[] = [];
	const first = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "localhost",
		port: 0,
		tls: { cert: LOOPBACK_CERT, key: LOOPBACK_KEY },
		fetch: async request => {
			const body = await request.arrayBuffer();
			const { pathname } = new URL(request.url);
			arrivals.push({
				path: pathname,
				credential: request.headers.has("x-api-key") || request.headers.has("authorization"),
				bytes: body.byteLength,
			});
			first.resolve();
			return pathname.endsWith("/messages") ? anthropicDone() : new Response("ok");
		},
	});
	return {
		url: `https://localhost:${server.port}`,
		arrivals,
		first: first.promise,
		stop: async () => {
			server.stop(true);
		},
	};
}

/** An HTTP/2 TLS endpoint that answers Cursor's run request with headers and keeps the stream open. */
async function cursorSite(): Promise<Site> {
	const arrivals: Arrival[] = [];
	const first = Promise.withResolvers<void>();
	const sessions = new Set<http2.ServerHttp2Session>();
	const server = http2.createSecureServer({ cert: LOOPBACK_CERT, key: LOOPBACK_KEY });
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
		const arrival: Arrival = {
			path: String(headers[":path"]),
			credential: typeof headers.authorization === "string",
			bytes: 0,
		};
		arrivals.push(arrival);
		stream.on("error", () => {});
		stream.on("data", (chunk: Buffer) => {
			arrival.bytes += chunk.length;
			first.resolve();
		});
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "localhost", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as { port: number };
	return {
		url: `https://localhost:${port}`,
		arrivals,
		first: first.promise,
		stop: async () => {
			for (const session of sessions) session.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

/** Wait for the first request, or long enough that one would have arrived over loopback. */
const firstOrQuiet = (site: Site, quietMs = 500) => Promise.race([site.first, Bun.sleep(quietMs)]);

const context = () => ({ messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] });

/** A fetch that reaches `below` only after `release` resolves; `entered` is called when it was called. */
function deferringFetch(below: FetchImpl, release: Promise<void>, entered: () => void): FetchImpl {
	return async (input, init) => {
		entered();
		await release;
		return below(input, init);
	};
}

const nativeFetch = globalThis.fetch;
let certDir: string;
let savedExtraCa: string | undefined;
let savedDefaultCas: string[];

beforeAll(() => {
	certDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-transport-gate-"));
	const certPath = path.join(certDir, "loopback.pem");
	fs.writeFileSync(certPath, LOOPBACK_CERT);
	savedExtraCa = Bun.env.NODE_EXTRA_CA_CERTS;
	Bun.env.NODE_EXTRA_CA_CERTS = certPath;
	savedDefaultCas = tls.getCACertificates("default");
	tls.setDefaultCACertificates([...savedDefaultCas, LOOPBACK_CERT]);
});

afterAll(() => {
	tls.setDefaultCACertificates(savedDefaultCas);
	if (savedExtraCa === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
	else Bun.env.NODE_EXTRA_CA_CERTS = savedExtraCa;
	fs.rmSync(certDir, { recursive: true, force: true });
});

describe("a held job's library sends are refused at the transport", () => {
	let manager: AsyncJobManager;
	/** Aborting it is the owner's `beginDispose()`: the manager holds the owner's surviving jobs. */
	let ownerDisposal: AbortController;
	const cleanups: Array<() => unknown> = [];

	beforeEach(() => {
		manager = new AsyncJobManager({ onJobComplete: () => {} });
		ownerDisposal = new AbortController();
		cleanups.push(manager.bindOwnerDisposal("Main", ownerDisposal.signal));
	});

	afterEach(async () => {
		globalThis.fetch = nativeFetch;
		manager.cancelAll();
		await manager.waitForAll();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		await manager.dispose({ timeoutMs: 3_000 });
	});

	/** Register a job for the owner that survives its disposal, as a subagent's does. */
	function register(label: string, body: (signal: AbortSignal) => Promise<unknown>): string {
		return manager.register(
			"task",
			label,
			async ({ signal }) => {
				await body(signal).catch(() => undefined);
				return "settled";
			},
			{ ownerId: "Main", survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES },
		);
	}

	/** The job is held, still alive, and the site got `requests` (each with its body bytes). */
	function expectHeld(jobId: string, site: Site): void {
		const job = manager.getJob(jobId)!;
		expect({ held: job.requestHold?.aborted, status: job.status, requests: site.arrivals.length }).toEqual({
			held: true,
			status: "running",
			requests: 0,
		});
	}

	describe("Cursor over HTTP/2 and TLS", () => {
		let site: Site;

		beforeEach(async () => {
			site = await cursorSite();
			cleanups.push(() => site.stop());
		});

		const cursorModel = (): Model<"cursor-agent"> =>
			buildModel({
				id: "cursor-composer-2.5",
				name: "Cursor",
				api: "cursor-agent",
				provider: "cursor",
				baseUrl: site.url,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			}) as Model<"cursor-agent">;

		const MODES = ["streamCursor after the hold", "complete after a model-header lookup", "complete after onPayload"];

		/**
		 * Start the mode's run in a job; `barrier` is where it waits before its send. The run ends on
		 * `request` or on the job's own cancellation, so a stream that did open is closed at teardown.
		 */
		function startRun(mode: string, request: AbortSignal, barrier: () => Promise<void>): string {
			const model = cursorModel();
			if (mode === MODES[1]) {
				model.resolveHeaders = async () => {
					await barrier();
					return {};
				};
			}
			const onPayload = async () => {
				await barrier();
				return undefined;
			};
			return register(mode, async jobSignal => {
				const options = {
					apiKey: "cursor-key",
					transport: "http2" as const,
					signal: AbortSignal.any([request, jobSignal]),
					...(mode === MODES[2] ? { onPayload } : {}),
				};
				if (mode === MODES[0]) {
					await barrier();
					return streamCursor(model, context(), options).result();
				}
				return complete(model, context(), options);
			});
		}

		it.each(MODES)("%s sends no request once the owner began disposing", async mode => {
			const entered = Promise.withResolvers<void>();
			const go = Promise.withResolvers<void>();
			cleanups.push(() => go.resolve());
			const request = new AbortController();
			cleanups.push(() => request.abort());
			const jobId = startRun(mode, request.signal, async () => {
				entered.resolve();
				await go.promise;
			});
			await entered.promise;

			ownerDisposal.abort();
			go.resolve();
			await firstOrQuiet(site);

			expectHeld(jobId, site);
		});

		it.each(MODES)("%s sends its run request when the owner is not disposing (control)", async mode => {
			const request = new AbortController();
			cleanups.push(() => request.abort());
			startRun(mode, request.signal, async () => {});
			await site.first;
			request.abort();
			await manager.waitForAll();

			expect(site.arrivals).toEqual([
				{ path: "/agent.v1.AgentService/Run", credential: true, bytes: expect.any(Number) },
			]);
			expect(site.arrivals[0].bytes).toBeGreaterThan(0);
		});
	});

	describe("pi-ai and the global fetch over HTTPS", () => {
		let site: Site;

		beforeEach(() => {
			site = httpsSite();
			cleanups.push(() => site.stop());
		});

		const anthropicModel = (): Model<Api> => ({
			...getBundledModel("anthropic", "claude-sonnet-4-5")!,
			baseUrl: site.url,
		});

		/** A job whose completion waits in its payload hook for `go`; `entered` resolves once it waits. */
		function completionJob(go: Promise<void>, entered: () => void, fetch?: FetchImpl): string {
			return register("completion", signal =>
				completeSimple(anthropicModel(), context(), {
					apiKey: "test-key",
					signal,
					fetch,
					onPayload: async () => {
						entered();
						await go;
						return undefined;
					},
				}),
			);
		}

		it("a completion sends nothing when the global fetch is put back to the native one after the hold engaged", async () => {
			const entered = Promise.withResolvers<void>();
			const go = Promise.withResolvers<void>();
			cleanups.push(() => go.resolve());
			const jobId = completionJob(go.promise, entered.resolve);
			await entered.promise;

			ownerDisposal.abort();
			globalThis.fetch = nativeFetch;
			go.resolve();
			await firstOrQuiet(site);

			expectHeld(jobId, site);
		});

		it("a completion is sent with the native global fetch when the owner is not disposing (control)", async () => {
			const entered = Promise.withResolvers<void>();
			const go = Promise.withResolvers<void>();
			completionJob(go.promise, entered.resolve);
			await entered.promise;

			globalThis.fetch = nativeFetch;
			go.resolve();
			await manager.waitForAll();

			expect(site.arrivals.map(({ path, credential }) => ({ path, credential }))).toEqual([
				{ path: "/v1/messages", credential: true },
			]);
		});

		describe("a fetch beneath the gate that defers its native send past the hold's start", () => {
			const VARIANTS = ["a raw fetch through the global", "a completion through its fetch option"] as const;

			/** Start the variant's request in a job; its deferring fetch waits for `release`. */
			function start(variant: (typeof VARIANTS)[number], release: Promise<void>, entered: () => void): string {
				const deferring = deferringFetch(nativeFetch, release, entered);
				if (variant === VARIANTS[1]) return completionJob(Promise.resolve(), () => {}, deferring);
				globalThis.fetch = deferring as typeof fetch;
				return register(variant, signal =>
					fetch(`${site.url}/plain`, { method: "POST", body: "{}", signal, ...TRUST }),
				);
			}

			it.each([...VARIANTS])("%s sends nothing", async variant => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				cleanups.push(() => release.resolve());
				const jobId = start(variant, release.promise, entered.resolve);
				await entered.promise;

				ownerDisposal.abort();
				release.resolve();
				await firstOrQuiet(site);

				expect({ held: manager.getJob(jobId)!.requestHold?.aborted, requests: site.arrivals.length }).toEqual({
					held: true,
					requests: 0,
				});
			});

			it.each([...VARIANTS])("%s is sent when the owner is not disposing (control)", async variant => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				start(variant, release.promise, entered.resolve);
				await entered.promise;

				release.resolve();
				await manager.waitForAll();

				expect(site.arrivals.length).toBe(1);
			});
		});

		describe("a raw fetch through a global replaced after the job registered", () => {
			function start(go: Promise<void>): string {
				const jobId = register("raw fetch", async signal => {
					await go;
					return fetch(`${site.url}/plain`, { method: "POST", body: "{}", signal, ...TRUST });
				});
				// Replaces the hold's wrapper the job's scope installed.
				globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
					nativeFetch(input, init)) as typeof fetch;
				return jobId;
			}

			it("sends nothing once the hold engaged, which re-arms the wrapper", async () => {
				const go = Promise.withResolvers<void>();
				cleanups.push(() => go.resolve());
				const jobId = start(go.promise);

				ownerDisposal.abort();
				go.resolve();
				await firstOrQuiet(site);

				expectHeld(jobId, site);
			});

			it("is sent when the owner is not disposing (control)", async () => {
				const go = Promise.withResolvers<void>();
				start(go.promise);

				go.resolve();
				await manager.waitForAll();

				expect(site.arrivals.length).toBe(1);
			});
		});

		describe("shared work, which no caller owns", () => {
			it.each([
				["a held job", true],
				["a job that is not held", false],
			] as const)("refuses a completion made in it from %s; its plain fetch still sends", async (_name, held) => {
				if (held) ownerDisposal.abort();
				const go = Promise.withResolvers<void>();
				let refusal: string | undefined;
				register("shared work", async () => {
					await go.promise;
					await runOutsideRequestHold(() =>
						completeSimple(anthropicModel(), context(), { apiKey: "test-key" }),
					).catch((error: Error) => {
						refusal = error.message;
					});
					return runOutsideRequestHold(() => fetch(`${site.url}/plain`, { method: "POST", body: "{}", ...TRUST }));
				});

				go.resolve();
				await manager.waitForAll();

				expect({ refusal, arrivals: site.arrivals.map(arrival => arrival.path) }).toEqual({
					refusal: expect.stringContaining("no owner"),
					arrivals: ["/plain"],
				});
			});
		});
	});
});
