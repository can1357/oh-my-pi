import { describe, expect, test } from "bun:test";
import { clampPanel, clampSidebar, PANEL_DEFAULT, SIDEBAR_DEFAULT } from "../src/shell/panelWidths";

/**
 * Dragging a column is easy to get right for the drag you happen to try and
 * wrong for the window size you do not. What has to hold is that the chat keeps
 * its 280px floor whatever the other two columns are asked for — the grid
 * declares that floor, so a width that ignores it produces a layout the grid
 * then refuses, and columns overlap.
 */
const WIDE = { viewport: 1600, panel: PANEL_DEFAULT, panelOpen: true };

describe("sidebar", () => {
	test("honours a reasonable drag", () => {
		expect(clampSidebar(320, WIDE)).toBe(320);
	});

	test("has a floor and a ceiling of its own", () => {
		expect(clampSidebar(40, WIDE)).toBe(180);
		expect(clampSidebar(5000, WIDE)).toBe(480);
	});

	test("gives way so the chat keeps 280px", () => {
		// 900 wide, 420 of panel: 900 − 280 − 420 = 200 left for the sidebar.
		expect(clampSidebar(400, { viewport: 900, panel: 420, panelOpen: true })).toBe(200);
	});

	test("reclaims the panel's room when the panel is hidden", () => {
		expect(clampSidebar(400, { viewport: 900, panel: 420, panelOpen: false })).toBe(400);
	});

	test("a window too narrow for any arrangement keeps the sidebar usable", () => {
		// Something has to give; a sidebar squeezed to nothing is worse than a
		// cramped chat, and the grid's own minmax still protects the chat.
		expect(clampSidebar(300, { viewport: 500, panel: 420, panelOpen: true })).toBe(180);
	});

	test("rounds, so the CSS variable never carries a fraction", () => {
		expect(clampSidebar(260.4, WIDE)).toBe(260);
	});
});

describe("panel", () => {
	test("honours a reasonable drag", () => {
		expect(clampPanel(500, { viewport: 1600, sidebar: SIDEBAR_DEFAULT, sidebarOpen: true })).toBe(500);
	});

	test("has its own floor and ceiling", () => {
		expect(clampPanel(10, { viewport: 1600, sidebar: 260, sidebarOpen: true })).toBe(220);
		expect(clampPanel(5000, { viewport: 2400, sidebar: 260, sidebarOpen: true })).toBe(640);
	});

	test("gives way so the chat keeps 280px", () => {
		// 900 wide, 260 of sidebar: 900 − 280 − 260 = 360 left for the panel.
		expect(clampPanel(600, { viewport: 900, sidebar: 260, sidebarOpen: true })).toBe(360);
	});

	test("reclaims the sidebar's room when the sidebar is hidden", () => {
		expect(clampPanel(600, { viewport: 900, sidebar: 260, sidebarOpen: false })).toBe(600);
	});
});

describe("the minimum window still fits all three", () => {
	// tauri.conf.json sets minWidth 720. At that size the defaults cannot all
	// fit, so what matters is that clamping produces a layout that adds up.
	const viewport = 720;

	test("both columns clamp to something the chat can live with", () => {
		const sidebar = clampSidebar(SIDEBAR_DEFAULT, { viewport, panel: PANEL_DEFAULT, panelOpen: true });
		const panel = clampPanel(PANEL_DEFAULT, { viewport, sidebar, sidebarOpen: true });
		expect(sidebar).toBe(180);
		expect(panel).toBe(260);
		expect(viewport - sidebar - panel).toBeGreaterThanOrEqual(280);
	});
});
