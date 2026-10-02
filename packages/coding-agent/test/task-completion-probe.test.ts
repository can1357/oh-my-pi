import { describe, expect, it } from "bun:test";
import { parseCompletionPercent } from "../src/task/completion-probe";

describe("parseCompletionPercent", () => {
	it("reads the first percentage out of loose model replies", () => {
		expect(parseCompletionPercent("40%")).toBe(40);
		expect(parseCompletionPercent("Roughly ~65 % done, then 90% later")).toBe(65);
		expect(parseCompletionPercent("`72.6%`")).toBe(73);
	});

	it("clamps to 0–100 and rejects replies without a percentage", () => {
		expect(parseCompletionPercent("150%")).toBe(100);
		expect(parseCompletionPercent("0%")).toBe(0);
		expect(parseCompletionPercent("about half")).toBeUndefined();
		expect(parseCompletionPercent("step 3 of 5")).toBeUndefined();
	});
});
