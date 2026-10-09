import { describe, expect, it } from "bun:test";
import { resolveMemoryCompletionInput } from "../src/mnemopi/backend";
import memoryExtractionPrompt from "../src/prompts/system/memory-extraction-system.md" with { type: "text" };
import memoryExperienceExtractionPrompt from "../src/prompts/system/memory-experience-extraction-system.md" with { type: "text" };

describe("resolveMemoryCompletionInput", () => {
	it("splits an extraction call into instruction and input turns", () => {
		const rendered = "whatever Mnemopi rendered for the prompt slot";
		const request = resolveMemoryCompletionInput(rendered, {
			task: { kind: "memory-extraction", input: "Sam works at Globex." },
		});
		expect(request.systemPrompt).toBe(memoryExtractionPrompt);
		expect(request.prompt).toBe("Sam works at Globex.");
		// The rendered prompt is deliberately discarded: instructions belong in the
		// system turn and the user turn must carry only the text to extract from.
		expect(request.prompt).not.toContain("rendered");
	});

	it("uses the assistant-only system turn for experience extraction", () => {
		const request = resolveMemoryCompletionInput("rendered slot", {
			task: { kind: "memory-extraction", input: "[role: assistant]\nI fixed the parser.\n[assistant:end]", sourceKind: "experience" },
		});
		expect(request.systemPrompt).toBe(memoryExperienceExtractionPrompt);
		expect(request.systemPrompt).not.toBe(memoryExtractionPrompt);
		expect(request.prompt).toBe("[role: assistant]\nI fixed the parser.\n[assistant:end]");
	});

	it("keeps the rendered prompt and adds no system turn without an extraction task", () => {
		// Consolidation reaches the same completion fn with no task, so it must keep
		// the prompt Mnemopi rendered from consolidationPrompt.
		const rendered = "Summarize these memories faithfully.";
		expect(resolveMemoryCompletionInput(rendered)).toEqual({ prompt: rendered });
		expect(resolveMemoryCompletionInput(rendered, {})).toEqual({ prompt: rendered });
		expect(resolveMemoryCompletionInput(rendered, { maxTokens: 256 })).toEqual({ prompt: rendered });
	});
});
