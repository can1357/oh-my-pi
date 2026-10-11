import { beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { createStartupStatusLine } from "../src/status-line/startup";
import { initTheme, theme } from "../src/theme";

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

	it("reserves a representative live compact width for a fresh embedded gauge", () => {
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
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const narrow = Bun.stripANSI(line.getTopBorder(14).content);
			expect(narrow).toContain("ctx:?");
			expect(narrow).not.toContain("Model");
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

	it("reserves a representative live compact width for a fresh standalone segment", () => {
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
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const narrow = Bun.stripANSI(line.getTopBorder(11).content);
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

	it("keeps the auto-compact icon at its cached live column", () => {
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
			autoCompactEnabled: true,
			compactionBoundaries: null,
		});

		try {
			const rendered = Bun.stripANSI(line.getTopBorder(30).content);
			const placeholderStart = rendered.indexOf("ctx:?");
			expect(placeholderStart).toBeGreaterThanOrEqual(0);
			expect(rendered.indexOf(theme.icon.auto)).toBe(placeholderStart + "ctx:9.1% ".length);
		} finally {
			line.dispose();
		}
	});

	it("uses cached overflow placement while masking the startup percentage", () => {
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
				rightSegments: ["context_total"],
				separator: "none",
				contextLine: "embedded",
				segmentOptions: { context_pct: { compact: true } },
			},
			gitEnabled: false,
			model,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			contextPercent: 120,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const rendered = Bun.stripANSI(line.getTopBorder(30).content);
			expect(rendered).toContain("ctx:?");
			expect(rendered).not.toContain("120%");
			expect(rendered.indexOf("100K")).toBeLessThan(rendered.indexOf("ctx:?"));
		} finally {
			line.dispose();
		}
	});

	it("places a masked compact label at its cached live percentage", () => {
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
				contextLine: "embedded",
				segmentOptions: { context_pct: { compact: true } },
			},
			gitEnabled: false,
			model,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			contextPercent: 50,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const rendered = Bun.stripANSI(line.getTopBorder(30).content);
			expect(rendered).toContain("ctx:?");
			expect(rendered.indexOf("ctx:?")).toBeGreaterThanOrEqual(12);
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
