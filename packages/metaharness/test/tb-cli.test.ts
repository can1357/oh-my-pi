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
	it.each([
		{ name: "names the token variable", argv: ["--env", "METAHARNESS_GATEWAY_TOKEN=other"] },
		{ name: "holds the token", argv: ["--env", "PI_ALIAS=Bearer tb-secret"] },
	])("refuses an --env entry for the guest omp that $name", ({ argv }) => {
		// The guest omp reads the token from its private file; its environment reaches every tool call.
		expect(() => parseArgs(["--gateway-token", "tb-secret", ...argv])).toThrow(/gateway token/);
	});
	it.each([
		{ name: "a provider id", argv: ["--model", "tb-secret/model"] },
		{ name: "the gateway URL", argv: ["--gateway-url", "http://127.0.0.1:4000/tb-secret"] },
	])("refuses $name that repeats the token, which the guest's models.yml would hold", ({ argv }) => {
		expect(() => parseArgs(["--gateway-token", "tb-secret", ...argv])).toThrow(/holds the gateway token/);
	});
});
