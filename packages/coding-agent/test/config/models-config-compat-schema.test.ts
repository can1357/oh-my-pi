import { type } from "@oh-my-pi/omptype";
import { describe, expect, test } from "bun:test";
import { OpenAICompatSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

// Regression for #11697: `stripImageInput` is the documented per-model opt-out
// for endpoints that really accept `image_url`, consumed by the transport
// (`vision-guard.ts`). It must be a declared, type-validated `compat` key so a
// misconfigured value surfaces as a schema error instead of silently leaving
// the catalog's text-only rule in force.
describe("OpenAICompatSchema stripImageInput", () => {
	test("accepts the documented boolean opt-out", () => {
		const parsed = OpenAICompatSchema({ stripImageInput: false });
		expect(parsed instanceof type.errors).toBe(false);
	});

	test("rejects a non-boolean value like every other declared compat key", () => {
		const parsed = OpenAICompatSchema({ stripImageInput: "no" });
		expect(parsed instanceof type.errors).toBe(true);
		expect(String(parsed)).toContain("stripImageInput");
	});
});

// Regression for #12376: `replayReasoningContent` and `qwenPreserveThinking` are
// the compat knobs a remote Qwen deployment needs to replay its reasoning
// history (DashScope sends `reasoning_content` back per turn). They must be
// declared, type-validated `compat` keys so the override reaches the transport
// instead of being rejected as an unknown config field.
describe("OpenAICompatSchema Qwen reasoning replay", () => {
	test("accepts the documented replay flags", () => {
		const parsed = OpenAICompatSchema({ replayReasoningContent: true, qwenPreserveThinking: true });
		expect(parsed instanceof type.errors).toBe(false);
	});

	test("rejects a non-boolean replay flag", () => {
		const parsed = OpenAICompatSchema({ replayReasoningContent: "yes" });
		expect(parsed instanceof type.errors).toBe(true);
		expect(String(parsed)).toContain("replayReasoningContent");
	});

	test("validates the flags inside whenThinking overrides too", () => {
		const parsed = OpenAICompatSchema({ whenThinking: { replayReasoningContent: false } });
		expect(parsed instanceof type.errors).toBe(false);
		const rejected = OpenAICompatSchema({ whenThinking: { qwenPreserveThinking: "maybe" } });
		expect(rejected instanceof type.errors).toBe(true);
	});
});
