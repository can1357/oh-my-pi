import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { Component } from "@oh-my-pi/pi-tui";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await initTheme();
	await Settings.init({ inMemory: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("EventController idle recap presentation", () => {
	it("renders one recap notice with the existing single-line whitespace normalization", async () => {
		const present = vi.fn<(content: Component | readonly Component[]) => void>();
		const controller = new EventController(createInteractiveModeContext({ present }));
		try {
			await controller.handleEvent({ type: "idle_recap", recap: "Where\tthings\nstand;  next step" });
			const notices = present.mock.calls
				.flatMap(([content]) => (Array.isArray(content) ? content : [content]))
				.filter((content): content is RecapNotice => content instanceof RecapNotice);
			expect(notices).toHaveLength(1);
			expect(Bun.stripANSI(notices[0].render(200).join("\n"))).toContain("Where things stand; next step");
		} finally {
			controller.dispose();
		}
	});

	it("does not mount a blank recap notice", async () => {
		const present = vi.fn();
		const controller = new EventController(createInteractiveModeContext({ present }));
		try {
			await controller.handleEvent({ type: "idle_recap", recap: "\n \t" });
			expect(present).not.toHaveBeenCalled();
		} finally {
			controller.dispose();
		}
	});
});
