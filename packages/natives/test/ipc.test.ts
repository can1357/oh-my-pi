import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	IpcConnection,
	type IpcConnectOptions,
	type IpcListenOptions,
	IpcServer,
	ipcEndpoint,
} from "../native/index.js";

const isWindows = process.platform === "win32";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ipc-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

async function endpointIn(): Promise<string> {
	return ipcEndpoint(await tempDir(), `ep-${process.pid}-${cleanups.length}`);
}

async function listen(
	endpoint: string,
	options: IpcListenOptions,
	onConnection: (connection: IpcConnection) => void,
): Promise<IpcServer> {
	const server = await IpcServer.listen(endpoint, options, onConnection);
	cleanups.push(() => server.close());
	return server;
}

async function connect(endpoint: string, options: IpcConnectOptions): Promise<IpcConnection> {
	const connection = await IpcConnection.connect(endpoint, options);
	cleanups.push(() => connection.destroy());
	return connection;
}

async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
	try {
		await promise;
	} catch (error) {
		return error as Error & { code?: string };
	}
	throw new Error("expected rejection");
}

/** Frames and the close of one started lines connection, in arrival order. */
interface Recorded {
	events: string[];
	closes: number;
	reason: string | null | undefined;
	closed: Promise<void>;
	/** Resolves once at least `count` events (frames + close) arrived. */
	until(count: number): Promise<void>;
}

function record(connection: IpcConnection): Recorded {
	const closed = Promise.withResolvers<void>();
	const waiters: { count: number; resolve: () => void }[] = [];
	const recorded: Recorded = {
		events: [],
		closes: 0,
		reason: undefined,
		closed: closed.promise,
		until(count) {
			if (recorded.events.length >= count) return Promise.resolve();
			const waiter = Promise.withResolvers<void>();
			waiters.push({ count, resolve: waiter.resolve });
			return waiter.promise;
		},
	};
	const push = (event: string) => {
		recorded.events.push(event);
		for (const waiter of waiters) if (recorded.events.length >= waiter.count) waiter.resolve();
	};
	connection.start(push, reason => {
		recorded.closes++;
		recorded.reason = reason;
		push("<close>");
		closed.resolve();
	});
	return recorded;
}

/** Server whose accepted connections resolve `accepted` in order. */
async function acceptingServer(endpoint: string, options: IpcListenOptions) {
	const accepted = Promise.withResolvers<IpcConnection>();
	const server = await listen(endpoint, options, connection => accepted.resolve(connection));
	return { server, accepted: accepted.promise };
}

/** Leave a socket file with no listener behind by SIGKILLing its owner. */
async function staleSocket(endpoint: string): Promise<void> {
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`require("node:net").createServer().listen(${JSON.stringify(endpoint)}, () => process.kill(process.pid, "SIGKILL"))`,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	await child.exited;
	expect((await fs.lstat(endpoint)).isSocket()).toBe(true);
}

