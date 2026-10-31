/**
 * The provider-request hold, case by case: `withAuth`, a streaming completion, a plain fetch, a
 * provider's own retry, `withOAuthAccess`, and nested scopes.
 *
 * Every endpoint speaks HTTPS on `localhost` (`helpers/loopback-tls.ts`), because the scheme picks the
 * code path. The path each fixture's requests take, against production's:
 * - The Anthropic completions ("streaming requests", "a provider's own retry") are made as production
 *   makes them: no caller `fetch`, a string URL, record headers and no proxy, so `transportFetch`
 *   sends them through `coworkFetch` on `node:https`, not the global fetch. Each live control checks
 *   that: its requests arrive while none passed the global fetch. Two properties differ, neither of
 *   which changes the transport: the base URL is a loopback one, not the official API (so no
 *   official-only beta is sent and a large body would not be compressed; a compressed body is bytes,
 *   which `coworkFetch` sends the same way), and the credential is an API key, not an OAuth token
 *   (whose body rewrite also yields bytes).
 * - The plain fetches ("fetch", the attempt `withOAuthAccess` runs, "nested scopes") call the global
 *   fetch, as a tool's own request does in production; the scheme does not change that path. The
 *   `withAuth` and `withOAuthAccess` cases are about the attempt the wrapper starts, which they count
 *   themselves.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type OAuthAccessSource, withAuth, withOAuthAccess } from "../src/auth-retry";
import { runInRequestHoldScope } from "../src/request-hold";
import { completeSimple } from "../src/stream";
import type { Api, Model } from "../src/types";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

trustLoopbackTls();

/** One Anthropic streaming response whose text is `done`. */
function anthropicDone(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_hold",
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

/** Let pending microtasks (a held wait, a resolved credential) run. */
async function settle(): Promise<void> {
	for (let round = 0; round < 20; round++) await Promise.resolve();
}

/**
 * A local HTTPS endpoint that counts what it receives; `answer` gets each request's 1-based number.
 *
 * The cases below wait real time where they assert that nothing arrives: a request is a loopback
 * HTTPS exchange, and a provider's retry waits on the real clock, so fake time can neither deliver one
 * nor show that none came.
 */
interface Endpoint {
	readonly url: string;
	/** Requests received so far. */
	readonly requests: number;
	/** Resolves when the first request arrives. */
	readonly first: Promise<void>;
	stop(): void;
}

function endpoint(answer: (count: number) => Response = () => new Response("ok")): Endpoint {
	let requests = 0;
	const first = Promise.withResolvers<void>();
	const server = Bun.serve({
		...LOOPBACK_TLS,
		port: 0,
		fetch: async request => {
			await request.arrayBuffer();
			requests++;
			first.resolve();
			return answer(requests);
		},
	});
	return {
		url: loopbackOrigin(server),
		get requests() {
			return requests;
		},
		first: first.promise,
		stop: () => server.stop(true),
	};
}

/** An Anthropic rate limit that asks the client to retry in one second. */
function rateLimited(): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down" } }), {
		status: 429,
		headers: { "content-type": "application/json", "retry-after": "1" },
	});
}

/** The requests to one origin that passed the global fetch, counted until `restore()`. */
interface GlobalFetchCount {
	readonly count: number;
	restore(): void;
}

/**
 * Count the requests to `origin` that pass the global fetch. An Anthropic request sent through
 * `coworkFetch` never does; one that fell back to the global fetch (an `http` URL, a `Request` input,
 * headers that are not a record, a proxy) does. A live control that sees zero here shows its fixture
 * takes the production path.
 */
function globalFetchesTo(origin: string): GlobalFetchCount {
	const below = globalThis.fetch;
	let count = 0;
	globalThis.fetch = Object.assign(
		(input: string | URL | Request, init?: RequestInit) => {
			if (new URL(input instanceof Request ? input.url : String(input)).origin === origin) count++;
			return below(input, init);
		},
		{ preconnect: below.preconnect },
	) as typeof fetch;
	return {
		get count() {
			return count;
		},
		restore: () => {
			globalThis.fetch = below;
		},
	};
}

