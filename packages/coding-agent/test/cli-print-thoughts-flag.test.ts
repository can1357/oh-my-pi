import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --print-thoughts flag", () => {
	it("parses --print-thoughts as a boolean flag", () => {
		const result = parseArgs(["--print-thoughts"]);
		expect(result.printThoughts).toBe(true);
	});

	it("does not consume the next argument", () => {
		const result = parseArgs(["--print", "--print-thoughts", "explain"]);
		expect(result.print).toBe(true);
		expect(result.printThoughts).toBe(true);
		expect(result.messages).toEqual(["explain"]);
	});
});
