import { describe, expect, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch } from "@oh-my-pi/pi-tui/fuzzy";

describe("fuzzyFilter", () => {
	it("does not satisfy long tokens by scattering letters across unrelated words", () => {
		const items = [
			{
				label: "Image Provider",
				text: "Image Provider providers.image openrouter Preferred provider for image generation",
			},
			{
				label: "Block Images",
				text: "Block Images images.blockImages false Prevent images from being sent to LLM providers",
			},
			{
				label: "Include Model in Prompt",
				text: "Include Model in Prompt includeModelInPrompt true Surface the active model identifier in the system prompt so the agent knows which model it is",
			},
			{
				label: "Service Tier",
				text: "Service Tier serviceTier openai-only Processing priority hint on supported providers",
			},
		];

		const results = fuzzyFilter(items, "image provider", item => item.text).map(item => item.label);

		expect(results[0]).toBe("Image Provider");
		expect(results).toContain("Block Images");
		expect(results).not.toContain("Include Model in Prompt");
		expect(results).not.toContain("Service Tier");
	});

	it("still supports short word-initial abbreviations", () => {
		const items = ["Ollama", "Kagi", "OpenCode Go", "Tavily"];

		expect(fuzzyFilter(items, "og", item => item)).toEqual(["OpenCode Go"]);
	});

	it("filters CJK queries instead of treating them as match-all", () => {
		const items = ["文件搜索", "搜索历史", "Settings"];

		expect(fuzzyFilter(items, "搜索", item => item)).toEqual(["搜索历史", "文件搜索"]);
		expect(fuzzyMatch("搜索", "Settings").matches).toBe(false);
	});
});
