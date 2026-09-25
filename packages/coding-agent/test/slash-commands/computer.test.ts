import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function acpRuntime(
	options: { enabled?: boolean; available?: boolean; display?: string; maxWidth?: number; maxHeight?: number } = {},
) {
	const settings = Settings.isolated({
		"computer.enabled": options.enabled ?? false,
		"computer.display": options.display ?? "all",
		"computer.maxWidth": options.maxWidth ?? 1920,
		"computer.maxHeight": options.maxHeight ?? 1200,
	});
	const getEvalPreludes = vi.fn(() =>
		cfgComputerEnabled.get(settings) && options.available !== false ? [{ name: "computer" }] : [],
	);
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const output = vi.fn();
	const runtime = {
		session: {
			settings,
			getEvalPreludes,
			refreshBaseSystemPrompt,
		},
		output,
	};
	return { output, refreshBaseSystemPrompt, runtime, settings };
}

const enabledStatus =
	"Computer use: enabled · prelude: active · configured: display=all, maxWidth=1920, maxHeight=1200";

describe("/computer slash command", () => {
	it("toggles a disabled session on and refreshes prelude guidance", async () => {
		const h = acpRuntime({ enabled: false });
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime])).toEqual({
			consumed: true,
		});
		expect(cfgComputerEnabled.get(h.settings)).toBe(true);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(h.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(h.output).toHaveBeenCalledWith(`Computer use enabled for this session. ${enabledStatus}`);
	});

	it("toggles an enabled session off", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
		expect(h.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
	});

	it("honors explicit on and off regardless of current state", async () => {
		const on = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", on.runtime]);
		expect(cfgComputerEnabled.get(on.settings)).toBe(true);

		const off = acpRuntime({ enabled: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer off", off.runtime]);
		expect(cfgComputerEnabled.get(off.settings)).toBe(false);
	});

	it("reports status without changing settings or refreshing the prompt", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(true);
		expect(h.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(enabledStatus);
	});

	it("reports configured values", async () => {
		const h = acpRuntime({ enabled: true, display: "display-2", maxWidth: 1600, maxHeight: 900 });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime]);
		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · prelude: active · configured: display=display-2, maxWidth=1600, maxHeight=900",
		);
	});

	it("rolls back when the session has no computer prelude", async () => {
		const h = acpRuntime({ enabled: false, available: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(h.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Computer use is unavailable in this session.");
	});

	it("rejects unknown arguments with usage", async () => {
		const h = acpRuntime();
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer bogus", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
		expect(h.output).toHaveBeenCalledWith("Usage: /computer [on|off|status]");
	});
});
