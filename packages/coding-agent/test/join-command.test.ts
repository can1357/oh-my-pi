/**
 * `omp join <link>` must route to the registered `join` subcommand instead of
 * being rewritten to `launch join <link>` and forwarded to the LLM as an
 * initial prompt (same failure mode as #1496).
 */
import { describe, expect, test } from "bun:test";
import { isSubcommand, resolveCliArgv } from "@pk-nerdsaver-ai/pi-coding-agent/cli-commands";

describe("join command is registered as a top-level subcommand", () => {
	test("CLI runner routes `join <link>` to the join command, not launch", () => {
		expect(isSubcommand("join")).toBe(true);
		expect(resolveCliArgv(["join", "wss://collab.pkking.computer/s/abc#key"])).toEqual({
			argv: ["join", "wss://collab.pkking.computer/s/abc#key"],
		});
	});
});
