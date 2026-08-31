import { describe, expect, it } from "bun:test";
import { ShadowEvalGate } from "@oh-my-pi/pi-ai/auth-gateway/shadow-eval";

describe("ShadowEvalGate", () => {
	it("rejects a second acquire when maxConcurrent is 1", () => {
		const gate = new ShadowEvalGate({ maxConcurrent: 1 });
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquire()).toBe(false);
	});

	it("allows acquire after release", () => {
		const gate = new ShadowEvalGate({ maxConcurrent: 1 });
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquire()).toBe(false);
		gate.release();
		expect(gate.tryAcquire()).toBe(true);
	});

	it("does not raise the cap on extra release (negative)", () => {
		const gate = new ShadowEvalGate({ maxConcurrent: 1 });
		gate.release();
		gate.release();
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquire()).toBe(false);
	});

	it("admits up to maxConcurrent then rejects", () => {
		const gate = new ShadowEvalGate({ maxConcurrent: 2 });
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquire()).toBe(false);
		gate.release();
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquire()).toBe(false);
	});

	it("rejects every acquire when maxConcurrent is 0 (negative)", () => {
		const gate = new ShadowEvalGate({ maxConcurrent: 0 });
		expect(gate.tryAcquire()).toBe(false);
		gate.release();
		expect(gate.tryAcquire()).toBe(false);
	});

	it("does not share in-flight counts across gates", () => {
		const a = new ShadowEvalGate({ maxConcurrent: 1 });
		const b = new ShadowEvalGate({ maxConcurrent: 1 });
		expect(a.tryAcquire()).toBe(true);
		expect(b.tryAcquire()).toBe(true);
		expect(a.tryAcquire()).toBe(false);
		expect(b.tryAcquire()).toBe(false);
	});
});
