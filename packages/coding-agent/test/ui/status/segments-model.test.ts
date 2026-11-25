/**
 * The status line's `model` segment display options: the provider prefix and the
 * `name`/`id`/`full` display modes.
 */
import { describe, expect, it } from "bun:test";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { StatusLineSegmentOptions, StatusLineSettings } from "../../../src/modes/view-model/status-line/types";
import type { StatusFacts } from "../../../src/ui/status/facts";
import { effectiveStatusSettings, segmentView } from "../../../src/ui/status/segments";
import { createStatusLine } from "../../../src/ui/status/status-line";
import "../../../src/ui/styles/status";
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

	it("keeps a model id with newlines and tabs on one row", () => {
		const dirty: StatusFacts = {
			...opus,
			model: { id: "claude\nopus\t4-8", name: "Claude Opus 4.8", provider: "anthropic", thinking: false },
		};
		const options = { display: "id", showProvider: true } as const;
		expect(text(dirty, options)).toBe("anthropic/claude opus 4-8");
		const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
		const settings: StatusLineSettings = {
			preset: "custom",
			leftSegments: ["model"],
			rightSegments: [],
			segmentOptions: { model: { ...options, showThinkingLevel: false } },
		};
		createRoot(dispose => {
			try {
				const { preview } = createStatusLine({
					settings: signal(settings),
					facts: () => dirty,
					placement: () => ({ bar: "full", gap: false, autocomplete: false }),
				});
				const rows = paintNode(env, preview(undefined), 80).rows.map(row => Bun.stripANSI(row).trim());
				expect(rows).toHaveLength(1);
				expect(rows[0]).toEndWith("anthropic/claude opus 4-8");
			} finally {
				dispose();
			}
		});
	});
});
