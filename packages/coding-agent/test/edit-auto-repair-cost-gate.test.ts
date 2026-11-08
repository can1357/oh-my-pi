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

	it("does not send another repair request when the cap is reached during retry backoff", async () => {
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

		// The retry helper waits on setTimeout between provider attempts. Hold that
		// wait so a sibling can spend the rest of the budget before the next attempt.
		let releaseBackoff: (() => void) | undefined;
		const backoffStarted = Promise.withResolvers<void>();
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const heldTimer = 2_147_483_646 as unknown as Timer;
		let providerCalls = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			providerCalls += 1;
			return Promise.resolve(billedOverload(0.4));
		});
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: (...args: unknown[]) => void,
			ms?: number,
			...args: unknown[]
		) => {
			if (providerCalls > 0 && typeof fn === "function" && typeof ms === "number" && ms > 0 && ms < 20_000) {
				const run = () => fn(...args);
				if (releaseBackoff === undefined) {
					releaseBackoff = run;
					backoffStarted.resolve();
				} else {
					queueMicrotask(run);
				}
				return heldTimer;
			}
			return realSetTimeout(fn, ms, ...args);
		}) as typeof setTimeout);
		vi.spyOn(globalThis, "clearTimeout").mockImplementation(id => {
			if (id === heldTimer) return;
			realClearTimeout(id as Timer);
		});

		const pending = attemptEditAutoRepair({
			session,
			snapshot: { path: filePath, prev: PREV, next: broken },
			writethrough: () => {
				throw new Error("repair wrote the file after the cap was reached");
			},
		});
		const backoffTimeout = Promise.withResolvers<undefined>();
		realSetTimeout(() => backoffTimeout.resolve(undefined), 2_000);
		const fireBackoff = await Promise.race([
			backoffStarted.promise.then(() => releaseBackoff),
			backoffTimeout.promise,
		]);
		if (!fireBackoff) throw new Error("repair retry did not wait between provider attempts");

		// The failed attempt is already billed. A sibling request spends the rest
		// while this repair is waiting, which is what the next attempt must see.
		expect(costGate.spent).toBeCloseTo(0.4, 10);
		costGate.record(0.7);
		fireBackoff();

		const error = await rejectionOf(pending);
		expect(providerCalls).toBe(1);
		expect(error).toBeInstanceOf(CostCapError);
		expect(costGate.spent).toBeCloseTo(1.1, 10);
	});
});
