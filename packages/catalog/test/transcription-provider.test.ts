import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { compileCompatRules } from "../scripts/compat-compiler";

const RULES_DIR = path.join(import.meta.dir, "../src/compat/rules");

async function resolvedSeedModels(providerId: "openai" | "openrouter") {
	const rules = await compileCompatRules(RULES_DIR);
	const seed = rules.providers[providerId]?.seed;
	if (!seed) throw new Error(`${providerId} has no catalog seed`);
	return seed.models.filter(row => row.api === "openai-transcriptions").map(row => buildModel(row as ModelSpec));
}

describe("cloud transcription catalog policy", () => {
	test("OpenAI transcription seeds resolve onto the STT runner", async () => {
		const models = await resolvedSeedModels("openai");
		expect(models.map(model => model.id)).toEqual(["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);
		for (const model of models) {
			expect(model.kind).toBe("stt");
			expect(model.api).toBe("openai-transcriptions");
		}
	});

	test("OpenRouter's documented transcription slugs resolve onto the STT runner", async () => {
		const models = await resolvedSeedModels("openrouter");
		expect(models.map(model => model.id)).toEqual([
			"openai/whisper-1",
			"openai/whisper-large-v3",
			"openai/gpt-4o-transcribe",
			"microsoft/mai-transcribe-1.5",
			"microsoft/mai-transcribe-2",
		]);
		for (const model of models) {
			expect(model.kind).toBe("stt");
			expect(model.api).toBe("openai-transcriptions");
		}
	});
});
