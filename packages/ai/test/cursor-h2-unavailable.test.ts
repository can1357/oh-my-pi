import { afterEach, expect, it, vi } from "bun:test";
import http2 from "node:http2";
import * as net from "node:net";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiRequestIdSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function update(message: InteractionUpdate["message"]): Buffer {
	const data = toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
		}),
	);
	const out = Buffer.alloc(5 + data.length);
	out.writeUInt32BE(data.length, 1);
	out.set(data, 5);
	return out;
}

/** Answers each RunSSE turn with one text delta and `turnEnded` once its first BidiAppend arrives. */
function startRunSseServer() {
	const streams = new Map<string, PromiseWithResolvers<ReadableStreamDefaultController<Uint8Array>>>();
	const streamFor = (requestId: string) => {
		let entry = streams.get(requestId);
		if (!entry) {
			entry = Promise.withResolvers();
			streams.set(requestId, entry);
		}
		return entry;
	};
	const answered = new Set<string>();
	let runSseOpens = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = new Uint8Array(await request.arrayBuffer());
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				runSseOpens++;
				const { requestId } = fromBinary(BidiRequestIdSchema, body.subarray(5));
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamFor(requestId).resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				const requestId = fromBinary(BidiAppendRequestSchema, body).requestId?.requestId ?? "";
				if (!answered.has(requestId)) {
					answered.add(requestId);
					const controller = await streamFor(requestId).promise;
					controller.enqueue(
						update({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "http1 ok" }) }),
					);
					controller.enqueue(update({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) }));
					controller.close();
				}
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});
	return {
		server,
		get runSseOpens() {
			return runSseOpens;
		},
	};
}

/**
 * Stands in for a TLS-intercepting proxy without HTTP/2 support: it closes the
 * connection before the TLS handshake completes. HTTP/2 sessions are pointed
 * at it, so the client sees the real handshake failure; RunSSE still reaches
 * the model's base URL.
 */
async function interceptHttp2() {
	let connections = 0;
	const dropper = net.createServer(socket => {
		connections++;
		socket.destroy();
	});
	const listening = Promise.withResolvers<void>();
	dropper.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = dropper.address();
	if (!address || typeof address === "string") throw new Error("expected the dropper to bind a tcp port");
	const realConnect = http2.connect;
	vi.spyOn(http2, "connect").mockImplementation(((_authority: string, ...rest: unknown[]) =>
		Reflect.apply(realConnect, http2, [`https://127.0.0.1:${address.port}`, ...rest])) as typeof http2.connect);
	return {
		/** TLS connections the proxy has dropped. */
		get connections() {
			return connections;
		},
		close: () => dropper.close(),
	};
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-h2-unavailable-fixture",
		name: "Cursor h2 unavailable fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = { messages: [{ role: "user", content: "transport", timestamp: 1 }] };

/** A turn that never settles fails the test at this bound instead of hanging the suite. */
const SETTLE_TIMEOUT_MS = 5_000;

afterEach(() => {
	vi.restoreAllMocks();
});

it(
	"falls back to RunSSE behind a proxy that drops HTTP/2, and starts the next ten minutes of turns there",
	async () => {
		let now = Date.UTC(2026, 0, 1);
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const runSse = startRunSseServer();
		const proxy = await interceptHttp2();
		try {
			const model = makeModel(runSse.server.url.toString());
			const turn = () =>
				streamCursor(model, context, {
					apiKey: "test-token",
					// Without the fallback the turn retries HTTP/2; skip those waits so it fails fast.
					providerRetryWait: async () => {},
				}).result();

			expect((await turn()).stopReason).toBe("stop");
			const dropped = proxy.connections;
			expect(dropped).toBeGreaterThan(0);

			// The next turn skips the handshake the proxy would drop again.
			expect((await turn()).stopReason).toBe("stop");
			expect(proxy.connections).toBe(dropped);

			// Ten minutes later, HTTP/2 is tried again in case the network changed.
			now += 10 * 60_000;
			expect((await turn()).stopReason).toBe("stop");
			expect(proxy.connections).toBeGreaterThan(dropped);
			expect(runSse.runSseOpens).toBe(3);
		} finally {
			proxy.close();
			runSse.server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);
