/**
 * `-e`/`--extension <path>` must count as prepaint-safe.
 *
 * #20158: the extension flag was missing from the prepaint-safe set, so
 * `omp -e <path>` skipped the speculative first frame and the terminal
 * capability queries became the first bytes of output. A terminal that
 * answers the kitty keyboard query slowly then received the upgrade
 * sequence after the first frame (and after the alternate-screen enter),
 * so keys typed in between arrived under modifyOtherKeys instead.
 */
import { describe, expect, test } from "bun:test";
import { isPrepaintSafeArgv } from "../src/cli";

describe("isPrepaintSafeArgv", () => {
	test("empty argv and plain safe flags are prepaint-safe", () => {
		expect(isPrepaintSafeArgv([])).toBe(true);
		expect(isPrepaintSafeArgv(["--no-session", "--offline"])).toBe(true);
	});

	test("`-e <path>` and `--extension <path>` are prepaint-safe", () => {
		expect(isPrepaintSafeArgv(["-e", "empty.ts"])).toBe(true);
		expect(isPrepaintSafeArgv(["--extension", "./ext/index.ts"])).toBe(true);
		expect(isPrepaintSafeArgv(["-e", "empty.ts", "--no-session"])).toBe(true);
	});

	test("`--extension=value` is prepaint-safe", () => {
		expect(isPrepaintSafeArgv(["--extension=empty.ts"])).toBe(true);
	});

	test("unsafe flags and subcommands still disable prepaint", () => {
		expect(isPrepaintSafeArgv(["-p", "hello"])).toBe(false);
		expect(isPrepaintSafeArgv(["--model", "gpt-5"])).toBe(false);
		expect(isPrepaintSafeArgv(["-e", "empty.ts", "-p", "hello"])).toBe(false);
	});
});
