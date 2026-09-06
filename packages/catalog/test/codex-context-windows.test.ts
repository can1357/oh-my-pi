import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { fetchCodexModels } from "../src/discovery/codex";
import fixture from "./fixtures/codex-context-windows.json";

describe("Codex context-window discovery", () => {
	test("maps catalog protocol fields without changing their bytes and preserves them through model resolution", async () => {
		const result = await fetchCodexModels({ accessToken: "test", fetchFn: async () => Response.json(fixture) });
		for (const row of fixture.models) {
			const model = result?.models.find(candidate => candidate.id === row.slug);
			const budget = row.model_messages.token_budget;
			const expected = {
				enabled: budget.enabled,
				useHistoryNotes: budget.use_history_notes_extension,
				reminderThresholdTokens: budget.reminder_threshold_tokens,
				reminderMessageTemplate: budget.reminder_message_template,
				guidanceMessage: budget.guidance_message,
				autoCompactFallbackPrompt: budget.auto_compact_fallback_prompt,
				autoCompactFallbackBufferTokens: budget.auto_compact_fallback_buffer_tokens,
			};
			expect(model?.compat).toMatchObject({ contextWindows: expected });
			if (!model) throw new Error("Discovery omitted a fixture model");
			expect(buildModel(model).compat).toMatchObject({ contextWindows: expected });
		}
	});

	test.each([
		{ reminder_threshold_tokens: 0 },
		{ auto_compact_fallback_buffer_tokens: 1.5 },
		{ guidance_message: "   " },
		{ reminder_message_template: "missing interpolation" },
		{ auto_compact_fallback_prompt: "" },
		{ enabled: "true" },
	])("drops an invalid budget without losing its model: %j", async invalid => {
		const row = fixture.models[0];
		if (!row) throw new Error("Missing catalog fixture");
		const result = await fetchCodexModels({
			accessToken: "test",
			fetchFn: async () =>
				Response.json({
					models: [
						{ ...row, model_messages: { token_budget: { ...row.model_messages.token_budget, ...invalid } } },
					],
				}),
		});
		expect(result?.models.map(model => model.id)).toEqual([row.slug]);
		expect(result?.models[0]?.compat).not.toHaveProperty("contextWindows");
	});
});
