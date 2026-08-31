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

	it("repartitions active tools and rebuilds the prompt when the context profile changes", async () => {
		const applyContextProfileChange = vi.fn(async () => {});
		const ctx = {
			session: { applyContextProfileChange },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("contextProfile", "balanced");
		await Promise.resolve();

		expect(applyContextProfileChange).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});
