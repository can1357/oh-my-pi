import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { cfgRatchetEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function acpRuntime(options: { tools?: string[]; available?: boolean } = {}) {
	const settings = Settings.isolated({ "ratchet.enabled": false });
	const tools = options.tools ?? ["read", "eval", "task", "ask"];
	const output = vi.fn();
	const runtime = {
		session: {
			settings,
			getEnabledToolNames: () => tools,
			getEvalPreludes: () =>
				cfgRatchetEnabled.get(settings) && options.available !== false ? [{ name: "ratchet" }] : [],
		},
		output,
	};
	return { output, runtime, settings };
}

describe("/ratchet slash command", () => {
	it("enables the prelude for the session only and submits the request as data inside the kickoff", async () => {
		const h = acpRuntime();
		const result = await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, [
			"/ratchet the inbox router in src/router, lower cost",
			h.runtime,
		]);
		expect(cfgRatchetEnabled.get(h.settings)).toBe(true);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(result).toHaveProperty("prompt");
		const { prompt } = result as { prompt: string };
		expect(prompt).toContain("<ratchet-request>\nthe inbox router in src/router, lower cost\n</ratchet-request>");
		expect(prompt).toContain("ONE batched `ask`");
	});

	it("tells a session without ask to only continue fully approved flows", async () => {
		const h = acpRuntime({ tools: ["eval", "task"] });
		const { prompt } = (await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/ratchet", h.runtime])) as {
			prompt: string;
		};
		expect(prompt).toContain("No `ask` in this session: NEVER build or approve.");
		expect(prompt).toContain("No flow named");
	});

	it("refuses without the task tool and leaves the prelude off", async () => {
		const h = acpRuntime({ tools: ["eval", "ask"] });
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/ratchet router", h.runtime])).toEqual({
			consumed: true,
		});
		expect(cfgRatchetEnabled.get(h.settings)).toBe(false);
		expect(h.output).toHaveBeenCalledWith("/ratchet needs the task tool active.");
	});

	it("rolls back when the session cannot host the prelude", async () => {
		const h = acpRuntime({ available: false });
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/ratchet router", h.runtime])).toEqual({
			consumed: true,
		});
		expect(cfgRatchetEnabled.get(h.settings)).toBe(false);
		expect(h.output).toHaveBeenCalledWith("The ratchet eval prelude is unavailable in this session.");
	});
});
