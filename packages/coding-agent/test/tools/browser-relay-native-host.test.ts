import { afterEach, describe, expect, it, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	encodeNativeFrame,
	NATIVE_FRAME_LIMIT,
	NativeFrameReader,
	type NativeHostIo,
	resolveSessionCwd,
	serveNativeHost,
	spawnRpcChild,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/native-host";
import { requestRelayRestart, waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { RELAY_RESTART_PATH } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import type { FromNativeHost, ToNativeHost } from "../../../browser-relay/extension/messages";
import { discoverRelayEndpoints } from "../../src/tools/browser/relay/discovery";
import * as wslNetworking from "../../src/tools/browser/relay/wsl-networking";

/**
 * Stand-in for `omp --mode rpc`: announces protocol v2, answers negotiation, echoes `echo` commands with the protocol
 * they were answered under, emits one oversized line (`big`) and one rpc_chunk-split frame (`chunked`), and exits 3
 * with a stderr note on `quit`.
 */
const FAKE_RPC = String.raw`
const out = line => Bun.write(Bun.stdout, line + "\n");
await out(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] }));
let buffer = "";
let protocol = 1;
for await (const bytes of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(bytes);
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const command = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		if (command.type === "negotiate_protocol") {
			protocol = 2;
			await out(JSON.stringify({ id: command.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } }));
		} else if (command.type === "echo") {
			await out(JSON.stringify({ type: "response", command: "echo", success: true, data: { cwd: process.cwd(), relay: process.env.PI_BROWSER_RELAY, protocol } }));
		} else if (command.type === "browser") {
			const response = await fetch(process.env.PI_PANEL_RELAY_URL + "/json/version");
			await out(JSON.stringify({ type: "response", command: "browser", data: { url: process.env.PI_PANEL_RELAY_URL, status: response.status } }));
		} else if (command.type === "big") {
			await out(JSON.stringify({ type: "message_update", text: "é".repeat(600_000) }));
		} else if (command.type === "chunked") {
			const json = JSON.stringify({ type: "response", command: "get_entries", success: true, data: "x".repeat(1_200_000) });
			const bytes = Buffer.from(json);
			const size = 256 * 1024;
			const count = Math.ceil(bytes.length / size);
			for (let index = 0; index < count; index++) {
				const data = bytes.subarray(index * size, (index + 1) * size).toString("base64");
				await out(JSON.stringify({ type: "rpc_chunk", chunkId: "c1", index, count, byteLength: bytes.length, data }));
			}
		} else if (command.type === "quit") {
			process.stderr.write("fake rpc: bye\n");
			process.exit(3);
		}
	}
}
`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Harness {
	/** Sends one extension→host message. */
	send(message: ToNativeHost): void;
	/** Closes the extension's port. */
	disconnect(): void;
	/** Every host→extension message so far. */
	received: FromNativeHost[];
	/** Resolves once a message received at index `from` or later satisfies `predicate`. */
	waitFor(predicate: (message: FromNativeHost) => boolean, from?: number): Promise<FromNativeHost>;
	done: Promise<void>;
	spawnedIn: string[];
}

async function startHost(relayPort = 0): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-host-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const script = path.join(dir, "fake-rpc.ts");
	await Bun.write(script, FAKE_RPC);

	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const input = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const reader = new NativeFrameReader();
	const received: FromNativeHost[] = [];
	const waiters: { predicate: (message: FromNativeHost) => boolean; resolve: (message: FromNativeHost) => void }[] =
		[];
	const spawnedIn: string[] = [];
	const io: NativeHostIo = {
		input,
		write: bytes => {
			expect(bytes.byteLength - 4).toBeLessThanOrEqual(NATIVE_FRAME_LIMIT);
			for (const message of reader.push(bytes)) {
				const typed: FromNativeHost = JSON.parse(JSON.stringify(message));
				received.push(typed);
				for (const waiter of waiters.splice(0)) {
					if (waiter.predicate(typed)) waiter.resolve(typed);
					else waiters.push(waiter);
				}
			}
		},
		spawn: (cwd, relayUrl) => {
			spawnedIn.push(cwd);
			return spawnRpcChild([process.execPath, script], cwd, relayUrl);
		},
		relayPort,
		log: () => {},
	};
	const done = serveNativeHost(io);
	return {
		send: message => {
			// Split each frame across two writes so the reader must reassemble it.
			const frame = encodeNativeFrame(message);
			controller.enqueue(frame.subarray(0, 3));
			controller.enqueue(frame.subarray(3));
		},
		disconnect: () => controller.close(),
		received,
		waitFor: (predicate, from = 0) => {
			const hit = received.slice(from).find(predicate);
			if (hit) return Promise.resolve(hit);
			const { promise, resolve } = Promise.withResolvers<FromNativeHost>();
			waiters.push({ predicate, resolve });
			return promise;
		},
		done,
		spawnedIn,
	};
}

function rpcLines(received: FromNativeHost[]): string[] {
	const lines: string[] = [];
	let chunks = "";
	for (const message of received) {
		if (message.t === "rpc") lines.push(message.line);
		else if (message.t === "chunk") {
			chunks += message.data;
			if (message.last) {
				lines.push(chunks);
				chunks = "";
			}
		}
	}
	return lines;
}

describe("native host", () => {
	it("relays rpc lines both ways, chunks oversized ones and reports the child's exit", async () => {
		const host = await startHost();
		const cwd = await fs.realpath(os.tmpdir());
		host.send({ t: "open", extensionId: "a".repeat(32), cwd });
		const ready = await host.waitFor(message => message.t === "ready");
		expect(ready).toMatchObject({ t: "ready", pid: expect.any(Number) });
		expect(host.spawnedIn).toEqual([cwd]);

		host.send({ t: "rpc", line: JSON.stringify({ type: "echo" }) });
		await host.waitFor(message => message.t === "rpc" && message.line.includes('"command":"echo"'));
		host.send({ t: "rpc", line: JSON.stringify({ type: "big" }) });
		await host.waitFor(message => message.t === "chunk" && message.last);
		host.send({ t: "rpc", line: JSON.stringify({ type: "chunked" }) });
		host.send({ t: "rpc", line: JSON.stringify({ type: "quit" }) });
		const exit = await host.waitFor(message => message.t === "exit");
		await host.done;

		expect(exit).toEqual({ t: "exit", code: 3, stderr: "fake rpc: bye\n" });
		const lines = rpcLines(host.received).map(line => JSON.parse(line));
		// The child's ready line passes through; the host's own negotiation response does not.
		expect(lines.map(line => (line.type === "response" ? line.command : line.type))).toEqual([
			"ready",
			"echo",
			"message_update",
			"get_entries",
		]);
		// Sent without waiting for the child's ready line, yet answered under v2: the host negotiates first.
		expect(lines[1].data).toEqual({ cwd, relay: "only", protocol: 2 });
		expect(lines[2].text).toBe("é".repeat(600_000));
		expect(lines[3].data).toBe("x".repeat(1_200_000));
		const chunkIds = new Set(host.received.flatMap(message => (message.t === "chunk" ? [message.id] : [])));
		expect(chunkIds.size).toBe(2);
	}, 20_000);

	it("stops the child when the extension disconnects", async () => {
		const host = await startHost();
		host.send({ t: "open", extensionId: "a".repeat(32), cwd: os.tmpdir() });
		await host.waitFor(message => message.t === "ready");
		host.disconnect();
		await host.done;
		expect(host.received.some(message => message.t === "exit")).toBe(false);
	}, 20_000);

	it("refuses a missing directory without spawning", async () => {
		const host = await startHost();
		const missing = path.join(os.tmpdir(), `omp-missing-${Date.now()}`);
		host.send({ t: "open", extensionId: "a".repeat(32), cwd: missing });
		await host.done;
		expect(host.spawnedIn).toEqual([]);
		expect(host.received).toEqual([{ t: "exit", code: null, stderr: `directory not found: ${missing}` }]);
	});

	it("expands ~ to the home directory", () => {
		expect(resolveSessionCwd("~")).toBe(os.homedir());
		expect(resolveSessionCwd("")).toBe(os.homedir());
		expect(resolveSessionCwd("~/src/x")).toBe(path.join(os.homedir(), "src", "x"));
	});
});

const HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
	discardedTabsProtocol: 1,
} as const;

