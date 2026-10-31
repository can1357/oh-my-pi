/**
 * The hold asked at the wrong moment lets a send out. Three shapes, each against a real TLS endpoint:
 *
 * - **A send on a connection already open.** Cursor's HTTP/2 run stream stays open while a tool runs,
 *   and the tool's result goes out as a new frame on it. Each frame asks the hold, so a run held while
 *   its tool ran sends no result.
 * - **Caller code between the admission and the send.** Codex tells its outbound observer about each
 *   frame; an observer that begins the owner's disposal must not let the frame it was told about out.
 *   The hold is asked again after the observer, right before the send.
 * - **A request admitted, whose bytes land later.** A request goes on the wire only after its TCP and
 *   TLS handshake (or WebSocket upgrade). A hold that begins in between cuts it, as a fetch is cut. A
 *   relay that accepts the connection but forwards nothing until released holds each request in its
 *   handshake while the hold begins.
 *
 * Every endpoint speaks TLS on `localhost` (`helpers/loopback-tls.ts`), as production does. Each case
 * counts what the endpoint receives, beside a live control that sends. The cases wait real time where
 * they assert that nothing arrives, which fake time can neither deliver nor rule out.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import http2 from "node:http2";
import * as net from "node:net";
import type { ServerWebSocket } from "bun";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	ReadArgsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCursorUsableModels } from "@oh-my-pi/pi-catalog/discovery/cursor";
import { coworkFetch } from "../src/providers/cowork-fetch";
import { streamCursor } from "../src/providers/cursor";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import { runInRequestHoldScope } from "../src/request-hold";
import type { Model } from "../src/types";
import { createCodexModel } from "./helpers";
import { LOOPBACK_CERT, LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

trustLoopbackTls();

/** What a direct `coworkFetch` call passes to trust the loopback certificate. */
const TRUST = { tls: { ca: [LOOPBACK_CERT] } } as RequestInit;

/** A Codex access token for a fresh account, so no state carries over between cases. */
function codexToken(): string {
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: crypto.randomUUID() } };
	return `aaa.${Buffer.from(JSON.stringify(claims)).toBase64()}.bbb`;
}

/** One Connect frame around `data`. */
function connectFrame(data: Uint8Array): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function cursorModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	}) as Model<"cursor-agent">;
}

/**
 * Cursor's HTTP/2 service: counts the run streams it accepts and the client messages on them by kind,
 * and answers a run's request with a `read` tool call, leaving the stream open for the result.
 */
