/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The settings window's footer keycaps follow the theme's symbol preset:
 * the ascii preset spells keys out instead of drawing unicode keycaps.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRoot, isUiNode, type UiNode } from "../../src";
import { paintNode, staticEnvironment } from "../../src/term/paint";
import "../../src/term/painters/prefs";
import type { SymbolPreset } from "../../src/theme";
import { setKeyHintPlatform } from "../../src/theme/keys";
import { loadThemeSync } from "../../src/theme/loader";

afterEach(() => setKeyHintPlatform(undefined));

function footer(preset: SymbolPreset): string {
	const theme = loadThemeSync("dark", { symbolPreset: preset });
	const row = (id: string) => ({ id, label: id, control: { k: "switch" as const, on: true } });
	const { node, dispose } = createRoot(dispose => {
		const built = (
			<prefs
				title="Settings"
				page="a"
				pages={[
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				]}
				sections={[
					{ id: "s1", title: "S1", rows: [row("x")] },
					{ id: "s2", title: "S2", rows: [row("y")] },
				]}
			/>
		);
		if (!isUiNode(built)) throw new Error("expected one node");
		return { node: built as UiNode, dispose };
	});
	try {
		const rows = paintNode(staticEnvironment(theme), node, 120, 20).rows;
		return Bun.stripANSI(rows[rows.length - 2]!);
	} finally {
		dispose();
	}
}

describe("prefs footer", () => {
	test("spells keys out in the ascii preset", () => {
		setKeyHintPlatform("darwin");
		const hint = footer("ascii");
		expect(hint).toContain(
			"Enter/Space to change · Tab to jump sections · Left/Right to switch tabs · Type to search · Esc to close",
		);
	});

	test("draws unicode keycaps in the unicode preset", () => {
		setKeyHintPlatform("darwin");
		expect(footer("unicode")).toContain("⏎/␣ to change · ⇥ to jump sections · ←/→ to switch tabs");
	});
});
