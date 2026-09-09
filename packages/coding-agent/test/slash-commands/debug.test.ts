import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness() {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showDebugSelector = vi.fn();
	return {
		setText,
		showStatus,
		showDebugSelector,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showStatus,
				showDebugSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/debug slash command", () => {
	it("opens the debug selector", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/debug", harness.runtime)).toBe(true);

		expect(harness.showDebugSelector).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
