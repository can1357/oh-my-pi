import { describe, expect, it } from "bun:test";
import {
	commitGateObservesDownstreamSse,
	holdSseUntilCommit,
	observeSseCommit,
	PreludeAbortedError,
	StreamCommitGate,
} from "@oh-my-pi/pi-ai/auth-gateway";

const FOUR_MIB = 4 * 1024 * 1024;

describe("StreamCommitGate", () => {
	it("commits on unknown or missing event type", () => {
		const unknown = new StreamCommitGate();
		expect(unknown.classifyAndObserve("totally-unknown-event", 16)).toBe("committed");
		const missing = new StreamCommitGate();
		expect(missing.classifyAndObserve("", 8)).toBe("committed");
	});

	it("stays probing on response.created metadata", () => {
		const gate = new StreamCommitGate();
		expect(gate.classifyAndObserve("response.created", 64)).toBe("probing");
		expect(gate.classifyAndObserve("response.in_progress", 32)).toBe("probing");
		expect(gate.classifyAndObserve("heartbeat", 4)).toBe("probing");
	});

	it("commits when prelude reaches 4 MiB even on metadata", () => {
		const gate = new StreamCommitGate();
		expect(gate.classifyAndObserve("response.created", FOUR_MIB)).toBe("committed");
	});

	it("stays probing just under the 4 MiB cap (negative)", () => {
		const gate = new StreamCommitGate();
		expect(gate.classifyAndObserve("response.created", FOUR_MIB - 1)).toBe("probing");
	});

	it("terminates after a retryable terminal once output has committed (failover stays forbidden)", () => {
		const gate = new StreamCommitGate();
		expect(gate.classifyAndObserve("response.output_text.delta", 12)).toBe("committed");
		// Post-commit `response.failed` ends the stream: the failure surfaces to
		// the client and the state machine must reflect terminality, not linger
		// in "committed" as if output could still flow.
		expect(gate.classifyAndObserve("response.failed", 40)).toBe("terminated");
		expect(gate.state).toBe("terminated");
	});

	it("classifies response.incomplete as a terminal, never as output", () => {
		const gate = new StreamCommitGate();
		expect(gate.classifyAndObserve("response.created", 20)).toBe("probing");
		expect(gate.classifyAndObserve("response.incomplete", 40)).toBe("terminated");
	});

	it("terminates as retryable when response.failed arrives before any output (negative)", () => {
		const gate = new StreamCommitGate();
		expect(gate.classifyAndObserve("response.created", 20)).toBe("probing");
		expect(gate.classifyAndObserve("response.failed", 20)).toBe("terminated");
		expect(gate.state).not.toBe("committed");
	});

	it("uses downstream SSE only for openai-responses (negative: chat is upstream-fed)", () => {
		expect(commitGateObservesDownstreamSse("openai-responses")).toBe(true);
		expect(commitGateObservesDownstreamSse("openai-chat")).toBe(false);
		expect(commitGateObservesDownstreamSse("anthropic-messages")).toBe(false);
	});

	it("observeSseCommit counts frame.length not chunk.byteLength (negative heartbeat steal)", async () => {
		const body = "event: response.created\ndata: {}";
		const frame = `${body}\n\n`;
		const bytes = new TextEncoder().encode(frame);
		const cap = body.length * 3 + 1;
		const gate = new StreamCommitGate(cap);
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.enqueue(bytes);
				controller.enqueue(bytes);
				controller.close();
			},
		});
		await observeSseCommit(source, gate).pipeTo(new WritableStream());
		expect(gate.state).toBe("probing");
	});

	it("observeSseCommit commits when metadata prelude reaches the cap", async () => {
		const body = "event: response.created\ndata: {}";
		const frame = `${body}\n\n`;
		const bytes = new TextEncoder().encode(frame);
		const gate = new StreamCommitGate(body.length);
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
		await observeSseCommit(source, gate).pipeTo(new WritableStream());
		expect(gate.state).toBe("committed");
	});
});


	it("reset returns a terminated gate to probing and clears buffered prelude", () => {
		const gate = new StreamCommitGate();
		expect(gate.bufferPrelude(new Uint8Array([1, 2, 3]))).toBe(true);
		expect(gate.classifyAndObserve("response.failed", 8)).toBe("terminated");
		gate.reset();
		expect(gate.state).toBe("probing");
		expect(gate.preludeByteLength).toBe(0);
		expect(gate.classifyAndObserve("response.created", 4)).toBe("probing");
	});

describe("holdSseUntilCommit (prelude replay buffer)", () => {
	function sse(frames: string[]): ReadableStream<Uint8Array> {
		const enc = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const f of frames) controller.enqueue(enc.encode(f));
				controller.close();
			},
		});
	}

	async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
		const dec = new TextDecoder();
		let out = "";
		for await (const chunk of stream) out += dec.decode(chunk, { stream: true });
		return out;
	}

	it("holds pre-commit frames, then flushes them on commit so the client sees exactly one response", async () => {
		const gate = new StreamCommitGate();
		const held = holdSseUntilCommit(
			sse(["event: response.created\ndata: {}\n\n", 'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n']),
			gate,
		);
		const out = await collect(held);
		expect(out).toContain("response.created");
		expect(out).toContain("output_text.delta");
		expect(gate.state).toBe("committed");
	});

	it("aborts with the dead attempt's frames on a pre-commit retryable terminal", async () => {
		const gate = new StreamCommitGate();
		const held = holdSseUntilCommit(
			sse(["event: response.created\ndata: {}\n\n", 'event: response.failed\ndata: {"error":{}}\n\n']),
			gate,
		);
		let aborted: PreludeAbortedError | undefined;
		try {
			await collect(held);
		} catch (error) {
			aborted = error as PreludeAbortedError;
		}
		expect(aborted).toBeInstanceOf(PreludeAbortedError);
		// the dead attempt's metadata is returned to the failover loop for
		// discarding — the replacement attempt's stream starts from byte zero
		expect(aborted?.frames.length).toBeGreaterThan(0);
		expect(gate.state).toBe("terminated");
	});

	it("never forwards a dead attempt's metadata to the client (negative)", async () => {
		const gate = new StreamCommitGate();
		const held = holdSseUntilCommit(
			sse(["event: response.created\ndata: {}\n\n", "event: response.failed\ndata: {}\n\n"]),
			gate,
		);
		let sawCreated = false;
		try {
			for await (const chunk of held) {
				if (new TextDecoder().decode(chunk).includes("response.created")) sawCreated = true;
			}
		} catch {
			// expected abort
		}
		expect(sawCreated).toBe(false);
	});

	it("stops buffering at commit and releases memory on drain (bounded)", () => {
		const gate = new StreamCommitGate();
		expect(gate.bufferPrelude(new Uint8Array(8))).toBe(true);
		gate.classifyAndObserve("response.output_text.delta", 10);
		// post-commit buffering is refused — held memory is capped by the prelude cap
		expect(gate.bufferPrelude(new Uint8Array(8))).toBe(false);
		// the holding consumer drains at flush time, releasing the buffer
		expect(gate.takePrelude()?.length).toBe(1);
		expect(gate.preludeByteLength).toBe(0);
	});
});
