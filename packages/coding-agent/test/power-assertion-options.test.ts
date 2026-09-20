import { describe, expect, it } from "bun:test";
import { powerAssertionOptions } from "../src/session/agent-session";

describe("powerAssertionOptions", () => {
	it("asks for no assertion when sleep prevention is off", () => {
		expect(powerAssertionOptions("off")).toBeUndefined();
	});

	it("selects cumulative flags per mode", () => {
		expect(powerAssertionOptions("idle")).toMatchObject({ idle: true, display: false, system: false, user: false });
		expect(powerAssertionOptions("display")).toMatchObject({ idle: true, display: true, system: false, user: false });
		expect(powerAssertionOptions("system")).toMatchObject({ idle: true, display: true, system: true, user: true });
	});

	it("names the session so platform power diagnostics can attribute the assertion", () => {
		expect(powerAssertionOptions("idle")?.reason).toBe("Oh My Pi agent session");
	});
});
