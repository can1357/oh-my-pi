import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { attemptEditAutoRepair } from "@oh-my-pi/pi-coding-agent/edit/auto-repair";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CostCapError, CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { rejectionOf } from "./helpers/rejection";

const PREV = ["export function beta(b: number): number {", "\tconst doubled = b * 2;", "\treturn doubled;", "}"].join(
	"\n",
);

/** A retryable provider failure that still billed the session. */
function billedOverload(cost: number): AssistantMessage {
	const message = createAssistantMessage("");
	message.stopReason = "error";
	message.errorStatus = 529;
	message.errorMessage = "Anthropic stream error (overloaded_error): Overloaded";
	message.usage.cost.total = cost;
	return message;
}

describe("edit auto-repair cost cap", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not send another repair request when the cap is reached before the retry", async () => {
		using tempDir = TempDir.createSync("@omp-edit-repair-cost-");
		const filePath = path.join(tempDir.path(), "sample.ts");
		const broken = PREV.replace("const doubled = b * 2;", "const doubled = (b * 2;");
		await Bun.write(filePath, broken);

		const model = {
			id: "repair-model",
			name: "Repair Model",
			api: "openai-responses",
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as Model<Api>;
		const settings = Settings.isolated({ "edit.autoRepair.enabled": true, "session.maxCost": 1 });
		settings.setModelRole("smol", "llama.cpp/repair-model");
		const costGate = new CostGate(settings, 0, () => {});
		const session = {
			settings,
			costGate,
			modelRegistry: {
				getAvailable: () => [model],
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			} as unknown as ModelRegistry,
			getSessionId: () => "sess",
		} as unknown as ToolSession;

		// The first attempt is billed $0.40 and fails transiently, so the repair
		// retries. A sibling request spends $0.70 while that attempt is in flight.
		// Only a repair that records the failed attempt's cost before deciding to
		// retry sees $1.10 against the $1 cap and refuses the second request.
		let providerCalls = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			providerCalls += 1;
			if (providerCalls === 1) costGate.record(0.7);
			return Promise.resolve(billedOverload(0.4));
		});

		const error = await rejectionOf(
			attemptEditAutoRepair({
				session,
				snapshot: { path: filePath, prev: PREV, next: broken },
				writethrough: () => {
					throw new Error("repair wrote the file after the cap was reached");
				},
			}),
		);

		expect(providerCalls).toBe(1);
		expect(error).toBeInstanceOf(CostCapError);
		expect(costGate.spent).toBeCloseTo(1.1, 10);
	}, 20_000);
});
