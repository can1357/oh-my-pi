import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	ResponsesWebSocketConnection,
	type ResponsesWebSocketConnectionOptions,
	ResponsesWebSocketTransportError,
} from "../src/providers/responses-websocket-connection";

const connections: ResponsesWebSocketConnection[] = [];
let server: Bun.Server<undefined>;
let beforeUpgrade: (() => Promise<void>) | undefined;
let onMessage: (socket: Bun.ServerWebSocket<undefined>, frame: Record<string, unknown>) => void;
let upgrades: number;
let sent: Record<string, unknown>[];
let rejectedBody: string | ReadableStream<Uint8Array>;

beforeEach(() => {
	beforeUpgrade = undefined;
	upgrades = 0;
	sent = [];
	rejectedBody = "upgrade is not supported";
	onMessage = socket => socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }));
	server = Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, server) {
			if (new URL(request.url).pathname === "/reject") {
				return new Response(rejectedBody, { status: 426, headers: { "x-upgrade-reason": "unsupported" } });
			}
			upgrades += 1;
			await beforeUpgrade?.();
			if (server.upgrade(request, { data: undefined })) return;
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			message(socket, message) {
				const frame = JSON.parse(String(message)) as Record<string, unknown>;
				sent.push(frame);
				onMessage(socket, frame);
			},
		},
	});
});

afterEach(() => {
	for (const connection of connections.splice(0)) connection.close();
	server.stop(true);
});

function connection(options: Partial<ResponsesWebSocketConnectionOptions> = {}): ResponsesWebSocketConnection {
	const value = new ResponsesWebSocketConnection({
		url: `ws://127.0.0.1:${server.port}/responses`,
		headers: {},
		connectTimeoutMs: 1_000,
		maxIdleReuseMs: 30_000,
		messageQueueCapacity: 4096,
		...options,
	});
	connections.push(value);
	return value;
}

