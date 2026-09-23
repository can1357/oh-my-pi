import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";

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

	it("parses --hide-thinking with --thinking mode flag (both can coexist)", () => {
		const result = parseArgs(["--hide-thinking", "--thinking", "adaptive"]);
		expect(result.hideThinking).toBe(true);
		expect(result.thinkingMode).toBe("adaptive");
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

describe("parseArgs — thinking mode and effort flags", () => {
	it("accepts --thinking modes so the additive thinking axis is CLI-controllable", () => {
		expect(parseArgs(["--thinking", "adaptive"]).thinkingMode).toBe("adaptive");
		expect(parseArgs(["--thinking=adaptive"]).thinkingMode).toBe("adaptive");
		expect(parseArgs(["--thinking", "default"]).thinkingMode).toBe("default");
	});

	it("accepts auto, off, and every concrete effort through --effort", () => {
		expect(parseArgs(["--effort", "auto"]).effort).toBe(AUTO_THINKING);
		expect(parseArgs(["--effort", "medium"]).effort).toBe(Effort.Medium);
		expect(parseArgs(["--effort", "max"]).effort).toBe(Effort.Max);
		expect(parseArgs(["--effort", "off"]).effort).toBe(ThinkingLevel.Off);
	});

	it("routes deprecated effort values passed to --thinking onto the effort axis", () => {
		// Compat: `--thinking off|high|...` kept working after the axis split.
		const off = parseArgs(["--thinking", "off"]);
		expect(off.effort).toBe(ThinkingLevel.Off);
		expect(off.thinkingMode).toBeUndefined();

		const high = parseArgs(["--thinking", "high"]);
		expect(high.effort).toBe(Effort.High);
		expect(high.thinkingMode).toBeUndefined();
	});

	it("warns when an effort value is passed to the deprecated --thinking flag", () => {
		// The warning is the whole user-visible half of the compat story; without
		// this the notice can vanish and the routing tests stay green.
		const off = (parseArgs(["--thinking", "off"]).warnings ?? []).join("\n");
		expect(off).toContain("--thinking off is deprecated");
		expect(off).toContain("--effort off");

		const abbreviatedOff = (parseArgs(["--thinking", "of"]).warnings ?? []).join("\n");
		expect(abbreviatedOff).toContain("--thinking of is deprecated");
		expect(abbreviatedOff).toContain("--effort off");

		// A real mode selector is not deprecated and must stay silent.
		// `warnings` is allocated only when a notice exists, so absent == silent.
		expect(parseArgs(["--thinking", "adaptive"]).warnings ?? []).toEqual([]);
	});

	it("accepts unambiguous abbreviations for off and auto on both flags", () => {
		// `off` lost prefix support when it moved to the effort axis; every other
		// selector kept it, so `--thinking of` silently became a fatal error.
		expect(parseArgs(["--effort", "of"]).effort).toBe(ThinkingLevel.Off);
		expect(parseArgs(["--effort", "au"]).effort).toBe(AUTO_THINKING);
		expect(parseArgs(["--thinking", "of"]).effort).toBe(ThinkingLevel.Off);
		expect(parseArgs(["--thinking", "au"]).effort).toBe(AUTO_THINKING);
	});

	it("keeps an explicit --effort authoritative over a deprecated --thinking effort in either order", () => {
		const deprecatedFirst = parseArgs(["--thinking", "off", "--effort", "high"]);
		expect(deprecatedFirst.effort).toBe(Effort.High);
		expect(deprecatedFirst.thinkingMode).toBeUndefined();

		const explicitFirst = parseArgs(["--effort", "off", "--thinking", "high"]);
		expect(explicitFirst.effort).toBe(ThinkingLevel.Off);
		expect(explicitFirst.thinkingMode).toBeUndefined();
	});

	it("lets the last deprecated --thinking effort win when no explicit --effort is given", () => {
		expect(parseArgs(["--thinking", "low", "--thinking", "high"]).effort).toBe(Effort.High);
	});

	it("keeps a thinking mode alongside a deprecated effort alias", () => {
		const result = parseArgs(["--thinking", "adaptive", "--thinking", "high"]);
		expect(result.thinkingMode).toBe("adaptive");
		expect(result.effort).toBe(Effort.High);
	});

	it("rejects invalid mode and effort selectors", () => {
		expect(() => parseArgs(["--thinking", "inherit"])).toThrow();
		expect(() => parseArgs(["--thinking", "bogus"])).toThrow();
		expect(() => parseArgs(["--effort", "adaptive"])).toThrow();
		expect(() => parseArgs(["--effort", "bogus"])).toThrow();
	});
});
