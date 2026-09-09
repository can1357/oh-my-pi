import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { colorToAnsi, detectColorMode } from "../src/modes/theme/color";

describe("theme color mode", () => {
	it("emits 256-color SGR for macOS Terminal.app", () => {
		const mode = detectColorMode({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" });

		expect(mode).toBe("256color");
		expect(colorToAnsi("#f5e0ac", mode)).toBe("\x1b[38;5;223m");
	});

	it("emits 256-color session accents for macOS Terminal.app", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				"--eval",
				'import { getSessionAccentAnsi } from "./packages/coding-agent/src/utils/session-color.ts"; process.stdout.write(getSessionAccentAnsi("#f5e0ac") ?? "undefined");',
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					KITTY_WINDOW_ID: "",
					GHOSTTY_RESOURCES_DIR: "",
					WEZTERM_PANE: "",
					ITERM_SESSION_ID: "",
					VSCODE_PID: "",
					ALACRITTY_WINDOW_ID: "",
					TERM_PROGRAM: "Apple_Terminal",
					TERM: "xterm-256color",
					COLORTERM: "",
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
