import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	encodeNativeFrame,
	NATIVE_FRAME_LIMIT,
	NativeFrameReader,
	type NativeHostIo,
	resolveSessionCwd,
	serveNativeHost,
	spawnRpcChild,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/native-host";
import type { FromNativeHost, ToNativeHost } from "../../../browser-relay/extension/messages";

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
	/** Resolves once a received message satisfies `predicate`. */
	waitFor(predicate: (message: FromNativeHost) => boolean): Promise<FromNativeHost>;
	done: Promise<void>;
	spawnedIn: string[];
}

async function startHost(): Promise<Harness> {
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
		spawn: cwd => {
			spawnedIn.push(cwd);
			return spawnRpcChild([process.execPath, script], cwd);
		},
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
		waitFor: predicate => {
			const hit = received.find(predicate);
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
		host.send({ t: "open", cwd });
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
		expect(lines[1].data).toEqual({ cwd, relay: "1", protocol: 2 });
		expect(lines[2].text).toBe("é".repeat(600_000));
		expect(lines[3].data).toBe("x".repeat(1_200_000));
		const chunkIds = new Set(host.received.flatMap(message => (message.t === "chunk" ? [message.id] : [])));
		expect(chunkIds.size).toBe(2);
	}, 20_000);

	it("stops the child when the extension disconnects", async () => {
		const host = await startHost();
		host.send({ t: "open", cwd: os.tmpdir() });
		await host.waitFor(message => message.t === "ready");
		host.disconnect();
		await host.done;
		expect(host.received.some(message => message.t === "exit")).toBe(false);
	}, 20_000);

	it("refuses a missing directory without spawning", async () => {
		const host = await startHost();
		const missing = path.join(os.tmpdir(), `omp-missing-${Date.now()}`);
		host.send({ t: "open", cwd: missing });
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
