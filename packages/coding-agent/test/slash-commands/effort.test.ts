import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	buildTuiBuiltinSlashCommands,
	lookupBuiltinSlashCommand,
	type SlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

const command = lookupBuiltinSlashCommand("effort");

interface Harness {
	outputs: string[];
	runtime: SlashCommandRuntime;
	tuiRuntime: TuiSlashCommandRuntime;
	level: () => ConfiguredThinkingLevel | undefined;
	configChanges: () => number;
}

function harness(options: { reasoning?: boolean; efforts?: readonly Effort[]; selectorEfforts?: readonly Effort[] } = {}): Harness {
	const outputs: string[] = [];
	let configured: ConfiguredThinkingLevel | undefined;
	let configChanges = 0;
	const model = { provider: "test", id: "test-model", reasoning: options.reasoning ?? true } as Model;
	const session = {
		model,
		configuredThinkingLevel: () => configured,
		setThinkingLevel: (level: ConfiguredThinkingLevel | undefined) => {
			configured = level;
		},
		getAvailableThinkingLevels: () => options.efforts ?? [Effort.Low, Effort.Medium, Effort.High],
		getAvailableEffortSelectors: () => [ThinkingLevel.Off, AUTO_THINKING, ...(options.selectorEfforts ?? options.efforts ?? [Effort.Low, Effort.Medium, Effort.High])],
	} as unknown as AgentSession;
	const tuiRuntime = { ctx: { session } } as unknown as TuiSlashCommandRuntime;
	return {
		outputs,
		runtime: {
			session,
			output: (text: string) => {
				outputs.push(text);
			},
			notifyConfigChanged: () => {
				configChanges++;
			},
		} as unknown as SlashCommandRuntime,
		tuiRuntime,
		level: () => configured,
		configChanges: () => configChanges,
	};
}

async function run(h: Harness, args: string): Promise<void> {
	await command!.handle!({ name: "effort", args, text: `/effort ${args}`.trim() }, h.runtime);
}

describe("/effort slash command", () => {
	it("is registered and accepts an argument", () => {
		expect(command).toBeDefined();
		expect(command!.allowArgs).toBe(true);
		expect(command!.subcommands?.map(sub => sub.name)).toContain("auto");
	});

	it("completes only effort levels exposed by the active model", async () => {
		const h = harness({ efforts: [Effort.Low, Effort.Medium] });
		const effort = buildTuiBuiltinSlashCommands(h.tuiRuntime).find(item => item.name === "effort");
		const completions = await Promise.resolve(effort?.getArgumentCompletions?.(""));
		expect(completions?.map(item => item.label)).toEqual(["off", "auto", "low", "medium"]);
		expect(completions?.map(item => item.label)).toEqual((h.tuiRuntime.ctx.session as any).getAvailableEffortSelectors());
		expect(completions?.map(item => item.label)).not.toContain("xhigh");
		expect(effort?.getInlineHint?.("x")).toBeNull();
	});

	it("uses the model-controls selector list for completions", async () => {
		const h = harness({ efforts: [Effort.Low, Effort.Medium], selectorEfforts: [Effort.Medium] });
		const effort = buildTuiBuiltinSlashCommands(h.tuiRuntime).find(item => item.name === "effort");
		const completions = await Promise.resolve(effort?.getArgumentCompletions?.(""));
		expect(completions?.map(item => item.label)).toEqual(["off", "auto", "medium"]);
	});

	it("reports the configured level and the model's selectable levels", async () => {
		const h = harness();
		await run(h, "");
		expect(h.outputs[0]).toContain("model default");
		expect(h.outputs[0]).toContain("off, auto, low, medium, high");
	});

	it("sets a concrete level the model supports", async () => {
		const h = harness();
		await run(h, "high");
		expect(h.level()).toBe(ThinkingLevel.High);
		expect(h.outputs[0]).toContain("set to high");
		expect(h.configChanges()).toBe(1);

		await run(h, "");
		expect(h.outputs[1]).toContain("Reasoning effort: high");
	});

	it("accepts off and auto", async () => {
		const h = harness();
		await run(h, "off");
		expect(h.level()).toBe(ThinkingLevel.Off);
		await run(h, "auto");
		expect(h.level()).toBe(AUTO_THINKING);
	});

	it("accepts unambiguous abbreviations like the --thinking flag", async () => {
		const h = harness();
		await run(h, "med");
		expect(h.level()).toBe(ThinkingLevel.Medium);
	});

	it("rejects levels the model does not expose instead of silently clamping", async () => {
		const h = harness({ efforts: [Effort.Low, Effort.Medium] });
		await run(h, "xhigh");
		expect(h.level()).toBeUndefined();
		expect(h.outputs[0]).toContain("Unknown effort: xhigh");
		expect(h.configChanges()).toBe(0);
	});

	it("rejects inherit and unknown selectors", async () => {
		const h = harness();
		await run(h, "inherit");
		await run(h, "turbo");
		expect(h.level()).toBeUndefined();
		expect(h.outputs).toHaveLength(2);
		for (const output of h.outputs) expect(output).toContain("Unknown effort");
	});

	it("explains that a non-reasoning model has no effort dial", async () => {
		const h = harness({ reasoning: false });
		await run(h, "high");
		expect(h.level()).toBeUndefined();
		expect(h.outputs[0]).toContain("test/test-model has no adjustable reasoning effort.");
	});
});
