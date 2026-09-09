import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("Portkey gateway custom models", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-test-portkey-gateway-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("gateway @modal/GLM-5-2-FP8 keeps full wire id (not devin glm-5-2)", () => {
		fs.writeFileSync(
			modelsPath,
			`providers:
  gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: test
    authHeader: true
    headers:
      x-portkey-api-key: test
    models:
      - id: "@modal/GLM-5-2-FP8"
        name: glm-5p2 (modal)
        reasoning: true
        input: [text]
        contextWindow: 1048576
        maxTokens: 131072
        compat:
          thinkingFormat: openai
          supportsReasoningEffort: true
          reasoningEffortMap:
            minimal: none
            low: low
            medium: medium
            high: high
            xhigh: max
`,
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("gateway", "@modal/GLM-5-2-FP8");
		expect(model).toBeDefined();
		expect(resolveWireModelId(model!, Effort.High)).toBe("@modal/GLM-5-2-FP8");
		expect(resolveWireModelId(model!, undefined)).toBe("@modal/GLM-5-2-FP8");
	});
});
