/**
 * Local IPC transport benchmark: native `IpcServer`/`IpcConnection` against a
 * `node:net` baseline doing the same newline framing in JS. Both ends run in
 * this process, so every frame crosses the native boundary twice.
 *
 *   bun bench/ipc.ts            # all cases
 *   IPC_BENCH_SCALE=0.2 IPC_BENCH_RUNS=1 bun bench/ipc.ts
 *
 * Each case alternates native and node:net runs and reports the best of
 * `IPC_BENCH_RUNS`, which filters out scheduler noise on a busy machine.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "../native/index.js";

const SCALE = Number(Bun.env.IPC_BENCH_SCALE ?? "1");
const RUNS = Number(Bun.env.IPC_BENCH_RUNS ?? "5");
const n = (count: number): number => Math.max(1, Math.round(count * SCALE));

interface Pair {
	/** Send one frame client → server. */
	send(frame: string): boolean;
	/** Resolves when the client write queue is empty. */
	drained(): Promise<void>;
	/** Server echoes every frame back to the client. */
	echo: boolean;
	onClientLine(handler: (line: string) => void): void;
	onServerLine(handler: (line: string) => void): void;
	close(): Promise<void>;
}

async function nativePair(dir: string, echo: boolean): Promise<Pair> {
	const endpoint = ipcEndpoint(dir, `native-${echo}`);
	let serverLine: (line: string) => void = () => {};
	let clientLine: (line: string) => void = () => {};
	const accepted = Promise.withResolvers<IpcConnection>();
	const server = await IpcServer.listen(endpoint, { framing: "lines" }, conn => {
		conn.start(
			line => {
				if (echo) conn.send(line);
				serverLine(line);
			},
			() => {},
		);
		accepted.resolve(conn);
	});
	const client = await IpcConnection.connect(endpoint, { framing: "lines" });
	client.start(
		line => clientLine(line),
		() => {},
	);
	const peer = await accepted.promise;
	return {
		echo,
		send: frame => client.send(frame),
		drained: () => client.drained(),
		onClientLine: handler => {
			clientLine = handler;
		},
		onServerLine: handler => {
			serverLine = handler;
		},
		close: async () => {
			client.destroy();
			peer.destroy();
			await server.close();
		},
	};
}

/** Linear newline splitter: fragments of a long line are joined once, when it completes. */
function splitLines(onLine: (line: string) => void): (chunk: string) => void {
	let fragments: string[] = [];
	return chunk => {
		let start = 0;
		for (;;) {
			const newline = chunk.indexOf("\n", start);
			if (newline < 0) break;
			let line = chunk.slice(start, newline);
			if (fragments.length > 0) {
				fragments.push(line);
				line = fragments.join("");
				fragments = [];
			}
			if (line) onLine(line);
			start = newline + 1;
		}
		if (start < chunk.length) fragments.push(chunk.slice(start));
	};
}

