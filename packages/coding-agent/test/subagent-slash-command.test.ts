import { describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import type { InteractiveModeContext } from "../src/modes/types";
import { collectSubagentWizardState, parseUsingForm } from "../src/slash-commands/helpers/subagent";

describe("/subagent using form", () => {
	it("parses a model selector and quoted task", () => {
		expect(parseUsingForm('using fast "Investigate the Agent Hub regression"')).toEqual({
			modelInput: "fast",
			task: "Investigate the Agent Hub regression",
		});
	});

	it("uses the supplied model and task while asking only for an optional name", async () => {
		const showHookInput = vi.fn(async () => "");
		const showHookSelector = vi.fn(async () => {
			throw new Error("quick launch must not open thinking or color selectors");
		});
		const showHookEditor = vi.fn(async () => {
			throw new Error("quick launch must not reopen the supplied task");
		});
		const ctx = {
			session: { thinkingLevel: ThinkingLevel.High },
			showHookInput,
			showHookSelector,
			showHookEditor,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const model = { id: "strong-model" } as Model<Api>;

		const state = await collectSubagentWizardState(
			ctx,
			model,
			"provider/strong-model",
			"Investigate the Agent Hub regression",
			true,
		);

		expect(showHookInput).toHaveBeenCalledWith("Subagent name (optional)", "leave blank for generated name");
		expect(showHookSelector).not.toHaveBeenCalled();
		expect(showHookEditor).not.toHaveBeenCalled();
		expect(state).toEqual({
			modelOverride: "provider/strong-model",
			thinkingLevel: ThinkingLevel.High,
			name: undefined,
			color: undefined,
			task: "Investigate the Agent Hub regression",
		});
	});
});
