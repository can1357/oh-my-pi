import { describe, expect, it } from "bun:test";
import { commitGateObservesDownstreamSse, observeSseCommit, StreamCommitGate } from "@oh-my-pi/pi-ai/auth-gateway";

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
