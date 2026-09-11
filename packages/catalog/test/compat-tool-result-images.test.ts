import { describe, expect, test } from "bun:test";
import { resolveCascade } from "../src/compat/cascade";
import type { ResolveTarget } from "../src/compat/types";
import { buildModel } from "../src/build";
import { getBundledModel, getBundledModels } from "../src/models";

// Bedrock Converse refuses an image nested in `toolResult.content` for the
// OpenAI class, reporting it as "This model doesn't support the image field for
// user messages" — the envelope, since convertMessages() collects tool results
// into a user message. The models do accept image input: the same bytes pass in
// a plain user block, and pass inside a tool result when the same model is
// reached through bedrock-mantle. So this is a deployment contract of the
// Converse host, and `providers/amazon-bedrock.kdl` is the stratum that owns it.
//
// The selector is the part that fails silently: scoped one level too wide it
// would hoist images for Claude, which accepts them nested, and scoped too
// narrow it would leave the original bug in place while every test still
// passed. These cases pin the boundary against the shipped rule index.
const target = (overrides: Partial<ResolveTarget>): ResolveTarget => ({
	provider: "amazon-bedrock",
	api: "bedrock-converse-stream",
	class: "openai",
	model: "global.openai.gpt-5.6-sol",
	reasoning: true,
	...overrides,
});

function hoisting(overrides: Partial<ResolveTarget>): unknown {
	const resolved = resolveCascade(target(overrides)) as { catalog?: Record<string, unknown> };
	return resolved.catalog?.requiresToolResultImageHoisting;
}

describe("tool-result image hoisting selector", () => {
	test("applies to the OpenAI class on Bedrock Converse", () => {
		expect(hoisting({})).toBe(true);
		// luna shares the class and the defect.
		expect(hoisting({ model: "global.openai.gpt-5.6-luna" })).toBe(true);
	});

	test("leaves Anthropic on the same host untouched", () => {
		// Measured: claude-opus-5 accepts an image nested in a tool result on this
		// exact API, so hoisting it would rewrite a working request.
		expect(hoisting({ class: "anthropic", model: "global.anthropic.claude-opus-5" })).toBeUndefined();
	});

	test("does not follow the same models onto an OpenAI-compatible transport", () => {
		// Same vendor lineage, different deployment: bedrock-mantle serves these
		// models over /openai/v1 and accepts the nested image.
		expect(
			hoisting({ provider: "bedrock-mantle", api: "openai-completions", model: "openai.gpt-5.6-sol" }),
		).toBeUndefined();
	});

	// The cascade above is only consulted by `buildModel`. The default runtime
	// path does not call it: `getBundledModels` hands `models.json` rows to the
	// model manager verbatim, so a flag that lives only in the rule index leaves
	// every shipped model unfixed while all of the tests above still pass. That
	// is how the first revision of this change slipped through review, and the
	// Cursor precedent bakes its flag into `models.json` for the same reason.
	test("is baked into the bundled Bedrock rows the runtime serves verbatim", () => {
		const bundled = getBundledModels("amazon-bedrock").filter(
			model => model.api === "bedrock-converse-stream" && model.identity?.class === "openai",
		);
		expect(bundled.length).toBeGreaterThan(0);
		for (const model of bundled) {
			expect(model.requiresToolResultImageHoisting).toBe(true);
		}

		// And the sibling class on the same provider must stay absent, so a blanket
		// bake would fail here rather than silently rewrite Anthropic requests.
		const claude = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-5");
		expect(claude?.requiresToolResultImageHoisting).toBeUndefined();
	});

	// `build.ts` deletes the field when the cascade does not set it, so a spec that
	// carried a stale value through `collapse.ts`'s project-and-rebuild cannot
	// resurrect it. Without that `else` branch a collapsed Anthropic model could
	// inherit hoisting from whatever it was projected from.
	test("a stale flag does not survive project-and-rebuild", () => {
		const claude = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-5");
		const poisoned = { ...claude, requiresToolResultImageHoisting: true, compat: undefined };
		expect(buildModel(poisoned as never).requiresToolResultImageHoisting).toBeUndefined();

		const sol = getBundledModel("amazon-bedrock", "global.openai.gpt-5.6-sol");
		const stripped = { ...sol, requiresToolResultImageHoisting: undefined, compat: undefined };
		expect(buildModel(stripped as never).requiresToolResultImageHoisting).toBe(true);
	});
});
