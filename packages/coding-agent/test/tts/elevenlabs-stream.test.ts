import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openElevenLabsStream } from "../../src/tts/elevenlabs-stream";
import type { TtsAudioChunk } from "../../src/tts/tts-client";

function int16PcmBytes(samples: number[]): Uint8Array {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	for (const [i, sample] of samples.entries()) view.setInt16(i * 2, sample, true);
	return bytes;
}

async function drain(chunks: AsyncIterable<TtsAudioChunk>): Promise<TtsAudioChunk[]> {
	const collected: TtsAudioChunk[] = [];
	for await (const chunk of chunks) collected.push(chunk);
	return collected;
}

describe("openElevenLabsStream", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("emits one chunk per pushed sentence, in arrival-index order, as float32 PCM", async () => {
		const requestedTexts: string[] = [];
		const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { text: string };
			requestedTexts.push(body.text);
			const gate = Promise.withResolvers<void>();
			gates.set(body.text, gate);
			await gate.promise; // released explicitly by the test below, in the order it chooses
			const samples = body.text.startsWith("First") ? [1_000, -1_000] : [2_000, -2_000];
			return new Response(int16PcmBytes(samples), { status: 200 });
		}) as unknown as typeof fetch;

		const handle = openElevenLabsStream({ apiKey: "test-key" });
		handle.push("First sentence. ");
		handle.push("Second sentence.");
		// Both requests are already in flight here: `push` synchronously drives
		// `#synthesizeSentence` -> `fetch` -> this mock down to its first
		// `await gate.promise`, so both `gates` entries exist before this line.
		// Resolve "Second" first to prove the client still reorders to index order.
		gates.get("Second sentence.")?.resolve();
		gates.get("First sentence.")?.resolve();
		handle.end();

		const chunks = await drain(handle.chunks);

		expect(requestedTexts).toEqual(["First sentence.", "Second sentence."]);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.index).toBe(0);
		expect(chunks[0]?.text).toBe("First sentence.");
		expect(chunks[0]?.sampleRate).toBe(24_000);
		expect(Array.from(chunks[0]?.pcm ?? [])).toEqual([1_000 / 32_768, -1_000 / 32_768]);
		expect(chunks[1]?.index).toBe(1);
		expect(chunks[1]?.text).toBe("Second sentence.");
	});

	it("flushes a trailing partial sentence with no terminator on end()", async () => {
		globalThis.fetch = (async () => new Response(int16PcmBytes([0]), { status: 200 })) as unknown as typeof fetch;

		const handle = openElevenLabsStream({ apiKey: "test-key" });
		handle.push("No terminator here");
		handle.end();

		const chunks = await drain(handle.chunks);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.text).toBe("No terminator here");
	});

	it("ignores whitespace-only pushes and fires no request", async () => {
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(int16PcmBytes([0]), { status: 200 });
		}) as unknown as typeof fetch;

		const handle = openElevenLabsStream({ apiKey: "test-key" });
		handle.push("   ");
		handle.end();

		const chunks = await drain(handle.chunks);
		expect(chunks).toHaveLength(0);
		expect(callCount).toBe(0);
	});

	it("splits oversized sentences without dropping text or boundary whitespace", async () => {
		let requestedTexts: string[] = [];
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { text: string };
			requestedTexts.push(body.text);
			return new Response(int16PcmBytes([0]), { status: 200 });
		}) as unknown as typeof fetch;

		for (const text of [`${"x".repeat(2_001)}.`, `${"a".repeat(1_990)} ${"b".repeat(20)}.`]) {
			requestedTexts = [];
			const handle = openElevenLabsStream({ apiKey: "test-key" });
			handle.push(text);
			handle.end();

			const chunks = await drain(handle.chunks);
			expect(requestedTexts.every(part => part.length <= 2_000)).toBe(true);
			expect(requestedTexts.join("")).toBe(text);
			expect(chunks.map(chunk => chunk.text).join("")).toBe(text);
		}
	});

	it("propagates an HTTP failure to the chunk iterator instead of hanging or silently dropping it", async () => {
		globalThis.fetch = (async () =>
			new Response("plan does not support pcm output", { status: 422 })) as unknown as typeof fetch;

		const handle = openElevenLabsStream({ apiKey: "test-key" });
		handle.push("Will fail.");
		handle.end();

		await expect(drain(handle.chunks)).rejects.toThrow(/ElevenLabs TTS stream failed \(422\)/);
	});

	it("times out a stalled synthesis request instead of blocking the stream forever", async () => {
		globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
			return promise;
		}) as typeof fetch;

		const handle = openElevenLabsStream({ apiKey: "test-key", requestTimeoutMs: 5 });
		handle.push("Will time out.");
		handle.end();

		await expect(drain(handle.chunks)).rejects.toThrow("request timed out");
	});

	it("returns an inert, immediately-closed handle for an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();

		const handle = openElevenLabsStream({ apiKey: "test-key", signal: controller.signal });
		const chunks = await drain(handle.chunks);
		expect(chunks).toHaveLength(0);
	});
});
