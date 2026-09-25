import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { STREAM_HISTORY_LIMIT, STREAM_PROTO, type StreamHostFrame, type StreamServerToHost } from "@oh-my-pi/pi-wire";
import { STREAM_LOCAL_PROTO, type StreamStreamerFrame } from "../../src/stream/protocol";
import { resolveStreamUrls, StreamMuxHost, type StreamConsoleEvent } from "../../src/stream/streamer";

type HostSocketData = Record<string, never>;

interface FrameWaiter<T> {
	predicate: (frame: T) => boolean;
	resolve: (frame: T) => void;
}

interface FakeStreamServer {
	port: number;
	frames: StreamHostFrame[];
	hostSocket(): Bun.ServerWebSocket<HostSocketData> | null;
	waitForFrame(predicate: (frame: StreamHostFrame) => boolean): Promise<StreamHostFrame>;
	stop(): Promise<void>;
}

interface FakeSession {
	socket: net.Socket;
	frames: StreamStreamerFrame[];
	send(...frames: object[]): void;
	waitForFrame(predicate: (frame: StreamStreamerFrame) => boolean): Promise<StreamStreamerFrame>;
}

const hosts: StreamMuxHost[] = [];
const servers: FakeStreamServer[] = [];
const sessions: net.Socket[] = [];
const projectDirs: string[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) session.destroy();
	for (const host of hosts.splice(0)) await host.close();
	for (const server of servers.splice(0)) await server.stop();
	for (const projectDir of projectDirs.splice(0)) await fs.rm(projectDir, { recursive: true, force: true });
});

function waitForFrame<T>(
	frames: readonly T[],
	waiters: FrameWaiter<T>[],
	predicate: (frame: T) => boolean,
): Promise<T> {
	const existing = frames.find(predicate);
	if (existing !== undefined) return Promise.resolve(existing);
	const pending = Promise.withResolvers<T>();
	waiters.push({ predicate, resolve: pending.resolve });
	return pending.promise;
}

function recordFrame<T>(frames: T[], waiters: FrameWaiter<T>[], frame: T): void {
	frames.push(frame);
	for (let index = waiters.length - 1; index >= 0; index -= 1) {
		const waiter = waiters[index];
		if (!waiter.predicate(frame)) continue;
		waiters.splice(index, 1);
		waiter.resolve(frame);
	}
}

function startFakeStreamServer(port = 0): FakeStreamServer {
	const frames: StreamHostFrame[] = [];
	const waiters: FrameWaiter<StreamHostFrame>[] = [];
	let host: Bun.ServerWebSocket<HostSocketData> | null = null;
	const server = Bun.serve<HostSocketData>({
		hostname: "127.0.0.1",
		port,
		fetch(request, bunServer): Response | undefined {
			if (request.headers.get("authorization") !== "Bearer contract-token") {
				return new Response("unauthorized", { status: 401 });
			}
			if (bunServer.upgrade(request, { data: {} })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket): void {
				host = socket;
			},
			message(socket, message): void {
				const text = typeof message === "string" ? message : message.toString("utf8");
				const frame = JSON.parse(text) as StreamHostFrame;
				recordFrame(frames, waiters, frame);
				if (frame.t === "hello") {
					const welcome: StreamServerToHost = {
						t: "welcome",
						proto: STREAM_PROTO,
						channel: "contract-test",
						url: `http://127.0.0.1:${server.port}/contract-test`,
						user: "contract-host",
					};
					socket.send(JSON.stringify(welcome));
				}
			},
			close(socket): void {
				if (host === socket) host = null;
			},
		},
	});
	if (!server.port) throw new Error("fake stream server did not bind a port");
	let stopped = false;
	const fake: FakeStreamServer = {
		port: server.port,
		frames,
		hostSocket: () => host,
		waitForFrame: predicate => waitForFrame(frames, waiters, predicate),
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			await server.stop(true);
		},
	};
	servers.push(fake);
	return fake;
}

async function connectSession(endpoint: string): Promise<FakeSession> {
	const socket = net.createConnection({ path: endpoint });
	sessions.push(socket);
	const connected = Promise.withResolvers<void>();
	socket.once("connect", () => connected.resolve());
	socket.once("error", error => connected.reject(error));
	await connected.promise;
	const frames: StreamStreamerFrame[] = [];
	const waiters: FrameWaiter<StreamStreamerFrame>[] = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			recordFrame(frames, waiters, JSON.parse(line) as StreamStreamerFrame);
		}
	});
	return {
		socket,
		frames,
		send(...outgoing): void {
			socket.write(`${outgoing.map(frame => JSON.stringify(frame)).join("\n")}\n`);
		},
		waitForFrame: predicate => waitForFrame(frames, waiters, predicate),
	};
}