/** The `ompRelayInstance` of the relay answering on `port`. */
async function relayInstance(port: number): Promise<unknown> {
	const body: unknown = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
	return typeof body === "object" && body !== null ? Reflect.get(body, "ompRelayInstance") : undefined;
}

/** Links `host` as browser `instanceId` and says hello once the host reports a relay. */
async function link(host: Harness, instanceId: string, from = 0): Promise<void> {
	await host.waitFor(message => message.t === "linked", from);
	host.send({ t: "relay", line: JSON.stringify({ ...HELLO, instanceId }) });
}

test("chat child discovers its browser over the chat port, not the terminal relay", async () => {
	const terminalPort = await findFreeCdpPort();
	const host = await startHost(terminalPort);
	host.send({ t: "open", cwd: os.tmpdir(), extensionId: "a".repeat(32) });
	await link(host, "panel-browser");
	host.send({ t: "rpc", line: JSON.stringify({ type: "browser" }) });
	const result = await host.waitFor(frame => frame.t === "rpc" && frame.line.includes('"command":"browser"'));
	if (result.t !== "rpc") throw new Error("expected RPC answer");
	const { data } = JSON.parse(result.line);
	expect(data.status).toBe(200);
	expect(new URL(data.url).port).not.toBe(String(terminalPort));
	host.send({ t: "rpc", line: JSON.stringify({ type: "quit" }) });
	await host.done;
	await expect(fetch(`${data.url}/json/version`)).rejects.toThrow();
});