describe("provider-request hold", () => {
	let held: AbortController;
	let ended: AbortController;

	beforeEach(() => {
		held = new AbortController();
		ended = new AbortController();
	});

	describe("withAuth", () => {
		it("sends a request made in a scope that is not held", async () => {
			const sent = await runInRequestHoldScope(held.signal, ended.signal, () =>
				withAuth("key", async key => `sent with ${key}`),
			);

			expect(sent).toBe("sent with key");
		});

		it("makes its attempt in the same turn it checks the hold, so no hold begins between them", async () => {
			const heldAtAttempt: boolean[] = [];
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				withAuth("key", async () => {
					heldAtAttempt.push(held.signal.aborted);
					return "sent";
				}),
			);
			// The hold begins in the caller's own continuation, right after the request was made.
			held.abort();
			ended.abort();
			await pending.catch(() => undefined);

			expect(heldAtAttempt).toEqual([false]);
		});

		it("holds a request made in a held scope, and refuses it when the scope ends", async () => {
			let attempts = 0;
			held.abort();
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				withAuth("key", async () => {
					attempts++;
					return "sent";
				}),
			);
			await settle();
			expect(attempts).toBe(0);

			ended.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
			expect(attempts).toBe(0);
		});

		it("refuses a held request when its own signal aborts", async () => {
			const request = new AbortController();
			held.abort();
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				withAuth("key", async () => "sent", { signal: request.signal }),
			);

			request.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
		});

		it("holds a request whose credential was still resolving when the hold began", async () => {
			let attempts = 0;
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				withAuth(
					async () => {
						held.abort();
						return "key";
					},
					async () => {
						attempts++;
						return "sent";
					},
				),
			);
			await settle();
			expect(attempts).toBe(0);

			ended.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
		});

		it("holds a request made in a scope nested inside a held one", async () => {
			let attempts = 0;
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				runInRequestHoldScope(new AbortController().signal, new AbortController().signal, () => {
					held.abort();
					return withAuth("key", async () => {
						attempts++;
						return "sent";
					});
				}),
			);
			await settle();
			expect(attempts).toBe(0);

			ended.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
		});
	});

	describe("streaming requests", () => {
		let server: Bun.Server<undefined>;
		let requests: number;
		let model: Model<Api>;
		let viaGlobalFetch: GlobalFetchCount;

		beforeEach(() => {
			requests = 0;
			server = Bun.serve({
				...LOOPBACK_TLS,
				port: 0,
				fetch: async request => {
					await request.json();
					requests++;
					return anthropicDone();
				},
			});
			model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: loopbackOrigin(server) };
			viaGlobalFetch = globalFetchesTo(loopbackOrigin(server));
		});

		afterEach(() => {
			viaGlobalFetch.restore();
			server.stop(true);
		});

		const ask = (apiKey: string | (() => Promise<string>)) =>
			completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey });

		it("sends a completion made in a scope that is not held", async () => {
			const message = await runInRequestHoldScope(held.signal, ended.signal, () => ask("key"));

			expect(message.stopReason).toBe("stop");
			expect({ requests, viaGlobalFetch: viaGlobalFetch.count }).toEqual({ requests: 1, viaGlobalFetch: 0 });
		});

		it("holds a completion made in a held scope until the scope ends, and sends nothing", async () => {
			held.abort();
			const pending = runInRequestHoldScope(held.signal, ended.signal, () => ask("key"));
			// Real time, long enough for a loopback HTTPS request to arrive: microtasks alone would show
			// nothing whether or not a request had been sent.
			await Bun.sleep(100);
			expect(requests).toBe(0);

			ended.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
			expect(requests).toBe(0);
		});

		it("holds a completion whose credential was still resolving when the hold began", async () => {
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				ask(async () => {
					held.abort();
					return "key";
				}),
			);
			await Bun.sleep(100);
			expect(requests).toBe(0);

			ended.abort();
			await pending.catch(() => undefined);

			expect(requests).toBe(0);
		});
	});

	describe("fetch", () => {
		let site: Endpoint;

		beforeEach(() => {
			site = endpoint();
		});

		afterEach(() => {
			site.stop();
		});

		const post = (init?: RequestInit) => fetch(site.url, { method: "POST", body: "{}", ...init });

		it("sends a fetch made in a scope that is not held", async () => {
			const response = await runInRequestHoldScope(held.signal, ended.signal, () => post());

			expect(await response.text()).toBe("ok");
			expect(site.requests).toBe(1);
		});

		it("never sends a fetch made in a held scope, and refuses it when the scope ends", async () => {
			held.abort();
			const pending = runInRequestHoldScope(held.signal, ended.signal, () => post());
			await Bun.sleep(50);
			expect(site.requests).toBe(0);

			ended.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
			expect(site.requests).toBe(0);
		});

		it("refuses a held fetch when its request signal aborts", async () => {
			const request = new AbortController();
			held.abort();
			const pending = runInRequestHoldScope(held.signal, ended.signal, () => post({ signal: request.signal }));

			request.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
			expect(site.requests).toBe(0);
		});

		it("refuses a held fetch of a Request when that Request's signal aborts", async () => {
			const request = new AbortController();
			held.abort();
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				fetch(new Request(site.url, { method: "POST", body: "{}", signal: request.signal })),
			);

			request.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
			expect(site.requests).toBe(0);
		});

		it("holds a fetch made through a global fetch installed after the hold's own", async () => {
			const previous = globalThis.fetch;
			let calls = 0;
			globalThis.fetch = Object.assign(
				(input: string | URL | Request, init?: RequestInit) => {
					calls++;
					return previous(input, init);
				},
				{ preconnect: previous.preconnect },
			) as typeof fetch;
			try {
				// Not held, the replacement is reached in the same call, and keeps its own properties.
				await runInRequestHoldScope(new AbortController().signal, new AbortController().signal, () => {
					const sent = post();
					expect(calls).toBe(1);
					return sent;
				});
				expect(typeof globalThis.fetch.preconnect).toBe("function");

				held.abort();
				const pending = runInRequestHoldScope(held.signal, ended.signal, () => post());
				await Bun.sleep(50);
				expect(calls).toBe(1);
				expect(site.requests).toBe(1);

				ended.abort();
				await expect(pending).rejects.toThrow("its owner began disposing");
			} finally {
				globalThis.fetch = previous;
			}
		});
	});

	describe("a provider's own retry", () => {
		const ask = (model: Model<Api>, signal?: AbortSignal) =>
			completeSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ apiKey: "key", signal },
			);

		it("sends the retry of a rate-limited request whose scope is not held", async () => {
			const site = endpoint(count => (count === 1 ? rateLimited() : anthropicDone()));
			const viaGlobalFetch = globalFetchesTo(site.url);
			try {
				const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: site.url };
				const message = await runInRequestHoldScope(held.signal, ended.signal, () => ask(model));

				expect(message.stopReason).toBe("stop");
				expect({ requests: site.requests, viaGlobalFetch: viaGlobalFetch.count }).toEqual({
					requests: 2,
					viaGlobalFetch: 0,
				});
			} finally {
				viaGlobalFetch.restore();
				site.stop();
			}
		}, 10_000);

		it("holds the retry of a request that was backing off when the hold began", async () => {
			// A request that arrives with `held` aborted was sent after the hold began: the retry is sent
			// only after the client's one-second retry-after wait, which starts once the first answer
			// arrives, and the hold begins as soon as the endpoint received the first request.
			let afterHold = 0;
			const site = endpoint(count => {
				if (held.signal.aborted) afterHold++;
				return count === 1 ? rateLimited() : anthropicDone();
			});
			const request = new AbortController();
			try {
				const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: site.url };
				const pending = runInRequestHoldScope(held.signal, ended.signal, () => ask(model, request.signal));
				await site.first;
				// The client now waits out the one-second retry-after; the hold begins during that wait.
				held.abort();
				await Bun.sleep(1_500);

				expect({ requests: site.requests, afterHold }).toEqual({ requests: 1, afterHold: 0 });

				request.abort();
				ended.abort();
				await pending.catch(() => undefined);
				expect(site.requests).toBe(1);
			} finally {
				site.stop();
			}
		}, 10_000);
	});

	describe("withOAuthAccess", () => {
		let site: Endpoint;
		let attempts: number;

		beforeEach(() => {
			site = endpoint();
			attempts = 0;
		});

		afterEach(() => {
			site.stop();
		});

		/** OAuth storage whose access is `access()`, and which never rotates. */
		const storage = (access: () => Promise<{ accessToken: string; credentialId: number }>) =>
			({
				oauth: { access: async () => access() },
				limits: { rotate: async () => ({ switched: false }) },
			}) as unknown as OAuthAccessSource;

		const send = async (access: { accessToken: string }): Promise<string> => {
			attempts++;
			const response = await fetch(site.url, {
				method: "POST",
				body: "{}",
				headers: { authorization: `Bearer ${access.accessToken}` },
			});
			return response.text();
		};

		it("sends an attempt made in a scope that is not held", async () => {
			const sent = await runInRequestHoldScope(held.signal, ended.signal, () =>
				withOAuthAccess(
					storage(async () => ({ accessToken: "token", credentialId: 1 })),
					"openai-codex",
					send,
				),
			);

			expect(sent).toBe("ok");
			expect({ attempts, requests: site.requests }).toEqual({ attempts: 1, requests: 1 });
		});

		it("holds an attempt made in a held scope, and refuses it when the scope ends", async () => {
			held.abort();
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				withOAuthAccess(
					storage(async () => ({ accessToken: "token", credentialId: 1 })),
					"openai-codex",
					send,
				),
			);
			await Bun.sleep(50);
			expect({ attempts, requests: site.requests }).toEqual({ attempts: 0, requests: 0 });

			ended.abort();

			await expect(pending).rejects.toThrow("its owner began disposing");
			expect({ attempts, requests: site.requests }).toEqual({ attempts: 0, requests: 0 });
		});

		it("holds an attempt whose access was still resolving when the hold began", async () => {
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				withOAuthAccess(
					storage(async () => {
						held.abort();
						return { accessToken: "token", credentialId: 1 };
					}),
					"openai-codex",
					send,
				),
			);
			await Bun.sleep(50);
			expect({ attempts, requests: site.requests }).toEqual({ attempts: 0, requests: 0 });

			ended.abort();
			await expect(pending).rejects.toThrow("its owner began disposing");
		});

		it("holds the retry of an attempt during which the hold began", async () => {
			let token = 0;
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				withOAuthAccess(
					storage(async () => ({ accessToken: `token-${++token}`, credentialId: token })),
					"openai-codex",
					async access => {
						if (attempts === 0) {
							attempts++;
							held.abort();
							throw new Error("401 Unauthorized");
						}
						return send(access);
					},
					{ isAuthError: () => true },
				),
			);
			await Bun.sleep(50);
			expect({ attempts, requests: site.requests }).toEqual({ attempts: 1, requests: 0 });

			ended.abort();
			await expect(pending).rejects.toThrow("its owner began disposing");
			expect({ attempts, requests: site.requests }).toEqual({ attempts: 1, requests: 0 });
		});
	});

	describe("nested scopes", () => {
		let site: Endpoint;
		let inner: { held: AbortController; ended: AbortController };

		beforeEach(() => {
			site = endpoint();
			inner = { held: new AbortController(), ended: new AbortController() };
		});

		afterEach(() => {
			ended.abort();
			inner.ended.abort();
			site.stop();
		});

		const requests = {
			withAuth: () => withAuth("key", key => fetch(site.url, { method: "POST", body: key })),
			fetch: () => fetch(site.url, { method: "POST", body: "{}" }),
		};
		const kinds = Object.keys(requests) as Array<keyof typeof requests>;

		/** Run `request` in `inner`'s scope, nested in the outer one; report when it settles. */
		function nested(request: () => Promise<unknown>): { settled: () => boolean; outcome: Promise<string> } {
			let settled = false;
			const outcome = runInRequestHoldScope(held.signal, ended.signal, () =>
				runInRequestHoldScope(inner.held.signal, inner.ended.signal, request),
			).then(
				() => "sent",
				(error: Error) => error.message,
			);
			void outcome.finally(() => {
				settled = true;
			});
			return { settled: () => settled, outcome };
		}

		it.each(kinds)("sends a %s request from nested scopes that are not held", async kind => {
			const { outcome } = nested(requests[kind]);

			expect(await outcome).toBe("sent");
			expect(site.requests).toBe(1);
		});

		it.each(kinds)("refuses a %s request waiting in a held inner scope when the outer scope ends", async kind => {
			held.abort();
			inner.held.abort();
			const { settled, outcome } = nested(requests[kind]);
			await Bun.sleep(20);
			expect(settled()).toBe(false);

			ended.abort();
			await Bun.sleep(20);

			expect(settled()).toBe(true);
			expect(await outcome).toContain("its owner began disposing");
			expect(site.requests).toBe(0);
		});

		it.each(kinds)(
			"refuses a %s request waiting in an unheld inner scope of a held one when the inner scope ends",
			async kind => {
				held.abort();
				const { settled, outcome } = nested(requests[kind]);
				await Bun.sleep(20);
				expect(settled()).toBe(false);

				inner.ended.abort();
				await Bun.sleep(20);

				expect(settled()).toBe(true);
				expect(await outcome).toContain("its owner began disposing");
				expect(site.requests).toBe(0);
			},
		);
	});
});
