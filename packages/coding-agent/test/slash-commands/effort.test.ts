import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMANDS,
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
	type SlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

const command = lookupBuiltinSlashCommand("effort");

interface Harness {
	outputs: string[];
	runtime: SlashCommandRuntime;
	tuiRuntime: TuiSlashCommandRuntime;
	level: () => ConfiguredThinkingLevel | undefined;
	configChanges: () => number;
	controls: ModelControls;
}

function harness(options: { reasoning?: boolean; efforts?: readonly Effort[]; ceiling?: Effort } = {}): Harness {
	const outputs: string[] = [];
	let configured: ConfiguredThinkingLevel | undefined;
	let configChanges = 0;
	const model = {
		provider: "test",
		id: "test-model",
		reasoning: options.reasoning ?? true,
		thinking: { efforts: options.efforts ?? [Effort.Low, Effort.Medium, Effort.High] },
	} as unknown as Model;
	// Real ModelControls, so the selector list under test is the production one
	// rather than a double: the exercised paths read the active model's supported
	// efforts and push the resolved level at the agent.
	const controls = new ModelControls(
		{
			agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} },
			model: () => model,
			promptGeneration: () => 0,
			sessionManager: { appendThinkingLevelChange: () => Promise.resolve() },
			clearInheritedProviderPromptCacheKey: () => {},
			clearActiveRetryFallback: () => {},
			emit: () => {},
			emitNotice: () => {},
		} as unknown as ModelControlsHost,
		{ thinkingLevelCeiling: options.ceiling },
	);
	const session = {
		model,
		configuredThinkingLevel: () => configured,
		setThinkingLevel: (level: ConfiguredThinkingLevel | undefined) => {
			configured = level;
		},
		getAvailableThinkingLevels: () => controls.getAvailableThinkingLevels(),
		getAvailableEffortSelectors: () => controls.getAvailableEffortSelectors(),
	} as unknown as AgentSession;
	const tuiRuntime = { ctx: { session, settings: Settings.isolated() } } as unknown as TuiSlashCommandRuntime;
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
		controls,
	};
}

async function run(h: Harness, args: string): Promise<void> {
	await command!.handle!({ name: "effort", args, text: `/effort ${args}`.trim() }, h.runtime);
}

