/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * What Tern is sent of the status line outside the composer facts: the settings screen's live
 * preview bar, and the glyphs the model chip embeds (the active preset's, so a Nerd Font run can
 * travel as an `icon` span).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot, isUiNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { composerFacts, StatusBarPreview } from "../../../src/ui/status/composer-facts";
import type { StatusFacts } from "../../../src/ui/status/facts";
import { effectiveStatusSettings, segmentView } from "../../../src/ui/status/segments";
import { corpusStatusFacts } from "./fixture";

/** The preview's root node for `facts` under the default preset. */
function preview(facts: StatusFacts): { root: UiNode; dispose(): void } {
	return createRoot(dispose => {
		const view = StatusBarPreview({ settings: () => ({ preset: "default" }), facts: signal(facts) });
		const built = typeof view === "function" ? (view as () => unknown)() : view;
		if (!isUiNode(built)) throw new Error("the preview must build one node");
		return { root: built, dispose };
	});
}

describe("status bar preview for Tern", () => {
	test("is the bare bar: pinned segments outlast the rest, the path shrinks first, clicks are advertised", () => {
		const { root, dispose } = preview(corpusStatusFacts());
		try {
			expect(root.kind).toBe("status");
			expect((root.props() as { role?: string }).role).toBe("omp.status");
			const segs = new Map(root.children().map(seg => [seg.key(), seg.props() as Record<string, unknown>]));
			const priority = (key: string): number => {
				const value = segs.get(key)?.priority;
				if (typeof value !== "number") throw new Error(`segment ${key} has no priority`);
				return value;
			};
			expect(segs.get("pi")).toMatchObject({ side: "left" });
			expect(segs.get("pi")?.actions).toBeUndefined();
			expect(segs.get("model")).toMatchObject({ actions: { click: "status.model" } });
			expect(segs.get("path")).toMatchObject({ min: { w: "12ch" }, actions: { click: "status.path" } });
			expect(segs.get("context_pct")).toMatchObject({ actions: { click: "status.context" } });
			// Pinned segments outlast every unpinned one.
			expect(priority("model")).toBeGreaterThan(priority("pi"));
			expect(priority("context_pct")).toBeGreaterThan(priority("pi"));
			expect(priority("pi")).toBeGreaterThan(priority("path"));
		} finally {
			dispose();
		}
	});

	test("puts extension statuses under the bar in the panel column", () => {
		const { root, dispose } = preview({ ...corpusStatusFacts(), hooks: ["lint ok"] });
		try {
			expect(root.kind).toBe("col");
			expect((root.props() as { role?: string }).role).toBe("omp.status.panel");
			const [bar, hook] = root.children();
			expect(bar?.kind).toBe("status");
			expect(hook?.props()).toMatchObject({ role: "omp.status.hook", text: "lint ok" });
		} finally {
			dispose();
		}
	});
});

describe("structured native extension statuses", () => {
	test("keeps the role and styled spans in composer extras without duplicating the configured status segment", () => {
		createRoot(dispose => {
			try {
				const spans = [{ t: "NORMAL", s: "strong accent" }, { t: " 1/3", s: "mono" }];
				const facts = signal<StatusFacts>({ ...corpusStatusFacts(), hooks: ["tests passing", "NORMAL 1/3"], hookStyles: [undefined, { role: "extension.navigation", spans }] });
				const { extras } = composerFacts({ settings: () => ({ preset: "custom", leftSegments: ["status"], rightSegments: [], showHookStatus: false }), facts, click: () => undefined });
				if (!isUiNode(extras)) throw new Error("Expected composer extras");
				const children = extras.children();
				expect(children).toHaveLength(2);
				const plain = children[0]!.props();
				expect("spans" in plain && plain.spans).toEqual(segmentView("status", { ...facts(), hooks: ["tests passing"] }, effectiveStatusSettings({ preset: "custom", leftSegments: ["status"], rightSegments: [] }))?.spans);
				expect(children[1]?.props()).toMatchObject({ role: "extension.navigation", spans });
				facts.set({ ...facts(), hooks: ["tests passing"], hookStyles: [undefined] });
				expect(extras.children()).toHaveLength(1);
			} finally {
				dispose();
			}
		});
	});

	test("preserves native styling in the status preview while plain statuses stay plain", () => {
		const spans = [{ t: "NORMAL", s: "strong accent" }, { t: " 1/3", s: "mono" }];
		const { root, dispose } = preview({ ...corpusStatusFacts(), hooks: ["tests passing", "NORMAL 1/3"], hookStyles: [undefined, { role: "extension.navigation", spans }] });
		try {
			expect(root.children()[1]?.props()).toMatchObject({ role: "omp.status.hook", text: "tests passing" });
			expect(root.children()[2]?.props()).toMatchObject({ role: "extension.navigation", spans });
		} finally {
			dispose();
		}
	});
});

describe("model chip glyphs", () => {
	const settings = effectiveStatusSettings({ preset: "default" });
	const facts: StatusFacts = { ...corpusStatusFacts(), advisor: { status: "idle", yielded: true } };
	let restoreTheme: () => void;
	beforeEach(() => {
		const theme = currentTheme();
		restoreTheme = () => setCurrentTheme(theme);
	});
	afterEach(() => restoreTheme());

	test("the advisor badge is the active preset's glyph", () => {
		for (const preset of ["nerd", "unicode"] as const) {
			setCurrentTheme(loadThemeSync("dark", { symbolPreset: preset }));
			const badge = segmentView("model", facts, settings)?.spans.find(span => span.s === "dim");
			expect(badge?.t).toBe(` ${presetSymbols(preset)["icon.advisorClosed"]}`);
		}
	});
});
