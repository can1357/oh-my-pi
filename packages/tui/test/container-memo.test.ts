import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Box, type Component, Container, Text } from "@oh-my-pi/pi-tui";
import {
	publishLineWidths,
	resetHangulCompatibilityJamoWidthForTests,
	setHangulCompatibilityJamoWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui/utils";

/**
 * Leaf component that returns a stable cached array and counts render calls.
 * Used to prove the memo skips rebuilding the concatenation, not the child
 * renders themselves (renders carry side effects per the Component contract).
 */
class Probe implements Component {
	renderCount = 0;
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	setLines(lines: string[]): void {
		this.#lines = lines;
	}

	render(_width: number): readonly string[] {
		this.renderCount++;
		return this.#lines;
	}
}

class MutablePublishedProbe implements Component {
	readonly lines = ["hi"];

	constructor() {
		publishLineWidths(this.lines, [2]);
	}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class MutableProbe implements Component {
	readonly lines = ["hi"];

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

afterEach(() => {
	resetHangulCompatibilityJamoWidthForTests();
});

function plain(lines: readonly string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line).trimEnd());
}

describe("Container render memoization", () => {
	it("returns the identical reference across renders while children are ref-stable", () => {
		const container = new Container();
		container.addChild(new Text("alpha", 0, 0));
		container.addChild(new Text("beta", 0, 0));

		const first = container.render(40);
		expect(plain(first)).toEqual(["alpha", "beta"]);
		expect(container.render(40)).toBe(first);
		expect(container.render(40)).toBe(first);
	});

	it("returns a new reference with updated rows after a child setText", () => {
		const container = new Container();
		const text = new Text("before", 0, 0);
		container.addChild(text);

		const before = container.render(40);
		text.setText("after");
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual(["after"]);
		// Stable again at the new content.
		expect(container.render(40)).toBe(after);
	});

	it("drops the memo on addChild", () => {
		const container = new Container();
		container.addChild(new Text("first", 0, 0));
		const before = container.render(40);

		container.addChild(new Text("second", 0, 0));
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual(["first", "second"]);
	});

	it("drops the memo on removeChild", () => {
		const container = new Container();
		const keep = new Text("keep", 0, 0);
		const drop = new Text("drop", 0, 0);
		container.addChild(keep);
		container.addChild(drop);
		const before = container.render(40);

		container.removeChild(drop);
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual(["keep"]);
	});

	it("drops the memo on clear", () => {
		const container = new Container();
		container.addChild(new Text("gone", 0, 0));
		const before = container.render(40);

		container.clear();
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(after.length).toBe(0);
	});

	it("drops the memo on invalidate even when content is unchanged", () => {
		const container = new Container();
		container.addChild(new Text("same", 0, 0));
		const before = container.render(40);

		container.invalidate();
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual(plain(before));
	});

	it("still renders every child on every call when the memo hits", () => {
		const container = new Container();
		const a = new Probe(["probe-a"]);
		const b = new Probe(["probe-b"]);
		container.addChild(a);
		container.addChild(b);

		const first = container.render(40);
		const second = container.render(40);
		const third = container.render(40);

		// Memo hit: identical reference…
		expect(second).toBe(first);
		expect(third).toBe(first);
		// …but children were rendered each frame regardless.
		expect(a.renderCount).toBe(3);
		expect(b.renderCount).toBe(3);
	});

	it("misses the memo on width change", () => {
		const container = new Container();
		container.addChild(new Probe(["constant-row"]));

		const narrow = container.render(40);
		const wide = container.render(60);
		expect(wide).not.toBe(narrow);
		// Stable at the new width.
		expect(container.render(60)).toBe(wide);
	});
});

describe("Box render memoization", () => {
	it("returns the identical reference across renders at a fixed width", () => {
		const box = new Box(1, 1);
		box.addChild(new Text("content", 0, 0));

		const first = box.render(40);
		expect(plain(first)).toEqual(["", " content", ""]);
		expect(box.render(40)).toBe(first);
	});

	it("returns a new reference with updated rows after a child change", () => {
		const box = new Box(1, 0);
		const text = new Text("old", 0, 0);
		box.addChild(text);

		const before = box.render(40);
		text.setText("new");
		const after = box.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual([" new"]);
		expect(box.render(40)).toBe(after);
	});

	it("misses the cache when the bgFn output changes without the function reference changing", () => {
		let tag = "A";
		const box = new Box(0, 0, text => `<${tag}>${text}</${tag}>`);
		box.addChild(new Probe(["row"]));

		const first = box.render(10);
		expect(first[0]).toBe("<A>row       </A>");
		// Same closure state → cache hit.
		expect(box.render(10)).toBe(first);

		// Mutate the closure: same function reference, different output. The
		// bg sample in the cache key must force a rebuild.
		tag = "B";
		const second = box.render(10);
		expect(second).not.toBe(first);
		expect(second[0]).toBe("<B>row       </B>");
	});
});

describe("width configuration cache invalidation", () => {
	const jamo = "\u3131\u314f";

	it("rerenders the same Text after a narrow-to-wide Hangul change", () => {
		const text = new Text(jamo, 0, 0);
		setHangulCompatibilityJamoWidth(1);
		const narrow = text.render(6);
		expect(narrow).toEqual([`${jamo}${" ".repeat(4)}`]);

		setHangulCompatibilityJamoWidth(2);
		const wide = text.render(6);
		expect(wide).not.toBe(narrow);
		expect(wide).toEqual([`${jamo}${" ".repeat(2)}`]);
	});

	it("rerenders a nested Box after a narrow-to-wide Hangul change", () => {
		const box = new Box(1, 0);
		box.setIgnoreTight(true);
		box.addChild(new Text(jamo, 0, 0));
		setHangulCompatibilityJamoWidth(1);
		const narrow = box.render(8);

		setHangulCompatibilityJamoWidth(2);
		const wide = box.render(8);
		expect(wide).not.toBe(narrow);
		expect(wide).not.toEqual(narrow);
		expect(wide.every(line => visibleWidth(line) === 8)).toBe(true);
	});

	it("keys the Box cache by width epoch even for ref-stable child rows", () => {
		const box = new Box(1, 0);
		box.setIgnoreTight(true);
		box.addChild(new Probe([jamo]));
		setHangulCompatibilityJamoWidth(1);
		const narrow = box.render(8);

		setHangulCompatibilityJamoWidth(2);
		const wide = box.render(8);
		expect(wide).not.toBe(narrow);
		expect(wide).not.toEqual(narrow);
		expect(wide.every(line => visibleWidth(line) === 8)).toBe(true);
	});
});

describe("Box carried-width proof", () => {
	it("rebuilds after a published child mutates its same array", () => {
		const child = new MutablePublishedProbe();
		const box = new Box(1, 0);
		box.setIgnoreTight(true);
		box.addChild(child);
		const before = box.render(8);

		child.lines[0] = "hello";
		const after = box.render(8);
		expect(after).not.toBe(before);
		expect(plain(after)).toEqual([" hello"]);
		expect(after.every(line => visibleWidth(line) === 8)).toBe(true);
	});

	it("rebuilds after an unpublished child mutates its same array", () => {
		const child = new MutableProbe();
		const box = new Box(1, 0);
		box.setIgnoreTight(true);
		box.addChild(child);
		const before = box.render(8);

		child.lines[0] = "hello";
		const after = box.render(8);
		expect(after).not.toBe(before);
		expect(plain(after)).toEqual([" hello"]);
		expect(after.every(line => visibleWidth(line) === 8)).toBe(true);
	});

	it("falls back for direct context-sensitive leading marks", () => {
		for (const line of ["\u200d\ufe0f", "\ufe0f\ufe0f", "\u20e3", "\u0301", "\u093f\u20e3", "\u0e33\ufe0f"]) {
			const lines = [line];
			publishLineWidths(lines, [visibleWidth(line)]);
			const box = new Box(1, 0);
			box.setIgnoreTight(true);
			box.addChild(new Probe(lines));

			const result = box.render(4);
			expect(result.every(row => visibleWidth(row) === 4)).toBe(true);
		}
	});

	it("falls back for SGR-hidden leading joiners and variation selectors", () => {
		const line = "\x1b[31m\u200d\ufe0f\x1b[0m";
		const lines = [line];
		publishLineWidths(lines, [visibleWidth(line)]);
		const box = new Box(1, 0);
		box.setIgnoreTight(true);
		box.addChild(new Probe(lines));

		const result = box.render(4);
		expect(result.every(row => visibleWidth(row) === 4)).toBe(true);
	});

	it("pads hard-class rows to full width from carried widths at zero paddingX", () => {
		// Hard classes whose width is context-sensitive: leading Mn mark, Mc
		// spacing mark, keycap, ZWJ, variation selector, Thai/Lao AM.
		const lines = [
			"\u0301a", // leading Mn combining mark
			"\u093f", // bare Mc spacing mark U+093F
			"1\u20e3", // keycap base + U+20E3
			"\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", // ZWJ emoji sequence
			"a\u200db", // bare ZWJ between letters
			"\u2764\ufe0f", // heart + variation selector U+FE0F
			"\u0e33\ufe0f", // Thai U+0E33 + variation selector
			"\u0eb3", // Lao U+0EB3
		];
		// Publish exact per-line widths the way a real Text render does; at
		// paddingX === 0 the Box must trust them (no remeasure) and still pad
		// every row to the full render width.
		publishLineWidths(
			lines,
			lines.map(line => visibleWidth(line)),
		);
		const box = new Box(0, 0);
		box.addChild(new Probe(lines));

		const result = box.render(8);
		expect(result.length).toBe(lines.length);
		expect(result.every(row => visibleWidth(row) === 8)).toBe(true);
	});
});
