import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(handleFreshCommand: InteractiveModeContext["handleFreshCommand"]) {
	const setText = vi.fn();
	return {
		setText,
		handleFreshCommand,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleFreshCommand,
			} as InteractiveModeContext,
		},
	};
}

describe("/fresh slash command", () => {
	it("awaits provider-state refresh before resolving", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleFreshCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness(handleFreshCommand);

		let settled = false;
		const execution = executeBuiltinSlashCommand("/fresh", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(harness.setText).toHaveBeenCalledWith("");
		expect(handleFreshCommand).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});
});
