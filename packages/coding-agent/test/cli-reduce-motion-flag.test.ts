import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";
import { restartArgv } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

describe("parseArgs — --reduce-motion flag", () => {
	it("parses the bare form as on", () => {
		const result = parseArgs(["--reduce-motion"]);
		expect(result.reduceMotion).toBe("on");
	});

	it.each(["off", "on", "strict"])("parses space-separated mode %s before a prompt", mode => {
		const result = parseArgs(["--reduce-motion", mode, "fix this"]);
		expect(result.reduceMotion).toBe(mode);
		expect(result.messages).toEqual(["fix this"]);
	});

	it.each(["off", "on", "strict"])("parses explicit mode %s before a prompt", mode => {
		const result = parseArgs([`--reduce-motion=${mode}`, "fix this"]);
		expect(result.reduceMotion).toBe(mode);
		expect(result.messages).toEqual(["fix this"]);
	});

	it.each(["fix this", "bogus"])("preserves positional prompt %s after the bare flag", prompt => {
		const result = parseArgs(["--reduce-motion", prompt]);
		expect(result.reduceMotion).toBe("on");
		expect(result.messages).toEqual([prompt]);
	});

	it.each(["bogus", "", "--print"])("rejects invalid explicit mode %s", value => {
		expect(() => parseArgs([`--reduce-motion=${value}`])).toThrow(
			`--reduce-motion accepts "on", "strict", or "off" (got "${value}")`,
		);
	});

	it("preserves mode-shaped prompts after --", () => {
		const result = parseArgs(["--reduce-motion", "--", "strict", "--print"]);
		expect(result.reduceMotion).toBe("on");
		expect(result.messages).toEqual(["strict", "--print"]);
		expect(result.print).toBeUndefined();
	});

	it("keeps subcommand routing and restart from consuming a prompt as a motion level", () => {
		expect(resolveCliArgv(["--reduce-motion", "acp"])).toEqual({ argv: ["acp", "--reduce-motion"] });
		expect(resolveCliArgv(["--reduce-motion", "strict", "fix this"])).toEqual({
			argv: ["launch", "--reduce-motion", "strict", "fix this"],
		});
		expect(restartArgv(["--reduce-motion", "fix this"], "session-id")).toEqual([
			"--reduce-motion",
			"--resume",
			"session-id",
		]);
		expect(restartArgv(["--reduce-motion", "strict", "fix this"], "session-id")).toEqual([
			"--reduce-motion",
			"strict",
			"--resume",
			"session-id",
		]);
	});

	it("preserves prompts and mode boundaries through profile bootstrap and reparsing", () => {
		for (const argv of [
			["--reduce-motion", "fix this", "--profile", "work"],
			["--reduce-motion", "--profile", "work", "strict"],
		]) {
			const original = [...argv];
			const extracted = extractProfileFlags(argv);
			expect(extracted.profile).toBe("work");
			for (let pass = 0; pass < 2; pass++) {
				const result = parseArgs(extracted.argv);
				expect(result.reduceMotion).toBe("on");
				expect(result.messages).toEqual([argv[1] === "fix this" ? "fix this" : "strict"]);
			}
			expect(argv).toEqual(original);
		}
	});

	it("defaults reduceMotion to undefined when flag is not provided", () => {
		const result = parseArgs([]);
		expect(result.reduceMotion).toBeUndefined();
	});

	it("releases flag-looking tokens back to their own handlers", () => {
		const result = parseArgs(["--reduce-motion", "--print", "hello"]);
		expect(result.reduceMotion).toBe("on");
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("treats an empty-string token as the bare form", () => {
		const result = parseArgs(["--reduce-motion", ""]);
		expect(result.reduceMotion).toBe("on");
		expect(result.messages).toEqual([""]);
	});
});
