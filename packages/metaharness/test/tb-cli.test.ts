import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/tb/cli";

describe("Terminal-Bench CLI", () => {
	it("defaults to the requested seven-model flash pool", () => {
		const config = parseArgs([]);
		expect(config.models).toEqual([
			"openrouter/inclusionai/ling-3.0-flash",
			"openrouter/deepseek/deepseek-v4-flash-0731",
			"openrouter/deepseek/deepseek-v4-flash",
			"openrouter/nvidia/nemotron-3.5-lightning",
			"openrouter/poolside/laguna-s-2.1",
			"openrouter/tencent/hy3",
			"openrouter/stepfun/step-3.7-flash",
		]);
		expect(config.openrouterVariant).toBe("floor");
	});

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
