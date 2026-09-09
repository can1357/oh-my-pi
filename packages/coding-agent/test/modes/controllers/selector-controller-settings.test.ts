import { describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("persists the Auto-Compact toggle globally from the settings panel", () => {
		const setAutoCompactionEnabled = vi.fn();
		const ctx = {
			session: { setAutoCompactionEnabled },
			statusLine: { setAutoCompactEnabled: vi.fn() },
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("autoCompact", false);

		// persist=true: panel edits are durable, unlike the session-scoped RPC path (#11431).
		expect(setAutoCompactionEnabled).toHaveBeenCalledWith(false, true);
	});
});
