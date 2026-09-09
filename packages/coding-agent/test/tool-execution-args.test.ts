import { afterEach, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

describe("ToolExecutionComponent.updateArgs (F8 — no clone, ref-eq fast path)", () => {
	let initialized = false;

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function makeComponent(args: unknown) {
		if (!initialized) {
			await initTheme();
			initialized = true;
		}
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		return new ToolExecutionComponent("bash", args, {}, undefined, uiStub);
	}

	it("does NOT call structuredClone in updateArgs (caller already owns isolation)", async () => {
		const cloneSpy = vi.spyOn(globalThis, "structuredClone");
		const component = await makeComponent({ command: "ls" });
		cloneSpy.mockClear();

		// Simulate event-controller.ts: each delta builds a fresh spread.
		for (let i = 0; i < 5; i++) {
			component.updateArgs({ command: `ls -l ${i}` });
		}

		expect(cloneSpy).not.toHaveBeenCalled();
	});
});
