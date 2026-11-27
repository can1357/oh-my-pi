/**
 * #20158: `-e`/`--extension <path>` disabled the speculative first frame, so the terminal capability
 * queries became the first output and a slow kitty keyboard reply landed after the alternate screen.
 */
import { describe, expect, test } from "bun:test";
import { prepaintOptionsForArgv } from "../src/cli";

describe("prepaintOptionsForArgv", () => {
	test("an extension path, in either spelling, keeps the first frame", () => {
		expect(prepaintOptionsForArgv(["-e", "empty.ts", "--no-session"])).toEqual({});
		expect(prepaintOptionsForArgv(["--extension", "./ext/index.ts"])).toEqual({});
		expect(prepaintOptionsForArgv(["--extension=empty.ts"])).toEqual({});
	});

	test("an extension path does not hide an unsafe flag after it", () => {
		expect(prepaintOptionsForArgv(["-e", "empty.ts", "-p", "hello"])).toBeUndefined();
		expect(prepaintOptionsForArgv(["--model", "gpt-5"])).toBeUndefined();
	});

	test("the first frame gets the last explicit mode, not a flag-shaped extension path", () => {
		expect(prepaintOptionsForArgv(["--tui-mode", "fullscreen"])).toEqual({ tuiMode: "fullscreen" });
		expect(prepaintOptionsForArgv(["--tui-mode=fullscreen", "--tui-mode", "inline"])).toEqual({ tuiMode: "inline" });
		expect(prepaintOptionsForArgv(["-e", "--tui-mode=fullscreen"])).toEqual({});
	});

	test("invalid modes and noninteractive commands do not start the terminal", () => {
		expect(prepaintOptionsForArgv(["--tui-mode"])).toBeUndefined();
		expect(prepaintOptionsForArgv(["--tui-mode="])).toBeUndefined();
		expect(prepaintOptionsForArgv(["--tui-mode", "invalid"])).toBeUndefined();
		expect(prepaintOptionsForArgv(["--tui-mode=fullscreen", "-p"])).toBeUndefined();
	});
});
