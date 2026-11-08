import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

describe("EventController vocalizer wiring", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	test("passes the session settings and registry to the vocalizer", () => {
		const setModelSource = spyOn(vocalizer, "setModelSource");
		const ctx = createInteractiveModeContext();
		new EventController(ctx);
		expect(setModelSource).toHaveBeenCalledWith({
			settings: ctx.session.settings,
			registry: ctx.session.modelRegistry,
		});
	});
});
