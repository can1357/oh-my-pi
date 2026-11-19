import { describe, expect, test } from "bun:test";
import { classifyModel } from "../src/compat/taxonomy";
import { productIdentityKey, productIdentityKeys } from "../src/identity/product";

/** Builds the row of `provider/id` with its catalog identity. */
function rowOf(model: string, requestModelId?: string) {
	const slash = model.indexOf("/");
	const provider = model.slice(0, slash);
	const id = model.slice(slash + 1);
	return { provider, id, identity: classifyModel(provider, id), requestModelId };
}

/** Builds `provider/id` from its catalog identity and returns its product key. */
function keyOf(model: string, requestModelId?: string): string | undefined {
	return productIdentityKey(rowOf(model, requestModelId));
}

function expectOneKey(base: string, others: readonly string[]): void {
	const baseKey = keyOf(base);
	expect(baseKey).toBeDefined();
	for (const other of others) {
		expect({ model: other, key: keyOf(other) }).toEqual({ model: other, key: baseKey });
	}
}

function expectSeparateKeys(models: readonly string[]): void {
	const keys = models.map(model => keyOf(model));
	expect(keys).not.toContain(undefined);
	expect(new Set(keys).size).toBe(models.length);
}

describe("productIdentityKey", () => {
	test("builds the key from the class, family, revision and product words", () => {
		expect(keyOf("anthropic/claude-opus-4-8")).toBe("anthropic/opus/4.8.0/");
		expect(keyOf("openai/gpt-5.6-sol")).toBe("openai/gpt/5.6.0/sol");
	});

	test("gives Claude Opus 4.8 one key under every provider's spelling", () => {
		expectOneKey("anthropic/claude-opus-4-8", [
			"google-vertex/claude-opus-4-8@default",
			"amazon-bedrock/us.anthropic.claude-opus-4-8",
			"amazon-bedrock/us-gov.anthropic.claude-opus-4-8",
			"github-copilot/claude-opus-4.8",
			"cursor/claude-opus-4-8-high",
			"nanogpt/anthropic/claude-opus-4.8:thinking",
		]);
	});

	test("gives Claude Sonnet 4.5 one key in Cursor's and Bedrock's spellings", () => {
		expectOneKey("anthropic/claude-sonnet-4-5", [
			"cursor/claude-4.5-sonnet",
			"amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
		]);
	});

	test("gives GPT-5.6 one key through a gateway", () => {
		expectOneKey("openai/gpt-5.6", ["cloudflare-ai-gateway/openai/gpt-5.6"]);
	});

	test("gives each GPT-5.6 product its own key", () => {
		expectSeparateKeys([
			"openai/gpt-5.6",
			"openai/gpt-5.6-sol",
			"openai/gpt-5.6-luna",
			"openai/gpt-5.6-terra",
			"openai/gpt-5.6-cyber",
		]);
	});

	test("gives o3-mini and o3-pro separate keys", () => {
		expectSeparateKeys(["openai/o3-mini", "openai/o3-pro"]);
	});

	test("gives gpt-4.1-mini and gpt-4.1-nano separate keys", () => {
		expectSeparateKeys(["openai/gpt-4.1-mini", "openai/gpt-4.1-nano"]);
	});

	test("gives Grok 4 and Grok 4 Fast Reasoning separate keys", () => {
		expectSeparateKeys(["xai/grok-4", "xai/grok-4-fast-reasoning"]);
	});

	test("returns undefined for an identity with no revision", () => {
		expect(classifyModel("openai", "gpt-4o").revision).toBeUndefined();
		expect(keyOf("openai/gpt-4o")).toBeUndefined();
	});

	test("reads the served id from requestModelId", () => {
		expect(keyOf("openai/gpt-5.6-sol-pro", "gpt-5.6-sol")).toBe(keyOf("openai/gpt-5.6-sol"));
		expect(keyOf("openai/gpt-5.6-sol-pro")).not.toBe(keyOf("openai/gpt-5.6-sol"));
	});

	test("drops the route words of a Claude id", () => {
		expectOneKey("anthropic/claude-opus-4-8", [
			"openrouter/anthropic/claude-opus-4.8-fast",
			"openrouter/anthropic/claude-opus-4.8:batch",
			"openrouter/anthropic/claude-opus-4.8-flex",
			"anthropic/claude-opus-4-8-latest",
			"openrouter/anthropic/claude-opus-4.8-discounted",
		]);
	});

	test("keeps fast as a product word of a Grok id", () => {
		expectSeparateKeys(["xai/grok-4", "xai/grok-4-fast"]);
	});

	test("drops highspeed from an id", () => {
		expectOneKey("kimi-code/k3.1-pro", ["kimi-code/k3.1-pro-highspeed"]);
	});

	test("drops turbo from a Qwen id and keeps it in an OpenAI id", () => {
		expectOneKey("deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct", [
			"deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
		]);
		expectSeparateKeys(["openai/gpt-4", "openai/gpt-4-turbo"]);
	});

	test("drops nothinking from an id", () => {
		expectOneKey("google/gemini-2.5-flash", ["nanogpt/gemini-2.5-flash-nothinking"]);
	});

	test("drops non-reasoning as one route word and keeps a bare non", () => {
		expectOneKey("xai/grok-4-fast-reasoning", ["xai/grok-4-fast-non-reasoning"]);
		expectSeparateKeys(["xai/grok-4", "xai/grok-4-non"]);
	});

	test("keeps preview as a product word", () => {
		expectSeparateKeys(["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-8-preview"]);
		expectSeparateKeys(["google/gemini-3.1-pro", "google/gemini-3.1-pro-preview"]);
	});

	test("keeps a product word that comes before the family's last word", () => {
		// Gemini 2.5 Flash Live and GLM-4.6V-Flash share their catalog class, family
		// and revision with Gemini 2.5 Flash and GLM-4-Flash, but they are other
		// products. The word that tells them apart (`live`, `6v`) comes before the
		// family's last word (`flash`), as `live` comes after it in
		// `gemini-3.1-flash-live-preview`.
		expectSeparateKeys(["google/gemini-2.5-flash", "google/gemini-live-2.5-flash"]);
		expectSeparateKeys(["nanogpt/glm-4-flash", "zai/glm-4.6v-flash"]);
	});

	test("keeps max as a product word of an OpenAI id", () => {
		// GPT-5.1 Codex Max is another model than GPT-5.1 Codex: providers send it upstream under its own id.
		expectSeparateKeys(["openai/gpt-5.1-codex", "openai/gpt-5.1-codex-max"]);
		expectOneKey("openai/gpt-5.1-codex-max", ["cursor/gpt-5.1-codex-max-high"]);
	});

	test("drops max from a Claude id", () => {
		// Cursor's Opus 4.8 Max is Opus 4.8 in Max mode.
		expectOneKey("anthropic/claude-opus-4-8", ["cursor/claude-opus-4-8-max"]);
	});

	test("starts the product words at a lineage word followed by digits", () => {
		expectOneKey("vercel-ai-gateway/alibaba/qwen3-coder-30b-a3b", ["amazon-bedrock/qwen.qwen3-coder-30b-a3b-v1:0"]);
	});

	test("drops a provider's lane word only at the end of the id", () => {
		expectOneKey("xai/grok-code-fast-1", ["cursor/grok-code-fast-1"]);
		expectOneKey("xai/grok-4.7", ["cursor/grok-4.7-fast"]);
		expectOneKey("openai-codex/gpt-5.6-luna", ["openai-codex/gpt-5.6-luna-wm"]);
	});

	test("keeps max as a product word of a Qwen id", () => {
		// In an id that starts with `qwen`, the catalog reads `-max` as part of the product (Qwen Max), not an effort.
		// The catalog gives its Qwen Max ids no family and so no key, so a Coder id stands in for one.
		expectSeparateKeys(["openrouter/qwen/qwen3-coder", "openrouter/qwen/qwen3-coder-max"]);
	});
});

describe("productIdentityKeys", () => {
	/** Builds `provider/id` from its catalog identity and returns its product keys. */
	function keysOf(model: string, requestModelId?: string): readonly string[] {
		return productIdentityKeys(rowOf(model, requestModelId));
	}

	test("holds the key of the served id and the key of the row's own id", () => {
		// OpenAI sends gpt-5.6-luna-pro as gpt-5.6-luna, and OpenRouter sends it under its own id.
		const keys: readonly (string | undefined)[] = keysOf("openai/gpt-5.6-luna-pro", "gpt-5.6-luna");
		expect(keys).toHaveLength(2);
		expect(keys).toContain(keyOf("openai/gpt-5.6-luna"));
		expect(keys).toContain(keyOf("openrouter/openai/gpt-5.6-luna-pro"));
	});

	test("gives GPT-5.1 Codex Max no key of GPT-5.1 Codex", () => {
		const max = keysOf("openai/gpt-5.1-codex-max");
		const codex = keysOf("openai/gpt-5.1-codex");
		expect(max).not.toHaveLength(0);
		expect(codex).not.toHaveLength(0);
		expect(max.filter(key => codex.includes(key))).toEqual([]);
	});
});
