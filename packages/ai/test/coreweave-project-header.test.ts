import { afterEach, describe, expect, test } from "bun:test";
import { resolveOpenAIRequestSetup } from "@pk-nerdsaver-ai/pi-ai/providers/openai-shared";

const COREWEAVE_ENV_KEYS = ["COREWEAVE_PROJECT", "WANDB_INFERENCE_PROJECT", "WANDB_ENTITY", "WANDB_PROJECT"] as const;
const ORIGINAL_ENV = new Map(COREWEAVE_ENV_KEYS.map(key => [key, Bun.env[key]]));

function restoreCoreWeaveEnv(): void {
	for (const key of COREWEAVE_ENV_KEYS) {
		const value = ORIGINAL_ENV.get(key);
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
}

afterEach(() => {
	restoreCoreWeaveEnv();
});

describe("CoreWeave Serverless Inference project header", () => {
	const coreWeaveModel = {
		provider: "coreweave",
		id: "zai-org/GLM-5.2",
		baseUrl: "https://api.inference.wandb.ai/v1",
	};

	test("adds OpenAI-Project from COREWEAVE_PROJECT", () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";
		delete Bun.env.WANDB_INFERENCE_PROJECT;
		delete Bun.env.WANDB_ENTITY;
		delete Bun.env.WANDB_PROJECT;

		const setup = resolveOpenAIRequestSetup(coreWeaveModel, {
			apiKey: "coreweave-key",
			messages: [],
		});

		expect(setup.headers["OpenAI-Project"]).toBe("team/project");
	});

	test("builds OpenAI-Project from W&B entity and project fallbacks", () => {
		delete Bun.env.COREWEAVE_PROJECT;
		delete Bun.env.WANDB_INFERENCE_PROJECT;
		Bun.env.WANDB_ENTITY = "wandb-team";
		Bun.env.WANDB_PROJECT = "inference-project";

		const setup = resolveOpenAIRequestSetup(coreWeaveModel, {
			apiKey: "coreweave-key",
			messages: [],
		});

		expect(setup.headers["OpenAI-Project"]).toBe("wandb-team/inference-project");
	});

	test("preserves an explicit request project header", () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";

		const setup = resolveOpenAIRequestSetup(coreWeaveModel, {
			apiKey: "coreweave-key",
			extraHeaders: { "openai-project": "explicit/team" },
			messages: [],
		});

		expect(setup.headers["openai-project"]).toBe("explicit/team");
		expect(setup.headers["OpenAI-Project"]).toBeUndefined();
	});
});
