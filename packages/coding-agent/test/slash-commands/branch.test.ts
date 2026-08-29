import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { doubleEscapeAction: "tree" } });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("/branch slash command", () => {
	it("opens the branch selector when double-Escape opens the tree selector", async () => {
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
