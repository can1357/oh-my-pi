import { afterEach, describe, expect, it } from "bun:test";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initThemeSync, setTheme } from "@oh-my-pi/pi-tui/theme";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TspHarness } from "./tsp-harness";

class Described implements Component {
	constructor(readonly current: NativeNode) {}
	render(): readonly string[] {
		return [];
	}
	describe(): NativeNode {
		return this.current;
	}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
	// Back to the default auto dark/light theme for later tests.
	initThemeSync();
});

describe("native theme palette", () => {
	it("sends both auto variants, resolved to hex, after open and before the first frame", async () => {
		initThemeSync();
		harness = await TspHarness.start(tui => tui.addChild(new Described(node("text", { text: "hi" }))));
		const verbs = harness.terminal.log.map(message => message.verb);
		expect(verbs.slice(0, 3)).toEqual(["o", "t", "f"]);

		const [palette] = harness.terminal.palettes;
		expect(palette?.sf).toBe(harness.terminal.surface ?? "");
		expect(palette?.name).toEqual({ dark: "dark", light: "light" });
		for (const variant of ["dark", "light"] as const) {
			const expected = loadThemeSync(variant);
			const colors = palette?.[variant];
			expect(colors?.accent).toBe(expected.getColorHex("accent"));
			expect(colors?.userMessageBg).toBe(expected.getBgHex("userMessageBg"));
			expect(colors?.syntaxKeyword).toBe(expected.getColorHex("syntaxKeyword"));
			for (const key in colors) expect(colors[key]).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it("resends the palette on a theme switch without re-adding any node", async () => {
		initThemeSync();
		harness = await TspHarness.start(tui => tui.addChild(new Described(node("text", { text: "hi" }))));
		const h = harness;
		const frames = h.frames.length;

		await setTheme("light");
		h.flush();
		expect(h.terminal.palettes).toHaveLength(2);
		expect(h.terminal.palettes[1]?.name).toEqual({ light: "light" });
		expect(h.terminal.palettes[1]?.dark).toBeUndefined();
		expect(h.frames.slice(frames).flatMap(frame => frame.ops.filter(op => op[0] === "add"))).toEqual([]);
		expect(h.region("main")?.c?.map(child => child.k)).toEqual(["text"]);
	});
});
