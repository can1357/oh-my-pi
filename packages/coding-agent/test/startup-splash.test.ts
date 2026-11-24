import { describe, expect, it, vi } from "bun:test";
import { shouldShowStartupSplash } from "@oh-my-pi/pi-coding-agent/startup-splash";
import { signal } from "@oh-my-pi/pi-tui";
import { SPLASH_MS, StartupSplash } from "../src/ui/setup/splash";
import { mountLayer } from "./helpers/layer-terminal";

describe("startup splash", () => {
	it("requires the explicit setting and normal interactive TTY startup", () => {
		const base = {
			configured: true,
			isInteractive: true,
			resuming: false,
			quiet: false,
			timing: false,
			stdinIsTTY: true,
			stdoutIsTTY: true,
		};

		expect(shouldShowStartupSplash(base)).toBe(true);
		expect(shouldShowStartupSplash({ ...base, configured: false })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, isInteractive: false })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, resuming: true })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, quiet: true })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, timing: true })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, stdinIsTTY: false })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, stdoutIsTTY: false })).toBe(false);
	});

	it("ends once on its time-out", () => {
		const now = signal(0);
		const onDone = vi.fn();
		const splash = mountLayer(() => StartupSplash({ version: "1.0.0", now, onDone }), { fullscreen: true });
		try {
			now.set(SPLASH_MS - 1);
			expect(onDone).not.toHaveBeenCalled();
			now.set(SPLASH_MS);
			now.set(SPLASH_MS * 2);
			expect(onDone).toHaveBeenCalledTimes(1);
		} finally {
			splash.dispose();
		}
	});

	it("ends early on Enter, Space or Escape and ignores other keys", () => {
		for (const key of ["enter", "space", "escape"]) {
			const onDone = vi.fn();
			const splash = mountLayer(() => StartupSplash({ version: "1.0.0", now: () => 0, onDone }), {
				fullscreen: true,
			});
			try {
				splash.press("x");
				expect(onDone).not.toHaveBeenCalled();
				splash.press(key);
				splash.press(key);
				expect(onDone).toHaveBeenCalledTimes(1);
			} finally {
				splash.dispose();
			}
		}
	});
});
