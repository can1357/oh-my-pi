import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime(submitManualContinue: () => boolean) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	return {
		setText,
		showStatus,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				submitManualContinue,
				showStatus,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/continue slash command", () => {
	it("is registered for autocomplete and routes through the shared continue path", async () => {
		expect(lookupBuiltinSlashCommand("continue")?.name).toBe("continue");

		const submitManualContinue = vi.fn(() => true);
		const harness = createRuntime(submitManualContinue);

		const handled = await executeBuiltinSlashCommand("/continue", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(submitManualContinue).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).not.toHaveBeenCalled();
	});

	it("reports a status instead of a silent no-op when the agent has no idle input waiter", async () => {
		const harness = createRuntime(() => false);

		const handled = await executeBuiltinSlashCommand("/continue", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("busy"));
	});
});
