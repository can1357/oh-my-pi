import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { doubleEscapeAction: "none" } });
});

afterEach(() => {
	resetSettingsForTest();
});

function createRuntime() {
	const showTreeSelector = vi.fn();
	const showUserMessageSelector = vi.fn();
	const setText = vi.fn();
	const runtime = {
		ctx: {
			collabGuest: false,
			showTreeSelector,
			showUserMessageSelector,
			editor: { setText },
		} as unknown as InteractiveModeContext,
	};
	return { runtime, setText, showTreeSelector, showUserMessageSelector };
}

describe("/branch slash command", () => {
	for (const doubleEscapeAction of ["tree", "none"] as const) {
		it(`opens the fullscreen rewind selector when double-Escape is configured as ${doubleEscapeAction}`, async () => {
			Settings.instance.override("doubleEscapeAction", doubleEscapeAction);
			const { runtime, setText, showTreeSelector, showUserMessageSelector } = createRuntime();

			expect(await executeBuiltinSlashCommand("/rewind", runtime)).toBe(true);
			expect(showUserMessageSelector).toHaveBeenCalledTimes(1);
			expect(showTreeSelector).not.toHaveBeenCalled();
			expect(setText).toHaveBeenCalledWith("");
		});
	}

	it("keeps /branch as the canonical command", async () => {
		const { runtime, setText, showUserMessageSelector } = createRuntime();

		expect(lookupBuiltinSlashCommand("rewind")?.name).toBe("branch");
		expect(await executeBuiltinSlashCommand("/branch", runtime)).toBe(true);
		expect(showUserMessageSelector).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
	});
});