async function netPair(dir: string, echo: boolean): Promise<Pair> {
	const endpoint = path.join(dir, `net-${echo}.sock`);
	let serverLine: (line: string) => void = () => {};
	let clientLine: (line: string) => void = () => {};
	const accepted = Promise.withResolvers<net.Socket>();
	const server = net.createServer(socket => {
		socket.setEncoding("utf8");
		socket.on(
			"data",
			splitLines(line => {
				if (echo) socket.write(`${line}\n`);
				serverLine(line);
			}),
		);
		socket.on("error", () => {});
		accepted.resolve(socket);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(endpoint, () => listening.resolve());
	await listening.promise;
	const client = net.createConnection(endpoint);
	const connected = Promise.withResolvers<void>();
	client.once("connect", () => connected.resolve());
	await connected.promise;
	client.setEncoding("utf8");
	client.on(
		"data",
		splitLines(line => clientLine(line)),
	);
	client.on("error", () => {});
	const peer = await accepted.promise;
	return {
		echo,
		send: frame => client.write(`${frame}\n`),
		drained: () => {
			if (!client.writableNeedDrain) return Promise.resolve();
			const drained = Promise.withResolvers<void>();
			client.once("drain", () => drained.resolve());
			return drained.promise;
		},
		onClientLine: handler => {
			clientLine = handler;
		},
		onServerLine: handler => {
			serverLine = handler;
		},
		close: async () => {
			client.destroy();
			peer.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

/** One measured run: elapsed nanoseconds for `count` frames of `bytes` each. */
interface Sample {
	ns: number;
	count: number;
	bytes: number;
}

/** Sequential request/response: one frame out, wait for its echo, repeat. */
async function roundTrip(pair: Pair, count: number, frame: string): Promise<Sample> {
	const start = Bun.nanoseconds();
	for (let i = 0; i < count; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		pair.onClientLine(() => resolve());
		pair.send(frame);
		await promise;
	}
	return { ns: Bun.nanoseconds() - start, count, bytes: frame.length + 1 };
}

/** One-way stream: blast `count` frames, resolve when the server saw them all. */
async function stream(pair: Pair, count: number, frame: string): Promise<Sample> {
	const done = Promise.withResolvers<void>();
	let seen = 0;
	pair.onServerLine(() => {
		if (++seen === count) done.resolve();
	});
	const start = Bun.nanoseconds();
	for (let i = 0; i < count; i++) {
		if (!pair.send(frame)) await pair.drained();
	}
	await done.promise;
	return { ns: Bun.nanoseconds() - start, count, bytes: frame.length + 1 };
}

function describe(sample: Sample, latency: boolean): string {
	if (latency) return `${(sample.ns / 1000 / sample.count).toFixed(1)} µs/rt`;
	const seconds = sample.ns / 1e9;
	const mib = (sample.count * sample.bytes) / 1024 / 1024;
	return `${(sample.count / seconds / 1000).toFixed(0)}k lines/s, ${(mib / seconds).toFixed(0)} MiB/s`;
}

const small = JSON.stringify({ id: 1, op: "complete", before: "please ", prefix: "re" });
const medium = JSON.stringify({ id: 2, type: "text", text: "x".repeat(4000) });
const vectors = JSON.stringify({
	id: "3",
	type: "vectors",
	vectors: Array.from({ length: 128 }, (_, row) => Array.from({ length: 1024 }, (_, col) => Math.sin(row * col))),
});
const unicode = JSON.stringify({ id: 4, text: "héllo wörld — ünïcødé ✓ ".repeat(40) });

const cases: { name: string; run: (pair: Pair) => Promise<Sample>; echo: boolean }[] = [
	{ name: `round-trip ${small.length} B`, echo: true, run: pair => roundTrip(pair, n(20_000), small) },
	{ name: `stream ${small.length} B`, echo: false, run: pair => stream(pair, n(300_000), small) },
	{ name: `stream ${medium.length} B`, echo: false, run: pair => stream(pair, n(40_000), medium) },
	{ name: `stream ${unicode.length} B non-ASCII`, echo: false, run: pair => stream(pair, n(60_000), unicode) },
	{
		name: `stream ${(vectors.length / 1024 / 1024).toFixed(1)} MiB vectors`,
		echo: false,
		run: pair => stream(pair, n(40), vectors),
	},
];

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipc-bench-"));
try {
	const transports = [
		["native", nativePair],
		["node:net", netPair],
	] as const;
	for (const testCase of cases) {
		const best = new Map<string, Sample>();
		for (let run = 0; run < RUNS; run++) {
			for (const [label, make] of transports) {
				const pair = await make(dir, testCase.echo);
				try {
					const sample = await testCase.run(pair);
					const previous = best.get(label);
					if (!previous || sample.ns < previous.ns) best.set(label, sample);
				} finally {
					await pair.close();
				}
			}
		}
		const results = transports.map(([label]) => `${label}: ${describe(best.get(label)!, testCase.echo)}`);
		console.log(`${testCase.name.padEnd(28)} ${results.join("   ")}`);
	}
} finally {
	await fs.rm(dir, { recursive: true, force: true });
}