describe("native IPC", () => {
	test("lines echo round-trip", async () => {
		const endpoint = await endpointIn();
		await listen(endpoint, { framing: "lines" }, connection => {
			connection.start(
				line => connection.send(`echo:${line}`),
				() => {},
			);
		});
		const client = await connect(endpoint, { framing: "lines" });
		const seen = record(client);
		expect(client.send("hello")).toBe(true);
		expect(client.send("wörld ✓")).toBe(true);
		await seen.until(2);
		expect(seen.events).toEqual(["echo:hello", "echo:wörld ✓"]);
		expect(() => client.send("bad\nline")).toThrow(TypeError);
		expect(() => client.send(new Uint8Array([1]))).toThrow(TypeError);
		expect(() =>
			client.startRaw(
				() => {},
				() => {},
			),
		).toThrow(TypeError);
	});

	test("raw round-trip", async () => {
		const endpoint = await endpointIn();
		await listen(endpoint, { framing: "raw" }, connection => {
			connection.startRaw(
				chunk => connection.send(chunk),
				() => {},
			);
		});
		const client = await connect(endpoint, { framing: "raw" });
		const payload = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256);
		const expected = [...payload, 0xc3, 0xbf];
		const received: number[] = [];
		const done = Promise.withResolvers<void>();
		client.startRaw(
			chunk => {
				expect(chunk).toBeInstanceOf(Uint8Array);
				received.push(...chunk);
				if (received.length >= expected.length) done.resolve();
			},
			() => {},
		);
		client.send(payload.subarray(0, 3));
		client.send(payload.subarray(3));
		client.send("\u00ff");
		await done.promise;
		expect(received).toEqual(expected);
		expect(() =>
			client.start(
				() => {},
				() => {},
			),
		).toThrow(TypeError);
	});

	test("frames sent before start() are delivered", async () => {
		const endpoint = await endpointIn();
		const { accepted } = await acceptingServer(endpoint, { framing: "lines" });
		const client = await connect(endpoint, { framing: "lines" });
		client.send("one");
		client.send("two");
		client.end();
		await client.drained();
		const seen = record(await accepted);
		await seen.closed;
		expect(seen.events).toEqual(["one", "two", "<close>"]);
		expect(seen.reason).toBeNull();
		expect(() => record(client)).not.toThrow();
		expect(() =>
			client.start(
				() => {},
				() => {},
			),
		).toThrow();
	});

	test("listen on a live endpoint rejects EADDRINUSE", async () => {
		const endpoint = await endpointIn();
		await listen(endpoint, { framing: "lines" }, () => {});
		const error = await rejection(IpcServer.listen(endpoint, { framing: "lines" }, () => {}));
		expect(error.code).toBe("EADDRINUSE");
	});

	test.skipIf(isWindows)("a stale socket file is taken over", async () => {
		const endpoint = await endpointIn();
		await staleSocket(endpoint);
		const { accepted } = await acceptingServer(endpoint, { framing: "lines" });
		await connect(endpoint, { framing: "lines" });
		expect(await accepted).toBeInstanceOf(IpcConnection);
	});

	test("connect to a missing endpoint rejects ENOENT", async () => {
		const endpoint = await endpointIn();
		const error = await rejection(IpcConnection.connect(endpoint, { framing: "lines" }));
		expect(error.code).toBe("ENOENT");
	});

	test.skipIf(isWindows)("connect to a stale socket file rejects ECONNREFUSED", async () => {
		const endpoint = await endpointIn();
		await staleSocket(endpoint);
		const error = await rejection(IpcConnection.connect(endpoint, { framing: "lines" }));
		expect(error.code).toBe("ECONNREFUSED");
	});

	test.skipIf(isWindows)("ipcEndpoint relocates an over-long dir", async () => {
		const dir = path.join(await tempDir(), "d".repeat(120));
		const name = `long-${process.pid}`;
		const endpoint = ipcEndpoint(dir, name);
		expect(endpoint).toMatch(new RegExp(`^/tmp/omp-${process.getuid!()}/[0-9a-f]{16}\\.sock$`));
		expect(ipcEndpoint(dir, name)).toBe(endpoint);
		expect(Buffer.byteLength(endpoint)).toBeLessThan(104);
		await listen(endpoint, { framing: "lines" }, connection => {
			connection.start(
				line => connection.send(line.toUpperCase()),
				() => {},
			);
		});
		const client = await connect(endpoint, { framing: "lines" });
		const seen = record(client);
		client.send("relocated");
		await seen.until(1);
		expect(seen.events).toEqual(["RELOCATED"]);
	});

	test("small and large frames arrive in send order, within and across tasks", async () => {
		// Small frames coalesce until the end of the task while large ones may
		// be written immediately; a 4 MiB frame also overflows the socket
		// buffer so later frames queue behind its unwritten tail.
		const endpoint = await endpointIn();
		const { accepted } = await acceptingServer(endpoint, { framing: "lines" });
		const client = await connect(endpoint, { framing: "lines" });
		const peer = record(await accepted);
		const big = "b".repeat(4 * 1024 * 1024);
		const mid = "m".repeat(128 * 1024);
		client.send(big); // written directly; the unwritten tail is queued
		client.send("a"); // corked behind the queued tail
		client.send(mid); // large, but joins the open cork to keep order
		await Promise.resolve();
		client.send("c");
		await client.drained();
		await peer.until(4);
		expect(peer.events.map(line => (line.length > 8 ? `${line[0]}×${line.length}` : line))).toEqual([
			`b×${big.length}`,
			"a",
			`m×${mid.length}`,
			"c",
		]);
	});

	test("send then end() delivers everything before the peer sees close", async () => {
		const endpoint = await endpointIn();
		const { accepted } = await acceptingServer(endpoint, { framing: "lines" });
		const client = await connect(endpoint, { framing: "lines" });
		const seen = record(await accepted);
		const expected = Array.from({ length: 2000 }, (_, i) => `line-${i}-${"x".repeat(i % 97)}`);
		for (const line of expected) client.send(line);
		client.end();
		expect(client.send("after-end")).toBe(false);
		await client.drained();
		await seen.closed;
		expect(seen.events).toEqual([...expected, "<close>"]);
		expect(seen.reason).toBeNull();
	});

	test("destroy() fires onClose(null) exactly once", async () => {
		const endpoint = await endpointIn();
		const { accepted } = await acceptingServer(endpoint, { framing: "lines" });
		const client = await connect(endpoint, { framing: "lines" });
		const peer = record(await accepted);
		const seen = record(client);
		client.destroy();
		client.destroy();
		expect(client.closed).toBe(true);
		expect(client.send("dropped")).toBe(false);
		await client.drained();
		await Promise.all([seen.closed, peer.closed]);
		// Both closes travel the same ordered queue; a duplicate would have been
		// queued before the peer's close round-trip completed.
		expect(seen.closes).toBe(1);
		expect(seen.reason).toBeNull();
		expect(peer.reason).toBeNull();
	});

	test("an oversize line closes the receiver with EMSGSIZE", async () => {
		const endpoint = await endpointIn();
		const { accepted } = await acceptingServer(endpoint, { framing: "lines", maxFrameBytes: 16 });
		const client = await connect(endpoint, { framing: "lines" });
		const seen = record(await accepted);
		client.send("short");
		client.send("y".repeat(100));
		await seen.closed;
		expect(seen.events).toEqual(["short", "<close>"]);
		expect(seen.reason).toStartWith("EMSGSIZE");
	});

	test.skipIf(isWindows)("server.close() unlinks the socket file", async () => {
		const endpoint = await endpointIn();
		const server = await IpcServer.listen(endpoint, { framing: "lines" }, () => {});
		expect(server.endpoint).toBe(endpoint);
		const stat = await fs.lstat(endpoint);
		expect(stat.isSocket()).toBe(true);
		expect(stat.mode & 0o777).toBe(0o600);
		await server.close();
		await server.close();
		expect(await fs.exists(endpoint)).toBe(false);
	});

	test("an unref'd idle client does not keep the process alive", async () => {
		const endpoint = await endpointIn();
		const { accepted } = await acceptingServer(endpoint, { framing: "lines" });
		const nativeModule = path.join(import.meta.dir, "../native/index.js");
		const script = `
			const { IpcConnection } = require(${JSON.stringify(nativeModule)});
			IpcConnection.connect(${JSON.stringify(endpoint)}, { framing: "lines" }).then(connection => {
				connection.start(() => {}, () => {});
				connection.unref();
				console.log("connected");
			});
		`;
		const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
		const peer = record(await accepted);
		// Real time is the subject here: a leaked loop ref means the child never
		// exits, so the only observable failure is the deadline expiring.
		const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => "timeout" as const)]);
		if (exited === "timeout") child.kill();
		expect(exited).toBe(0);
		expect(await new Response(child.stdout).text()).toContain("connected");
		await peer.closed;
		expect(peer.reason).toBeNull();
	});
});