async function cursorService() {
	const runs: string[] = [];
	const messages: string[] = [];
	const resultArrived = Promise.withResolvers<void>();
	const firstRun = Promise.withResolvers<void>();
	const sessions = new Set<http2.ServerHttp2Session>();
	const server = http2.createSecureServer({ ...LOOPBACK_TLS.tls });
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
		runs.push(String(headers[":path"]));
		firstRun.resolve();
		stream.on("error", () => {});
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		let buffer = Buffer.alloc(0);
		stream.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
				const length = buffer.readUInt32BE(1);
				const message = fromBinary(AgentClientMessageSchema, buffer.subarray(5, 5 + length));
				buffer = buffer.subarray(5 + length);
				const kind = message.message.case ?? "unknown";
				messages.push(kind);
				if (kind === "execClientMessage") resultArrived.resolve();
				if (kind === "runRequest") {
					const readCall = create(AgentServerMessageSchema, {
						message: {
							case: "execServerMessage",
							value: create(ExecServerMessageSchema, {
								id: 1,
								execId: "exec-1",
								message: {
									case: "readArgs",
									value: create(ReadArgsSchema, { path: "/held-test", toolCallId: "read-1" }),
								},
							}),
						},
					});
					stream.write(connectFrame(toBinary(AgentServerMessageSchema, readCall)));
				}
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "localhost", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as net.AddressInfo;
	return {
		port,
		url: `https://localhost:${port}`,
		runs,
		messages,
		results: () => messages.filter(kind => kind === "execClientMessage").length,
		resultArrived: resultArrived.promise,
		firstRun: firstRun.promise,
		stop: async () => {
			for (const session of sessions) session.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

/**
 * A TCP relay to `targetPort` that accepts each connection at once but forwards nothing either way
 * until released: a request through it is admitted and sent by the client, yet reaches the endpoint
 * only on release. A connection the client closed before then is never forwarded.
 */
async function handshakeRelay(targetPort: number) {
	const accepted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const sockets = new Set<net.Socket>();
	const server = net.createServer(client => {
		sockets.add(client);
		client.pause();
		let closed = false;
		client.on("close", () => {
			closed = true;
		});
		client.on("error", () => {});
		accepted.resolve();
		void release.promise.then(() => {
			if (closed || client.destroyed) return;
			const upstream = net.connect(targetPort, "localhost");
			sockets.add(upstream);
			upstream.on("error", () => client.destroy());
			client.on("close", () => upstream.destroy());
			upstream.on("close", () => client.destroy());
			client.pipe(upstream);
			upstream.pipe(client);
			client.resume();
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "localhost", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as net.AddressInfo;
	return {
		url: `https://localhost:${port}`,
		accepted: accepted.promise,
		release: () => release.resolve(),
		stop: () => {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

describe("a send asked of the hold at the wrong moment", () => {
	let held: AbortController;
	let ended: AbortController;
	let request: AbortController;
	const cleanups: Array<() => unknown> = [];

	beforeEach(() => {
		held = new AbortController();
		ended = new AbortController();
		request = new AbortController();
	});

	afterEach(async () => {
		request.abort();
		ended.abort();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	const inScope = <T>(fn: () => T): T => runInRequestHoldScope(held.signal, ended.signal, fn);

	describe("a tool result on Cursor's open HTTP/2 run stream", () => {
		/** Run until the read tool is entered, begin the hold if asked, then let the tool return. */
		async function toolResultAfter(hold: boolean) {
			const service = await cursorService();
			cleanups.push(() => service.stop());
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			cleanups.push(() => release.resolve());
			const run = inScope(() =>
				streamCursor(
					cursorModel(service.url),
					{ messages: [{ role: "user", content: "read the file", timestamp: 1 }] },
					{
						apiKey: "cursor-test-token",
						transport: "http2",
						signal: request.signal,
						execHandlers: {
							read: async (args: { toolCallId: string }) => {
								entered.resolve();
								await release.promise;
								return {
									role: "toolResult" as const,
									toolCallId: args.toolCallId,
									toolName: "read",
									content: [{ type: "text" as const, text: "file contents" }],
									isError: false,
									timestamp: 1,
								};
							},
						},
					},
				).result(),
			).catch(() => undefined);
			await entered.promise;
			if (hold) held.abort();
			release.resolve();
			await Promise.race([service.resultArrived, Bun.sleep(600)]);
			const counts = { runs: service.runs.length, results: service.results() };
			request.abort();
			ended.abort();
			await run;
			return counts;
		}

		it("is not sent once the run is held while its tool runs", async () => {
			expect(await toolResultAfter(true)).toEqual({ runs: 1, results: 0 });
		});

		it("is sent when the run is not held (control)", async () => {
			expect(await toolResultAfter(false)).toEqual({ runs: 1, results: 1 });
		});
	});

	describe("a Codex frame whose outbound observer begins the owner's disposal", () => {
		/** Stream one turn; the observer sees the outgoing `response.create` and begins the hold if asked. */
		async function frameAfterObserver(hold: boolean) {
			const frames: string[] = [];
			let observed = 0;
			const arrived = Promise.withResolvers<void>();
			const server = Bun.serve({
				...LOOPBACK_TLS,
				port: 0,
				fetch(incoming, server) {
					if (server.upgrade(incoming, { data: undefined })) return undefined;
					return new Response("WebSocket required", { status: 400 });
				},
				websocket: {
					message(socket: ServerWebSocket<unknown>, message) {
						const frame = JSON.parse(String(message)) as { type: string };
						frames.push(frame.type);
						arrived.resolve();
						socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
						socket.send(
							JSON.stringify({
								type: "response.completed",
								response: {
									id: "resp_1",
									status: "completed",
									usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
								},
							}),
						);
					},
				},
			});
			cleanups.push(() => server.stop(true));
			const model: Model<"openai-codex-responses"> = {
				...createCodexModel("gpt-5.5"),
				baseUrl: loopbackOrigin(server),
			};
			const turn = inScope(() =>
				streamOpenAICodexResponses(
					model,
					{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
					{
						apiKey: codexToken(),
						sessionId: crypto.randomUUID(),
						providerSessionState: new Map(),
						preferWebsockets: true,
						signal: request.signal,
						onSseEvent: event => {
							if (event.event !== "response.create") return;
							observed++;
							if (hold) held.abort();
						},
					},
				).result(),
			).catch(() => undefined);
			await Promise.race([arrived.promise, Bun.sleep(600)]);
			const counts = { observed, frames: frames.length };
			request.abort();
			ended.abort();
			await turn;
			return counts;
		}

		it("is not sent", async () => {
			expect(await frameAfterObserver(true)).toEqual({ observed: 1, frames: 0 });
		});

		it("is sent when the observer begins nothing (control)", async () => {
			expect(await frameAfterObserver(false)).toEqual({ observed: 1, frames: 1 });
		});
	});

	describe("a request whose hold begins during its connection handshake", () => {
		/** Start `send` through a relay that holds its handshake, begin the hold if asked, then release. */
		async function throughHeldHandshake(
			targetPort: number,
			hold: boolean,
			send: (origin: string) => Promise<unknown>,
			arrived: Promise<void>,
		): Promise<void> {
			const relay = await handshakeRelay(targetPort);
			cleanups.push(() => relay.stop());
			const pending = inScope(() => send(relay.url)).catch(() => undefined);
			await relay.accepted;
			if (hold) held.abort();
			relay.release();
			await Promise.race([arrived, Bun.sleep(800)]);
			request.abort();
			ended.abort();
			await pending;
		}

		describe("Anthropic's node:https transport (coworkFetch)", () => {
			async function requestsAfter(hold: boolean): Promise<number> {
				let requests = 0;
				const arrived = Promise.withResolvers<void>();
				const server = Bun.serve({
					...LOOPBACK_TLS,
					port: 0,
					fetch: async incoming => {
						await incoming.arrayBuffer();
						requests++;
						arrived.resolve();
						return new Response("ok");
					},
				});
				cleanups.push(() => server.stop(true));
				await throughHeldHandshake(
					server.port!,
					hold,
					origin =>
						coworkFetch(`${origin}/v1/messages`, {
							method: "POST",
							headers: { "x-api-key": "test-key", "content-type": "application/json" },
							body: "{}",
							signal: request.signal,
							...TRUST,
						}).then(response => response.text()),
					arrived.promise,
				);
				return requests;
			}

			it("is cut, and the endpoint receives nothing", async () => {
				expect(await requestsAfter(true)).toBe(0);
			});

			it("is sent when no hold began (control)", async () => {
				expect(await requestsAfter(false)).toBe(1);
			});
		});

		describe("Cursor's HTTP/2 run", () => {
			async function runsAfter(hold: boolean): Promise<number> {
				const service = await cursorService();
				cleanups.push(() => service.stop());
				await throughHeldHandshake(
					service.port,
					hold,
					origin =>
						streamCursor(
							cursorModel(origin),
							{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
							{ apiKey: "cursor-test-token", transport: "http2", signal: request.signal },
						).result(),
					service.firstRun,
				);
				return service.runs.length;
			}

			it("is cut, and the service receives no run", async () => {
				expect(await runsAfter(true)).toBe(0);
			});

			it("is sent when no hold began (control)", async () => {
				expect(await runsAfter(false)).toBe(1);
			});
		});

		describe("the Codex WebSocket upgrade", () => {
			async function upgradesAfter(hold: boolean): Promise<number> {
				let upgrades = 0;
				const arrived = Promise.withResolvers<void>();
				const server = Bun.serve({
					...LOOPBACK_TLS,
					port: 0,
					fetch(incoming, server) {
						upgrades++;
						arrived.resolve();
						if (server.upgrade(incoming, { data: undefined })) return undefined;
						return new Response("WebSocket required", { status: 400 });
					},
					websocket: { message() {} },
				});
				cleanups.push(() => server.stop(true));
				await throughHeldHandshake(
					server.port!,
					hold,
					origin =>
						streamOpenAICodexResponses(
							{ ...createCodexModel("gpt-5.5"), baseUrl: origin },
							{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
							{
								apiKey: codexToken(),
								sessionId: crypto.randomUUID(),
								providerSessionState: new Map(),
								preferWebsockets: true,
								signal: request.signal,
							},
						).result(),
					arrived.promise,
				);
				return upgrades;
			}

			it("is cut, and the server receives no upgrade", async () => {
				expect(await upgradesAfter(true)).toBe(0);
			});

			it("is sent when no hold began (control)", async () => {
				expect(await upgradesAfter(false)).toBe(1);
			});
		});
	});

	describe("Cursor model discovery (pi-catalog), which falls back from fetch to HTTP/2", () => {
		/**
		 * Cursor's discovery service over TLS, speaking HTTP/1.1 (unless `http2Only`) and HTTP/2. Each
		 * request is recorded with its protocol, its credential, and whether the caller's scope had ended.
		 * HTTP/1.1 requests are answered only when `answerHttp1`, so a fetch leg can be left in flight.
		 */
		async function discoveryService(options: { http2Only?: boolean; answerHttp1?: boolean }) {
			const requests: Array<{ http2: boolean; bearer: boolean; afterEnded: boolean }> = [];
			const http1Arrived = Promise.withResolvers<void>();
			const server = http2.createSecureServer({ ...LOOPBACK_TLS.tls, allowHTTP1: !options.http2Only });
			const streams = new Set<http2.Http2Session>();
			server.on("session", session => {
				streams.add(session);
				session.on("close", () => streams.delete(session));
			});
			server.on("request", (incoming: http2.Http2ServerRequest, response: http2.Http2ServerResponse) => {
				const http2Request = incoming.httpVersion === "2.0";
				requests.push({
					http2: http2Request,
					bearer: String(incoming.headers.authorization ?? "").startsWith("Bearer "),
					afterEnded: ended.signal.aborted,
				});
				if (!http2Request) {
					http1Arrived.resolve();
					if (!options.answerHttp1) return;
				}
				incoming.resume();
				response.writeHead(200, { "content-type": "application/proto" });
				response.end();
			});
			const listening = Promise.withResolvers<void>();
			server.listen(0, "localhost", () => listening.resolve());
			await listening.promise;
			const { port } = server.address() as net.AddressInfo;
			cleanups.push(async () => {
				for (const session of streams) session.destroy();
				const closed = Promise.withResolvers<void>();
				server.close(() => closed.resolve());
				await closed.promise;
			});
			return {
				url: `https://localhost:${port}`,
				requests,
				http1Arrived: http1Arrived.promise,
				http2Requests: () => requests.filter(entry => entry.http2).length,
			};
		}

		const discover = (baseUrl: string) =>
			fetchCursorUsableModels({ apiKey: "cursor-session-token", baseUrl, timeoutMs: 4_000 });

		it("sends nothing over HTTP/2 when its held fetch is refused at the end of its scope", async () => {
			const service = await discoveryService({});
			held.abort();
			const pending = inScope(() => discover(service.url)).catch(() => undefined);
			await Bun.sleep(300);
			ended.abort();
			await pending;
			await Bun.sleep(300);

			expect({ requests: service.requests.length }).toEqual({ requests: 0 });
		});

		it("sends nothing over HTTP/2 when the hold begins while its fetch is in flight", async () => {
			// The fetch leg reaches the service, which does not answer; the hold then cuts it, and the
			// HTTP/2 fallback must ask the hold itself.
			const service = await discoveryService({ answerHttp1: false });
			const pending = inScope(() => discover(service.url)).catch(() => undefined);
			await service.http1Arrived;
			await Bun.sleep(50);
			held.abort();
			await Bun.sleep(300);
			ended.abort();
			await pending;
			await Bun.sleep(300);

			expect({ http2Requests: service.http2Requests() }).toEqual({ http2Requests: 0 });
		});

		it("falls back to HTTP/2, with its credential, when the fetch fails and no hold began (control)", async () => {
			const service = await discoveryService({ http2Only: true });
			await inScope(() => discover(service.url));

			expect({
				http2Requests: service.http2Requests(),
				bearer: service.requests.every(entry => entry.bearer),
			}).toEqual({ http2Requests: 3, bearer: true });
		});
	});
});
