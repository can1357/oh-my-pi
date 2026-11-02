import { describe, expect, it } from "bun:test";
import { envFlag } from "@oh-my-pi/pi-mnemopi/util/env";

describe("envFlag", () => {
	it("keeps the default only when the variable is unset or blank", () => {
		expect(envFlag("MNEMOPI_LLM_ENABLED", true, {})).toBe(true);
		expect(envFlag("MNEMOPI_LLM_ENABLED", true, { MNEMOPI_LLM_ENABLED: "  " })).toBe(true);
		expect(envFlag("MNEMOPI_HOST_LLM_ENABLED", false, {})).toBe(false);
	});

	it("reads a malformed value as disabled even when the default is enabled", () => {
		expect(envFlag("MNEMOPI_LLM_ENABLED", true, { MNEMOPI_LLM_ENABLED: "maybe" })).toBe(false);
		expect(envFlag("MNEMOPI_LLM_ENABLED", true, { MNEMOPI_LLM_ENABLED: "0" })).toBe(false);
	});

	it("enables for the recognized truthy spellings", () => {
		expect(envFlag("MNEMOPI_HOST_LLM_ENABLED", false, { MNEMOPI_HOST_LLM_ENABLED: " Yes " })).toBe(true);
		expect(envFlag("MNEMOPI_HOST_LLM_ENABLED", false, { MNEMOPI_HOST_LLM_ENABLED: "1" })).toBe(true);
	});
});
