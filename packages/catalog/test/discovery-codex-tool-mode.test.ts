import { describe, expect, test } from "bun:test";
import { fetchCodexModels } from "../src/discovery/codex";
import { getBundledModel } from "../src/models";

function modelsResponse(entries: Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ models: entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

const FETCH_OK = (entries: Record<string, unknown>[]) =>
	(async () => modelsResponse(entries)) as unknown as typeof fetch;

describe("codex discovery tool_mode", () => {
	test("parses tool_mode code_mode_only into Model.toolMode", async () => {
		const result = await fetchCodexModels({
			accessToken: "test-token",
			fetchFn: FETCH_OK([
				{
					slug: "gpt-5.6-sol",
					context_window: 272000,
					use_responses_lite: true,
					tool_mode: "code_mode_only",
				},
			]),
		});
		const sol = result?.models.find(spec => spec.id === "gpt-5.6-sol");
		expect(sol?.toolMode).toBe("code_mode_only");
		expect(sol?.useResponsesLite).toBe(true);
	});

	test("omits toolMode for other or absent tool_mode values", async () => {
		const result = await fetchCodexModels({
			accessToken: "test-token",
			fetchFn: FETCH_OK([
				{ slug: "gpt-5.6-terra", context_window: 272000, tool_mode: "other" },
				{ slug: "gpt-5.6-luna", context_window: 272000 },
			]),
		});
		for (const spec of result?.models ?? []) {
			expect(spec.toolMode).toBeUndefined();
		}
	});

	test("bundles Code Mode flags for offline GPT-5.6 fallbacks", () => {
		for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
			expect(getBundledModel("openai-codex", id)?.toolMode).toBe("code_mode_only");
		}
	});
});
