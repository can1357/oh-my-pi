import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { MemoizedRuntime } from "../src/subprocess/worker-runtime";
import type { SttTransport, SttWorkerInbound, SttWorkerOutbound } from "../src/stt/asr-protocol";
import { startSttWorker } from "../src/stt/asr-worker";
import * as registry from "../src/stt/models";
import * as runtime from "../src/stt/sherpa-runtime";

// A stateful native-API double: each positive sample introduces a token, -1
// ends an utterance, and token 3 needs inputFinished before it becomes ready.
// No recognition result is supplied directly to the worker under test.
class OnlineStream implements runtime.SherpaOnlineStream {
	pending: number[] = [];
	words: string[] = [];
	endpoint = false;
	finished = false;
	finishCalls = 0;

	acceptWaveform({ samples }: { samples: Float32Array; sampleRate: number }): void {
		if (this.finished) throw new Error("audio after inputFinished");
		for (const sample of samples) if (sample !== 0) this.pending.push(sample);
	}

	inputFinished(): void {
		this.finished = true;
		this.finishCalls++;
	}
}

const vocabulary = ["", "hello", "world", "tail"];
class OnlineRecognizer implements runtime.SherpaOnlineRecognizer {
	static instances: OnlineRecognizer[] = [];
	streams: OnlineStream[] = [];
	resetCalls = 0;

	constructor() {
		OnlineRecognizer.instances.push(this);
	}

	createStream(): OnlineStream {
		const stream = new OnlineStream();
		this.streams.push(stream);
		return stream;
	}

	isReady(stream: OnlineStream): boolean {
		return stream.pending.length > 0 && (stream.pending[0] !== 3 || stream.finished);
	}

	decode(stream: OnlineStream): void {
		if (!this.isReady(stream)) throw new Error("decode before ready");
		const token = stream.pending.shift()!;
		if (token === -1) stream.endpoint = true;
		else if (token > 0) stream.words.push(vocabulary[token]!);
	}

	getResult(stream: OnlineStream): { text: string } {
		return { text: stream.words.join(" ") };
	}

	isEndpoint(stream: OnlineStream): boolean {
		return stream.endpoint;
	}

	reset(stream: OnlineStream): void {
		this.resetCalls++;
		stream.words.length = 0;
		stream.endpoint = false;
	}
}

class OfflineStream {
	samples: Float32Array = new Float32Array();
	acceptWaveform({ samples }: { samples: Float32Array; sampleRate: number }): void {
		this.samples = samples;
	}
}

const offlineRecognizer = {
	createStream: () => new OfflineStream(),
	decodeAsync: async (stream: OfflineStream) => ({
		text: Array.from(stream.samples, sample => vocabulary[sample] ?? "").join(" "),
	}),
};
const nativeRuntime: runtime.SherpaRuntime = {
	OnlineRecognizer,
	OfflineRecognizer: { createAsync: async () => offlineRecognizer },
};
const onlineSpec = registry.getSttModelSpec("nemotron-streaming-en-0.6b")!;
const offlineSpec = registry.getSttModelSpec("parakeet-tdt-0.6b-v3")!;
let nextKey = 0;
let key: registry.SttModelKey;
let offlineKey: registry.SttModelKey;
const presentFile = await fs.stat(import.meta.path);

function harness() {
	const events: SttWorkerOutbound[] = [];
	const listeners = new Set<() => void>();
	let receive!: (message: SttWorkerInbound) => void;
	const transport: SttTransport = {
		send: event => {
			events.push(event);
			for (const listener of listeners) listener();
		},
		onMessage: handler => {
			receive = handler;
			return () => {};
		},
	};
	startSttWorker(transport);
	return {
		events,
		send: (message: SttWorkerInbound) => receive(message),
		waitFor: (type: SttWorkerOutbound["type"], id: string) => {
			const { promise, resolve } = Promise.withResolvers<SttWorkerOutbound>();
			const check = () => {
				const event = events.find(item => item.type === type && "id" in item && item.id === id);
				if (event) {
					listeners.delete(check);
					resolve(event);
				}
			};
			listeners.add(check);
			check();
			return promise;
		},
	};
}

function transcriptEvents(events: SttWorkerOutbound[]) {
	return events.filter(event => ["partial", "segment", "stream_done", "error"].includes(event.type));
}

// Flush promise continuations, including the worker's shared inference chain.
const nextTurn = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

beforeEach(() => {
	// Isolate the worker's intentionally warm model cache without adding a
	// production-only cache reset or dependency-injection API.
	key = `online-worker-test-${++nextKey}` as registry.SttModelKey;
	offlineKey = `offline-worker-test-${nextKey}` as registry.SttModelKey;
	// Do not leave a fake native runtime cached for other test files.
	spyOn(MemoizedRuntime.prototype, "load").mockImplementation(build => build());
	spyOn(registry, "getSttModelSpec").mockImplementation(requested =>
		requested === key ? onlineSpec : requested === offlineKey ? offlineSpec : undefined,
	);
	spyOn(runtime, "loadSourceSherpaRuntime").mockReturnValue(nativeRuntime);
	spyOn(fs, "mkdir").mockResolvedValue(undefined);
	spyOn(fs, "stat").mockResolvedValue(presentFile);
	OnlineRecognizer.instances.length = 0;
});

