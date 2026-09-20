import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const MODELS = [
	{ provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 },
	{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
	{ provider: "openai", id: "gpt-5.2", contextWindow: 400_000 },
];

function createRuntime() {
	const showModelSelector = vi.fn();
	const switchSessionModel = vi.fn(async () => {});
	const showError = vi.fn();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const settings = Settings.isolated();
	return {
		showModelSelector,
		switchSessionModel,
		showError,
		setText,
		settings,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				settings,
				session: {
					scopedModels: [],
					modelRegistry: { getAll: () => MODELS, getAvailable: () => MODELS },
				},
				showModelSelector,
				switchSessionModel,
				showError,
				showStatus,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model slash command", () => {
	it("opens the model setup picker for role and thinking assignment", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector.mock.calls).toEqual([[]]);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/switch slash command", () => {
	it("opens the temporary model selector (mirrors alt+p)", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/switch sonnet:high fuzzy-resolves and switches session-only with the thinking suffix", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch sonnet:high", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.switchSessionModel).toHaveBeenCalledWith(MODELS[1], "high");
		expect(harness.showModelSelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/switch @smol resolves the configured role alias", async () => {
		const harness = createRuntime();
		harness.settings.setModelRole("smol", "openai/gpt-5.2");

		await executeBuiltinSlashCommand("/switch @smol", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(MODELS[2], undefined);
	});

	it("/switch unknown surfaces an error without opening the picker or switching", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/switch nope-9000", harness.runtime);

		expect(harness.showError).toHaveBeenCalledWith("Unknown model: nope-9000");
		expect(harness.switchSessionModel).not.toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});
});
