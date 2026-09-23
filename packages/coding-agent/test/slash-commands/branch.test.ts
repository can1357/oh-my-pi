import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { doubleEscapeAction: "none" } });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("/branch slash command", () => {
	it("opens the branch selector even when double-Escape is disabled", async () => {
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

		expect(await executeBuiltinSlashCommand("/branch", runtime)).toBe(true);
		expect(showUserMessageSelector).toHaveBeenCalledTimes(1);
		expect(showTreeSelector).not.toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
	});
});