describe("resolveStreamUrls", () => {
	it("uses the identity-derived host endpoint", () => {
		expect(resolveStreamUrls("https://live.omp.sh")).toEqual({ hostUrl: "wss://live.omp.sh/ws/host" });
	});
});

describe("StreamMuxHost", () => {
	it("materializes patch, reset, and bounded history state across reconnect replays", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stream-test-"));
		projectDirs.push(projectDir);
		const firstServer = startFakeStreamServer();
		const port = firstServer.port;
		const events: StreamConsoleEvent[] = [];
		const host = new StreamMuxHost({
			projectDir,
			title: "Contract test",
			hostUrl: `ws://127.0.0.1:${port}/ws/host`,
			token: () => Promise.resolve("contract-token"),
			onEvent: event => events.push(event),
			reconnectDelay: () => 10,
		});
		hosts.push(host);
		const endpoint = await host.start();
		await firstServer.waitForFrame(frame => frame.t === "hello");

		const session = await connectSession(endpoint);
		const history = Array.from({ length: STREAM_HISTORY_LIMIT + 2 }, (_, index) => `history-${index}`);
		session.send(
			{ t: "hello", proto: STREAM_LOCAL_PROTO, sessionId: "session-1", title: "Pane one", cols: 80, rows: 2 },
			{ t: "history", rows: history },
			{ t: "viewport", rows: ["old-a", "old-b"] },
			{
				t: "patch",
				rows: 2,
				ops: [
					[1, "old-B"],
					[-1, "ignored"],
					[99, "ignored"],
				],
			},
			{ t: "paused", paused: true },
		);
		await firstServer.waitForFrame(frame => frame.t === "patch");
		expect(firstServer.frames.map(frame => frame.t)).toContain("pane-open");
		expect(firstServer.frames.map(frame => frame.t)).toContain("viewport");

		firstServer.hostSocket()?.send(JSON.stringify({ t: "viewers", n: 7 } satisfies StreamServerToHost));
		firstServer.hostSocket()?.send(
			JSON.stringify({
				t: "chat",
				msg: { id: 1, name: "viewer", text: "hello", ts: 1_700_000_000_000 },
			} satisfies StreamServerToHost),
		);
		await session.waitForFrame(frame => frame.t === "chat");
		expect(events).toContainEqual({
			t: "link",
			state: "live",
			detail: `http://127.0.0.1:${port}/contract-test`,
			channel: "contract-test",
			user: "contract-host",
		});
		expect(events).toContainEqual({
			t: "pane",
			action: "attached",
			id: 1,
			title: "Pane one",
			cols: 80,
			rows: 2,
		});
		expect(events).toContainEqual({ t: "viewers", n: 7 });
		expect(events).toContainEqual({
			t: "chat",
			msg: { id: 1, name: "viewer", text: "hello", ts: 1_700_000_000_000 },
		});
		expect(session.frames.find(frame => frame.t === "viewers")).toEqual({ t: "viewers", n: 7 });
		expect(session.frames.find(frame => frame.t === "chat")).toEqual({
			t: "chat",
			msg: { id: 1, name: "viewer", text: "hello", ts: 1_700_000_000_000 },
		});

		await firstServer.waitForFrame(frame => frame.t === "paused");
		await firstServer.stop();

		const secondServer = startFakeStreamServer(port);
		await secondServer.waitForFrame(frame => frame.t === "paused");
		expect(secondServer.frames.slice(0, 5)).toEqual([
			{ t: "hello", proto: STREAM_PROTO, title: "Contract test" },
			{ t: "pane-open", pane: 1, title: "Pane one", cols: 80, rows: 2 },
			{ t: "history", pane: 1, rows: history.slice(-STREAM_HISTORY_LIMIT) },
			{ t: "viewport", pane: 1, rows: ["old-a", "old-B"] },
			{ t: "paused", pane: 1, paused: true },
		]);

		session.send({ t: "reset" }, { t: "history", rows: ["after-reset"] });
		await secondServer.waitForFrame(
			frame => frame.t === "history" && frame.rows.length === 1 && frame.rows[0] === "after-reset",
		);
		await secondServer.stop();

		const thirdServer = startFakeStreamServer(port);
		await thirdServer.waitForFrame(frame => frame.t === "paused");
		expect(thirdServer.frames.slice(0, 5)).toEqual([
			{ t: "hello", proto: STREAM_PROTO, title: "Contract test" },
			{ t: "pane-open", pane: 1, title: "Pane one", cols: 80, rows: 2 },
			{ t: "history", pane: 1, rows: ["after-reset"] },
			{ t: "viewport", pane: 1, rows: [] },
			{ t: "paused", pane: 1, paused: true },
		]);
	});
});
