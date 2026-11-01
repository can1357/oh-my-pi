import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { type Api, type Model, type ModelSpec, retryAfterMsOf } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createModelJobWidgetAuthor } from "../../src/job-widgets/author";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { rejectionOf } from "../helpers/rejection";

/** A keyless model on a custom API, so the stubbed completion needs no credentials. */
const model = buildModel({
	id: "widget-wait-model",
	name: "Widget Wait Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
	api: "test-widget-retry-wait",
	provider: "llama.cpp",
	baseUrl: "http://127.0.0.1:8080/v1",
} as ModelSpec<Api>) as Model<Api>;

async function authorFailure(failure: { errorMessage: string; errorRetryAfterMs?: number }): Promise<unknown> {
	const failed = createAssistantMessage("");
	failed.stopReason = "error";
	Object.assign(failed, failure);
	vi.spyOn(ai, "completeSimple").mockResolvedValue(failed);
	const settings = Settings.isolated({});
	settings.setModelRole("widget", "llama.cpp/widget-wait-model");
	const modelRegistry = {
		getAvailable: () => [model],
		find: () => model,
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
	const author = createModelJobWidgetAuthor({ settings, modelRegistry, sessionId: () => "sess" });
	return rejectionOf(
		author({ jobId: "job-1", brief: { kind: "bash", command: "make" }, sources: [] }, new AbortController().signal),
	);
}

describe("a widget spec request that the provider fails", () => {
	afterEach(() => vi.restoreAllMocks());

	it("throws the provider's text with the server's wait in headers, not in the text", async () => {
		const error = await authorFailure({ errorMessage: "429 rate_limit_error", errorRetryAfterMs: 30_000 });

		// Status scanners read `.message`; a wait written there reads as a status.
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("429 rate_limit_error");
		expect(retryAfterMsOf(error)).toBe(30_000);
	});

	it("carries no wait when the failure stated none, even if its old text names one", async () => {
		const error = await authorFailure({ errorMessage: "429 rate_limit_error retry-after-ms=9000" });

		expect((error as Error).message).toBe("429 rate_limit_error retry-after-ms=9000");
		expect(retryAfterMsOf(error)).toBeUndefined();
	});
});