test("local discovery ignores malformed records and returns live endpoints newest first", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-record-"));
	const registry = spyOn(dirs, "getBrowserRelayInstallRegistryFile").mockReturnValue(path.join(dir, "installs.json"));
	const networking = spyOn(wslNetworking, "getWslNetworkingMode").mockReturnValue(undefined);
	try {
		expect(await discoverRelayEndpoints()).toEqual([]);
		for (const [name, mtime] of [
			[`${process.pid}-9201`, 1],
			[`${process.pid}-9202`, 2],
			[`${process.pid}-65536`, 3],
			["not-an-endpoint", 4],
		] as const) {
			const file = path.join(dir, "endpoints", name);
			await Bun.write(file, "");
			await fs.utimes(file, mtime, mtime);
		}
		expect(await discoverRelayEndpoints()).toEqual(["http://127.0.0.1:9202", "http://127.0.0.1:9201"]);
	} finally {
		networking.mockRestore();
		registry.mockRestore();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "linux").each([
	["mirrored", true],
	["nat", false],
	["wsl1", false],
	["unknown", true],
	[undefined, false],
] as const)("local relay discovery with WSL mode %s", async (mode, requireOwner) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-record-"));
	const registry = spyOn(dirs, "getBrowserRelayInstallRegistryFile").mockReturnValue(path.join(dir, "installs.json"));
	const networking = spyOn(wslNetworking, "getWslNetworkingMode").mockReturnValue(mode);
	const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	try {
		const url = `http://127.0.0.1:${listener.port}`;
		const record = (pid: number) => path.join(dir, "endpoints", `${pid}-${listener.port}`);
		await Bun.write(record(process.ppid), "");
		expect(await discoverRelayEndpoints()).toEqual(requireOwner ? [] : [url]);
		await fs.unlink(record(process.ppid));
		await Bun.write(record(process.pid), "");
		expect(await discoverRelayEndpoints()).toEqual([url]);
	} finally {
		listener.stop(true);
		networking.mockRestore();
		registry.mockRestore();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("terminal relay publishes its assigned port and retires it when Chrome disconnects", async () => {
	const before = new Set(await discoverRelayEndpoints());
	const host = await startHost();
	host.send({ t: "link", extensionId: "a".repeat(32) });
	await link(host, "dynamic-browser");
	const url = (await discoverRelayEndpoints()).find(endpoint => !before.has(endpoint));
	if (!url) throw new Error("relay did not publish an endpoint");
	expect(await waitForRelayExtension(url)).toBe("ready");
	host.disconnect();
	await host.done;
	expect(await discoverRelayEndpoints()).not.toContain(url);
});

describe("native host relay link", () => {
	it("serves the relay for the first browser, forwards the next one's, and hands over when the first leaves", async () => {
		const port = await findFreeCdpPort();
		const cdpUrl = `http://127.0.0.1:${port}`;
		const first = await startHost(port);
		first.send({ t: "link", extensionId: "a".repeat(32) });
		await link(first, "first");
		expect(await waitForRelayExtension(cdpUrl)).toBe("ready");
		const leader = await relayInstance(port);

		const second = await startHost(port);
		second.send({ t: "link", extensionId: "b".repeat(32) });
		await link(second, "second");
		// The follower's calls reach the leader's bridge and its answers come back over the follower's port.
		second.send({ t: "relay", line: JSON.stringify({ t: "call", id: 7, call: { op: "collabHosts" } }) });
		await second.waitFor(message => message.t === "relay" && message.line.includes('"t":"callResult","id":7'));

		const mark = second.received.length;
		first.disconnect();
		await first.done;
		await second.waitFor(message => message.t === "unlinked", mark);
		await link(second, "second", mark);
		expect(await waitForRelayExtension(cdpUrl)).toBe("ready");
		expect(await relayInstance(port)).not.toBe(leader);
		second.disconnect();
		await second.done;
		expect(await waitForRelayExtension(cdpUrl)).toBe("unreachable");
	}, 20_000);

	it("gives way only to a newer omp's restart, and then exits so Chrome starts the next host", async () => {
		const port = await findFreeCdpPort();
		const cdpUrl = `http://127.0.0.1:${port}`;
		const host = await startHost(port);
		host.send({ t: "link", extensionId: "a".repeat(32) });
		await link(host, "browser");
		expect(await waitForRelayExtension(cdpUrl)).toBe("ready");

		expect(await requestRelayRestart(cdpUrl, { idleOnly: false })).toBe(false);
		const restart = await fetch(`${cdpUrl}${RELAY_RESTART_PATH}?version=999.0.0`, { method: "POST" });
		expect(restart.status).toBe(202);
		await host.done;
		expect(await waitForRelayExtension(cdpUrl)).toBe("unreachable");
	}, 20_000);
});
