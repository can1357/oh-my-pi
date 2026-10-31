/**
 * The Codex WebSocket transport sends no request in a held scope: no upgrade request, no
 * `response.create` frame and no `response.steer` frame. WebSocket traffic never passes through the
 * global fetch the hold wraps, so the transport checks the hold itself, right before each send.
 *
 * Every server is a real loopback WebSocket over `wss` on `localhost` (`helpers/loopback-tls.ts`),
 * which is what production dials (`wss://chatgpt.com/backend-api/...`), and each case counts what the
 * server receives. The transport opens it as in production: Bun's `WebSocket` with the request's
 * headers, no proxy (none is configured), WebSockets preferred. Only the host differs. The cases wait
 * real time where they assert that nothing arrives, which fake time can neither deliver nor rule out.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
	type OpenAICodexResponsesOptions,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { LiveSteering, Model } from "@oh-my-pi/pi-ai/types";
import { runInRequestHoldScope } from "../src/request-hold";
import { stream } from "../src/stream";
import { createCodexModel } from "./helpers";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

trustLoopbackTls();

type Frame = Record<string, unknown>;

const USAGE = { input_tokens: 5, output_tokens: 1, total_tokens: 6 };

/** A Codex access token for a fresh account, so no state carries over between cases. */
function token(): string {
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: crypto.randomUUID() } };
	return `aaa.${Buffer.from(JSON.stringify(claims)).toBase64()}.bbb`;
}

