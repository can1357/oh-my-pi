/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { actionHint, keyCaps } from "@oh-my-pi/pi-tui/term/painters/picker";
import { createRoot, isUiNode } from "../../src";
import { paintNode, staticEnvironment } from "../../src/term/paint";
import { loadThemeSync } from "../../src/theme/loader";

test("picker footer preserves alternative keys and keeps modifier chords together", () => {
	const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
	const { node, dispose } = createRoot(dispose => {
		const node = (
			<picker
				title="Choose model"
				items={[{ id: "a", label: "A" }]}
				actions={[
					{ id: "choose", label: "Choose", keys: ["left", "right"] },
					{ id: "open", label: "Open", keys: ["alt", "enter"] },
					{ id: "move", label: "Move", keys: ["ctrl+up", "ctrl+down"] },
				]}
			/>
		);
		if (!isUiNode(node)) throw new Error("expected one node");
		return { node, dispose };
	});
	try {
		const { rows } = paintNode(staticEnvironment(theme), node, 100, 20);
		expect(Bun.stripANSI(rows.join("\n"))).toContain("Left/Right choose · Alt+Enter open · Ctrl+Up/Ctrl+Down move");
	} finally {
		dispose();
	}
});

test("legacy picker helpers keep compact Unicode keycaps and ignore extra JS arguments", () => {
	expect(keyCaps(["ctrl", "p"])).toBe("⌃P");
	const actions = [{ id: "choose", label: "Choose", keys: ["left", "right"] }];
	expect(actionHint(actions)).toBe("←→ choose");
	expect(Reflect.apply(keyCaps, undefined, [["ctrl", "p"], {}])).toBe("⌃P");
	expect(Reflect.apply(actionHint, undefined, [actions, {}])).toBe("←→ choose");
});
