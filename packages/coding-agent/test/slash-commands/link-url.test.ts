import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { cfgTuiShowLinkUrl } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function tuiRuntime() {
	const settings = Settings.isolated();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const setText = vi.fn();
	const ctx = { settings, showStatus, showError, composer: { setText } } as unknown as InteractiveModeContext;
	return { runtime: { ctx }, settings, showStatus, showError, setText };
}

describe("/link-url slash command", () => {
	it("toggles without an argument and reports the new state", async () => {
		const h = tuiRuntime();

		expect(await executeBuiltinSlashCommand("/link-url", h.runtime)).toBe(true);
		expect(cfgTuiShowLinkUrl.get(h.settings)).toBe(false);
		expect(h.showStatus).toHaveBeenCalledWith("Link URLs disabled.");
		expect(h.setText).toHaveBeenCalledWith("");

		expect(await executeBuiltinSlashCommand("/link-url", h.runtime)).toBe(true);
		expect(cfgTuiShowLinkUrl.get(h.settings)).toBe(true);
		expect(h.showStatus).toHaveBeenCalledWith("Link URLs enabled.");
	});

	it("sets explicit on and off and reports status without changing it", async () => {
		const h = tuiRuntime();

		expect(await executeBuiltinSlashCommand("/link-url off", h.runtime)).toBe(true);
		expect(cfgTuiShowLinkUrl.get(h.settings)).toBe(false);
		expect(h.showStatus).toHaveBeenCalledWith("Link URLs disabled.");

		expect(await executeBuiltinSlashCommand("/link-url status", h.runtime)).toBe(true);
		expect(cfgTuiShowLinkUrl.get(h.settings)).toBe(false);
		expect(h.showStatus).toHaveBeenCalledWith("Link URLs are off.");

		expect(await executeBuiltinSlashCommand("/link-url on", h.runtime)).toBe(true);
		expect(cfgTuiShowLinkUrl.get(h.settings)).toBe(true);
		expect(h.showStatus).toHaveBeenCalledWith("Link URLs enabled.");
	});

	it("rejects unknown arguments without touching the setting", async () => {
		const h = tuiRuntime();

		expect(await executeBuiltinSlashCommand("/link-url maybe", h.runtime)).toBe(true);
		expect(h.showError).toHaveBeenCalledWith("Usage: /link-url [on|off|status]");
		expect(cfgTuiShowLinkUrl.get(h.settings)).toBe(true);
		expect(h.showStatus).not.toHaveBeenCalled();
	});
});

describe("/link-url in ACP", () => {
	it("is not advertised and not dispatched to ACP clients", async () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "link-url")).toBe(false);

		const settings = Settings.isolated();
		expect(await executeAcpBuiltinSlashCommand("/link-url status", { settings } as never)).toBe(false);
		expect(cfgTuiShowLinkUrl.get(settings)).toBe(true);
	});
});
