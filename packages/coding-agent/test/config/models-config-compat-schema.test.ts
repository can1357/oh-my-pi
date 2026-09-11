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
