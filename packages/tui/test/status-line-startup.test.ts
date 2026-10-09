import { beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { createStartupStatusLine } from "../src/status-line/startup";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

describe("status line startup layout", () => {
	it("reserves the cached live compact-context width without displaying stale usage", () => {
		const model = {
			id: "startup-model",
			name: "Model",
			provider: "test",
			api: "test",
			contextWindow: 100_000,
		} as Model;
		const line = createStartupStatusLine({
			settings: {
				preset: "custom",
				leftSegments: ["model", "context_pct"],
				rightSegments: [],
				separator: "pipe",
				contextLine: "embedded",
				segmentOptions: { context_pct: { compact: true } },
			},
			gitEnabled: false,
			model,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			contextPercent: 9.1,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const narrow = Bun.stripANSI(line.getTopBorder(14).content);
			expect(narrow).toContain("ctx:?");
			expect(narrow).not.toContain("Model");
			expect(Bun.stripANSI(line.getTopBorder(17).content)).toContain("Model");
		} finally {
			line.dispose();
		}
	});

	it("reserves cached compact width for a standalone startup segment", () => {
		const model = {
			id: "startup-model",
			name: "Model",
			provider: "test",
			api: "test",
			contextWindow: 100_000,
		} as Model;
		const line = createStartupStatusLine({
			settings: {
				preset: "custom",
				leftSegments: ["model", "context_pct"],
				rightSegments: [],
				separator: "none",
				contextLine: "off",
				segmentOptions: { context_pct: { compact: true } },
			},
			gitEnabled: false,
			model,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			contextPercent: 9.1,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const narrow = Bun.stripANSI(line.getTopBorder(11).content);
			// The live `ctx:9.1%` frame cannot share this width with the model, so
			// the startup placeholder must make the same choice instead of flashing.
			expect(narrow).not.toContain("ctx:?");
			expect(narrow).toContain("Model");
		} finally {
			line.dispose();
		}
	});

	it("paints the cached compact width so the opposite startup group stays aligned", () => {
		const model = {
			id: "startup-model",
			name: "Model",
			provider: "test",
			api: "test",
			contextWindow: 100_000,
		} as Model;
		const line = createStartupStatusLine({
			settings: {
				preset: "custom",
				leftSegments: ["context_pct"],
				rightSegments: ["model"],
				separator: "none",
				contextLine: "off",
				segmentOptions: { context_pct: { compact: true }, model: { showThinkingLevel: false } },
			},
			gitEnabled: false,
			model,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			contextPercent: 9.1,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const rendered = Bun.stripANSI(line.getTopBorder(24).content);
			expect(rendered).toMatch(/ctx:\? {3,}.*Model/);
			expect(rendered.endsWith("Model ")).toBeTrue();
		} finally {
			line.dispose();
		}
	});

	it("reserves cached token-breakdown width while masking stale startup values", () => {
		const model = {
			id: "startup-model",
			name: "Model",
			provider: "test",
			api: "test",
			contextWindow: 100_000,
		} as Model;
		const line = createStartupStatusLine({
			settings: {
				preset: "custom",
				leftSegments: ["model"],
				rightSegments: ["token_total"],
				separator: "none",
				contextLine: "off",
				segmentOptions: {
					model: { showThinkingLevel: false },
					token_total: { breakdown: true },
				},
			},
			gitEnabled: false,
			model,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			tokenBreakdown: {
				input: 25_000,
				output: 5,
				cacheWrite: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
			},
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const boundary = Bun.stripANSI(line.getTopBorder(24).content);
			expect(boundary).toContain("Model");
			expect(boundary).toContain("in:…  ");
			expect(boundary).toContain("out:…");
			expect(boundary).not.toContain("25K");
			const belowBoundary = Bun.stripANSI(line.getTopBorder(23).content);
			expect(belowBoundary).toContain("Model");
			expect(belowBoundary).not.toContain("in:");
		} finally {
			line.dispose();
		}
	});
});
