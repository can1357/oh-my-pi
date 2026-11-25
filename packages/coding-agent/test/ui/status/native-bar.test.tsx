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
import { StatusBarPreview } from "../../../src/ui/status/composer-facts";
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
			expect(segs.get("pi")).toMatchObject({ side: "left", priority: 11 });
			expect(segs.get("pi")?.actions).toBeUndefined();
			expect(segs.get("model")).toMatchObject({ priority: 1009, actions: { click: "status.model" } });
			expect(segs.get("path")).toMatchObject({ priority: 5, min: { w: "12ch" }, actions: { click: "status.path" } });
			expect(segs.get("context_pct")).toMatchObject({ priority: 1002, actions: { click: "status.context" } });
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
