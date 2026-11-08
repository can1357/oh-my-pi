import { afterEach, expect, it, vi } from "bun:test";
import http2 from "node:http2";
import * as net from "node:net";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import * as proxy from "@oh-my-pi/pi-ai/utils/proxy";
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

function startRunSseServer(options: { runSseStatus?: number } = {}) {
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
				if (options.runSseStatus !== undefined) return new Response(null, { status: options.runSseStatus });
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

// HTTP/2 sessions are pointed at a server that drops the ClientHello; RunSSE still reaches the model.
async function interceptHttp2() {
	let connections = 0;
	const dropper = net.createServer(socket => {
		connections++;
		// Close only once the ClientHello arrives: closing on accept can reset the
		// socket before the client writes, which surfaces as a bare `read ECONNRESET`.
		socket.once("data", () => socket.destroy());
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
		get connections() {
			return connections;
		},
		close: () => dropper.close(),
	};
}

// A CONNECT proxy that accepts the tunnel, then drops the ClientHello; only the HTTP/2 path uses it.
async function interceptProxiedHttp2() {
	let tunnels = 0;
	const dropper = net.createServer(socket => {
		let request = "";
		const onData = (chunk: Buffer) => {
			request += chunk.toString("latin1");
			if (!request.includes("\r\n\r\n")) return;
			socket.off("data", onData);
			tunnels++;
			socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
			socket.once("data", () => socket.destroy());
		};
		socket.on("data", onData);
	});
	const listening = Promise.withResolvers<void>();
	dropper.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = dropper.address();
	if (!address || typeof address === "string") throw new Error("expected the dropper to bind a tcp port");
	vi.spyOn(proxy, "getProxyForUrl").mockReturnValue(`http://127.0.0.1:${address.port}`);
	return {
		get tunnels() {
			return tunnels;
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

const SETTLE_TIMEOUT_MS = 5_000;

afterEach(() => {
	vi.restoreAllMocks();
});

it(
	"falls back to RunSSE behind a proxy that drops HTTP/2, and starts the next ten minutes of turns there",
	async () => {
		const realNow = performance.now.bind(performance);
		let skew = 0;
		vi.spyOn(performance, "now").mockImplementation(() => realNow() + skew);
		const runSse = startRunSseServer();
		const proxy = await interceptHttp2();
		try {
			const model = makeModel(runSse.server.url.toString());
			const turn = () =>
				streamCursor(model, context, {
					apiKey: "test-token",
					providerRetryWait: async () => {},
				}).result();

			expect((await turn()).stopReason).toBe("stop");
			const dropped = proxy.connections;
			expect(dropped).toBeGreaterThan(0);

			expect((await turn()).stopReason).toBe("stop");
			expect(proxy.connections).toBe(dropped);

			skew += 10 * 60_000 + 1;
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

it(
	"keeps trying HTTP/2 on the next turn when the RunSSE fallback after a TLS reset fails",
	async () => {
		const runSse = startRunSseServer({ runSseStatus: 403 });
		const proxy = await interceptHttp2();
		try {
			const model = makeModel(runSse.server.url.toString());
			const turn = () =>
				streamCursor(model, context, {
					apiKey: "test-token",
					providerRetryWait: async () => {},
				}).result();

			expect((await turn()).stopReason).toBe("error");
			const dropped = proxy.connections;
			expect(dropped).toBeGreaterThan(0);
			expect(runSse.runSseOpens).toBeGreaterThan(0);

			expect((await turn()).stopReason).toBe("error");
			expect(proxy.connections).toBeGreaterThan(dropped);
		} finally {
			proxy.close();
			runSse.server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);

it(
	"falls back to RunSSE when the explicit proxy's tunnel drops the HTTP/2 handshake",
	async () => {
		const runSse = startRunSseServer();
		const proxied = await interceptProxiedHttp2();
		try {
			const result = await streamCursor(makeModel(runSse.server.url.toString()), context, {
				apiKey: "test-token",
				providerRetryWait: async () => {},
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(proxied.tunnels).toBeGreaterThan(0);
			expect(runSse.runSseOpens).toBe(1);
		} finally {
			proxied.close();
			runSse.server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);
