import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

describe("parseArgs — --hide-thinking flag", () => {
	it("parses --hide-thinking as a boolean flag", () => {
		const result = parseArgs(["--hide-thinking"]);
		expect(result.hideThinking).toBe(true);
	});

	it("defaults hideThinking to undefined when flag is not provided", () => {
		const result = parseArgs([]);
		expect(result.hideThinking).toBeUndefined();
	});

	it("parses --hide-thinking with other flags", () => {
		const result = parseArgs(["--hide-thinking", "--model", "opus", "hello"]);
		expect(result.hideThinking).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toContain("hello");
	});

	it("parses --hide-thinking with --thinking flag (both can coexist)", () => {
		const result = parseArgs(["--hide-thinking", "--thinking", "xhigh"]);
		expect(result.hideThinking).toBe(true);
		expect(result.thinking).toBe(Effort.XHigh);
	});

	it("parses --hide-thinking in any position", () => {
		const result1 = parseArgs(["--hide-thinking", "prompt"]);
		const result2 = parseArgs(["prompt", "--hide-thinking"]);
		const result3 = parseArgs(["--model", "opus", "--hide-thinking", "prompt"]);

		expect(result1.hideThinking).toBe(true);
		expect(result2.hideThinking).toBe(true);
		expect(result3.hideThinking).toBe(true);
	});

	it("does not consume a value after --hide-thinking", () => {
		const result = parseArgs(["--hide-thinking", "--model", "opus"]);
		expect(result.hideThinking).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
	});
});

describe("parseArgs — --thinking flag", () => {
	it("accepts off so reasoning can be disabled from the CLI", () => {
		expect(parseArgs(["--thinking", "off"]).thinking).toBe(ThinkingLevel.Off);
		expect(parseArgs(["--thinking=off"]).thinking).toBe(ThinkingLevel.Off);
	});

	it("accepts auto and every concrete effort including max", () => {
		expect(parseArgs(["--thinking", "auto"]).thinking).toBe(AUTO_THINKING);
		expect(parseArgs(["--thinking", "medium"]).thinking).toBe(Effort.Medium);
		expect(parseArgs(["--thinking", "max"]).thinking).toBe(ThinkingLevel.Max);
	});

	it("ignores invalid levels and the internal inherit selector", () => {
		expect(parseArgs(["--thinking", "bogus"]).thinking).toBeUndefined();
		expect(parseArgs(["--thinking", "inherit"]).thinking).toBeUndefined();
	});
});