afterEach(() => mock.restore());

describe("native online STT worker", () => {
	it("emits changing words before Stop and feeds each chunk only once", async () => {
		const h = harness();
		h.send({ type: "stream_start", id: "live", modelKey: key });
		const first = Float32Array.of(1);
		const second = Float32Array.of(0, 2);
		h.send({ type: "stream_audio", id: "live", audio: first });
		await h.waitFor("partial", "live");
		expect(transcriptEvents(h.events)).toEqual([{ type: "partial", id: "live", text: "hello" }]);
		h.send({ type: "stream_audio", id: "live", audio: second });
		await nextTurn();
		expect(transcriptEvents(h.events)).toEqual([
			{ type: "partial", id: "live", text: "hello" },
			{ type: "partial", id: "live", text: "hello world" },
		]);
		const recognizer = OnlineRecognizer.instances[0]!;
		h.send({ type: "stream_stop", id: "live" });
		expect(await h.waitFor("stream_done", "live")).toEqual({ type: "stream_done", id: "live", text: "hello world" });
		expect(recognizer.streams[0]!.finishCalls).toBe(1);
	});

	it("commits endpoints once and drains buffered tail tokens on Stop", async () => {
		const h = harness();
		h.send({ type: "stream_start", id: "endpoint", modelKey: key });
		h.send({ type: "stream_audio", id: "endpoint", audio: Float32Array.of(1, -1, 2, 3) });
		await h.waitFor("segment", "endpoint");
		h.send({ type: "stream_stop", id: "endpoint" });
		h.send({ type: "stream_stop", id: "endpoint" });
		h.send({ type: "stream_audio", id: "endpoint", audio: Float32Array.of(1) });
		expect(await h.waitFor("stream_done", "endpoint")).toEqual({
			type: "stream_done",
			id: "endpoint",
			text: "hello world tail",
		});
		expect(h.events.filter(event => event.type === "segment")).toEqual([
			{ type: "segment", id: "endpoint", index: 0, text: "hello" },
			{ type: "segment", id: "endpoint", index: 1, text: "world tail" },
		]);
		const recognizer = OnlineRecognizer.instances[0]!;
		expect(recognizer.resetCalls).toBe(1);
		const stream = recognizer.streams[0]!;
		expect(stream.finishCalls).toBe(1);
		expect(stream.pending).toEqual([]);
	});

	it("buffers startup audio and Stop while model files are loading", async () => {
		const entered = Promise.withResolvers<void>();
		const loaded = Promise.withResolvers<undefined>();
		spyOn(fs, "mkdir").mockImplementationOnce(() => {
			entered.resolve();
			return loaded.promise;
		});
		const h = harness();
		h.send({ type: "stream_start", id: "loading", modelKey: key });
		await entered.promise;
		h.send({ type: "stream_audio", id: "loading", audio: Float32Array.of(1) });
		h.send({ type: "stream_audio", id: "loading", audio: Float32Array.of(2, 3) });
		h.send({ type: "stream_stop", id: "loading" });
		expect(transcriptEvents(h.events)).toEqual([]);
		loaded.resolve(undefined);
		expect(await h.waitFor("stream_done", "loading")).toEqual({
			type: "stream_done",
			id: "loading",
			text: "hello world tail",
		});
	});

	it("suppresses all callbacks after startup cancellation and keeps the loaded model warm", async () => {
		const entered = Promise.withResolvers<void>();
		const loaded = Promise.withResolvers<undefined>();
		spyOn(fs, "mkdir").mockImplementationOnce(() => {
			entered.resolve();
			return loaded.promise;
		});
		const h = harness();
		h.send({ type: "stream_start", id: "cancelled", modelKey: key });
		await entered.promise;
		h.send({ type: "stream_audio", id: "cancelled", audio: Float32Array.of(1) });
		h.send({ type: "stream_cancel", id: "cancelled" });
		const callbacksAtCancel = h.events.length;
		loaded.resolve(undefined);
		await nextTurn();
		expect(h.events).toHaveLength(callbacksAtCancel);
		expect(OnlineRecognizer.instances[0]!.streams).toHaveLength(0);
		h.send({ type: "stream_start", id: "warm", modelKey: key });
		h.send({ type: "stream_audio", id: "warm", audio: Float32Array.of(2) });
		h.send({ type: "stream_stop", id: "warm" });
		expect(await h.waitFor("stream_done", "warm")).toEqual({ type: "stream_done", id: "warm", text: "world" });
		expect(OnlineRecognizer.instances).toHaveLength(1);
	});

	it("cancels a loaded session without a final decode or callbacks", async () => {
		const h = harness();
		h.send({ type: "stream_start", id: "cancel-live", modelKey: key });
		h.send({ type: "stream_audio", id: "cancel-live", audio: Float32Array.of(1) });
		await h.waitFor("partial", "cancel-live");
		h.send({ type: "stream_audio", id: "cancel-live", audio: Float32Array.of(3) });
		h.send({ type: "stream_stop", id: "cancel-live" });
		h.send({ type: "stream_cancel", id: "cancel-live" });
		const count = h.events.length;
		await nextTurn();
		expect(h.events).toHaveLength(count);
		expect(OnlineRecognizer.instances[0]!.streams[0]!.finishCalls).toBe(0);
	});

	it("reports startup failure without waiting for audio and suppresses cancelled failure", async () => {
		spyOn(fs, "mkdir").mockRejectedValueOnce(new Error("model cache unavailable"));
		const h = harness();
		h.send({ type: "stream_start", id: "failed", modelKey: key });
		expect(await h.waitFor("error", "failed")).toMatchObject({
			error: expect.stringContaining("model cache unavailable"),
		});
		const failedLoad = Promise.withResolvers<undefined>();
		spyOn(fs, "mkdir").mockImplementationOnce(() => failedLoad.promise);
		h.send({ type: "stream_start", id: "failed-cancel", modelKey: key });
		await nextTurn();
		h.send({ type: "stream_cancel", id: "failed-cancel" });
		const count = h.events.length;
		failedLoad.reject(new Error("cancelled cache failure"));
		await nextTurn();
		expect(h.events).toHaveLength(count);
	});

	it("propagates native decode errors through the existing error protocol", async () => {
		spyOn(OnlineRecognizer.prototype, "decode").mockImplementationOnce(() => {
			throw new Error("native decode failed");
		});
		const h = harness();
		h.send({ type: "stream_start", id: "decode-error", modelKey: key });
		h.send({ type: "stream_audio", id: "decode-error", audio: Float32Array.of(1) });
		expect(await h.waitFor("error", "decode-error")).toMatchObject({
			error: expect.stringContaining("native decode failed"),
		});
		h.send({ type: "stream_stop", id: "decode-error" });
		await nextTurn();
		expect(h.events.some(event => event.type === "stream_done")).toBe(false);
	});

	it("supports online batch transcription and leaves offline decodeAsync intact", async () => {
		const offlineDecode = spyOn(offlineRecognizer, "decodeAsync");
		const h = harness();
		h.send({ type: "transcribe", id: "batch-online", modelKey: key, audio: Float32Array.of(1, 2, 3) });
		expect(await h.waitFor("transcription", "batch-online")).toEqual({
			type: "transcription",
			id: "batch-online",
			text: "hello world tail",
		});
		expect(OnlineRecognizer.instances[0]!.streams[0]!.finishCalls).toBe(1);
		expect(offlineDecode).not.toHaveBeenCalled();
		h.send({ type: "transcribe", id: "batch-offline", modelKey: offlineKey, audio: Float32Array.of(1, 2) });
		expect(await h.waitFor("transcription", "batch-offline")).toEqual({
			type: "transcription",
			id: "batch-offline",
			text: "hello world",
		});
		expect(offlineDecode).toHaveBeenCalledTimes(1);
	});
});

