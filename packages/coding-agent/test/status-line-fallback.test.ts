/**
 * The model segment's retry-fallback marker: shown while a retry fallback
 * serves as the displayed model, never for the configured model or a model
 * the session switched to before its first answer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { effectiveStatusSettings, segmentView } from "@oh-my-pi/pi-coding-agent/ui/status/segments";
import { disposeStatusLines, segmentText, statusFacts, statusLine, statusSession } from "./helpers/session-status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
});

const opus = getBundledModel("anthropic", "claude-opus-4-5");

function servingFallback(model: Model, serving: { selector: string; isFallback: boolean } | undefined) {
	const line = statusLine(
		statusSession({
			model,
			state: { messages: [], model, thinkingLevel: "high" },
			servingModel: serving,
		}),
	);
	return line.facts().servingFallback === true;
}

describe("status line model segment retry fallback", () => {
	it("marks the displayed model while it serves as a retry fallback", () => {
		expect(servingFallback(opus, { selector: "anthropic/claude-opus-4-5:high", isFallback: true })).toBe(true);
	});

	it("adds no marker while the configured model serves", () => {
		expect(servingFallback(opus, { selector: "anthropic/claude-opus-4-5:high", isFallback: false })).toBe(false);
		expect(servingFallback(opus, undefined)).toBe(false);
	});

	it("drops the marker once the displayed model is no longer the serving fallback", () => {
		// Attribution moves only when a model settles a turn: after `/model` or a primary
		// restore it still names the fallback while the session model is already the new one.
		expect(servingFallback(opus, { selector: "openai/gpt-4o-mini:high", isFallback: true })).toBe(false);
	});

	it("matches a pinned aggregator fallback with its upstream", () => {
		const bundled = getBundledModel<"openai-completions">("openrouter", "z-ai/glm-4.7");
		const routed: Model<"openai-completions"> = {
			...bundled,
			compat: { ...bundled.compat, openRouterRouting: { only: ["cerebras"] } },
		};
		expect(servingFallback(routed, { selector: "openrouter/z-ai/glm-4.7@cerebras:high", isFallback: true })).toBe(
			true,
		);
		expect(servingFallback(routed, { selector: "openrouter/z-ai/glm-4.7@sambanova:high", isFallback: true })).toBe(
			false,
		);
	});

	it("matches a fallback whose model id ends in a thinking-level word", () => {
		// A non-reasoning model gets no thinking suffix, so the selector is the bare id.
		const phi: Model = { ...opus, provider: "ollama", id: "phi3:medium", name: "phi3:medium" };
		expect(servingFallback(phi, { selector: "ollama/phi3:medium", isFallback: true })).toBe(true);
		expect(servingFallback(phi, { selector: "ollama/phi3:medium:high", isFallback: true })).toBe(true);
		expect(servingFallback(phi, { selector: "ollama/phi3", isFallback: true })).toBe(false);
	});

	it("renders a warning-colored marker after the model name", () => {
		const model = { id: "claude-opus-4-5", name: "Claude Opus 4.5", thinking: true };
		const custom = effectiveStatusSettings({ preset: "custom" });
		const facts = statusFacts({ model, thinkingLevel: "high", servingFallback: true });
		expect(segmentText("model", facts)).toContain("Opus 4.5");
		expect(segmentText("model", facts)).toEndWith("fallback");
		const view = segmentView("model", facts, custom);
		expect(view?.spans.at(-1)).toMatchObject({ s: "warning" });
		expect(view?.spans.at(-1)?.t).toEndWith("fallback");
		expect(view?.tone).toBe("warning");
		const plain = segmentView("model", statusFacts({ model, thinkingLevel: "high" }), custom);
		expect(plain?.spans.map(s => s.t).join("")).not.toContain("fallback");
		expect(plain?.tone).toBeUndefined();
	});
});
