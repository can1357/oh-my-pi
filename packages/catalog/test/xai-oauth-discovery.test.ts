import { describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { xaiOAuthModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

// Regression for https://github.com/can1357/oh-my-pi/issues/12697: xAI's
// OAuth /v1/models returns bare `{id}` rows with no reasoning, limits, or
// modality metadata. Without a curated seed, grok-4.7 refreshes into a sparse
// entry (reasoning false, null limits) whose thinking picker offers only
// inherit/off.
describe("xai-oauth grok-4.7 discovery", () => {
	test("refreshing sparse upstream rows yields complete grok-4.7 metadata", async () => {
		let requestHeaders: RequestInit["headers"];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			requestHeaders = init?.headers;
			return Response.json({
				object: "list",
				data: [{ id: "grok-4.7" }, { id: "grok-4.6" }],
			});
		});
		const options = xaiOAuthModelManagerOptions({ apiKey: "xai-oauth-test", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		expect(fetchMock).toHaveBeenCalledWith("https://api.x.ai/v1/models", expect.objectContaining({ method: "GET" }));
		expect(requestHeaders).toHaveProperty("Authorization", "Bearer xai-oauth-test");
		const spec = specs?.find(model => model.id === "grok-4.7");
		expect(spec).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 500_000,
			maxTokens: 500_000,
		});
		if (!spec) throw new Error("Expected curated grok-4.7 spec");
		expect(getSupportedEfforts(buildModel(spec))).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
	});

	test("voice ids never become chat rows; the transcriber is the seeded xai-stt runner", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({
				object: "list",
				data: [
					{ id: "grok-4.7" },
					{ id: "grok-voice-transcribe-2.0" },
					{ id: "grok-voice-transcribe-3.0" },
					{ id: "grok-stt-1" },
					{ id: "grok-voice-latest" },
					{ id: "grok-voice-think-fast" },
				],
			}),
		);
		const options = xaiOAuthModelManagerOptions({ apiKey: "xai-oauth-test", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		expect(specs?.filter(model => model.id.startsWith("grok-voice") || model.id.startsWith("grok-stt"))).toEqual([]);
		expect(options.staticModels?.find(model => model.id === "grok-voice-transcribe-2.0")).toMatchObject({
			api: "xai-stt",
			baseUrl: "https://api.x.ai/v1",
		});
	});
});
