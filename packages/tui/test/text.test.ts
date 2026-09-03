import { describe, expect, it } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui/components/text";

describe("Text component", () => {
	it("reports whether setText changed the stored text", () => {
		const text = new Text("a");

		expect(text.setText("a")).toBe(false);
		expect(text.setText("b")).toBe(true);
		expect(text.getText()).toBe("b");
	});

	it("applies the style fn at render time, not construction time", () => {
		const text = new Text("hello", 0, 0).setStyleFn(t => `<c>${t}</c>`);
		expect(text.render(40).join("\n")).toContain("<c>hello</c>");
	});

	it("re-resolves the style fn after invalidate so a theme change re-shapes", () => {
		// The styler reads a mutable `color`, standing in for the active theme.
		// The coding-agent invalidates status components on `onThemeChange`, so a
		// lazily-styled Text must pick up the new color on the next render —
		// something a baked ANSI string can never do (issue #6337).
		let color = "RED";
		const text = new Text("hello", 0, 0).setStyleFn(t => `[${color}]${t}`);
		expect(text.render(40).join("\n")).toContain("[RED]hello");

		// Without invalidation the cached render is returned unchanged.
		color = "BLUE";
		expect(text.render(40).join("\n")).toContain("[RED]hello");

		text.invalidate();
		const out = text.render(40).join("\n");
		expect(out).toContain("[BLUE]hello");
		expect(out).not.toContain("[RED]hello");
	});
});
