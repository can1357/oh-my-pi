import { afterAll, describe, expect, it } from "bun:test";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { cfgHindsightApiToken } from "@oh-my-pi/pi-coding-agent/hindsight/settings";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import { cfgGoalModelObjectiveUpdates } from "@oh-my-pi/pi-coding-agent/goals/settings";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { settingsScreen, setupSettingsWindow } from "../../helpers/settings-window";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const mountSettingsWindow = setupSettingsWindow();

function createSelector(onCancel: () => void = () => {}, columns = 120): TestTerminal {
	return mountSettingsWindow({ callbacks: { onCancel } }, { columns });
}

/** Switch to the memory page (after appearance/model/interaction/context). */
function focusMemoryTab(term: TestTerminal): void {
	for (let i = 0; i < 4; i++) term.press("right");
}

/** The `N match(es)` search banner row. */
function banner(term: TestTerminal): string {
	return (
		settingsScreen(term)
			.split("\n")
			.find(line => /\d+ match/.test(line)) ?? ""
	);
}

describe("settings memory page and search", () => {
	it("reveals condition-gated Hindsight rows the moment memory.backend changes via the submenu", () => {
		cfgMemoryBackend.set(settings, "off");
		const comp = createSelector();
		focusMemoryTab(comp);
		const before = settingsScreen(comp);
		expect(before).toContain("Memory Backend");
		expect(before).not.toContain("Hindsight API URL");
		expect(before).not.toContain("Hindsight API Token");

		// Memory Backend is the only visible row, so it is selected; Enter opens its menu on "off",
		// two steps down reach "hindsight".
		comp.press("enter");
		comp.press("down");
		comp.press("down");
		comp.press("enter");

		expect(cfgMemoryBackend.get(settings)).toBe("hindsight");
		const after = settingsScreen(comp);
		expect(after).toContain("Memory Backend");
		expect(after).toContain("Hindsight API URL");
		expect(after).toContain("Hindsight API Token");
		expect(after).toContain("Hindsight Auto Recall");
	});

	it("saves a pasted Hindsight API token from its settings row", () => {
		cfgMemoryBackend.set(settings, "hindsight");
		cfgHindsightApiToken.set(settings, "saved-secret-token");
		const comp = createSelector();

		comp.type("hindsight api token");
		const row = settingsScreen(comp);
		expect(row).toContain("Hindsight API Token");
		expect(row).toContain("••••••••");
		expect(row).not.toContain("saved-secret-token");

		comp.press("enter");
		expect(settingsScreen(comp)).not.toContain("saved-secret-token");
		comp.press("enter");
		expect(cfgHindsightApiToken.get(settings)).toBe("saved-secret-token");
		expect(settingsScreen(comp)).not.toContain("saved-secret-token");

		comp.press("enter");
		comp.press("ctrl+u");
		comp.paste("test-token-123");
		expect(settingsScreen(comp)).not.toContain("test-token-123");
		comp.press("enter");

		expect(cfgHindsightApiToken.get(settings)).toBe("test-token-123");
		expect(loadHindsightConfig(settings).hindsightApiToken).toBe("test-token-123");
		expect(settingsScreen(comp)).not.toContain("test-token-123");
	});

	it("hides Hindsight rows again when the backend is switched back to off without leaving the tab", () => {
		cfgMemoryBackend.set(settings, "hindsight");
		const comp = createSelector();
		focusMemoryTab(comp);
		expect(settingsScreen(comp)).toContain("Hindsight API URL");

		// The Memory Backend menu opens on the current value ("hindsight"); two steps up reach "off".
		comp.press("enter");
		comp.press("up");
		comp.press("up");
		comp.press("enter");

		expect(cfgMemoryBackend.get(settings)).toBe("off");
		const after = settingsScreen(comp);
		expect(after).toContain("Memory Backend");
		expect(after).not.toContain("Hindsight API URL");
		expect(after).not.toContain("Hindsight Auto Recall");
	});

	it("clears the global settings search on Escape before closing the selector", () => {
		let cancelCount = 0;
		const comp = createSelector(() => {
			cancelCount++;
		});

		// Typing starts the cross-tab search: the banner shows the query and its matches.
		comp.type("b");
		expect(banner(comp)).toContain(" b ");

		// First Escape exits search mode without closing the panel.
		comp.press("escape");
		expect(cancelCount).toBe(0);
		expect(settingsScreen(comp)).not.toMatch(/\d+ match/);

		comp.press("escape");
		expect(cancelCount).toBe(1);
	});

	it("puts the exact global settings search hit before incidental matches", () => {
		const comp = createSelector();
		comp.type("fetch provider");

		const rendered = settingsScreen(comp);
		const providersIndex = rendered.indexOf("Providers");
		const appearanceIndex = rendered.indexOf("Appearance");

		expect(rendered).toContain("Fetch Provider");
		expect(rendered).not.toContain("Include Model in Prompt");
		expect(rendered).not.toContain("Service Tier");
		expect(providersIndex).toBeGreaterThanOrEqual(0);
		if (appearanceIndex >= 0) {
			expect(appearanceIndex).toBeGreaterThan(providersIndex);
		}
	});

	it("supports editor hotkeys in the global search bar", () => {
		const comp = createSelector();

		// alt+backspace deletes the trailing word from the query.
		comp.type("image provider");
		comp.press("alt+backspace");
		expect(banner(comp)).toContain("image");
		expect(banner(comp)).not.toContain("provider");

		// Arrow keys move the cursor; typing inserts mid-query instead of appending.
		comp.press("ctrl+u"); // clears the query before the cursor
		comp.type("model");
		for (let i = 0; i < 5; i++) comp.press("left");
		comp.type("x");
		expect(banner(comp)).toContain("xmodel");
	});

	it("delegates Escape to an open settings submenu before closing the selector", () => {
		let cancelCount = 0;
		cfgMemoryBackend.set(settings, "off");
		const comp = createSelector(() => {
			cancelCount++;
		});
		focusMemoryTab(comp);

		comp.press("enter");
		comp.press("escape");
		expect(cancelCount).toBe(0);
		expect(settingsScreen(comp)).toContain("Memory Backend");

		comp.press("escape");
		expect(cancelCount).toBe(1);
	});
});

describe("settings goal objective updates", () => {
	it("selects confirmation, trusted user requests, and disabled permissions from the goal setting submenu", () => {
		const comp = createSelector();

		comp.type("goal objective updates");
		comp.press("enter");
		const options = settingsScreen(comp);
		expect(options).toContain("Disabled");
		expect(options).toContain("Confirm each edit");
		expect(options).toContain("On user request");

		comp.press("down");
		comp.press("enter");
		expect(cfgGoalModelObjectiveUpdates.get(settings)).toBe("confirm");

		comp.press("enter");
		comp.press("down");
		comp.press("enter");
		expect(cfgGoalModelObjectiveUpdates.get(settings)).toBe("on-request");

		comp.press("enter");
		comp.press("up");
		comp.press("up");
		comp.press("enter");
		expect(cfgGoalModelObjectiveUpdates.get(settings)).toBe("disabled");
		comp.dispose();
	});
});