/** The frames of one completed response whose text is `Answer`. */
function answerFrames(id: string): Frame[] {
	const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed" };
	return [
		{ type: "response.created", response: { id } },
		{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Answer" },
		{ type: "response.output_item.done", item: { ...item, content: [{ type: "output_text", text: "Answer" }] } },
		{ type: "response.completed", response: { id, status: "completed", usage: USAGE } },
	];
}

describe("the Codex WebSocket transport in a hold scope", () => {
	let held: AbortController;
	let ended: AbortController;
	let request: AbortController;

	beforeEach(() => {
		held = new AbortController();
		ended = new AbortController();
		request = new AbortController();
	});

	afterEach(() => {
		request.abort();
		ended.abort();
	});

	describe("against a real WebSocket server", () => {
		let server: Bun.Server<undefined>;
		let upgrades: number;
		let frames: Frame[];
		let model: Model<"openai-codex-responses">;

		beforeEach(() => {
			upgrades = 0;
			frames = [];
			server = Bun.serve({
				...LOOPBACK_TLS,
				port: 0,
				fetch(incoming, server) {
					upgrades++;
					if (server.upgrade(incoming)) return undefined;
					return new Response("WebSocket required", { status: 400 });
				},
				websocket: {
					message(socket: ServerWebSocket<unknown>, message) {
						const frame = JSON.parse(String(message)) as Frame;
						frames.push(frame);
						for (const event of answerFrames(`resp_${frames.length}`)) socket.send(JSON.stringify(event));
					},
				},
			});
			model = { ...createCodexModel("gpt-5.5"), baseUrl: loopbackOrigin(server) };
		});

		afterEach(() => {
			server.stop(true);
		});

		const options = (extra?: Partial<OpenAICodexResponsesOptions>): OpenAICodexResponsesOptions => ({
			apiKey: token(),
			sessionId: crypto.randomUUID(),
			providerSessionState: new Map(),
			preferWebsockets: true,
			signal: request.signal,
			...extra,
		});
		const context = {
			systemPrompt: ["system prompt"],
			messages: [{ role: "user" as const, content: "Hi", timestamp: 1 }],
		};

		it("opens a socket and sends its request when the scope is not held", async () => {
			const reply = await runInRequestHoldScope(held.signal, ended.signal, () =>
				streamOpenAICodexResponses(model, context, options()).result(),
			);

			expect(reply.stopReason).toBe("stop");
			expect({ upgrades, creates: frames.filter(frame => frame.type === "response.create").length }).toEqual({
				upgrades: 1,
				creates: 1,
			});
		});

		it("sends no request frame once the hold began after its socket opened", async () => {
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				streamOpenAICodexResponses(
					model,
					context,
					options({
						// The socket is open by now; the frame is the next thing sent.
						onPayload: () => {
							held.abort();
							return undefined;
						},
					}),
				).result(),
			);
			await Bun.sleep(100);

			expect({ upgrades, frames: frames.length }).toEqual({ upgrades: 1, frames: 0 });

			// As when a held job is cancelled: its scope ends and its turn is aborted.
			ended.abort();
			request.abort();
			await pending;
			expect(frames.length).toBe(0);
		});

		it("opens no socket once the hold began before it connected", async () => {
			const lateHeaders: Model<"openai-codex-responses"> = {
				...model,
				resolveHeaders: async () => {
					held.abort();
					return {};
				},
			};
			const pending = runInRequestHoldScope(held.signal, ended.signal, () =>
				stream(lateHeaders, context, options()).result(),
			);
			let settled = false;
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await Bun.sleep(100);

			// Still waiting, not ended: a turn whose socket failed in the client (on TLS, say) would show
			// no upgrade either, but it would have ended.
			expect({ upgrades, frames: frames.length, settled }).toEqual({ upgrades: 0, frames: 0, settled: false });

			ended.abort();
			request.abort();
			await pending;
			expect({ upgrades, frames: frames.length }).toEqual({ upgrades: 0, frames: 0 });
		});
	});

	describe("steering a response in flight", () => {
		let server: Bun.Server<undefined>;
		/** The frames the server received. */
		let received: Frame[];
		/** The server's end of the turn's socket, once it opened. */
		let peer: ServerWebSocket<unknown> | undefined;

		beforeEach(() => {
			received = [];
			peer = undefined;
			// A server that starts each response it is asked for and leaves it open, so a steer can join it.
			server = Bun.serve({
				...LOOPBACK_TLS,
				port: 0,
				fetch(incoming, server) {
					if (server.upgrade(incoming, { data: undefined })) return undefined;
					return new Response("WebSocket required", { status: 400 });
				},
				websocket: {
					open(socket: ServerWebSocket<unknown>) {
						peer = socket;
					},
					message(socket: ServerWebSocket<unknown>, message) {
						const frame = JSON.parse(String(message)) as Frame;
						received.push(frame);
						if (frame.type === "response.create") {
							for (const event of answerFrames("resp_1").slice(0, 4)) socket.send(JSON.stringify(event));
						}
						if (frame.type === "response.steer") {
							socket.send(
								JSON.stringify({
									type: "response.steer.accepted",
									steer: { id: "steer_1", previous_response_id: "resp_1" },
								}),
							);
						}
					},
				},
			});
		});

		afterEach(() => {
			server.stop(true);
		});

		/** A steering source whose one message becomes claimable when `ready` resolves. */
		function steeringOnce(ready: Promise<void>): LiveSteering {
			let claimed = false;
			return {
				wait: async signal => {
					if (!claimed) return ready;
					const { promise, resolve } = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => resolve(), { once: true });
					return promise;
				},
				claim: async () => {
					if (claimed) return undefined;
					claimed = true;
					return {
						messages: [{ role: "user", content: "follow-up", timestamp: Date.now() }],
						accept: () => {},
						reject: () => {},
					};
				},
			};
		}

		/**
		 * Stream one turn whose response stays open; once its text arrives, `whenStreaming` runs and the
		 * steering message becomes claimable. Returns, once the steer had time to reach the server from
		 * then, whether the response streamed and how many steers the server received.
		 */
		async function steerWhileStreaming(whenStreaming: () => void): Promise<{ streamed: boolean; steers: number }> {
			const ready = Promise.withResolvers<void>();
			const model: Model<"openai-codex-responses"> = {
				...createCodexModel("gpt-6-sol"),
				baseUrl: loopbackOrigin(server),
			};
			let streamed = false;
			const turn = runInRequestHoldScope(held.signal, ended.signal, async () => {
				const events = streamOpenAICodexResponses(
					model,
					{ systemPrompt: ["system prompt"], messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
					{
						apiKey: token(),
						sessionId: crypto.randomUUID(),
						providerSessionState: new Map(),
						preferWebsockets: true,
						liveSteering: steeringOnce(ready.promise),
						signal: request.signal,
					},
				);
				for await (const event of events) {
					if (event.type !== "text_delta") continue;
					whenStreaming();
					streamed = true;
					ready.resolve();
				}
			});
			// The steer becomes claimable when the text arrives; a turn that ends first never streamed.
			await Promise.race([ready.promise, turn.catch(() => undefined)]);
			await Bun.sleep(100);
			const steers = received.filter(frame => frame.type === "response.steer").length;
			ended.abort();
			request.abort();
			const completed = {
				type: "response.completed",
				response: { id: "resp_1", status: "completed", usage: USAGE },
			};
			peer?.send(JSON.stringify(completed));
			await turn.catch(() => undefined);
			return { streamed, steers };
		}

		it("sends the steer when the scope is not held", async () => {
			expect(await steerWhileStreaming(() => {})).toEqual({ streamed: true, steers: 1 });
		});

		it("sends no steer once the hold began while the response streamed", async () => {
			expect(await steerWhileStreaming(() => held.abort())).toEqual({ streamed: true, steers: 0 });
		});
	});
});
