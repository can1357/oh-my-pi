import { describe, expect, it } from "bun:test";
import { resolveMemoryCompletionInput } from "../src/mnemopi/backend";

describe("resolveMemoryCompletionInput", () => {
	it("passes the rendered extraction prompt through unchanged", () => {
		// core/extraction.ts's buildExtractionPrompt() already renders the
		// structured, kg-triple-requesting JSON template with the source text
		// embedded (and honors a MNEMOPI_EXTRACTION_PROMPT override), so the
		// completion input must carry that prompt verbatim. Substituting a
		// separate, unstructured system prompt here (the old behavior) made the
		// tiny-local-model and smol completion paths incapable of ever emitting
		// a `kg` triple.
		const rendered = 'Return JSON {"facts":[],"kg":[]}...\n\nUser message: Sam works at Globex.\n\nExtraction:';
		const request = resolveMemoryCompletionInput(rendered, {
			task: { kind: "memory-extraction", input: "Sam works at Globex." },
		});
		expect(request).toEqual({ prompt: rendered });
	});

	it("keeps the rendered prompt for tasks with no extraction kind", () => {
		// Consolidation reaches the same completion fn with no task, and must keep
		// the prompt Mnemopi rendered from consolidationPrompt.
		const rendered = "Summarize these memories faithfully.";
		expect(resolveMemoryCompletionInput(rendered)).toEqual({ prompt: rendered });
		expect(resolveMemoryCompletionInput(rendered, {})).toEqual({ prompt: rendered });
		expect(resolveMemoryCompletionInput(rendered, { maxTokens: 256 })).toEqual({ prompt: rendered });
	});
});
