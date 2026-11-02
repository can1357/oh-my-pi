import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { colorToAnsi, detectColorMode } from "@oh-my-pi/pi-tui/theme/color";

describe("theme color mode", () => {
	it("emits 256-color SGR for macOS Terminal.app", () => {
		const mode = detectColorMode({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" });

		expect(mode).toBe("256color");
		expect(colorToAnsi("#f5e0ac", mode)).toBe("\x1b[38;5;223m");
	});

	it("keeps repeated foreground conversions separate across color depths", () => {
		expect(colorToAnsi("#f5e0ac", "truecolor")).toBe("\x1b[38;2;245;224;172m");
		expect(colorToAnsi("#f5e0ac", "256color")).toBe("\x1b[38;5;223m");
		expect(colorToAnsi("#f5e0ac", "truecolor")).toBe("\x1b[38;2;245;224;172m");
	});

	it("emits 256-color session accents for macOS Terminal.app", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				"--eval",
				'import { getSessionAccentAnsi } from "./packages/tui/src/theme/session-color.ts"; process.stdout.write(getSessionAccentAnsi("#f5e0ac") ?? "undefined");',
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				// Only what the child needs to run: any inherited terminal identity (TMUX, WT_SESSION,
				// NO_COLOR, FORCE_COLOR, a parent omp's overrides, …) would change the detected color depth.
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					TERM_PROGRAM: "Apple_Terminal",
					TERM: "xterm-256color",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("\x1b[38;5;223m");
	});
});
