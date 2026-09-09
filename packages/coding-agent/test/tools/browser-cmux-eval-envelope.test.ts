import { describe, expect, it } from "bun:test";
import { serializeEvalWithEnvelope, unwrapEvalEnvelope } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";

/**
 * Executes the envelope script the way the cmux daemon would (global-scope
 * evaluation of an expression) and round-trips the result through JSON to
 * mirror the socket wire format.
 */
function runOnWire(script: string): unknown {
	const value = new Function(`return (${script})`)();
	return JSON.parse(JSON.stringify(value));
}

describe("cmux eval envelope", () => {
	it("returns plain values through the ok envelope", () => {
		const value = runOnWire(serializeEvalWithEnvelope("1 + 1", []));
		expect(unwrapEvalEnvelope<number>(value, "tab.evaluate()")).toBe(2);
	});

	it("invokes function sources with serialized args", () => {
		const script = serializeEvalWithEnvelope(
			((a: number, b: number) => a * b) as (...args: unknown[]) => unknown,
			[6, 7],
		);
		const value = runOnWire(script);
		expect(unwrapEvalEnvelope<number>(value, "tab.evaluate()")).toBe(42);
	});

	it("surfaces thrown exceptions with their message instead of an opaque js_error", () => {
		// Regression: a throwing script came back as the daemon's bare
		// `js_error: A JavaScript exception occurred`, hiding the actual error.
		const script = serializeEvalWithEnvelope("(() => { throw new Error('boom from page') })()", []);
		const value = runOnWire(script);
		expect(() => unwrapEvalEnvelope(value, "tab.evaluate()")).toThrow(/boom from page/);
	});

	it("flags Promise returns with an actionable error instead of an unsupported-type failure", () => {
		const script = serializeEvalWithEnvelope("Promise.resolve(1)", []);
		const value = runOnWire(script);
		expect(() => unwrapEvalEnvelope(value, "tab.evaluate()")).toThrow(/synchronously/);
	});

	it("maps undefined results to null (JSON cannot carry undefined)", () => {
		const value = runOnWire(serializeEvalWithEnvelope("undefined", []));
		expect(unwrapEvalEnvelope<null>(value, "tab.evaluate()")).toBeNull();
	});

	it("passes through values from daemons that did not run the wrapper", () => {
		expect(unwrapEvalEnvelope<{ plain: boolean }>({ plain: true }, "tab.evaluate()")).toEqual({ plain: true });
		expect(unwrapEvalEnvelope<number>(7, "tab.evaluate()")).toBe(7);
	});
});
