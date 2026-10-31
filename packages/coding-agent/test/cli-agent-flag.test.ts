import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --agent flag", () => {
	it("sets args.agent to the provided name", () => {
		const result = parseArgs(["--agent", "sisyphus"]);
		expect(result.agent).toBe("sisyphus");
	});

	it("defaults agent to undefined when flag is absent", () => {
		const result = parseArgs([]);
		expect(result.agent).toBeUndefined();
	});

	it("does not consume following flags as the agent name", () => {
		// --agent is a STRING_VALUE_FLAGS member — it must consume exactly one token.
		// This confirms it doesn't eat a flag-looking token incorrectly.
		const result = parseArgs(["--agent", "beta", "--print"]);
		expect(result.agent).toBe("beta");
		expect(result.print).toBe(true);
	});
});
