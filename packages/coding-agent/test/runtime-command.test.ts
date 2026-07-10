import { describe, expect, test } from "bun:test";
import { commands, isSubcommand, resolveCliArgv } from "@pk-nerdsaver-ai/pi-coding-agent/cli-commands";

describe("runtime command registration", () => {
	test("runtime is a top-level subcommand", () => {
		expect(commands.some(c => c.name === "runtime")).toBe(true);
		expect(isSubcommand("runtime")).toBe(true);
		expect(resolveCliArgv(["runtime", "list"])).toEqual({ argv: ["runtime", "list"] });
	});
});
