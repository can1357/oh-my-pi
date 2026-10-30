import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { withAuth } from "../src/auth-retry";
import { runInRequestHoldScope } from "../src/request-hold";
import { completeSimple } from "../src/stream";
import type { Api, Model } from "../src/types";

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

		beforeEach(() => {
			requests = 0;
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: async request => {
					await request.json();
					requests++;
					return anthropicDone();
				},
			});
			model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: server.url.origin };
		});

		afterEach(() => {
			server.stop(true);
		});

		const ask = (apiKey: string | (() => Promise<string>)) =>
			completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey });

		it("sends a completion made in a scope that is not held", async () => {
			const message = await runInRequestHoldScope(held.signal, ended.signal, () => ask("key"));

			expect(message.stopReason).toBe("stop");
			expect(requests).toBe(1);
		});

		it("holds a completion made in a held scope until the scope ends, and sends nothing", async () => {
			held.abort();
			const pending = runInRequestHoldScope(held.signal, ended.signal, () => ask("key"));
			await settle();
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
			await settle();
			expect(requests).toBe(0);

			ended.abort();
			await pending.catch(() => undefined);

			expect(requests).toBe(0);
		});
	});
});
