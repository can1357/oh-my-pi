import { afterEach, describe, expect, test, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { Tokenizer, tokenizerEncodingForModel } from "../src/tokenizer";

afterEach(() => {
	vi.restoreAllMocks();
});

// Contract: the catalog resolves model identity once as Model.tokenizer; the
// agent maps that catalog property to the matching native counter. A wrong
// row silently skews every context-budget and compaction decision.
describe("tokenizerEncodingForModel", () => {
	test("maps every catalog tokenizer family to its native counter", () => {
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v3" })).toBe(natives.Encoding.ClaudeV3);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v47" })).toBe(natives.Encoding.ClaudeV47);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v5" })).toBe(natives.Encoding.ClaudeV5);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v5-sonnet" })).toBe(natives.Encoding.ClaudeV5Sonnet);
		expect(tokenizerEncodingForModel({ tokenizer: "qwen3" })).toBe(natives.Encoding.Qwen3);
		expect(tokenizerEncodingForModel({ tokenizer: "deepseek-v3" })).toBe(natives.Encoding.DeepSeekV3);
		expect(tokenizerEncodingForModel({ tokenizer: "kimi-k2" })).toBe(natives.Encoding.KimiK2);
		expect(tokenizerEncodingForModel({ tokenizer: "glm5" })).toBe(natives.Encoding.Glm5);
	});

	test("leaves unknown catalog models on the estimate policy", () => {
		expect(tokenizerEncodingForModel({})).toBeNull();
		expect(tokenizerEncodingForModel(undefined)).toBeNull();
	});
});

describe("Tokenizer", () => {
	test("defaults to null encoding and byte estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.encoding).toBeNull();
		expect(tokenizer.countTokens("hello world")).toBe(3);
	});

	test("encoding is fixed at construction from the catalog model", () => {
		expect(new Tokenizer({ tokenizer: "claude-v47" }).encoding).toBe(natives.Encoding.ClaudeV47);
		expect(new Tokenizer({ tokenizer: "claude-v5" }).encoding).toBe(natives.Encoding.ClaudeV5);
		expect(new Tokenizer({}).encoding).toBeNull();
		expect(new Tokenizer(undefined).encoding).toBeNull();
	});

	test("separate instances do not interfere with each other", () => {
		const t1 = new Tokenizer({ tokenizer: "claude-v47" });
		const t2 = new Tokenizer({ tokenizer: "qwen3" });
		const t3 = new Tokenizer({});

		expect(t1.encoding).toBe(natives.Encoding.ClaudeV47);
		expect(t2.encoding).toBe(natives.Encoding.Qwen3);
		expect(t3.encoding).toBeNull();

		const t4 = new Tokenizer({ tokenizer: "claude-v3" });
		expect(t4.encoding).toBe(natives.Encoding.ClaudeV3);
		expect(t1.encoding).toBe(natives.Encoding.ClaudeV47);
		expect(t2.encoding).toBe(natives.Encoding.Qwen3);
		expect(t3.encoding).toBeNull();
	});
});

describe("countTokens with modes", () => {
	test("approximate mode uses fast estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "approximate")).toBe(3);
	});

	test("upperbound mode uses byte length", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "upperbound")).toBe(11);
	});

	test("strict mode uses native counting regardless of encoding", () => {
		const noEncoding = new Tokenizer();
		expect(noEncoding.countTokens("hello world", "strict")).toBe(2);
		const claudeEncoding = new Tokenizer({ tokenizer: "claude-v47" });
		expect(claudeEncoding.countTokens("hello world", "strict")).toBeGreaterThan(0);
	});

	test("mode is per-call; encoding stays independently model-scoped in strict mode", () => {
		// approximate/upperbound skip the encoding entirely under NODE_ENV=test
		// (fast estimate for a snappy suite); strict is testEnv-independent, so
		// it is the mode that proves per-instance encoding isolation here.
		const claude = new Tokenizer({ tokenizer: "claude-v47" });
		const generic = new Tokenizer({});
		expect(claude.countTokens("hello world", "strict")).not.toBe(generic.countTokens("hello world", "strict"));
	});

	test("falls back conservatively when native encoding is unknown", () => {
		vi.spyOn(natives, "countTokens").mockImplementation(() => {
			throw new Error('value "DeepSeekV3" does not match any variant of enum Encoding');
		});
		const tokenizer = new Tokenizer({ tokenizer: "deepseek-v3" });
		expect(tokenizer.countTokens("hello world", "strict")).toBe(11);
		expect(tokenizer.countTokens("hello world", "upperbound")).toBe(11);
		expect(tokenizer.checkTokenBudget("x".repeat(40), 20)).toEqual({
			fits: false,
			tokens: 40,
			exact: false,
		});
	});

	test("does not swallow unrelated native tokenizer errors", () => {
		vi.spyOn(natives, "countTokens").mockImplementation(() => {
			throw new Error("native tokenizer exploded");
		});
		expect(() => new Tokenizer({ tokenizer: "deepseek-v3" }).countTokens("hello world", "strict")).toThrow(
			"native tokenizer exploded",
		);
	});
});
