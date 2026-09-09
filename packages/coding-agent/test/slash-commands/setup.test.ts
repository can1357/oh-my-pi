import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const showProviderSetup = vi.fn(async () => {});
	const showWarning = vi.fn();
	const setText = vi.fn();
	return {
		showProviderSetup,
		showWarning,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showProviderSetup,
				showWarning,
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/setup slash command", () => {
	it("exposes the providers alias to slash command autocomplete", () => {
		const setupCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "setup");
		expect(setupCommand?.aliases).toContain("providers");
	});

	it("opens provider setup for /setup", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/setup", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showProviderSetup).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("opens provider setup for /setup providers", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/setup providers", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showProviderSetup).toHaveBeenCalledTimes(1);
		expect(harness.showWarning).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("opens provider setup through the /providers alias", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/providers", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showProviderSetup).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shows usage for unsupported setup scenes", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/setup theme", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showProviderSetup).not.toHaveBeenCalled();
		expect(harness.showWarning).toHaveBeenCalledWith("Usage: /setup [providers]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shows alias-specific usage for unsupported providers alias arguments", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/providers theme", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showProviderSetup).not.toHaveBeenCalled();
		expect(harness.showWarning).toHaveBeenCalledWith("Usage: /providers [providers]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
