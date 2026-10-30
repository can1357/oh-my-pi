import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/tb/cli";

describe("Terminal-Bench CLI", () => {
	it("replaces the default pool with explicit models", () => {
		expect(parseArgs(["--model", "openrouter/a", "-m", "openrouter/b"]).models).toEqual([
			"openrouter/a",
			"openrouter/b",
		]);
	});
	it("accepts an explicit OpenRouter routing policy", () => {
		expect(parseArgs(["--openrouter-variant", "nitro"]).openrouterVariant).toBe("nitro");
		expect(() => parseArgs(["--openrouter-variant", "random"])).toThrow(/openrouter-variant/);
	});
});
