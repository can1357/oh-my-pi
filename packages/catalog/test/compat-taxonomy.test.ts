import { describe, expect, test } from "bun:test";
import { billingVariantPlain, classifyModel, collapseVariantId, routingVariantPlain } from "../src/compat/taxonomy";
import { Effort } from "../src/effort";

describe("classifyModel", () => {
	test("anthropic dashed revision extracts as dotted triple", () => {
		expect(classifyModel("anthropic", "claude-opus-4-6")).toEqual({
			class: "anthropic",
			family: "opus",
			revision: "4.6.0",
		});
	});

	test("namespaced aggregator ids classify by bare name", () => {
		expect(classifyModel("openrouter", "anthropic/claude-opus-4-6")).toEqual({
			class: "anthropic",
			family: "opus",
			revision: "4.6.0",
		});
	});

	test("bare o-series names carry no revision", () => {
		expect(classifyModel("openai", "o3")).toEqual({ class: "openai", family: "o-series" });
		expect(classifyModel("openai", "o3-mini")).toEqual({
			class: "openai",
			family: "o-series",
			revision: "3.0.0",
		});
	});

	test("bounded matchers do not fire on substrings", () => {
		expect(classifyModel("test", "anthropicology").class).toBe("unknown");
		expect(classifyModel("test", "deepseeker").class).toBe("unknown");
	});

	test("gpt-oss outranks the gpt- prefix", () => {
		expect(classifyModel("openai", "gpt-oss-120b").class).toBe("gpt-oss");
	});
	test("zai- vendor-prefixed bare ids classify as glm", () => {
		// Bounded matchers are prefix-anchored, so `bounded "glm"` never sees
		// `zai-glm-*`; losing the class drops the glm tokenizer and <think>
		// replay dialect on hosts like mistral (regression: pre-KDL parity sweep).
		expect(classifyModel("mistral", "zai-glm-5-2")).toEqual({ class: "glm", revision: "5.2.0" });
		expect(classifyModel("cerebras", "zai-glm-4.7")).toEqual({ class: "glm", revision: "4.7.0" });
	});

	test("-thinking suffix collapses to the logical id", () => {
		expect(classifyModel("vercel-ai-gateway", "glm-4.6-thinking")).toMatchObject({
			class: "glm",
			thinkingVariant: true,
			logicalId: "glm-4.6",
		});
	});

	test("effort suffix collapses with except-bare-prefix gate", () => {
		// qwen3.6-max is a product SKU, not an effort variant: the collapse
		// vocabulary carries except-bare-prefix="qwen" on the -max suffix.
		const qwen = classifyModel("alibaba-token-plan", "qwen3.6-max");
		expect(qwen.class).toBe("qwen");
		expect(qwen.effort).toBeUndefined();
	});

	test("daybreak overrides pin class/revision", () => {
		expect(classifyModel("openai", "daybreak-blue-latest")).toMatchObject({
			class: "unknown",
			revision: "5.6.0",
		});
		expect(classifyModel("openai", "gpt-daybreak-blue-latest")).toMatchObject({
			class: "openai",
			revision: "5.6.0",
		});
	});

	test("provider-specific override beats provider-agnostic classification", () => {
		expect(classifyModel("kilo", "qwq-32b")).toMatchObject({
			class: "qwen",
			logicalId: "qwen/qwq-32b",
		});
	});
});

describe("collapse and variant vocabulary", () => {
	test("routing-variant suffix resolves on declared providers only", () => {
		expect(routingVariantPlain("openai-codex", "gpt-5.6-luna-wm")).toBe("gpt-5.6-luna");
		expect(routingVariantPlain("openai", "gpt-5.6-luna-wm")).toBeUndefined();
	});

	test("billing-variant suffix strips to the transport base", () => {
		expect(billingVariantPlain("gpt-5.5-pro-free")).toBe("gpt-5.5-pro");
		expect(billingVariantPlain("-free")).toBeUndefined();
	});

	test("collapse assigns effort tier from the declared suffix", () => {
		const collapsed = collapseVariantId("openai", "gpt-5.2-codex-xhigh");
		expect(collapsed).toEqual({ logicalId: "gpt-5.2-codex", effort: Effort.XHigh, thinkingVariant: false });
	});
});
