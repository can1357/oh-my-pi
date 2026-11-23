import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import {
	lookupBuiltinSlashCommand,
	type SlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const command = lookupBuiltinSlashCommand("fast");

interface Harness {
	outputs: string[];
	runtime: SlashCommandRuntime;
	controls: ModelControls;
}

function harness(model: Model): Harness {
	const outputs: string[] = [];
	// Real ModelControls, so the tier classification and family lookup under
	// test are the production ones rather than a double: `/fast off` branches
	// on serviceTierFamily(model), which a stubbed session would bypass.
	const controls = new ModelControls(
		{
			agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} },
			model: () => model,
			promptGeneration: () => 0,
			sessionManager: {
				appendThinkingLevelChange: () => Promise.resolve(),
				appendServiceTierChange: () => Promise.resolve(),
			},
			clearInheritedProviderPromptCacheKey: () => {},
			clearActiveRetryFallback: () => {},
			providerSessionState: {},
			emit: () => {},
			emitNotice: () => {},
		} as unknown as ModelControlsHost,
		{},
	);
	const session = {
		model,
		setFastMode: (enabled: boolean) => controls.setFastMode(enabled),
		toggleFastMode: () => controls.toggleFastMode(),
		setUltrafastMode: (enabled: boolean) => controls.setUltrafastMode(enabled),
		isFastModeEnabled: () => controls.isFastModeEnabled(),
		isUltrafastModeEnabled: () => controls.isUltrafastModeEnabled(),
	} as unknown as AgentSession;
	return {
		outputs,
		runtime: {
			session,
			output: (text: string) => {
				outputs.push(text);
			},
		} as unknown as SlashCommandRuntime,
		controls,
	};
}

/** A model whose provider matches no service-tier family, like a local or relay model. */
function tierlessModel(): Model {
	return { provider: "test", id: "test-model" } as unknown as Model;
}

/** A first-party OpenAI model, whose family takes `priority`/`ultrafast` tiers. */
function openaiModel(): Model {
	return { provider: "openai", id: "gpt-test" } as unknown as Model;
}

describe("/fast slash command", () => {
	it("reports unavailability on /fast off for a model with no service-tier control, instead of claiming success", async () => {
		const h = harness(tierlessModel());
		const result = await command!.handle!({ name: "fast", args: "off", text: "/fast off" }, h.runtime);
		expect(h.outputs).toEqual(["Fast mode is unavailable for the current model."]);
		expect(result).toEqual({ consumed: true });
		expect(h.controls.isFastModeEnabled()).toBe(false);
	});

	it("disables fast mode on /fast off for a model in a service-tier family", async () => {
		const h = harness(openaiModel());
		await command!.handle!({ name: "fast", args: "off", text: "/fast off" }, h.runtime);
		expect(h.outputs).toEqual(["Fast mode disabled."]);
		expect(h.controls.isFastModeEnabled()).toBe(false);
	});

	it("reports unavailability on /fast on for a model with no service-tier control, matching the off branch", async () => {
		const h = harness(tierlessModel());
		await command!.handle!({ name: "fast", args: "on", text: "/fast on" }, h.runtime);
		expect(h.outputs).toEqual(["Fast mode is unavailable for the current model."]);
		expect(h.controls.isFastModeEnabled()).toBe(false);
	});
});
