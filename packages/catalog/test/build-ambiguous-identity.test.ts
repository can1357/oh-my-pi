import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { rebakeModelThinking } from "../scripts/generated-policies";
import { collapseBuiltVariants } from "../src/compat/collapse";
import { clampsContextOverride, resolveMaxContextWindow } from "../src/compat/context-window";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

const ambiguousSpec: ModelSpec<"openai-completions"> = {
	id: "openai-compatible-chat-b524a192-5149-4722-ba4c-aec8d52dbaef/cohere/north-mini-code:free",
	name: "cohere/north-mini-code:free",
	api: "openai-completions",
	provider: "omni",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

describe("model identity strictness", () => {
	test("runtime discovery preserves ambiguous IDs without aborting startup", () => {
		const model = buildModel(ambiguousSpec);
		expect(model.id).toBe(ambiguousSpec.id);
		expect(model.identity.class).toBe("unknown");
	});

	test("curated generator materialization rejects ambiguous identities", () => {
		expect(() => buildModel(ambiguousSpec, { strict: true })).toThrow("ambiguous class");
	});

	test("policy resolution remains strict by default", () => {
		expect(() => resolveModelPolicy(ambiguousSpec)).toThrow("ambiguous class");
		expect(resolveModelPolicy(ambiguousSpec, { strict: false }).identity.class).toBe("unknown");
	});

	test("runtime context-window re-resolution stays lenient", () => {
		const model = buildModel(ambiguousSpec);
		// Unknown identity has no curated ceiling/clamp; live maxima still pass through.
		expect(resolveMaxContextWindow(model)).toBeUndefined();
		expect(resolveMaxContextWindow({ ...model, maxContextWindow: 64_000 })).toBe(64_000);
		expect(clampsContextOverride(model)).toBe(false);
	});

	test("curated policy rebaking rejects ambiguous identities", () => {
		expect(() => rebakeModelThinking({ ...ambiguousSpec })).toThrow("ambiguous class");
	});

	test("runtime request-model aliases retain lenient identity resolution", () => {
		const spec: ModelSpec<"openai-responses"> = {
			...ambiguousSpec,
			compat: undefined,
			remoteCompaction: undefined,
			id: "gpt-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			requestModelId: ambiguousSpec.id,
		};
		expect(buildModel(spec).supportsComputerUse).toBe(false);
		expect(() => buildModel(spec, { strict: true })).toThrow("ambiguous class");
	});

	test("strict and lenient materialization agree for known identities", () => {
		const spec = { ...ambiguousSpec, id: "gpt-4.1" };
		expect(buildModel(spec, { strict: true })).toEqual(buildModel(spec));
	});

	test("runtime pair collapsing stays lenient for ambiguous X/X-thinking twins", () => {
		const baseId = ambiguousSpec.id;
		const thinkingId = `${baseId}-thinking`;
		const base = buildModel({ ...ambiguousSpec, id: baseId, name: baseId, reasoning: false });
		const thinking = buildModel({
			...ambiguousSpec,
			id: thinkingId,
			name: thinkingId,
			reasoning: false,
			thinking: undefined,
		});
		expect(() => resolveModelPolicy({ ...ambiguousSpec, id: thinkingId })).toThrow("ambiguous class");
		const collapsed = collapseBuiltVariants([base, thinking]);
		expect(collapsed.map(model => model.id)).toEqual([baseId]);
		expect(collapsed[0]?.reasoning).toBe(true);
	});
});
