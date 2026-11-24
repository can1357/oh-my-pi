import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgDisplayHideToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("InputController tool output expansion", () => {
	it("flips the reactive expansion flag", () => {
		const showStatus = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			hideToolActivity: false,
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(showStatus).toHaveBeenCalledWith("Tool output expansion: enabled");
	});

	it("does not expand hidden tool activity and explains why", () => {
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: true,
			toolOutputExpanded: false,
			keybindings: KeybindingsManager.inMemory(),
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
	});
});

describe("InputController tool activity visibility", () => {
	it("persists the toggle, rebuilds scrollback, and reveals tools collapsed", () => {
		const settings = Settings.isolated();
		const replayHistory = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: true,
			settings,
			shell: { host: { replayHistory } },
			showStatus,
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(true);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(true);
		expect(replayHistory).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: hidden");

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(false);
		expect(replayHistory).toHaveBeenCalledTimes(2);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: visible");
	});
});
