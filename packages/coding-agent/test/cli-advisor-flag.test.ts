import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --advisor flag", () => {
	it("parses --advisor as a boolean flag", () => {
		const result = parseArgs(["--advisor"]);
		expect(result.advisor).toBe(true);
	});

	it("defaults advisor to undefined when flag is not provided", () => {
		const result = parseArgs([]);
		expect(result.advisor).toBeUndefined();
	});

	it("parses --advisor with other flags", () => {
		const result = parseArgs(["--advisor", "--model", "opus", "hello"]);
		expect(result.advisor).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toContain("hello");
	});

	it("parses --advisor in any position", () => {
		const result1 = parseArgs(["--advisor", "prompt"]);
		const result2 = parseArgs(["prompt", "--advisor"]);
		const result3 = parseArgs(["--model", "opus", "--advisor", "prompt"]);

		expect(result1.advisor).toBe(true);
		expect(result2.advisor).toBe(true);
		expect(result3.advisor).toBe(true);
	});

	it("does not consume a value after --advisor", () => {
		const result = parseArgs(["--advisor", "--model", "opus"]);
		expect(result.advisor).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
	});
});
