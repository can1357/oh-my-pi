import { describe, expect, it } from "bun:test";
import { splitPressArgs } from "@oh-my-pi/pi-coding-agent/tools/browser/press-args";

describe("splitPressArgs (issue #12136)", () => {
	it("keeps the key-only form unchanged", () => {
		expect(splitPressArgs("Escape")).toEqual({ key: "Escape", selector: undefined });
		expect(splitPressArgs("Escape", undefined)).toEqual({ key: "Escape", selector: undefined });
	});

	it("keeps the options-object form unchanged", () => {
		expect(splitPressArgs("Escape", { selector: "body" })).toEqual({ key: "Escape", selector: "body" });
		expect(splitPressArgs("Escape", {})).toEqual({ key: "Escape", selector: undefined });
	});

	it("reads a string second argument as Playwright-style (selector, key)", () => {
		expect(splitPressArgs("body", "Escape")).toEqual({ key: "Escape", selector: "body" });
	});
});
