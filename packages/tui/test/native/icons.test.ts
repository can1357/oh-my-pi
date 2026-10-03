import { afterEach, describe, expect, it } from "bun:test";
import { node, span } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId, Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getSymbolPresetOverride, initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
/** A Nerd Font glyph (Private Use Area) and one from the supplementary PUA plane. */
const GLYPH = "\uf4bc";
const WIDE_GLYPH = "\u{F0D57}";

class Described implements Component {
	constructor(readonly current: NativeNode) {}
	render(): readonly string[] {
		return [];
	}
	describe(): NativeNode {
		return this.current;
	}
}

/** The wire node a component's description becomes on its first frame. */
function sent(current: NativeNode): TspNode {
	const comp = new Described(current);
	const ops = new Reconciler("s:t").reconcile({ main: [comp], dock: [], layer: [] }, cx);
	const add = ops.find(op => op[0] === "add" && op[1] === nativeComponentId(comp));
	if (add?.[0] !== "add") throw new Error("component was not added");
	return add[4];
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

describe("native icon glyphs", () => {
	it("splits a padded glyph into its own icon span that keeps the colour token", () => {
		const wire = sent(node("seg", { spans: [span(`${GLYPH} Demo Model`, "statusLineModel")], side: "left" }));
		expect(wire.p).toEqual({
			spans: [
				{ t: GLYPH, s: "statusLineModel icon" },
				{ t: "Demo Model", s: "statusLineModel" },
			],
			side: "left",
		});
	});

	it("drops padding-only spans around glyphs and converts plain text labels, leaving other text untouched", () => {
		const wire = sent(
			node("item", {
				label: `${WIDE_GLYPH} Settings`,
				detail: [span("ctx "), span(GLYPH, "accent"), span(" ⟲ 12%", "muted")],
				value: "⟲ 3 ✓",
			}),
		);
		expect(wire.p).toEqual({
			label: [{ t: WIDE_GLYPH, s: "icon" }, { t: "Settings" }],
			detail: [{ t: "ctx" }, { t: GLYPH, s: "accent icon" }, { t: "⟲ 12%", s: "muted" }],
			value: "⟲ 3 ✓",
		});
	});

	it("normalizes glyphs inside table cells and tree labels", () => {
		const table = sent(
			node("table", {
				cols: [{ id: "a", head: `${GLYPH} Name` }],
				rows: [{ id: "r", cells: { a: [span(`${GLYPH} x`, "path")] } }],
			}),
		);
		expect(table.p).toEqual({
			cols: [{ id: "a", head: [{ t: GLYPH, s: "icon" }, { t: "Name" }] }],
			rows: [
				{
					id: "r",
					cells: {
						a: [
							{ t: GLYPH, s: "path icon" },
							{ t: "x", s: "path" },
						],
					},
				},
			],
		});
		const tree = sent(
			node("tree", { nodes: [{ id: "n", label: "root", children: [{ id: "c", label: `${GLYPH} leaf` }] }] }),
		);
		expect(tree.p).toEqual({
			nodes: [{ id: "n", label: "root", children: [{ id: "c", label: [{ t: GLYPH, s: "icon" }, { t: "leaf" }] }] }],
		});
	});

	it("uses the nerd symbol preset while a surface is live without touching the user's preset", async () => {
		initThemeSync("unicode");
		harness = await TspHarness.start(tui => tui.addChild(new Described(node("text", { text: "hi" }))));
		expect(TERMINAL.glyphProtocol).toBe(false);
		expect(theme.getSymbolPreset()).toBe("nerd");
		expect(getSymbolPresetOverride()).toBe("unicode");
		harness.stop();
		harness = undefined;
		expect(theme.getSymbolPreset()).toBe("unicode");
	});
});
