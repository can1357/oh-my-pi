import { describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";

function createRuntimeHarness(overrides?: { setForcedToolChoice?: (toolName: string) => void }) {
	const setForcedToolChoice = vi.fn(overrides?.setForcedToolChoice ?? ((_toolName: string) => {}));
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();

	const ctx = {
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		session: { setForcedToolChoice } as unknown as InteractiveModeContext["session"],
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;

	return {
		runtime: {
			ctx,
		},
		setForcedToolChoice,
		setText,
		showStatus,
		showError,
	};
}

describe("/force slash command", () => {
	it("forces the next round tool with colon syntax", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/force:write", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
		expect(harness.showStatus).toHaveBeenCalledWith("Next turn forced to use write.");
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shows usage when tool name is missing", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/force", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setForcedToolChoice).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Usage: /force:<tool-name> [prompt]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("returns remaining prompt text when provided after tool name", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force:write fix the tests", harness.runtime);

		expect(result).toBe("fix the tests");
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
		expect(harness.showStatus).toHaveBeenCalledWith("Next turn forced to use write.");
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("forces tool with space syntax", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force write", harness.runtime);

		expect(result).toBe(true);
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
	});

	it("returns remaining prompt with space syntax", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force write fix the tests", harness.runtime);

		expect(result).toBe("fix the tests");
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
	});

	it("surfaces session validation errors", async () => {
		const harness = createRuntimeHarness({
			setForcedToolChoice: () => {
				throw new Error('Tool "write" is not currently active.');
			},
		});

		const handled = await executeBuiltinSlashCommand("/force:write", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).toHaveBeenCalledWith('Tool "write" is not currently active.');
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("builds a named Ollama choice for local forced tools", () => {
		const model = buildModel({
			id: "ggml-org/gemma-3-1b-it/GGUF",
			name: "Gemma 3 1B",
			api: "ollama-chat",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 8_192,
		}) satisfies Model<"ollama-chat">;

		expect(buildNamedToolChoice("write", model)).toEqual({ type: "function", name: "write" });
	});
});
