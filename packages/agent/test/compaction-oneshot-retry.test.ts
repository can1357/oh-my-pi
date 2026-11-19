import { describe, expect, it } from "bun:test";
import { generateSummary } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai/types";

/**
 * Defends `SummaryOptions.oneshotRetry`, the split that lets manual `/compact`
 * survive a transient provider blip without inflating auto-compaction's budget.
 *
 * Both paths call the same `generateSummary`, so the policy cannot be a constant
 * inside it. Auto-compaction wraps the whole attempt in its own retry loop
 * (`session-maintenance.ts`), and a nested inner loop would multiply requests
 * (10 outer x 3 inner) while stacking each outer wait on an inner backoff.
 * Manual `/compact` has no outer loop: without retry, one `overloaded_error`
 * aborts compaction and leaves the user's context full.
 *
 * A transient failure arrives as a **resolved** `AssistantMessage` with
 * `stopReason: "error"`, which is why `completeImpl` returning that value —
 * rather than throwing — is the realistic stub here.
 */

const emptyUsage = (): Usage =>
	({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}) as unknown as Usage;

const model = {
	id: "claude-sonnet-4-6",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	maxTokens: 8192,
} as unknown as Model;

// `ApiKey` is `string | ApiKeyResolver`; the stubbed `completeImpl` never uses it.
const apiKey = "test-key";

const messages = [{ role: "user", content: "summarize this session", timestamp: 0 }] as unknown as AgentMessage[];

function overloaded(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: "overloaded_error: Overloaded",
		errorStatus: 529,
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function summary(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
	} as unknown as AssistantMessage;
}

describe("SummaryOptions.oneshotRetry", () => {
	it("retries a transient failure by default, so manual /compact survives a blip", async () => {
		let calls = 0;
		const text = await generateSummary(messages, model, 10_000, apiKey, undefined, undefined, undefined, {
			// No `oneshotRetry`: the manual `/compact` shape. The one real backoff
			// wait (default 500ms) is the price of asserting the DEFAULT rather than
			// a value this test picked for itself.
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(calls === 1 ? overloaded() : summary("recovered summary"));
			},
		});

		expect(calls).toBe(2);
		expect(text).toContain("recovered summary");
	});

	it("makes exactly one attempt when the caller owns the retry loop", async () => {
		let calls = 0;
		const attempt = generateSummary(messages, model, 10_000, apiKey, undefined, undefined, undefined, {
			// What auto-compaction passes: its own loop re-runs the whole attempt.
			oneshotRetry: false,
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(overloaded());
			},
		});

		// The failure must surface for the outer loop to classify and retry.
		await expect(attempt).rejects.toThrow();
		expect(calls).toBe(1);
	});
});
