import { describe, expect, it } from "bun:test";
import { localizationKey } from "./localization-key";

describe("stable semantic translation contexts", () => {
	it("requires an explicit context for conflicting meanings rather than reverse-matching translations", () => {
		const catalog = { Write: "작성", "Write\u0004tool.write.action": "쓰기" };
		expect(() => localizationKey("Write", "쓰기", catalog)).toThrow("explicit meaning-based context");
		expect(localizationKey("Write", "쓰기", catalog, "tool.write.action")).toBe("Write\u0004tool.write.action");
		expect(localizationKey("Write\u0004tool.write.action", "쓰기", catalog)).toBe("Write\u0004tool.write.action");
	});

	it("keeps an unambiguous English source instead of guessing an existing contextual alias", () => {
		const catalog = { "Write\u0004tool.write.action": "쓰기" };
		expect(localizationKey("Write", "쓰기", catalog)).toBe("Write");
		expect(localizationKey("Message {0}", "메시지 {0}", {}, "context.message.label")).toBe(
			"Message {0}\u0004context.message.label",
		);
	});

	it("rejects implementation-derived, conflicting and malformed contexts", () => {
		for (const context of [
			"packages/tui/src/tool.ts:Renderer.label",
			"Renderer.label",
			"tool.#render",
			"tool:write",
			"tool..write",
			"",
		]) {
			expect(() => localizationKey("Write", "쓰기", {}, context)).toThrow("semantic translation context");
			expect(() => localizationKey(`Write\u0004${context}`, "쓰기", {})).toThrow("semantic translation context");
		}
		expect(() => localizationKey("Write\u0004tool.write.action", "쓰기", {}, "tool.write.state")).toThrow(
			"Conflicting",
		);
		expect(() => localizationKey("Write\u0004tool.write.action\u0004extra", "쓰기", {})).toThrow("Invalid");
	});
});
