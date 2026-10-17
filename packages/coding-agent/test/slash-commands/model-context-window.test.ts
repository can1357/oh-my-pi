import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const MODELS = [
	{ provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 },
	{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
	{ provider: "openai", id: "gpt-5.2", contextWindow: 400_000 },
];

const CURRENT = { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 };

function createRuntime(model: typeof CURRENT | null = CURRENT) {
	const setModel = vi.fn(async () => {});
	const showStatus = vi.fn();
	const settings = Settings.isolated();
	return {
		setModel,
		showStatus,
		runtime: {
			ctx: {
				editor: { setText: vi.fn() } as unknown as InteractiveModeContext["editor"],
				settings,
				session: {
					model,
					setModel,
					scopedModels: [],
					modelRegistry: { getAll: () => MODELS, getAvailable: () => MODELS },
				},
				sessionManager: { getCwd: () => "C:/src/harness" },
				showStatus,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model --context-window (issue #12578)", () => {
	it("overrides the context window of the current model when no selector is given", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/model --context-window 400k", harness.runtime);

		expect(harness.setModel).toHaveBeenCalledWith({ ...CURRENT, contextWindow: 400_000 });
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("Context window set to"));
	});

	it("combines a selector with an inline override", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/model openai/gpt-5.2 --context-window=128k", harness.runtime);

		expect(harness.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "openai", id: "gpt-5.2", contextWindow: 128_000 }),
		);
	});

	it("accepts underscore separators", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/model --context-window 1_000_000", harness.runtime);

		expect(harness.setModel).toHaveBeenCalledWith({ ...CURRENT, contextWindow: 1_000_000 });
	});

	it("reports usage and leaves the model untouched for an unparseable value", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/model --context-window banana", harness.runtime);

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("Invalid context window: --context-window banana"),
		);
	});

	it("reports usage when a flag is given with no value", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/model --context-window", harness.runtime);

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("Invalid context window"));
	});

	it("leaves a bare selector without an override untouched", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/model openai/gpt-5.2", harness.runtime);

		const passed = harness.setModel.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(passed?.provider).toBe("openai");
		expect(passed?.contextWindow).toBe(400_000);
	});
});