import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgDisplayToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("InputController tool output expansion", () => {
	it("flips the reactive expansion flag", () => {
		const showStatus = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			toolActivity: "detailed",
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(showStatus).toHaveBeenCalledWith("Tool output expansion: enabled");
	});

	it("does not expand hidden tool activity and explains why", () => {
		const showStatus = vi.fn();
		const ctx = {
			toolActivity: "hidden",
			toolOutputExpanded: false,
			keybindings: KeybindingsManager.inMemory(),
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
	});
});

describe("InputController tool activity cycle", () => {
	it("cycles detailed, concise and hidden, persisting each, rebuilding scrollback and folding tools", () => {
		const settings = Settings.isolated();
		const replayHistory = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			toolActivity: "detailed",
			toolOutputExpanded: true,
			settings,
			shell: { host: { replayHistory } },
			showStatus,
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);

		for (const [index, mode] of (["concise", "hidden", "detailed"] as const).entries()) {
			ctx.toolOutputExpanded = true;
			controller.cycleToolActivity();

			expect(ctx.toolActivity).toBe(mode);
			expect(cfgDisplayToolActivity.get(settings)).toBe(mode);
			expect(ctx.toolOutputExpanded).toBe(false);
			expect(replayHistory).toHaveBeenCalledTimes(index + 1);
			expect(showStatus).toHaveBeenLastCalledWith(`Tool activity: ${mode}`);
		}
	});
});
