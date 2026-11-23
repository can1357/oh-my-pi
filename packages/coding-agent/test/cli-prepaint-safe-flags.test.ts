/**
 * #20158: `-e`/`--extension <path>` disabled the speculative first frame, so the terminal capability
 * queries became the first output and a slow kitty keyboard reply landed after the alternate screen.
 */
import { describe, expect, test } from "bun:test";
import { isPrepaintSafeArgv } from "../src/cli";

describe("isPrepaintSafeArgv", () => {
	test("an extension path, in either spelling, keeps the first frame", () => {
		expect(isPrepaintSafeArgv(["-e", "empty.ts", "--no-session"])).toBe(true);
		expect(isPrepaintSafeArgv(["--extension", "./ext/index.ts"])).toBe(true);
		expect(isPrepaintSafeArgv(["--extension=empty.ts"])).toBe(true);
	});

	test("an extension path does not hide an unsafe flag after it", () => {
		expect(isPrepaintSafeArgv(["-e", "empty.ts", "-p", "hello"])).toBe(false);
		expect(isPrepaintSafeArgv(["--model", "gpt-5"])).toBe(false);
	});
});
