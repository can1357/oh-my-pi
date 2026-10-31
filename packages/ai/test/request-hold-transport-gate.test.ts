/**
 * The provider-request hold is enforced where the library hands a request to a transport: each send
 * asks `admitSend` in the same turn it sends, whatever `globalThis.fetch` is at the time. The global
 * fetch wrapper stays as a backstop for code that never asks.
 *
 * Every endpoint here speaks HTTPS with a self-signed loopback certificate, because the scheme picks
 * the code path: Anthropic Messages leaves fetch for `node:https` (`coworkFetch`) only over HTTPS. The
 * certificate is trusted the way the product trusts one: `NODE_EXTRA_CA_CERTS`, which `transportFetch`
 * applies to each request as `tls.ca`; a fetch made outside `transportFetch` passes the same `tls.ca`.
 *
 * Each case counts what a local endpoint receives, beside a live control that sends. The cases wait
 * real time where they assert that nothing arrives: a request is a loopback HTTPS exchange, which fake
 * time can neither deliver nor rule out.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runOutsideRequestHold } from "@oh-my-pi/pi-utils";
import { withAuth } from "../src/auth-retry";
import { AuthStorage } from "../src/auth-storage";
import { streamAnthropic } from "../src/providers/anthropic";
import { coworkFetch } from "../src/providers/cowork-fetch";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/registry/oauth";
import { admitSend, ensureRequestHoldFetch, gatedFetch, runInRequestHoldScope } from "../src/request-hold";
import { completeSimple } from "../src/stream";
import type { Api, FetchImpl, Model } from "../src/types";
import { connectProxiedSocket } from "../src/utils/proxy";
import { transportFetch } from "../src/utils/transport-fetch";
import { LOOPBACK_CERT, LOOPBACK_TLS, loopbackOrigin } from "./helpers/loopback-tls";

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

/** One OpenAI chat-completions stream whose text is `ok`. */
function chatCompletion(): Response {
	const chunk = (extra: object) =>
		`data: ${JSON.stringify({ id: "chatcmpl-gate", object: "chat.completion.chunk", created: 0, model: "gpt-4o-mini", ...extra })}\n\n`;
	return new Response(
		`${chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}${chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}data: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

/** A local HTTPS endpoint that counts what it receives. */
interface Endpoint {
	readonly url: string;
	/** Requests received so far, with their paths and whether they carried a credential. */
	readonly received: Array<{ path: string; credential: boolean }>;
	/** Resolves when the first request arrives. */
	readonly first: Promise<void>;
	stop(): void;
}

function endpoint(answer: (request: Request) => Response | Promise<Response> = () => new Response("ok")): Endpoint {
	const received: Endpoint["received"] = [];
	const first = Promise.withResolvers<void>();
	const server = Bun.serve({
		...LOOPBACK_TLS,
		port: 0,
		fetch: async request => {
			await request.arrayBuffer();
			received.push({
				path: new URL(request.url).pathname,
				credential: request.headers.has("x-api-key") || request.headers.has("authorization"),
			});
			first.resolve();
			return answer(request);
		},
	});
	return { url: loopbackOrigin(server), received, first: first.promise, stop: () => server.stop(true) };
}

/** Let pending microtasks (a held wait, a refusal) run. */
async function settle(): Promise<void> {
	for (let round = 0; round < 20; round++) await Promise.resolve();
}

/** Wait for the first request, or long enough that one would have arrived over loopback. */
const firstOrQuiet = (site: Endpoint, quietMs = 400) => Promise.race([site.first, Bun.sleep(quietMs)]);

/**
 * Whether `promise` settled, and its error. A held request is still pending when nothing arrived; one
 * that failed in the client (a TLS setup error, say) settles, so a zero count alone proves no hold.
 */
function track(promise: Promise<unknown>): { settled: boolean; error?: string } {
	const state: { settled: boolean; error?: string } = { settled: false };
	promise.then(
		() => {
			state.settled = true;
		},
		(error: Error) => {
			state.settled = true;
			state.error = error.message;
		},
	);
	return state;
}

const context = () => ({ messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] });

/** A fetch that reaches `below` only after `release` resolves; `entered` resolves when it was called. */
function deferringFetch(below: FetchImpl, release: Promise<void>, entered: () => void): FetchImpl {
	return async (input, init) => {
		entered();
		await release;
		return below(input, init);
	};
}

const nativeFetch = globalThis.fetch;
let savedExtraCa: string | undefined;
let certDir: string;

beforeAll(() => {
	certDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-transport-gate-"));
	const certPath = path.join(certDir, "loopback.pem");
	fs.writeFileSync(certPath, LOOPBACK_CERT);
	savedExtraCa = Bun.env.NODE_EXTRA_CA_CERTS;
	Bun.env.NODE_EXTRA_CA_CERTS = certPath;
});

afterAll(() => {
	if (savedExtraCa === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
	else Bun.env.NODE_EXTRA_CA_CERTS = savedExtraCa;
	fs.rmSync(certDir, { recursive: true, force: true });
});

describe("the transport gate", () => {
	let held: AbortController;
	let ended: AbortController;
	let site: Endpoint;
	const cleanups: Array<() => unknown> = [];

	beforeEach(() => {
		held = new AbortController();
		ended = new AbortController();
	});

	afterEach(async () => {
		ended.abort();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		globalThis.fetch = nativeFetch;
	});

	function serve(answer?: (request: Request) => Response | Promise<Response>): Endpoint {
		site = endpoint(answer);
		cleanups.push(() => site.stop());
		return site;
	}

	const inScope = <T>(fn: () => T): T => runInRequestHoldScope(held.signal, ended.signal, fn);

	describe("admitSend", () => {
		it("admits a send outside every scope and in a scope that is not held", () => {
			expect(admitSend()).toBeUndefined();
			expect(inScope(() => admitSend())).toBeUndefined();
		});

		it("returns a refusal in a held scope that rejects only when the scope ends", async () => {
			held.abort();
			const refusal = inScope(() => admitSend());
			let outcome = "pending";
			void refusal?.catch((error: Error) => {
				outcome = error.message;
			});
			await settle();
			expect(outcome).toBe("pending");

			ended.abort();
			await settle();

			expect(outcome).toContain("its owner began disposing");
		});

		it("refuses a send in shared work at once: it has no owner", async () => {
			const refusal = runOutsideRequestHold(() => admitSend());

			await expect(refusal!).rejects.toThrow("no owner");
		});
	});

	describe("gatedFetch", () => {
		it("calls the fetch below in the same call when admitted", async () => {
			serve();
			let calls = 0;
			const below: FetchImpl = (input, init) => {
				calls++;
				return nativeFetch(input, init);
			};

			const response = await inScope(() => {
				const sent = gatedFetch(below)(site.url, { method: "POST", body: "{}", ...TRUST });
				expect(calls).toBe(1);
				return sent;
			});

			expect(await response.text()).toBe("ok");
			expect(site.received.length).toBe(1);
		});

		it("never calls the fetch below in a held scope, and refuses when the scope ends", async () => {
			serve();
			let calls = 0;
			const below: FetchImpl = (input, init) => {
				calls++;
				return nativeFetch(input, init);
			};
			held.abort();
			const pending = inScope(() => gatedFetch(below)(site.url, { method: "POST", body: "{}", ...TRUST }));
			await firstOrQuiet(site);
			expect({ calls, requests: site.received.length }).toEqual({ calls: 0, requests: 0 });

			ended.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
		});

		it("aborts a send the fetch below defers past the hold's start", async () => {
			serve();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const below = deferringFetch(nativeFetch, release.promise, entered.resolve);
			const pending = inScope(() => gatedFetch(below)(site.url, { method: "POST", body: "{}", ...TRUST }));
			void pending.catch(() => undefined);
			await entered.promise;

			held.abort();
			release.resolve();
			await firstOrQuiet(site);

			expect(site.received.length).toBe(0);
			await expect(pending).rejects.toThrow("held");
		});

		it("sends what the fetch below deferred when no hold began (control)", async () => {
			serve();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const below = deferringFetch(nativeFetch, release.promise, entered.resolve);
			const pending = inScope(() => gatedFetch(below)(site.url, { method: "POST", body: "{}", ...TRUST }));
			await entered.promise;

			release.resolve();

			expect(await (await pending).text()).toBe("ok");
			expect(site.received.length).toBe(1);
		});

		it("does not cut a response already streaming when the hold begins", async () => {
			const more = Promise.withResolvers<void>();
			serve(
				() =>
					new Response(
						new ReadableStream<Uint8Array>({
							async start(controller) {
								controller.enqueue(new TextEncoder().encode("a"));
								await more.promise;
								controller.enqueue(new TextEncoder().encode("b"));
								controller.close();
							},
						}),
					),
			);
			const response = await inScope(() => gatedFetch()(site.url, { method: "POST", body: "{}", ...TRUST }));

			held.abort();
			more.resolve();

			expect(await response.text()).toBe("ab");
		});

		it("refuses a send made in shared work, and sends nothing", async () => {
			serve();

			await expect(
				runOutsideRequestHold(() => gatedFetch()(site.url, { method: "POST", body: "{}", ...TRUST })),
			).rejects.toThrow("no owner");
			await firstOrQuiet(site);
			expect(site.received.length).toBe(0);
		});
	});

	describe("the global fetch backstop", () => {
		it("aborts a send that a global fetch installed before the scope defers past the hold's start", async () => {
			serve();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			globalThis.fetch = deferringFetch(nativeFetch, release.promise, entered.resolve) as typeof fetch;
			const pending = inScope(() => fetch(site.url, { method: "POST", body: "{}", ...TRUST }));
			const state = track(pending);
			await entered.promise;

			held.abort();
			release.resolve();
			await firstOrQuiet(site);

			expect({ requests: site.received.length, error: state.error }).toEqual({
				requests: 0,
				error: expect.stringContaining("held"),
			});
		});

		it("sends what that global fetch deferred when no hold began (control)", async () => {
			serve();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			globalThis.fetch = deferringFetch(nativeFetch, release.promise, entered.resolve) as typeof fetch;
			const pending = inScope(() => fetch(site.url, { method: "POST", body: "{}", ...TRUST }));
			await entered.promise;

			release.resolve();

			expect(await (await pending).text()).toBe("ok");
			expect(site.received.length).toBe(1);
		});

		it("re-wraps, once re-armed, a global fetch replaced since the scope began", async () => {
			serve();
			const go = Promise.withResolvers<void>();
			const pending = inScope(async () => {
				await go.promise;
				return fetch(site.url, { method: "POST", body: "{}", ...TRUST });
			});
			const state = track(pending);
			await settle();
			globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
				nativeFetch(input, init)) as typeof fetch;

			held.abort();
			ensureRequestHoldFetch();
			go.resolve();
			await firstOrQuiet(site);

			expect({ requests: site.received.length, settled: state.settled }).toEqual({ requests: 0, settled: false });
		});
	});

	describe("Anthropic Messages over HTTPS, which leaves fetch for node:https", () => {
		const anthropicModel = (): Model<Api> => ({
			...getBundledModel("anthropic", "claude-sonnet-4-5")!,
			baseUrl: site.url,
		});

		const coworkInit = (): RequestInit =>
			({
				method: "POST",
				headers: { "x-api-key": "test-key", "content-type": "application/json" },
				body: "{}",
				...TRUST,
			}) as RequestInit;

		it("coworkFetch sends nothing from a held scope", async () => {
			serve();
			held.abort();
			const state = track(inScope(() => coworkFetch(`${site.url}/v1/messages`, coworkInit())));
			await firstOrQuiet(site);

			expect({ requests: site.received.length, settled: state.settled }).toEqual({ requests: 0, settled: false });
		});

		it("coworkFetch sends from a scope that is not held (control)", async () => {
			serve();
			const response = await inScope(() => coworkFetch(`${site.url}/v1/messages`, coworkInit()));

			expect(await response.text()).toBe("ok");
			expect(site.received).toEqual([{ path: "/v1/messages", credential: true }]);
		});

		it("transportFetch(<anthropic model>) sends nothing from a held scope", async () => {
			serve();
			held.abort();
			const state = track(
				inScope(() =>
					transportFetch(anthropicModel(), undefined)(`${site.url}/v1/messages`, {
						method: "POST",
						headers: { "x-api-key": "test-key", "content-type": "application/json" },
						body: "{}",
					}),
				),
			);
			await firstOrQuiet(site);

			expect({ requests: site.received.length, settled: state.settled }).toEqual({ requests: 0, settled: false });
		});

		it("transportFetch(<anthropic model>) sends from a scope that is not held (control)", async () => {
			serve();
			const response = await inScope(() =>
				transportFetch(anthropicModel(), undefined)(`${site.url}/v1/messages`, {
					method: "POST",
					headers: { "x-api-key": "test-key", "content-type": "application/json" },
					body: "{}",
				}),
			);

			expect(await response.text()).toBe("ok");
			expect(site.received).toEqual([{ path: "/v1/messages", credential: true }]);
		});

		/** Start a completion whose payload hook waits for `go`; resolves `entered` once it waits. */
		function completionAfterPayload(model: Model<Api>, go: Promise<void>, entered: () => void) {
			return inScope(() =>
				completeSimple(model, context(), {
					apiKey: "test-key",
					onPayload: async () => {
						entered();
						await go;
						return undefined;
					},
				}),
			);
		}

		it.each([
			["the global fetch untouched", false],
			["the global fetch restored to the native one", true],
		] as const)("a completion whose hold began before its send sends nothing, %s", async (_name, restore) => {
			serve(() => anthropicDone());
			const entered = Promise.withResolvers<void>();
			const go = Promise.withResolvers<void>();
			const state = track(completionAfterPayload(anthropicModel(), go.promise, entered.resolve));
			await entered.promise;

			held.abort();
			if (restore) globalThis.fetch = nativeFetch;
			go.resolve();
			await firstOrQuiet(site);

			expect({ requests: site.received.length, settled: state.settled }).toEqual({ requests: 0, settled: false });
		});

		it("a completion is sent when no hold began (control)", async () => {
			serve(() => anthropicDone());
			const entered = Promise.withResolvers<void>();
			const go = Promise.withResolvers<void>();
			const pending = completionAfterPayload(anthropicModel(), go.promise, entered.resolve);
			await entered.promise;

			globalThis.fetch = nativeFetch;
			go.resolve();
			const message = await pending;

			expect(message.stopReason).toBe("stop");
			expect(site.received).toEqual([{ path: "/v1/messages", credential: true }]);
		});
	});

	describe("a plain-fetch provider over HTTPS (OpenAI chat completions)", () => {
		const completionsModel = (): Model<Api> => ({
			...getBundledModel("openai", "gpt-4o-mini")!,
			api: "openai-completions",
			baseUrl: `${site.url}/v1`,
		});

		/**
		 * Start a completion in the scope after the global fetch was put back to the native one (the scope
		 * had wrapped it), so the provider's fetch never meets the backstop; its payload hook waits for `go`.
		 */
		function completion(go: Promise<void>, entered: () => void) {
			return inScope(() => {
				globalThis.fetch = nativeFetch;
				return completeSimple(completionsModel(), context(), {
					apiKey: "test-key",
					onPayload: async () => {
						entered();
						await go;
						return undefined;
					},
				});
			});
		}

		it("sends nothing once the hold began before its send, with the global fetch restored to the native one", async () => {
			serve(() => chatCompletion());
			const entered = Promise.withResolvers<void>();
			const go = Promise.withResolvers<void>();
			const state = track(completion(go.promise, entered.resolve));
			await entered.promise;

			held.abort();
			go.resolve();
			await firstOrQuiet(site);

			expect({ requests: site.received.length, settled: state.settled }).toEqual({ requests: 0, settled: false });
		});

		it("is sent when no hold began (control)", async () => {
			serve(() => chatCompletion());
			const entered = Promise.withResolvers<void>();
			const go = Promise.withResolvers<void>();
			const pending = completion(go.promise, entered.resolve);
			await entered.promise;

			go.resolve();
			const message = await pending;

			expect(message.stopReason).toBe("stop");
			expect(site.received).toEqual([{ path: "/v1/chat/completions", credential: true }]);
		});
	});

	describe("shared work, which no caller owns", () => {
		const anthropicModel = (): Model<Api> => ({
			...getBundledModel("anthropic", "claude-sonnet-4-5")!,
			baseUrl: site.url,
		});

		it.each([
			["outside every scope", false],
			["started from a held scope", true],
		] as const)("refuses a completion made in it, %s, and sends nothing", async (_name, fromHeldScope) => {
			serve(() => anthropicDone());
			if (fromHeldScope) held.abort();
			const ask = () =>
				runOutsideRequestHold(() => completeSimple(anthropicModel(), context(), { apiKey: "test-key" }));

			await expect(fromHeldScope ? inScope(ask) : ask()).rejects.toThrow("no owner");
			await firstOrQuiet(site);
			expect(site.received.length).toBe(0);
		});

		it("refuses a provider stream entered directly in it, and sends nothing", async () => {
			serve(() => anthropicDone());

			// A direct caller passes its own fetch; this one trusts the loopback certificate.
			const trusting: FetchImpl = (input, init) => nativeFetch(input, { ...init, ...TRUST });
			const message = await runOutsideRequestHold(() =>
				streamAnthropic(anthropicModel() as Model<"anthropic-messages">, context(), {
					apiKey: "test-key",
					fetch: trusting,
				}).result(),
			);
			await firstOrQuiet(site);

			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("no owner");
			expect(site.received.length).toBe(0);
		});

		it("sends a plain fetch made in it (control)", async () => {
			serve();
			held.abort();

			const response = await inScope(() =>
				runOutsideRequestHold(() => fetch(site.url, { method: "POST", body: "{}", ...TRUST })),
			);

			expect(await response.text()).toBe("ok");
			expect(site.received.length).toBe(1);
		});
	});

	describe("withAuth with an expired OAuth credential", () => {
		const PROVIDER = "unit-transport-gate-refresh";
		const SOURCE = "request-hold-transport-gate-test";
		let storage: AuthStorage;
		let refreshSite: Endpoint;

		beforeEach(async () => {
			refreshSite = endpoint(() => Response.json({ access: "fresh-access" }));
			cleanups.push(() => refreshSite.stop());
			registerOAuthProvider({
				id: PROVIDER,
				name: "Transport Gate Refresh",
				sourceId: SOURCE,
				async login() {
					return { access: "login", refresh: "login", expires: Date.now() + 3_600_000 };
				},
				async refreshToken(credentials, signal) {
					const response = await fetch(`${refreshSite.url}/v1/oauth/token`, {
						method: "POST",
						headers: { authorization: `Bearer ${credentials.refresh}` },
						body: credentials.refresh,
						signal,
						...TRUST,
					});
					const { access } = (await response.json()) as { access: string };
					return { ...credentials, access, refresh: "next-refresh", expires: Date.now() + 3_600_000 };
				},
				getApiKey: credentials => credentials.access,
			});
			cleanups.push(() => unregisterOAuthProviders(SOURCE));
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-transport-gate-auth-"));
			cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
			storage = await AuthStorage.create(path.join(dir, "agent.db"));
			cleanups.push(() => storage.close());
			await storage.credentials.set(PROVIDER, [
				{ type: "oauth", access: "stale", refresh: "session-refresh", expires: Date.now() - 1_000 },
			]);
		});

		const call = () =>
			withAuth(
				async () => storage.keys.get(PROVIDER, "session"),
				async key => key,
			);

		it("starts no credential refresh from a held scope", async () => {
			held.abort();
			const state = track(inScope(call));
			await firstOrQuiet(refreshSite);

			expect({ refreshes: refreshSite.received.length, settled: state.settled }).toEqual({
				refreshes: 0,
				settled: false,
			});
		});

		it("refreshes the credential from a scope that is not held (control)", async () => {
			const key = await inScope(call);

			expect(key).toBe("fresh-access");
			expect(refreshSite.received).toEqual([{ path: "/v1/oauth/token", credential: true }]);
		});
	});

	describe("the proxy tunnel Cursor's HTTP/2 transport opens", () => {
		/**
		 * A CONNECT proxy that counts the connections it accepts and never answers. It speaks plain TCP,
		 * as an `http://` proxy does; the gate is asked before the connection opens, whatever its scheme.
		 */
		async function silentProxy(): Promise<{ url: string; connections: () => number }> {
			let connections = 0;
			const sockets = new Set<net.Socket>();
			const server = net.createServer(socket => {
				connections++;
				sockets.add(socket);
				socket.on("error", () => {});
			});
			const listening = Promise.withResolvers<void>();
			server.listen(0, "127.0.0.1", () => listening.resolve());
			await listening.promise;
			cleanups.push(() => {
				for (const socket of sockets) socket.destroy();
				server.close();
			});
			const { port } = server.address() as net.AddressInfo;
			return { url: `http://127.0.0.1:${port}`, connections: () => connections };
		}

		it("opens no connection to the proxy from a held scope", async () => {
			const proxy = await silentProxy();
			const request = new AbortController();
			cleanups.push(() => request.abort());
			held.abort();
			const state = track(
				inScope(() => connectProxiedSocket(proxy.url, "https://cursor.example", { signal: request.signal })),
			);
			await Bun.sleep(300);

			expect({ connections: proxy.connections(), settled: state.settled }).toEqual({
				connections: 0,
				settled: false,
			});
		});

		it("connects to the proxy from a scope that is not held (control)", async () => {
			const proxy = await silentProxy();
			const request = new AbortController();
			const pending = inScope(() =>
				connectProxiedSocket(proxy.url, "https://cursor.example", { signal: request.signal }),
			);
			void pending.catch(() => undefined);
			for (let waited = 0; proxy.connections() === 0 && waited < 2_000; waited += 20) await Bun.sleep(20);
			request.abort();

			expect(proxy.connections()).toBe(1);
		});
	});
});
