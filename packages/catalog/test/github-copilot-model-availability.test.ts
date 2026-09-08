/**
 * Guard rails for `isCopilotModelAvailableForAccount`: only an explicit
 * unavailable signal prunes a `/models` entry. `policy` is authoritative when
 * present; without one, a model is hidden only when `model_picker_enabled` is
 * explicitly false. Absence of both gates must keep the model (backward
 * compatibility with legacy/minimal `/models` shapes).
 */
import { describe, expect, it, vi } from "bun:test";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

/** `/models` entry; grant fields are opt-in so absent means "no gate". */
function entry(id: string, patch?: { policy?: Record<string, unknown>; modelPickerEnabled?: boolean }) {
	return {
		id,
		name: id,
		capabilities: { type: "chat" },
		...(patch?.policy ? { policy: patch.policy } : {}),
		...(patch?.modelPickerEnabled !== undefined ? { model_picker_enabled: patch.modelPickerEnabled } : {}),
	};
}

describe("github-copilot /models availability prune contract", () => {
	it("keeps a model with no grant gate (backward compat for minimal payloads)", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [entry("claude-opus-5"), entry("gpt-5.3-codex")] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch });
		const specs = (await options.fetchDynamicModels?.()) ?? [];
		expect(specs.map(s => s.id).sort()).toEqual(["claude-opus-5", "gpt-5.3-codex"]);
	});

	it("treats `policy` as authoritative over `model_picker_enabled`", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [entry("gpt-4.1", { policy: { state: "enabled" }, modelPickerEnabled: false })],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch });
		const specs = (await options.fetchDynamicModels?.()) ?? [];
		expect(specs.map(s => s.id)).toEqual(["gpt-4.1"]);
	});

	it("drops a model whose `policy` is explicitly disabled", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [entry("legacy-x", { policy: { state: "disabled" } })] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch });
		const specs = (await options.fetchDynamicModels?.()) ?? [];
		expect(specs).toEqual([]);
	});

	it("drops a policy-less model explicitly excluded from the picker", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [entry("gpt-4o", { modelPickerEnabled: false })] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch });
		const specs = (await options.fetchDynamicModels?.()) ?? [];
		expect(specs).toEqual([]);
	});
});
