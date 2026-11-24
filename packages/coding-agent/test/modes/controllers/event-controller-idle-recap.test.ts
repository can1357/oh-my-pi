import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";
import { transcriptText } from "../../helpers/transcript-text";

let settingsState: SettingsTestState | undefined;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("EventController idle recap presentation", () => {
	it("renders one recap notice with the existing single-line whitespace normalization", () => {
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		try {
			controller.presentIdleRecap("Where\tthings\nstand;  next step");
			expect(ctx.shell.transcript.blocks()).toHaveLength(1);
			expect(transcriptText(ctx.shell, 200)).toContain("Where things stand; next step");
		} finally {
			controller.dispose();
		}
	});

	it("does not mount a blank recap notice", () => {
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		try {
			controller.presentIdleRecap("\n \t");
			expect(ctx.shell.transcript.blocks()).toHaveLength(0);
		} finally {
			controller.dispose();
		}
	});
});
