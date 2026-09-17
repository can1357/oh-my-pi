import { beforeAll, describe, expect, test } from "bun:test";
import type { AddCustomOpenAIProviderOptions } from "../src/config/models-config-writer";
import { ModelAddWizard } from "../src/modes/components/model-add-wizard";
import { initTheme } from "../src/modes/theme/theme";

describe("ModelAddWizard", () => {
	beforeAll(async () => {
		await initTheme();
	});
	test("cancels on escape on first step", () => {
		let cancelled = false;
		const wizard = new ModelAddWizard(
			() => {},
			() => {
				cancelled = true;
			},
		);

		wizard.handleInput("\x1b"); // Escape
		expect(cancelled).toBe(true);
	});

	test("cancels on Ctrl+C at any step", () => {
		let cancelled = false;
		const wizard = new ModelAddWizard(
			() => {},
			() => {
				cancelled = true;
			},
		);

		wizard.handleInput("\x03"); // Ctrl+C
		expect(cancelled).toBe(true);
	});

	test("steps through manual model creation and invokes onComplete", async () => {
		let completedResult: AddCustomOpenAIProviderOptions | null = null;
		const probeDeferred = Promise.withResolvers<void>();
		let inProbe = false;
		let wizard!: ModelAddWizard;
		wizard = new ModelAddWizard(
			result => {
				completedResult = result;
			},
			() => {},
			() => {
				if (inProbe && wizard.isProbeSettled) {
					probeDeferred.resolve();
				}
			},
		);
		// Step 1: Provider ID
		for (const ch of "my-vllm") {
			wizard.handleInput(ch);
		}
		wizard.handleInput("\n"); // Enter

		// Step 2: Base URL (default is http://localhost:8000/v1, press enter)
		wizard.handleInput("\n");

		// Step 3: API Format (default openai-completions, press enter)
		wizard.handleInput("\n");

		// Step 4: Auth Method (default none, press enter)
		wizard.handleInput("\n");

		// Step 6: Model Mode (navigate down to manual)
		wizard.handleInput("\t"); // Tab -> selects manual
		wizard.handleInput("\n"); // Enter

		// Step 7: Manual Model ID
		for (const ch of "llama-3-8b") {
			wizard.handleInput(ch);
		}
		wizard.handleInput("\n");

		// Step 8: Manual Model Name (press enter to default to id)
		wizard.handleInput("\n");

		// Step 9: Context Window (default 128000, press enter)
		inProbe = true;
		wizard.handleInput("\n");

		// Await deterministic probe resolution signal from onRender
		await probeDeferred.promise;
		// Step 10: Probe failed screen -> select option 0: "Save anyway"
		wizard.handleInput("\n");

		// Step 11: Confirm screen -> option 0: "Save configuration"
		wizard.handleInput("\n");

		expect(completedResult).not.toBeNull();
		expect(completedResult).toMatchObject({
			provider: "my-vllm",
			baseUrl: "http://localhost:8000/v1",
			api: "openai-completions",
			auth: "none",
			disableStrictTools: true,
			model: {
				id: "llama-3-8b",
				name: "llama-3-8b",
				contextWindow: 128000,
			},
		});
	});

	test("steps through discovery mode with apiKey", async () => {
		let completedResult: AddCustomOpenAIProviderOptions | null = null;
		const probeDeferred = Promise.withResolvers<void>();
		let inProbe = false;
		let wizard!: ModelAddWizard;
		wizard = new ModelAddWizard(
			result => {
				completedResult = result;
			},
			() => {},
			() => {
				if (inProbe && wizard.isProbeSettled) {
					probeDeferred.resolve();
				}
			},
		);
		// Step 1: Provider ID
		for (const ch of "openai-proxy") {
			wizard.handleInput(ch);
		}
		wizard.handleInput("\n");

		// Step 2: Base URL
		for (const ch of "https://api.openai.com/v1") {
			wizard.handleInput(ch);
		}
		wizard.handleInput("\n");

		// Step 3: API Format (default openai-completions)
		wizard.handleInput("\n");

		// Step 4: Auth Method (navigate down to apiKey)
		wizard.handleInput("\t"); // Tab -> apiKey
		wizard.handleInput("\n");

		// Step 5: API Key
		for (const ch of "sk-test-secret-key") {
			wizard.handleInput(ch);
		}
		wizard.handleInput("\n");

		// Step 6: Model Mode (default is discovery, press enter)
		inProbe = true;
		wizard.handleInput("\n");

		// Await deterministic probe resolution signal from onRender
		await probeDeferred.promise;
		wizard.handleInput("\n");

		// Confirm screen -> save
		wizard.handleInput("\n");

		expect(completedResult).not.toBeNull();
		expect(completedResult).toMatchObject({
			provider: "openai-proxy",
			baseUrl: "https://api.openai.com/v1",
			api: "openai-completions",
			auth: "apiKey",
			apiKey: "sk-test-secret-key",
			discovery: true,
			disableStrictTools: true,
		});
	});
});
