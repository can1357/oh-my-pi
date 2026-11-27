import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function acpRuntime(
	options: {
		enabled?: boolean;
		available?: boolean;
		display?: string;
		maxWidth?: number;
		maxHeight?: number;
		takeover?: "fallback" | "foreground" | "always" | "refuse";
	} = {},
) {
	const settings = Settings.isolated({
		"computer.enabled": options.enabled ?? false,
		"computer.display": options.display ?? "active",
		"computer.maxWidth": options.maxWidth ?? 1920,
		"computer.maxHeight": options.maxHeight ?? 1200,
		...(options.takeover ? { "computer.takeover": options.takeover } : {}),
	});
	const getEvalPreludes = vi.fn(() =>
		cfgComputerEnabled.get(settings) && options.available !== false ? [{ name: "computer" }] : [],
	);
	const output = vi.fn();
	const runtime = {
		session: {
			settings,
			getEvalPreludes,
			isFastModeEnabled: () => false,
			isUltrafastModeEnabled: () => false,
		},
		output,
	};
	return { output, runtime, settings };
}

describe("/computer slash command", () => {
	it("toggles a disabled session on without persisting", async () => {
		const h = acpRuntime({ enabled: false });
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime])).toEqual({
			consumed: true,
		});
		expect(cfgComputerEnabled.get(h.settings)).toBe(true);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(h.output).toHaveBeenCalledWith("Computer use enabled for this session.");
	});

	it("toggles an enabled session off", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
		expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
	});

	it("reports effective computer use and settings in /session info without changing them", async () => {
		const h = acpRuntime({
			enabled: true,
			display: "display-2",
			maxWidth: 1600,
			maxHeight: 900,
			takeover: "refuse",
		});
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/session info", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(true);
		expect(h.output).toHaveBeenCalledWith(
			expect.stringContaining("Computer use: enabled\nComputer prelude: active"),
		);
		expect(h.output).toHaveBeenCalledWith(
			expect.stringContaining("display=display-2, maxWidth=1600, maxHeight=900, takeover=refuse"),
		);
	});

	it("rolls back when the session has no computer prelude", async () => {
		const h = acpRuntime({ enabled: false, available: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(h.output).toHaveBeenCalledWith("Computer use is unavailable in this session.");
	});

	it("sets computer use explicitly instead of toggling when on or off is repeated", async () => {
		const h = acpRuntime({ enabled: false });
		for (const { arg, enabled } of [
			{ arg: "on", enabled: true },
			{ arg: "off", enabled: false },
		]) {
			await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, [`/computer ${arg}`, h.runtime]);
			expect(cfgComputerEnabled.get(h.settings)).toBe(enabled);
			await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, [`/computer ${arg}`, h.runtime]);
			expect(cfgComputerEnabled.get(h.settings)).toBe(enabled);
		}
	});

	it("rejects the old status argument without toggling", async () => {
		const h = acpRuntime();
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime])).toEqual({
			consumed: true,
			failed: true,
		});
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
	});
});
