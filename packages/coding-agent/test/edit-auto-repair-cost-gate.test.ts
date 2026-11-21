import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { attemptEditAutoRepair } from "@oh-my-pi/pi-coding-agent/edit/auto-repair";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CostCapError, CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import type { ModelUsageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { rejectionOf } from "./helpers/rejection";

const PREV = ["export function beta(b: number): number {", "\tconst doubled = b * 2;", "\treturn doubled;", "}"].join(
	"\n",
);

const BROKEN = PREV.replace("const doubled = b * 2;", "const doubled = (b * 2;");

const REPAIR_MODEL = {
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

/** A session whose `smol` role resolves to {@link REPAIR_MODEL}, with auto-repair on. */
function repairSession(settings: Settings, extra: Partial<ToolSession>): ToolSession {
	settings.setModelRole("smol", "llama.cpp/repair-model");
	return {
		settings,
		modelRegistry: {
			getAvailable: () => [REPAIR_MODEL],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as unknown as ModelRegistry,
		getSessionId: () => "sess",
		...extra,
	} as unknown as ToolSession;
}

/** A retryable provider failure that still billed the session. */
function billedOverload(cost: number): AssistantMessage {
	const message = createAssistantMessage("");
	message.stopReason = "error";
	message.errorStatus = 529;
	message.errorMessage = "Anthropic stream error (overloaded_error): Overloaded";
	message.usage.cost.total = cost;
	return message;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("edit auto-repair cost cap", () => {
	it("does not send another repair request when the cap is reached before the retry", async () => {
		using tempDir = TempDir.createSync("@omp-edit-repair-cost-");
		const filePath = path.join(tempDir.path(), "sample.ts");
		await Bun.write(filePath, BROKEN);

		const settings = Settings.isolated({ "edit.autoRepair.enabled": true, "session.maxCost": 1 });
		const costGate = new CostGate(settings, 0, () => {});
		const session = repairSession(settings, { costGate });

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
				snapshot: { path: filePath, prev: PREV, next: BROKEN },
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

describe("edit auto-repair usage journal", () => {
	it("journals every billed repair attempt once as `edit-repair`, the retried failure included", async () => {
		using tempDir = TempDir.createSync("@omp-edit-repair-journal-");
		const filePath = path.join(tempDir.path(), "sample.ts");
		await Bun.write(filePath, BROKEN);

		const sessionManager = SessionManager.inMemory();
		const session = repairSession(Settings.isolated({ "edit.autoRepair.enabled": true }), { sessionManager });

		// The first request fails transiently and is replaced by its retry; neither
		// request's candidate parses, so the repair gives up after its feedback retry.
		let providerCalls = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			providerCalls += 1;
			if (providerCalls === 1) return Promise.resolve(billedOverload(0.4));
			const unusable = createAssistantMessage("(((");
			unusable.usage.cost.total = 0.1;
			return Promise.resolve(unusable);
		});

		const repaired = await attemptEditAutoRepair({
			session,
			snapshot: { path: filePath, prev: PREV, next: BROKEN },
			writethrough: () => {
				throw new Error("repair wrote a candidate that does not parse");
			},
		});

		expect(repaired).toBeUndefined();
		const journaled = sessionManager
			.getEntries()
			.filter((entry): entry is ModelUsageEntry => entry.type === "model_usage");
		expect(journaled.map(entry => [entry.purpose, entry.stopReason, entry.usage.cost.total])).toEqual([
			["edit-repair", "error", 0.4],
			["edit-repair", "stop", 0.1],
			["edit-repair", "stop", 0.1],
		]);
		expect(journaled[1]?.completion?.reply).toBe("(((");
		expect(sessionManager.getUsageStatistics().cost).toBeCloseTo(0.6, 10);
	}, 20_000);
});
