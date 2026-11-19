/**
 * `omp join <link>` must route to the registered `join` subcommand instead of
 * being rewritten to `launch join <link>` and forwarded to the LLM as an
 * initial prompt (same failure mode as #1496).
 */
import { describe, expect, test } from "bun:test";
import { isSubcommand, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

describe("join command is registered as a top-level subcommand", () => {
	test("CLI runner routes `join <link>` to the join command, not launch", () => {
		expect(isSubcommand("join")).toBe(true);
		expect(resolveCliArgv(["join", "wss://my.omp.sh/s/abc#key"])).toEqual({
			argv: ["join", "wss://my.omp.sh/s/abc#key"],
		});
	});
});
