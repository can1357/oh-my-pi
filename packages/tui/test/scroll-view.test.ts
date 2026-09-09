import { describe, expect, it } from "bun:test";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import { Ellipsis, visibleWidth } from "@oh-my-pi/pi-tui/utils";

const theme = {
	track: () => "T",
	thumb: () => "B",
};

describe("ScrollView", () => {
	it("renders a fixed-height viewport and omits auto scrollbar when content fits", () => {
		const view = new ScrollView(["one", "two"], { height: 3, theme });

		expect(view.render(10)).toEqual(["one", "two", ""]);
	});

	it("renders a right-edge scrollbar when content overflows", () => {
		const view = new ScrollView(["alpha", "beta", "gamma", "delta", "omega"], { height: 3, theme });

		expect(view.render(6)).toEqual(["alphaB", "beta T", "gammaT"]);
	});

	it("scrolls and clamps offsets", () => {
		const view = new ScrollView(["one", "two", "three", "four", "five"], { height: 3, theme });

		view.scroll(10);

		expect(view.getScrollOffset()).toBe(2);
		expect(view.render(6)).toEqual(["threeT", "four T", "five B"]);

		view.scroll(-10);

		expect(view.getScrollOffset()).toBe(0);
	});

	it("reserves a scrollbar column in always mode", () => {
		const view = new ScrollView(["one"], { height: 2, scrollbar: "always", theme });

		expect(view.render(5)).toEqual(["one B", "    B"]);
	});

	it("does not reserve a scrollbar column in never mode", () => {
		const view = new ScrollView(["alpha", "beta", "gamma"], { height: 2, scrollbar: "never", theme });

		expect(view.render(6)).toEqual(["alpha", "beta"]);
	});

	it("renders scrollbar geometry for pre-windowed lines", () => {
		const view = new ScrollView(["gamma", "delta"], { height: 2, totalRows: 4, theme });
		view.setScrollOffset(2);

		expect(view.render(6)).toEqual(["gammaT", "deltaB"]);
	});

	it("does not render a scrollbar when width is zero", () => {
		const view = new ScrollView(["one", "two"], { height: 1, theme });

		expect(view.render(0)).toEqual([""]);
	});

	it("clamps scroll offset when content shrinks", () => {
		const view = new ScrollView(["one", "two", "three", "four"], { height: 2, theme });
		view.scrollToBottom();

		view.setLines(["one"]);

		expect(view.getScrollOffset()).toBe(0);
		expect(view.render(10)).toEqual(["one", ""]);
	});

	it("keeps rendered rows within requested width with ANSI input", () => {
		const view = new ScrollView(["\x1b[31malphabet\x1b[0m", "plain", "tail"], { height: 2, theme });
		const rendered = view.render(5);

		expect(rendered).toHaveLength(2);
		expect(rendered.every(line => visibleWidth(line) <= 5)).toBe(true);
		expect(rendered[0]).toContain("B");
	});

	it("appends an overflow ellipsis by default and omits it when configured", () => {
		const long = ["abcdefghij"];
		const def = new ScrollView(long, { height: 1, scrollbar: "never", theme });
		expect(def.render(5)[0]).toContain("…");

		const omit = new ScrollView(long, { height: 1, scrollbar: "never", ellipsis: Ellipsis.Omit, theme });
		expect(omit.render(5)[0]).toBe("abcde");
	});

	it("handles navigation keys, with Shift+Arrow scrolling by fastScrollLines", () => {
		const view = new ScrollView(
			Array.from({ length: 50 }, (_, i) => String(i)),
			{ height: 5, fastScrollLines: 7, theme },
		);

		expect(view.handleScrollKey("\x1b[B")).toBe(true); // down
		expect(view.getScrollOffset()).toBe(1);
		expect(view.handleScrollKey("\x1b[1;2B")).toBe(true); // shift+down
		expect(view.getScrollOffset()).toBe(8);
		expect(view.handleScrollKey("\x1b[1;2A")).toBe(true); // shift+up
		expect(view.getScrollOffset()).toBe(1);
		expect(view.handleScrollKey("x")).toBe(false);
	});
});