describe("Responses physical WebSocket channel", () => {
	it("lets an aborted handshake joiner leave without cancelling the owner", async () => {
		const entered = Promise.withResolvers<void>();
		const allowUpgrade = Promise.withResolvers<void>();
		beforeUpgrade = () => {
			entered.resolve();
			return allowUpgrade.promise;
		};
		const socket = connection();
		const owner = socket.connect();
		try {
			await entered.promise;
			const controller = new AbortController();
			const joining = socket.connect(controller.signal);
			const reason = new Error("joiner cancelled");
			controller.abort(reason);
			await expect(joining).rejects.toMatchObject({ reason: "aborted", phase: "connect", cause: reason });
			expect(socket.isConnecting()).toBe(true);
			expect(socket.hasActiveRequest()).toBe(false);
			allowUpgrade.resolve();
			await owner;
			expect(socket.isHealthyForReuse()).toBe(true);
			expect(upgrades).toBe(1);
		} finally {
			allowUpgrade.resolve();
			await owner.catch(() => {});
		}
	});

	it("settles every handshake waiter when the owner cancels and never reopens that channel", async () => {
		const entered = Promise.withResolvers<void>();
		const allowUpgrade = Promise.withResolvers<void>();
		beforeUpgrade = () => {
			entered.resolve();
			return allowUpgrade.promise;
		};
		const socket = connection();
		const controller = new AbortController();
		// Observe both rejections immediately: abort settles the owner and every
		// joiner in the same turn, before sequential rejection assertions resume.
		const owner = socket.connect(controller.signal).then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await entered.promise;
			const joining = socket.connect().then(
				() => undefined,
				(error: unknown) => error,
			);
			const reason = new Error("owner cancelled");
			controller.abort(reason);
			expect(await owner).toBeInstanceOf(ResponsesWebSocketTransportError);
			expect(await owner).toMatchObject({ reason: "aborted", phase: "connect", cause: reason });
			expect(await joining).toMatchObject({ reason: "aborted", phase: "connect", cause: reason });
			socket.close();
			await expect(socket.connect()).rejects.toMatchObject({ reason: "aborted" });
			expect(socket.isOpen()).toBe(false);
			expect(socket.isConnecting()).toBe(false);
			expect(upgrades).toBe(1);
		} finally {
			allowUpgrade.resolve();
			await owner.catch(() => {});
		}
	});

	it("releases reader ownership when the ownership callback throws", async () => {
		const socket = connection();
		await socket.connect();
		const error = new Error("ownership hook failed");
		const failed = socket.streamRequest({ send: { type: "response.create" } }, {}, undefined, undefined, () => {
			throw error;
		});
		await expect(failed.next()).rejects.toBe(error);
		expect(socket.hasActiveRequest()).toBe(false);
		expect(sent).toHaveLength(0);
		const result: Record<string, unknown>[] = [];
		for await (const frame of socket.streamRequest({ send: { type: "response.create" } }, {})) result.push(frame);
		expect(result).toEqual([{ type: "response.completed", response: { id: "resp_1" } }]);
		expect(sent).toHaveLength(1);
	});

	it("handles controls without a reader and receives queued successors without sending or draining them", async () => {
		const acknowledged = Promise.withResolvers<void>();
		const successorQueued = Promise.withResolvers<void>();
		onMessage = socket => {
			socket.send(JSON.stringify({ type: "response.steer.accepted" }));
			socket.send(JSON.stringify({ type: "response.steer.failed" }));
			socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_successor" } }));
			socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_successor" } }));
			socket.send(JSON.stringify({ type: "response.steer.pending" }));
		};
		const socket = connection({
			controlFrames: {
				consume(frame) {
					if (frame.type === "response.steer.accepted") {
						acknowledged.resolve();
						return true;
					}
					if (frame.type === "response.steer.failed") return new Error("late commit failure");
					if (frame.type === "response.steer.pending") {
						successorQueued.resolve();
						return true;
					}
					return false;
				},
				closed() {},
			},
		});
		await socket.connect();
		socket.sendControl({ type: "response.steer" });
		await acknowledged.promise;
		await successorQueued.promise;
		const result: Record<string, unknown>[] = [];
		for await (const frame of socket.streamRequest({ receive: true }, {})) result.push(frame);
		expect(result).toEqual([
			{ type: "response.created", response: { id: "resp_successor" } },
			{ type: "response.completed", response: { id: "resp_successor" } },
		]);
		expect(sent).toEqual([{ type: "response.steer" }]);
	});

	it("does not replace a queued terminal with an eager close when the consumer breaks", async () => {
		onMessage = socket => {
			socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }));
			socket.close(1011, "after completion");
		};
		const socket = connection();
		await socket.connect();
		const result: Record<string, unknown>[] = [];
		for await (const frame of socket.streamRequest({ send: { type: "response.create" } }, {})) {
			result.push(frame);
			break;
		}
		expect(result).toEqual([{ type: "response.completed", response: { id: "resp_1" } }]);
		expect(socket.hasActiveRequest()).toBe(false);
	});

	it("wakes an active reader and controls exactly once when explicitly closed", async () => {
		const received = Promise.withResolvers<void>();
		onMessage = () => received.resolve();
		const closed: Error[] = [];
		const socket = connection({ controlFrames: { consume: () => false, closed: error => closed.push(error) } });
		await socket.connect();
		const reader = socket.streamRequest({ send: { type: "response.create" } }, {});
		const pending = reader.next();
		await received.promise;
		socket.close("session-reset");
		socket.close("again");
		await expect(pending).rejects.toMatchObject({
			reason: "closed",
			phase: "stream",
			message: "websocket closed (session-reset)",
		});
		expect(closed).toHaveLength(1);
		expect(socket.hasActiveRequest()).toBe(false);
	});

	it("rejects a second reader without sending or disturbing the owner", async () => {
		const received = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
		onMessage = socket => received.resolve(socket);
		const socket = connection();
		await socket.connect();
		const owner = socket.streamRequest({ send: { type: "response.create" } }, {});
		const pending = owner.next();
		const serverSocket = await received.promise;
		const contender = socket.streamRequest({ send: { type: "response.create" } }, {});
		await expect(contender.next()).rejects.toMatchObject({ reason: "busy", phase: "stream" });
		expect(socket.hasActiveRequest()).toBe(true);
		expect(sent).toHaveLength(1);
		serverSocket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }));
		expect((await pending).value).toEqual({ type: "response.completed", response: { id: "resp_1" } });
		await owner.return(undefined);
		expect(socket.hasActiveRequest()).toBe(false);
	});

	it("reports first-event deadlines without closing or replaying the request", async () => {
		onMessage = () => {};
		const socket = connection();
		await socket.connect();
		const reader = socket.streamRequest({ send: { type: "response.create" } }, { firstEventTimeoutMs: 10 });
		await expect(reader.next()).rejects.toMatchObject({
			reason: "timeout",
			phase: "first-event",
			message: "timeout waiting for first websocket event (last event: none; last progress: none)",
		});
		expect(sent).toHaveLength(1);
		expect(socket.isOpen()).toBe(true);
		expect(socket.hasActiveRequest()).toBe(false);
	});

	it("reports rejected-upgrade metadata and releases a streaming rejection without consuming its body", async () => {
		const cancelled = Promise.withResolvers<void>();
		rejectedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				// Leave the body unfinished: connect must not wait for its tail.
				controller.enqueue(new TextEncoder().encode("upgrade "));
			},
			cancel() {
				cancelled.resolve();
			},
		});
		const closed: Error[] = [];
		const socket = connection({
			url: `ws://127.0.0.1:${server.port}/reject`,
			inspectUpgradeResponse: true,
			controlFrames: { consume: () => false, closed: error => closed.push(error) },
		});
		const controller = new AbortController();
		let rejection: ResponsesWebSocketTransportError | undefined;
		try {
			await socket.connect(controller.signal);
			throw new Error("expected rejected upgrade");
		} catch (error) {
			expect(error).toBeInstanceOf(ResponsesWebSocketTransportError);
			if (!(error instanceof ResponsesWebSocketTransportError)) throw error;
			rejection = error;
			expect(error).toMatchObject({
				reason: "upgrade",
				phase: "connect",
				status: 426,
				message: "websocket upgrade rejected (HTTP 426)",
			});
			expect(error.headers?.get("x-upgrade-reason")).toBe("unsupported");
		}
		await cancelled.promise;
		controller.abort(new Error("consumer cancelled after rejection"));
		socket.close("released");
		socket.close("again");
		expect(socket.isOpen()).toBe(false);
		expect(socket.isConnecting()).toBe(false);
		expect(closed).toEqual([rejection]);
		expect(sent).toHaveLength(0);
		await expect(socket.connect()).rejects.toBe(rejection);
	});
});
