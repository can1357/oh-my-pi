import { describe, expect, it } from "bun:test";
import { signal, type UiNode } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { Overlays } from "../../../src/ui/shell/overlays";

/** Overlays over a plain focus signal; focus falls back to `editor`, as the composer does. */
function stack() {
	const editor = jsx("col", {}) as UiNode;
	const focused = signal<UiNode | null>(editor);
	const overlays = new Overlays({ focused, focus: node => focused.set(node), fallback: () => editor });
	return { editor, focused, overlays };
}

describe("OverlayHandle.isFocused", () => {
	it("reports whether the overlay holds focus", () => {
		const { editor, focused, overlays } = stack();
		const handle = overlays.show(() => jsx("col", {}));
		expect(handle.isFocused()).toBe(true);

		focused.set(editor);
		expect(handle.isFocused()).toBe(false);

		focused.set(handle.node);
		expect(handle.isFocused()).toBe(true);
	});

	it("reports focus when a node the overlay owns holds focus", () => {
		const { editor, focused, overlays } = stack();
		const handle = overlays.show(() => jsx("col", { children: jsx("col", {}) }));
		const owned = handle.node.children()[0]!;

		focused.set(owned);
		expect(handle.isFocused()).toBe(true);

		focused.set(editor);
		expect(handle.isFocused()).toBe(false);
	});

	it("reports false once the overlay is closed, and gives focus back", () => {
		const { editor, focused, overlays } = stack();
		const handle = overlays.show(() => jsx("col", {}));

		handle.close();
		expect(handle.isFocused()).toBe(false);
		expect(focused()).toBe(editor);
	});
});
