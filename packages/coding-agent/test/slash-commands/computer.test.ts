import { describe, expect, it, vi } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";

function acpRuntime(options?: { enabled?: boolean; available?: boolean }) {
	const store = {
		"computer.enabled": options?.enabled ?? false,
		"computer.display": "all",
		"computer.maxWidth": 1920,
		"computer.maxHeight": 1200,
	};
	const get = vi.fn((path: string) => {
		switch (path) {
			case "computer.enabled":
				return store["computer.enabled"];
			case "computer.display":
				return store["computer.display"];
			case "computer.maxWidth":
				return store["computer.maxWidth"];
			case "computer.maxHeight":
				return store["computer.maxHeight"];
		}
	});
	const override = vi.fn((path: string, value: boolean) => {
		if (path === "computer.enabled") store[path] = value;
	});
	const set = vi.fn();
	const getEvalPreludes = vi.fn(() =>
		store["computer.enabled"] && options?.available !== false ? [{ name: "computer" }] : [],
	);
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const output = vi.fn();
	const runtime = {
		session: {
			settings: { get, override, set },
			getEvalPreludes,
			refreshBaseSystemPrompt,
		},
		output,
	};
	return { getEvalPreludes, override, output, refreshBaseSystemPrompt, runtime, set, store };
}

const enabledStatus =
	"Computer use: enabled · prelude: active · configured: display=all, maxWidth=1920, maxHeight=1200";

describe("/computer slash command", () => {
	it("toggles a disabled session on and refreshes prelude guidance", async () => {
		const h = acpRuntime({ enabled: false });
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime])).toEqual({
			consumed: true,
		});
		expect(h.override).toHaveBeenCalledWith("computer.enabled", true);
		expect(h.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(h.set).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(`Computer use enabled for this session. ${enabledStatus}`);
	});

	it("toggles an enabled session off", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime]);
		expect(h.override).toHaveBeenCalledWith("computer.enabled", false);
		expect(h.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
	});

	it("honors explicit on and off regardless of current state", async () => {
		const on = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", on.runtime]);
		expect(on.override).toHaveBeenCalledWith("computer.enabled", true);

		const off = acpRuntime({ enabled: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer off", off.runtime]);
		expect(off.override).toHaveBeenCalledWith("computer.enabled", false);
	});

	it("reports status without changing settings or refreshing the prompt", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime]);
		expect(h.override).not.toHaveBeenCalled();
		expect(h.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(enabledStatus);
	});

	it("reports configured values", async () => {
		const h = acpRuntime({ enabled: true });
		h.store["computer.display"] = "display-2";
		h.store["computer.maxWidth"] = 1600;
		h.store["computer.maxHeight"] = 900;
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime]);
		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · prelude: active · configured: display=display-2, maxWidth=1600, maxHeight=900",
		);
	});

	it("rolls back when the session has no computer prelude", async () => {
		const h = acpRuntime({ enabled: false, available: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", h.runtime]);
		expect(h.override).toHaveBeenNthCalledWith(1, "computer.enabled", true);
		expect(h.override).toHaveBeenNthCalledWith(2, "computer.enabled", false);
		expect(h.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Computer use is unavailable in this session.");
	});

	it("rejects unknown arguments with usage", async () => {
		const h = acpRuntime();
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer bogus", h.runtime]);
		expect(h.override).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Usage: /computer [on|off|status]");
	});
});
