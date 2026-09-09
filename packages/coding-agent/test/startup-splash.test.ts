import { beforeAll, describe, expect, it } from "bun:test";
import { runStartupSplash } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/startup-splash";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { shouldShowStartupSplash } from "@oh-my-pi/pi-coding-agent/startup-splash";
import type { Component } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false);
});

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

	it("shows and hides a fullscreen setup-splash overlay", async () => {
		const preSplashEditor: Component = { render: () => [] };
		let hidden = false;
		let renderRequests = 0;
		let focused: Component | undefined = preSplashEditor;
		let overlayComponent: Component | undefined;
		const ctx = {
			ui: {
				terminal: { rows: 8 },
				showOverlay: (component: Component) => {
					overlayComponent = component;
					const preFocus = focused;
					focused = component;
					return {
						hide: () => {
							hidden = true;
							if (focused === component) {
								focused = preFocus;
							}
						},
					};
				},
				setFocus: (component: Component) => {
					focused = component;
				},
				requestRender: () => {
					renderRequests += 1;
				},
			},
		} as unknown as InteractiveModeContext;

		await runStartupSplash(ctx, { durationMs: 0, tickMs: 1, now: () => 0 });

		expect(hidden).toBe(true);
		expect(renderRequests).toBeGreaterThan(0);
		expect(focused).toBe(preSplashEditor);
		expect(overlayComponent?.render(32)).toHaveLength(8);
	});
});
