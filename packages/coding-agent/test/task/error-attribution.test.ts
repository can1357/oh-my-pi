import { describe, expect, it } from "bun:test";
import { attributeSubagentError } from "@oh-my-pi/pi-coding-agent/task/error-attribution";

describe("attributeSubagentError", () => {
	it("prefixes provider/model so misrouted subagent failures name their transport", () => {
		expect(
			attributeSubagentError("Connect error invalid_argument: Error", {
				provider: "cursor",
				model: "cursor/default",
			}),
		).toBe("[cursor/cursor/default] Connect error invalid_argument: Error");
	});

	it("uses the fallback text when the message is empty", () => {
		expect(attributeSubagentError(undefined, { provider: "anthropic", model: "claude-sonnet-4-5" })).toBe(
			"[anthropic/claude-sonnet-4-5] Subagent failed",
		);
		expect(attributeSubagentError("   ", undefined)).toBe("Subagent failed");
	});

	it("preserves the provider's original error text", () => {
		expect(attributeSubagentError("  first line\nsecond line  ", undefined)).toBe("  first line\nsecond line  ");
	});

	it("returns the bare message when no identity is known", () => {
		expect(attributeSubagentError("boom", undefined)).toBe("boom");
		expect(attributeSubagentError("boom", {})).toBe("boom");
	});

	it("skips the prefix when the message already names the provider", () => {
		expect(
			attributeSubagentError("Cursor stream ended before turnEnded", { provider: "cursor", model: "gpt-5" }),
		).toBe("Cursor stream ended before turnEnded");
	});

	it("attributes with a partial identity", () => {
		expect(attributeSubagentError("boom", { model: "gpt-5" })).toBe("[gpt-5] boom");
		expect(attributeSubagentError("boom", { provider: "openai" })).toBe("[openai] boom");
	});
});
