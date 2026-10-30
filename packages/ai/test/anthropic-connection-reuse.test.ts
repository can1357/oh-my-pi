import { afterEach, describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const SSE_EVENTS = [
	{
		type: "message_start",
		message: {
			id: "msg_reuse",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
];
const SSE = new TextEncoder().encode(
	SSE_EVENTS.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
);

/**
 * An Anthropic endpoint that flushes `message_stop` and ends the chunked body
 * only once `tail` resolves, as a relay that forwards the terminal chunk
 * separately. Records each request's client port so connection reuse is
 * observable, and whether the client cancelled a body still open.
 */
function startUpstream(tail: () => Promise<void>) {
	const clientPorts: number[] = [];
	const cancelled: boolean[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const peer = srv.requestIP(request);
			if (peer) clientPorts.push(peer.port);
			const slot = cancelled.push(false) - 1;
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(SSE);
					await tail();
					if (!cancelled[slot]) controller.close();
				},
				cancel() {
					cancelled[slot] = true;
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { server, clientPorts, cancelled };
}

let stop: (() => void) | undefined;
afterEach(() => {
	stop?.();
	stop = undefined;
});

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function modelAt(baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

describe("anthropic stream after message_stop", () => {
	it("reads the body to its end so the next request reuses the kept-alive connection", async () => {
		// A real socket and Bun's fetch pool decide reuse, so the trailing chunk has to
		// arrive in a separate write after a genuine delay; fake timers cannot drive either.
		const { server, clientPorts, cancelled } = startUpstream(() => Bun.sleep(50));
		stop = () => server.stop(true);
		const model = modelAt(server.url.toString());
		for (let i = 0; i < 3; i++) {
			// `waitForTerminalDrain` resolves the turn only after the bounded drain, so the
			// next request starts once the previous connection is back in the pool.
			const reply = await streamAnthropic(model, context, {
				apiKey: "sk-test",
				waitForTerminalDrain: true,
			}).result();
			expect(reply.stopReason).toBe("stop");
			expect(reply.content).toMatchObject([{ type: "text", text: "ok" }]);
		}
		expect(cancelled).toEqual([false, false, false]);
		expect(clientPorts).toHaveLength(3);
		expect(new Set(clientPorts).size).toBe(1);
	});

	it("completes the turn while a body that stays open after message_stop is still being drained", async () => {
		const gate = Promise.withResolvers<void>();
		const { server, cancelled } = startUpstream(() => gate.promise);
		stop = () => {
			gate.resolve();
			server.stop(true);
		};
		const reply = await streamAnthropic(modelAt(server.url.toString()), context, { apiKey: "sk-test" }).result();
		expect(reply.stopReason).toBe("stop");
		// The body is still open: the turn did not wait for it, and nothing cancelled it yet.
		expect(cancelled).toEqual([false]);
	});
});