describe("online stream terminal boundaries", () => {
	it("finishes an empty stream without inventing a segment", async () => {
		const h = harness();
		h.send({ type: "stream_start", id: "empty", modelKey: key });
		h.send({ type: "stream_stop", id: "empty" });
		expect(await h.waitFor("stream_done", "empty")).toEqual({ type: "stream_done", id: "empty", text: "" });
		expect(transcriptEvents(h.events)).toEqual([{ type: "stream_done", id: "empty", text: "" }]);
	});

	it("does not recommit an endpoint when Stop has no remaining speech", async () => {
		const h = harness();
		h.send({ type: "stream_start", id: "last-endpoint", modelKey: key });
		h.send({ type: "stream_audio", id: "last-endpoint", audio: Float32Array.of(1, -1) });
		await h.waitFor("segment", "last-endpoint");
		h.send({ type: "stream_stop", id: "last-endpoint" });
		expect(await h.waitFor("stream_done", "last-endpoint")).toEqual({
			type: "stream_done",
			id: "last-endpoint",
			text: "hello",
		});
		expect(h.events.filter(event => event.type === "segment")).toHaveLength(1);
	});

	it("cancels before the asynchronous model load begins", async () => {
		const h = harness();
		h.send({ type: "stream_start", id: "cancel-now", modelKey: key });
		h.send({ type: "stream_cancel", id: "cancel-now" });
		await nextTurn();
		expect(h.events).toEqual([]);
		expect(OnlineRecognizer.instances[0]!.streams).toHaveLength(0);
	});
});
