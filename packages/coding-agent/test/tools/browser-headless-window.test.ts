import { describe, expect, it } from "bun:test";

import { buildHeadlessLaunchArgs } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

const VIEWPORT = { width: 1365, height: 768 };

describe("headless Chromium window placement", () => {
	// `--headless=new` on Windows still creates a native window that Windows 11
	// composites onto the desktop even without WS_VISIBLE, so headless launches
	// must park it off-desktop — and visible launches must not, or the browser
	// the user asked to see is dragged out of view.
	it("parks headless windows off-desktop and leaves visible ones placeable", () => {
		const headless = buildHeadlessLaunchArgs(VIEWPORT, true);
		const headed = buildHeadlessLaunchArgs(VIEWPORT, false);

		expect(headless).toContain("--window-position=-32000,-32000");
		expect(headed.some(arg => arg.startsWith("--window-position"))).toBe(false);
		// Both keep the viewport-sized window: headless emulation reads it from
		// CDP, but the shared daemon spawns headed browsers at this size.
		expect(headless).toContain("--window-size=1365,768");
		expect(headed).toContain("--window-size=1365,768");
	});
});
