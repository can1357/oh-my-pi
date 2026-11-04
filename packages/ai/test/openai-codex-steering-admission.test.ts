import { afterEach, expect, it, vi } from "bun:test";
import { CodexSteerPump } from "../src/providers/openai-codex/live-steering";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import { type RequestHolds, runWithRequestHolds } from "../src/request-holds";
import type { LiveSteering } from "../src/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

afterEach(() => vi.restoreAllMocks());

for (const ending of ["reject", "abort"] as const) {
	it(`keeps the in-flight WebSocket watchdog after a steering admission wait ends by ${ending}`, async () => {
		const idleBudgetMs = 100;
		const checked = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>();
		const firstProgress = Promise.withResolvers<void>();
		const rejectedClaim = Promise.withResolvers<void>();
		const frames: string[] = [];
		let held = false;
		let claimed = false;
		let rejected = 0;
		let fallback = 0;
		let closed = false;
		let settled = false;
		const refusal = Promise.reject(new Error("steering admission refused"));
		void refusal.catch(() => {});
		const holds: RequestHolds = {
			open: () => ({
				check() {
					if (!held) return;
					checked.resolve();
					return ending === "reject" ? refusal : paused.promise;
				},
				release() {},
			}),
		};
		const server = Bun.serve<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request, { data: undefined })) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				close() {
					closed = true;
				},
				message(socket, message) {
					const frame = JSON.parse(String(message)) as Record<string, unknown>;
					frames.push(String(frame.type));
					if (frame.type !== "response.create") return;
					socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_stall" } }));
					socket.send(
						JSON.stringify({
							type: "response.output_item.added",
							item: { type: "message", id: "msg_stall", role: "assistant", status: "in_progress", content: [] },
						}),
					);
					socket.send(
						JSON.stringify({ type: "response.output_text.delta", item_id: "msg_stall", delta: "before" }),
					);
				},
			},
		});
		const NativeSocket = globalThis.WebSocket;
		let client: WebSocket | undefined;
		const constructor = vi.spyOn(globalThis, "WebSocket") as unknown as {
			mockImplementation(factory: (_url: string | URL, options?: Bun.WebSocketOptions) => WebSocket): void;
		};
		constructor.mockImplementation((_url, options) => {
			client = new NativeSocket(`ws://127.0.0.1:${server.port}/responses`, options);
			return client;
		});
		Object.assign(globalThis.WebSocket, {
			OPEN: NativeSocket.OPEN,
			CONNECTING: NativeSocket.CONNECTING,
			CLOSING: NativeSocket.CLOSING,
			CLOSED: NativeSocket.CLOSED,
		});
		const source: LiveSteering = {
			async wait(signal) {
				if (!claimed || signal.aborted) return;
				const stopped = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => stopped.resolve(), { once: true });
				await stopped.promise;
			},
			async claim() {
				if (claimed) return;
				claimed = true;
				held = true;
				return {
					messages: [{ role: "user", content: "continue", timestamp: 1 }],
					accept() {},
					reject() {
						held = false;
						rejected++;
						rejectedClaim.resolve();
					},
				};
			},
		};
		const pump = new CodexSteerPump(
			source,
			{
				async steer(previousResponseId, input) {
					client!.send(
						JSON.stringify({ type: "response.steer", previous_response_id: previousResponseId, input }),
					);
					return { accepted: true, id: "unexpected-steer" };
				},
			},
			messages => messages.map(message => ({ role: "user", content: String(message.content) })),
		);
		const model = buildModel({
			id: "gpt-6-sol",
			name: "local",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: true,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		});
		const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: crypto.randomUUID() } })).toString("base64")}.bbb`;
		const controller = new AbortController();
		let startingPump: Promise<void> | undefined;
		const result = runWithRequestHolds(holds, () =>
			streamOpenAICodexResponses(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{
					apiKey: token,
					sessionId: crypto.randomUUID(),
					providerSessionState: new Map(),
					signal: controller.signal,
					streamIdleTimeoutMs: idleBudgetMs,
					streamFirstEventTimeoutMs: idleBudgetMs,
					codexSseMaxAttempts: 1,
					liveSteering: ending === "reject" ? source : undefined,
					onPayload() {
						if (ending === "abort" && !startingPump)
							startingPump = (async () => {
								await firstProgress.promise;
								pump.start("resp_stall");
							})();
					},
					onSseEvent(event) {
						if (event.event === "response.output_text.delta") firstProgress.resolve();
					},
					fetch: async () => {
						fallback++;
						throw new Error("watchdog fallback observed");
					},
				},
			).result(),
		).then(message => {
			settled = true;
			return message;
		});
		try {
			await checked.promise;
			if (ending === "abort") {
				await startingPump;
				await pump.finish();
			}
			await rejectedClaim.promise;
			expect({ held, rejected, frames }).toEqual({ held: false, rejected: 1, frames: ["response.create"] });
			// Native socket I/O must race the real watchdog; fake time cannot drive that transport.
			await Bun.sleep(idleBudgetMs * 4);
			expect({ settled, fallback, closed }).toEqual({ settled: true, fallback: 1, closed: true });
			expect((await result).stopReason).toBe("error");
		} finally {
			held = false;
			paused.resolve();
			controller.abort();
			await pump.finish();
			await result;
			server.stop(true);
		}
	});
}
