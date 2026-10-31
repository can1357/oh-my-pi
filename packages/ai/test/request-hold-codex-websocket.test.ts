/**
 * The Codex WebSocket transport sends no request in a held scope: no upgrade request, no
 * `response.create` frame and no `response.steer` frame. WebSocket traffic never passes through the
 * global fetch the hold wraps, so the transport checks the hold itself, right before each send.
 *
 * The cases wait real time where they assert that nothing arrives: the server is a real loopback
 * WebSocket, which fake time can neither deliver nor rule out.
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
				hostname: "127.0.0.1",
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
			model = { ...createCodexModel("gpt-5.5"), baseUrl: `http://127.0.0.1:${server.port}` };
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
			await Bun.sleep(100);

			expect({ upgrades, frames: frames.length }).toEqual({ upgrades: 0, frames: 0 });

			ended.abort();
			request.abort();
			await pending;
			expect({ upgrades, frames: frames.length }).toEqual({ upgrades: 0, frames: 0 });
		});
	});

	describe("steering a response in flight", () => {
		const originalWebSocket = globalThis.WebSocket;
		let sent: Frame[];
		let socket: ScriptedWebSocket | undefined;

		/** A socket that opens at once and starts each response it is asked for, leaving it open. */
		class ScriptedWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = ScriptedWebSocket.CONNECTING;
			binaryType = "nodebuffer";
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onclose: ((event: Event) => void) | null = null;

			constructor() {
				socket = this;
				queueMicrotask(() => {
					this.readyState = ScriptedWebSocket.OPEN;
					this.onopen?.(new Event("open"));
				});
			}

			send(data: string): void {
				const frame = JSON.parse(data) as Frame;
				sent.push(frame);
				if (frame.type === "response.create") this.emit(...answerFrames("resp_1").slice(0, 4));
				if (frame.type === "response.steer") {
					this.emit({ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } });
				}
			}

			close(): void {
				this.readyState = ScriptedWebSocket.CLOSED;
			}

			emit(...frames: Frame[]): void {
				queueMicrotask(() => {
					for (const frame of frames) this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
				});
			}
		}

		beforeEach(() => {
			sent = [];
			socket = undefined;
			globalThis.WebSocket = ScriptedWebSocket as unknown as typeof WebSocket;
		});

		afterEach(() => {
			globalThis.WebSocket = originalWebSocket;
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
		 * steering message becomes claimable. Returns once the steer had time to go out.
		 */
		async function steerWhileStreaming(whenStreaming: () => void): Promise<number> {
			const ready = Promise.withResolvers<void>();
			const model: Model<"openai-codex-responses"> = {
				...createCodexModel("gpt-6-sol"),
				baseUrl: "https://chatgpt.com/backend-api",
			};
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
					ready.resolve();
				}
			});
			await Bun.sleep(100);
			const steers = sent.filter(frame => frame.type === "response.steer").length;
			ended.abort();
			request.abort();
			socket?.emit({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: USAGE } });
			await turn.catch(() => undefined);
			return steers;
		}

		it("sends the steer when the scope is not held", async () => {
			expect(await steerWhileStreaming(() => {})).toBe(1);
		});

		it("sends no steer once the hold began while the response streamed", async () => {
			expect(await steerWhileStreaming(() => held.abort())).toBe(0);
		});
	});
});
