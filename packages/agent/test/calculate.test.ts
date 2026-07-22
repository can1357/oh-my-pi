import { describe, expect, it } from "bun:test";
import { calculate } from "./utils/calculate";

describe("calculate test tool", () => {
	it("evaluates arithmetic with precedence, parentheses, unary signs, and exponents", () => {
		expect(calculate("-2 + 3 * (4 + 1e1)").content).toEqual([{ type: "text", text: "-2 + 3 * (4 + 1e1) = 40" }]);
	});

	it("rejects executable JavaScript instead of evaluating it", () => {
		expect(() => calculate("globalThis.process.exit(1)")).toThrow("Unsupported token at position 1");
	});
});
