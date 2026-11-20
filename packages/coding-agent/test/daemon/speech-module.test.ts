/**
 * The daemon `speech` module against a real isolated daemon and a fake frame
 * worker (`test/fixtures/fake-frame-worker.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { daemonClient } from "../../src/daemon/client";
import { encodeFrame, FrameDecoder, type SpeechFrame } from "../../src/daemon/modules/speech-frames";
import { type DaemonClient, type DaemonTunnel, GLOBAL_SCOPE } from "../../src/daemon/protocol";
import { IsolatedDaemon, waitFor } from "../fixtures/daemon-harness";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures");
const WORKER = path.join(FIXTURES, "fake-frame-worker.ts");
const TEST_TIMEOUT_MS = 60_000;

/** Client end of one speech tunnel: frames out, every decoded frame recorded in arrival order. */
class SpeechTunnel {
	readonly frames: SpeechFrame[] = [];
	readonly closed: Promise<void>;
	readonly #tunnel: DaemonTunnel;

	constructor(tunnel: DaemonTunnel) {
		this.#tunnel = tunnel;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.closed = promise;
		const decoder = new FrameDecoder();
		tunnel.start(
			chunk => decoder.push(chunk, frame => this.frames.push(frame)),
			() => resolve(),
		);
	}

	send(header: Record<string, unknown>, payload?: Uint8Array): void {
		this.#tunnel.send(encodeFrame(header, payload));
	}

	frame(type: string, id: string): Promise<SpeechFrame> {
		return waitFor(
			() => this.frames.find(frame => frame.header.type === type && frame.header.id === id),
			`${type} ${id}`,
		);
	}

	close(): void {
		this.#tunnel.close();
	}
}

describe("daemon speech module", () => {
	let daemon: IsolatedDaemon;
	let tempDir: string;
	let logPath: string;
	const tunnels: SpeechTunnel[] = [];

	beforeEach(async () => {
		daemon = await IsolatedDaemon.create();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-speech-module-"));
		logPath = path.join(tempDir, "frames.jsonl");
	});

	afterEach(async () => {
		for (const tunnel of tunnels.splice(0)) tunnel.close();
		await daemon.dispose();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function openSpeech(client: DaemonClient, key: string): Promise<string> {
		const { unit } = await client.open({
			kind: "speech",
			scope: GLOBAL_SCOPE,
			key,
			params: {
				command: [process.execPath, WORKER],
				cwd: FIXTURES,
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tempDir, FAKE_FRAME_LOG: logPath },
			},
		});
		daemon.track(...unit.pids);
		return unit.id;
	}

	/** The isolated daemon of this test, started on first use. */
	async function startDaemon(): Promise<DaemonClient> {
		const client = await daemonClient();
		daemon.track(client.welcome.daemon.pid);
		return client;
	}

	async function attach(client: DaemonClient, unitId: string): Promise<SpeechTunnel> {
		const tunnel = new SpeechTunnel(await client.attach(unitId));
		tunnels.push(tunnel);
		return tunnel;
	}

	async function workerLog(): Promise<Record<string, unknown>[]> {
		const text = await fs.readFile(logPath, "utf8").catch(() => "");
		return text
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as Record<string, unknown>);
	}

	it(
		"keeps concurrent streams with the same client id on two tunnels apart",
		async () => {
			const client = await startDaemon();
			const unitId = await openSpeech(client, "stt:auto:auto");
			const a = await attach(client, unitId);
			const b = await attach(client, unitId);
			// Both sessions are open in the worker at once under the same client id.
			a.send({ type: "stream_start", id: "s", tag: "A" });
			b.send({ type: "stream_start", id: "s", tag: "B" });
			await a.frame("stream_started", "s");
			await b.frame("stream_started", "s");
			a.send({ type: "stream_push", id: "s", chunks: 3 });
			b.send({ type: "stream_push", id: "s", chunks: 3 });
			await a.frame("stream_done", "s");
			await b.frame("stream_done", "s");

			const tags = (tunnel: SpeechTunnel) =>
				tunnel.frames.filter(frame => frame.header.type === "stream_chunk").map(frame => frame.header.tag);
			expect(tags(a)).toEqual(["A", "A", "A"]);
			expect(tags(b)).toEqual(["B", "B", "B"]);
			const workerIds = new Set(
				(await workerLog()).filter(header => header.type === "stream_start").map(header => header.id),
			);
			expect(workerIds.size).toBe(2);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"delivers a stream's audio chunks only to the originating tunnel, in order",
		async () => {
			const client = await startDaemon();
			const unitId = await openSpeech(client, "tts:auto:auto");
			const origin = await attach(client, unitId);
			const bystander = await attach(client, unitId);
			origin.send({ type: "stream_start", id: "speak", tag: "O" });
			await origin.frame("stream_started", "speak");
			origin.send({ type: "stream_push", id: "speak", chunks: 64 });
			await origin.frame("stream_done", "speak");
			bystander.send({ type: "ping", id: "probe" });
			await bystander.frame("pong", "probe");

			const chunks = origin.frames.filter(frame => frame.header.type === "stream_chunk");
			expect(chunks.map(frame => frame.header.index)).toEqual(Array.from({ length: 64 }, (_, index) => index));
			expect(chunks.map(frame => Array.from(frame.payload!))).toEqual(
				Array.from({ length: 64 }, (_, index) => [index, "O".charCodeAt(0)]),
			);
			expect(bystander.frames.map(frame => frame.header.type)).toEqual(["pong"]);
		},
		TEST_TIMEOUT_MS,
	);

	it.each([
		["stt:auto:auto", "stream_cancel"],
		["tts:auto:auto", "stream-cancel"],
	])(
		"%s: closing a tunnel with an open stream sends %s to the worker",
		async (key, cancelType) => {
			const client = await startDaemon();
			const unitId = await openSpeech(client, key);
			const tunnel = await attach(client, unitId);
			tunnel.send({ type: "stream_start", id: "live", tag: "L" });
			await tunnel.frame("stream_started", "live");
			const workerId = await waitFor(
				async () => (await workerLog()).find(header => header.type === "stream_start")?.id,
				"worker to log the stream start",
			);

			tunnel.close();

			const cancel = await waitFor(
				async () => (await workerLog()).find(header => header.type === cancelType),
				`${cancelType} in the worker`,
			);
			expect(cancel.id).toBe(workerId);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"passes a binary PCM payload through both hops byte-identical",
		async () => {
			const client = await startDaemon();
			const unitId = await openSpeech(client, "stt:auto:auto");
			const tunnel = await attach(client, unitId);
			// Larger than the decoders' initial buffer, and not a whole number of f32 samples.
			const payload = new Uint8Array(300_003);
			for (let at = 0; at < payload.length; at++) payload[at] = (at * 31 + (at >> 8)) & 0xff;
			tunnel.send({ type: "transcribe", id: "pcm", $pcm: "audio" }, payload);

			const reply = await tunnel.frame("transcription", "pcm");
			expect(reply.header).toEqual({ type: "transcription", id: "pcm", $pcm: "audio" });
			expect(reply.payload!.length).toBe(payload.length);
			expect(Buffer.from(reply.payload!).equals(Buffer.from(payload))).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);
});
