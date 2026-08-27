import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";
import {
	QWEN_CLOUD_OPENAI_BASE_URL,
	qwenCloudModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Fixture mirrors the live `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models`
 * surface: an OpenAI-style envelope of bare ids with no per-model metadata.
 * The entry includes a chat model, the bundled default (`qwen3.8-max`), and
 * several non-chat DashScope SKUs to prove the chat filter.
 */
function qwenCloudModelsFetch(ids: string[]): { calls: string[]; authorizations: string[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: string[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response(
			JSON.stringify({
				object: "list",
				data: ids.map(id => ({ id, object: "model", created: 0, owned_by: "system" })),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

describe("Qwen Cloud provider", () => {
	test("static seed carries the documented caps for the headline models", () => {
		const options = qwenCloudModelManagerOptions();
		expect(options.providerId).toBe("qwen-cloud");
		expect(options.dynamicModelsAuthoritative).toBe(true);

		const max = options.staticModels?.find(model => model.id === "qwen3.8-max");
		expect(max).toBeDefined();
		expect(max?.contextWindow).toBe(1_000_000);
		expect(max?.maxTokens).toBe(131_072);
		expect(max?.input).toContain("image");
		expect(max?.reasoning).toBe(true);
		for (const model of options.staticModels ?? []) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe(QWEN_CLOUD_OPENAI_BASE_URL);
		}
	});

	test("discovery hits the OpenAI-compatible /models endpoint with bearer auth", async () => {
		const { calls, authorizations, fetch } = qwenCloudModelsFetch(["qwen3.8-27b"]);
		await qwenCloudModelManagerOptions({ apiKey: "sk-ws-test", fetch }).fetchDynamicModels?.();
		expect(calls).toEqual([`${QWEN_CLOUD_OPENAI_BASE_URL}/models`]);
		expect(authorizations).toEqual(["Bearer sk-ws-test"]);
	});

	test("chat filter drops image/tts/asr/embedding/realtime SKUs from discovery", async () => {
		const ids = [
			"qwen3.8-27b",
			"kimi-k3",
			"text-embedding-v4",
			"qwen-image-2.0-pro",
			"qwen3-asr-flash",
			"qwen3-tts-flash",
			"wan2.7-image-pro",
			"z-image-turbo",
			"tongyi-tingwu-slp",
			"qwen-mt-flash",
			"qwen3-livetranslate-flash-realtime",
			"qwen3.5-omni-flash-realtime",
			"qwen-vl-ocr",
			"ccai-pro",
		];
		const { fetch } = qwenCloudModelsFetch(ids);
		const models = await qwenCloudModelManagerOptions({ apiKey: "sk-ws-test", fetch }).fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["kimi-k3", "qwen3.8-27b"]);
	});

	test("seeded ids keep their curated metadata through credentialed discovery", async () => {
		const { fetch } = qwenCloudModelsFetch(["qwen3.7-plus"]);
		const models = await qwenCloudModelManagerOptions({ apiKey: "sk-ws-test", fetch }).fetchDynamicModels?.();
		const plus = models?.find(model => model.id === "qwen3.7-plus");
		expect(plus).toMatchObject({
			baseUrl: QWEN_CLOUD_OPENAI_BASE_URL,
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			reasoning: true,
			input: ["text", "image"],
		});
	});

	test("dashscope compatible-mode base URL resolves the top-level enable_thinking format", () => {
		// Qwen Cloud rides the same consumer compatible-mode frontend as the other
		// DashScope providers; its wire dialect is top-level `enable_thinking`,
		// never `developer` roles or multiple system blocks.
		expect(hostMatchesUrl(QWEN_CLOUD_OPENAI_BASE_URL, "alibabaDashscope")).toBe(true);
		const spec = qwenCloudModelManagerOptions().staticModels?.find(model => model.id === "qwen3.8-max");
		if (!spec) throw new Error("expected static seed entry");
		const compat = buildModel(spec).compat;
		expect(compat).toMatchObject({
			thinkingFormat: "qwen",
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsMultipleSystemMessages: false,
		});
	});
});
