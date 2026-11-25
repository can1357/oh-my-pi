/**
 * The status line's `model` segment display options: the provider prefix and the
 * `name`/`id`/`full` display modes.
 */
import { describe, expect, it } from "bun:test";
import type { StatusLineSegmentOptions } from "../../../src/modes/view-model/status-line/types";
import type { StatusFacts } from "../../../src/ui/status/facts";
import { effectiveStatusSettings, segmentView } from "../../../src/ui/status/segments";
import { corpusStatusFacts } from "./fixture";

function text(facts: StatusFacts, model?: StatusLineSegmentOptions["model"]): string | undefined {
	const settings = effectiveStatusSettings({
		preset: "custom",
		sessionAccent: false,
		segmentOptions: { model: { showThinkingLevel: false, ...model } },
	});
	return segmentView("model", facts, settings)
		?.spans.map(part => part.t)
		.join("");
}

const opus: StatusFacts = {
	...corpusStatusFacts(),
	model: { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", thinking: true },
};

const gateway: StatusFacts = {
	...corpusStatusFacts(),
	model: { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", provider: "openrouter", thinking: false },
};

describe("status line model segment", () => {
	it("shows the display name without the Claude prefix by default", () => {
		expect(text(opus)).toBe("Opus 4.8");
	});

	it("prefixes the provider when showProvider is on", () => {
		expect(text(opus, { showProvider: true })).toBe("anthropic/Opus 4.8");
	});

	it("shows the exact model id under display id", () => {
		expect(text(opus, { display: "id" })).toBe("claude-opus-4-8");
		expect(text(gateway, { display: "id", showProvider: true })).toBe("openrouter/google/gemini-3.7-flash");
	});

	it("shows the id and the display name under display full", () => {
		expect(text(gateway, { display: "full" })).toBe("google/gemini-3.7-flash (Gemini 3.7 Flash)");
		const unnamed: StatusFacts = { ...gateway, model: { id: "glm-5", name: "glm-5", thinking: false } };
		expect(text(unnamed, { display: "full" })).toBe("glm-5");
	});

	it("leaves the name bare when the model has no provider", () => {
		const bare: StatusFacts = { ...opus, model: { id: "claude-opus-4-8", name: "Claude Opus 4.8", thinking: true } };
		expect(text(bare, { showProvider: true })).toBe("Opus 4.8");
	});
});