describe("/effort slash command", () => {
	it("is found by thinking and intelligence without registering a thinking alias", async () => {
		const provider = new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd());
		for (const query of ["/thinking", "/intelligence"]) {
			const suggestions = await provider.getSuggestions([query], 0, query.length);
			const resolved = suggestions?.items.map(item => lookupBuiltinSlashCommand(item.value)?.name);
			expect(resolved).toContain("effort");
		}
		const h = harness();
		expect(await executeBuiltinSlashCommand("/thinking high", { ...h.tuiRuntime, draftDetached: true })).toBe(false);
		expect(h.level()).toBeUndefined();
	});

	it("completes only effort levels exposed by the active model", async () => {
		const h = harness({ efforts: [Effort.Low, Effort.Medium] });
		const effort = buildTuiBuiltinSlashCommands(h.tuiRuntime).find(item => item.name === "effort");
		const completions = await Promise.resolve(effort?.getArgumentCompletions?.(""));
		expect(completions?.map(item => item.label)).toEqual(["off", "auto", "low", "medium"]);
		expect(effort?.getInlineHint?.("x")).toBeNull();
		expect(effort?.getInlineHint?.("me")).toBe("dium");
		expect(effort?.getInlineHint?.("me ")).toBeNull();
		expect(effort?.getInlineHint?.("low")).toBeNull();
	});

	it("rejects levels above the session ceiling and keeps cycling within it", async () => {
		const h = harness({ ceiling: Effort.Low });
		const thinking = buildTuiBuiltinSlashCommands(h.tuiRuntime).find(item => item.name === "effort");
		const choices = await thinking?.getArgumentCompletions?.("");
		expect(choices?.map(item => item.label)).toEqual(["off", "auto", "low"]);
		expect(thinking?.getInlineHint?.("hi")).toBeNull();
		await run(h, "high");
		expect(h.level()).toBeUndefined();
		expect(h.outputs[0]).toContain("Unknown thinking level: high");
		expect(h.configChanges()).toBe(0);
		const cycled = Array.from({ length: 4 }, () => h.controls.cycleThinkingLevel());
		expect(cycled).toEqual([ThinkingLevel.Off, AUTO_THINKING, ThinkingLevel.Low, ThinkingLevel.Off]);
	});

	it("offers exactly the selectors the cycle walks", async () => {
		const h = harness({ efforts: [Effort.Low, Effort.Medium] });
		const effort = buildTuiBuiltinSlashCommands(h.tuiRuntime).find(item => item.name === "effort");
		const completions = await Promise.resolve(effort?.getArgumentCompletions?.(""));
		const controls = h.controls;
		const cycled: ConfiguredThinkingLevel[] = [];
		for (let step = 0; step < 4; step++) {
			const next = controls.cycleThinkingLevel();
			if (next === undefined) break;
			cycled.push(next);
		}
		// One source of truth: the dropdown and keyboard cycling must enumerate
		// the same selectors, so a second hardcoded list in either surface fails.
		expect(completions?.map(item => item.label)).toEqual(cycled.slice(0, 4));
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
		expect(h.outputs[1]).toContain("Thinking: high");

		const thinking = buildTuiBuiltinSlashCommands(h.tuiRuntime).find(item => item.name === "effort");
		const narrowed = await Promise.resolve(thinking?.getArgumentCompletions?.("hi"));
		expect(narrowed?.map(item => [item.label, item.description])).toEqual([
			["high", expect.stringContaining("(current)")],
		]);
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
		expect(h.outputs[0]).toContain("Unknown thinking level: xhigh");
		expect(h.configChanges()).toBe(0);
	});

	it("rejects inherit and unknown selectors", async () => {
		const h = harness();
		await run(h, "inherit");
		await run(h, "turbo");
		expect(h.level()).toBeUndefined();
		expect(h.outputs).toHaveLength(2);
		for (const output of h.outputs) expect(output).toContain("Unknown thinking level");
	});

	it("explains that a non-reasoning model has no thinking dial", async () => {
		const h = harness({ reasoning: false });
		await run(h, "high");
		expect(h.level()).toBeUndefined();
		expect(h.outputs[0]).toContain("test/test-model has no adjustable thinking level.");
	});

	it("opens the picker bare, sets a level by name, and reports bad levels in the TUI", async () => {
		const h = harness({ efforts: [Effort.Low, Effort.Medium] });
		const events: string[] = [];
		const ctx = {
			...h.tuiRuntime.ctx,
			showThinkingSelector: () => events.push("picker"),
			showStatus: (message: string) => events.push(`status:${message}`),
			showError: (message: string) => events.push(`error:${message}`),
		} as unknown as InteractiveModeContext;

		await executeBuiltinSlashCommand("/effort", { ctx, draftDetached: true });
		await executeBuiltinSlashCommand("/effort med", { ctx, draftDetached: true });
		await executeBuiltinSlashCommand("/effort xhigh", { ctx, draftDetached: true });

		expect(h.level()).toBe(ThinkingLevel.Medium);
		expect(events).toEqual([
			"picker",
			"status:Thinking set to medium.",
			expect.stringContaining("error:Unknown thinking level: xhigh"),
		]);
	});

	it("tells a non-reasoning TUI session there is nothing to pick, and errors on a level", async () => {
		const h = harness({ reasoning: false });
		const events: string[] = [];
		const ctx = {
			...h.tuiRuntime.ctx,
			showThinkingSelector: () => events.push("picker"),
			showStatus: (message: string) => events.push(`status:${message}`),
			showError: (message: string) => events.push(`error:${message}`),
		} as unknown as InteractiveModeContext;

		await executeBuiltinSlashCommand("/effort", { ctx, draftDetached: true });
		await executeBuiltinSlashCommand("/effort high", { ctx, draftDetached: true });
		expect(events).toEqual([
			"status:test/test-model has no adjustable thinking level.",
			"error:test/test-model has no adjustable thinking level.",
		]);
		expect(h.level()).toBeUndefined();
	});
});
