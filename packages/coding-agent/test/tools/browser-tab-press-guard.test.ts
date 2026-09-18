import { describe, expect, it } from "bun:test";
import { assertTabPressArgs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";

describe("tab.press argument guard", () => {
	it("names the inverted (selector, key) call and suggests the corrected order", () => {
		// Reported failure (#12136): press("body", "Escape") died inside the key
		// parser as `Unknown key: body`, so the agent retried the same inverted
		// call instead of fixing the argument order.
		expect(() => assertTabPressArgs("body", "Escape")).toThrow(
			/tab\.press\(\) takes \(key, options\) but was called as \(selector, key\)[\s\S]*tab\.press\("Escape", \{ ?selector: "body" \}\)/,
		);
	});

	it("passes the canonical (key, options) call through untouched", () => {
		expect(() => assertTabPressArgs("Escape", { selector: "body" })).not.toThrow();
	});

	it("passes a bare key through untouched", () => {
		expect(() => assertTabPressArgs("Escape")).not.toThrow();
	});
});
