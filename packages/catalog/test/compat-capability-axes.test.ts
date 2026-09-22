import { expect, test } from "bun:test";
import { supportsOutputTokenLimit } from "@oh-my-pi/pi-catalog/compat/output-limits";
import { requiresNativeTools, requiresToolFreeHistoryForToolOptOut } from "@oh-my-pi/pi-catalog/compat/tools";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";

function fixture(provider: Parameters<typeof getBundledModels>[0], predicate?: (candidate: Model) => boolean): Model {
	const models = getBundledModels(provider);
	const found = predicate ? models.find(predicate) : models[0];
	if (!found) throw new Error(`missing bundled fixture for ${provider}`);
	return found;
}

test("google-antigravity vetoes caller output caps while the gemini-cli lane preserves them", () => {
	// Both providers ride the google-gemini-cli api; only the provider-scoped
	// preserves-max-output-tokens rule may separate them.
	expect(fixture("google-antigravity").api).toBe(fixture("google-gemini-cli").api);
	expect(supportsOutputTokenLimit(fixture("google-antigravity"))).toBe(false);
	expect(supportsOutputTokenLimit(fixture("google-gemini-cli"))).toBe(true);
});

test("transports that cannot encode output limits are omitted", () => {
	expect(supportsOutputTokenLimit(fixture("openai-codex", m => m.api === "openai-codex-responses"))).toBe(false);
	expect(supportsOutputTokenLimit(fixture("cursor", m => m.api === "cursor-agent"))).toBe(false);
	expect(supportsOutputTokenLimit(fixture("gitlab-duo-agent"))).toBe(false);
	// Model-level omitMaxOutputTokens still vetoes through the same helper.
	expect(supportsOutputTokenLimit(fixture("ollama-cloud"))).toBe(false);
	// Providers riding encoding-capable apis are unaffected.
	expect(supportsOutputTokenLimit(fixture("gitlab-duo", m => m.api === "anthropic-messages"))).toBe(true);
	expect(supportsOutputTokenLimit(getBundledModel("anthropic", "claude-sonnet-4-6")!)).toBe(true);
});

test("requiresNativeTools marks only cursor-agent transports", () => {
	expect(requiresNativeTools(fixture("cursor", m => m.api === "cursor-agent"))).toBe(true);
	expect(requiresNativeTools(fixture("gitlab-duo", m => m.api === "anthropic-messages"))).toBe(false);
});

test("requiresToolFreeHistoryForToolOptOut marks only bedrock-converse-stream", () => {
	expect(requiresToolFreeHistoryForToolOptOut(fixture("amazon-bedrock", m => m.reasoning))).toBe(true);
	expect(requiresToolFreeHistoryForToolOptOut(getBundledModel("anthropic", "claude-sonnet-4-6")!)).toBe(false);
});
