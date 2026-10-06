import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	allocateImageId,
	compositeTuiLine,
	type Component,
	getCapabilities,
	HStack,
	ImageProtocol,
	isViewportTUI,
	setTerminalImageProtocol,
	TERMINAL,
	TUI,
	VIEWPORT_TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// The Pi names a Pi extension imports at runtime: one missing is an ESM link
// error, so the whole extension fails to load. These cover the surface omp
// serves from this package, including the places where Pi's layout semantics and
// this package's native API could silently diverge.

withoutTerminalMultiplexer();

const originalProtocol = TERMINAL.imageProtocol;
afterEach(() => {
	setTerminalImageProtocol(originalProtocol);
});

/** Read a branded value by its symbol key; the brand is a plain `symbol`. */
function branded(value: object): Record<PropertyKey, unknown> {
	return value as Record<PropertyKey, unknown>;
}

/** Rows with the trailing fill removed; leading cells are meaningful. */
function cells(lines: readonly string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""));
}

describe("compositeTuiLine", () => {
	it("keeps the row exactly as wide as the terminal", () => {
		const result = compositeTuiLine("abcdefghij", "XY", 3, 2, 10);
		expect(visibleWidth(result)).toBe(10);
		expect(stripVTControlCharacters(result)).toBe("abcXYfghij");
	});

	it("carries ANSI styling with the cells it styles rather than across the seam", () => {
		const base = "\x1b[31mabcdefghij\x1b[0m";
		const overlay = "\x1b[32mXY\x1b[0m";
		const result = compositeTuiLine(base, overlay, 3, 2, 10);
		expect(visibleWidth(result)).toBe(10);
		expect(stripVTControlCharacters(result)).toBe("abcXYfghij");
		// The base's own SGR survives on its cells, and a reset lands before the
		// overlay so the overlay's green cannot bleed left.
		expect(result.startsWith("\x1b[31mabc")).toBe(true);
		expect(result.indexOf("\x1b[32mXY")).toBeGreaterThan(result.indexOf("\x1b[31mabc"));
		expect(result.indexOf("\x1b[32mXY")).toBeGreaterThan(result.indexOf("\x1b[0m"));
	});

	it("pads an overlay narrower than its slot instead of shifting the rest left", () => {
		const result = compositeTuiLine("abcdefghij", "X", 4, 4, 10);
		expect(visibleWidth(result)).toBe(10);
		expect(stripVTControlCharacters(result)).toBe("abcdX   ij");
	});

	it("never exceeds the total width across the seam parameters", () => {
		const base = "\x1b[1mabc\x1b[0m\u{4e00}\u{4e00}";
		const overlay = "\x1b[32m\u{4e00}XY\x1b[0m";
		for (const total of [4, 8, 12]) {
			for (let startCol = 0; startCol <= 10; startCol += 2) {
				for (let overlayWidth = 0; overlayWidth <= 6; overlayWidth += 2) {
					const result = compositeTuiLine(base, overlay, startCol, overlayWidth, total);
					expect(visibleWidth(result)).toBeLessThanOrEqual(total);
				}
			}
		}
	});

	it("returns an image row untouched, since placement sequences cannot be split", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const placeholder = "\u{10eeee}\u030d\u0305";
		const row = `\x1b[38;2;255;179;102m${placeholder}${placeholder}\x1b[39m`;
		expect(TERMINAL.isImageLine(row)).toBe(true);
		expect(compositeTuiLine(row, "Z", 0, 1, 10)).toBe(row);
	});
});

describe("isViewportTUI", () => {
	it("is true for a TUI, which is branded as owning the viewport", () => {
		const tui = new TUI(new VirtualTerminal(20, 5), undefined, { renderScheduler: new VirtualRenderScheduler() });
		expect(isViewportTUI(tui)).toBe(true);
		expect(branded(tui)[VIEWPORT_TUI]).toBe(true);
	});

	it("is false for anything that is not branded", () => {
		expect(isViewportTUI(undefined)).toBe(false);
		expect(isViewportTUI(null)).toBe(false);
		expect(isViewportTUI({})).toBe(false);
		expect(isViewportTUI({ [VIEWPORT_TUI]: false } as object)).toBe(false);
		expect(isViewportTUI({ [VIEWPORT_TUI]: 1 } as object)).toBe(false);
	});

	it("reads the brand through the shared registry, so a duplicate copy agrees", () => {
		expect(VIEWPORT_TUI === Symbol.for("@earendil-works/pi-tui/viewport")).toBe(true);
		expect(isViewportTUI({ [Symbol.for("@earendil-works/pi-tui/viewport")]: true } as object)).toBe(true);
	});
});

describe("TUI layoutRoot", () => {
	it("renders the child list until a root is installed, then only that root", () => {
		const tui = new TUI(new VirtualTerminal(20, 5), undefined, { renderScheduler: new VirtualRenderScheduler() });
		tui.addChild(new Rows(["child-list"]));
		expect(cells(tui.render(20))).toEqual(["child-list"]);

		expect(tui.layoutRoot).toBe(undefined);
		tui.setLayoutRoot(new Rows(["override"]));
		expect(cells(tui.layoutRoot?.render(20) ?? [])).toEqual(["override"]);
		// The override replaces the child list rather than joining it.
		expect(cells(tui.render(20))).toEqual(["override"]);

		tui.setLayoutRoot(undefined);
		expect(cells(tui.render(20))).toEqual(["child-list"]);
	});
});

describe("getCapabilities", () => {
	it("reports the Pi shape with booleans and an inline-image protocol", () => {
		const capabilities = getCapabilities();
		expect(typeof capabilities.trueColor).toBe("boolean");
		expect(typeof capabilities.hyperlinks).toBe("boolean");
		expect(["kitty", "iterm2", null]).toContain(capabilities.images);
	});

	it("names the Kitty and iTerm2 protocols Pi expects", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		expect(getCapabilities().images).toBe("kitty");
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		expect(getCapabilities().images).toBe("iterm2");
	});

	it("reports no inline images for a protocol Pi has no name for", () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		expect(getCapabilities().images).toBe(null);
		setTerminalImageProtocol(null);
		expect(getCapabilities().images).toBe(null);
	});
});

describe("allocateImageId", () => {
	it("returns ids inside the Kitty range", () => {
		for (let index = 0; index < 200; index++) {
			const id = allocateImageId();
			expect(Number.isInteger(id)).toBe(true);
			expect(id).toBeGreaterThanOrEqual(1);
			expect(id).toBeLessThanOrEqual(0xfffffffe);
		}
	});

	it("does not repeat across a batch, so two images cannot collide", () => {
		const ids = new Set<number>();
		for (let index = 0; index < 200; index++) ids.add(allocateImageId());
		expect(ids.size).toBe(200);
	});
});

describe("HStack", () => {
	it("lays children out side by side at their basis", () => {
		const stack = new HStack([
			{ component: new Rows(["ab"]), basis: 4 },
			{ component: new Rows(["cd"]), basis: 6 },
		]);
		const lines = stack.render(10);
		expect(cells(lines)).toEqual(["abcd"]);
		expect(lines.every(line => visibleWidth(line) === 10)).toBe(true);
	});

	it("gives a bare component its natural width", () => {
		expect(cells(new HStack([new Rows(["ab"]), new Rows(["cde"])]).render(10))).toEqual(["abcde"]);
	});

	it("grows a grow slot out of the leftover width, as Pi does from basis 0", () => {
		const stack = new HStack([
			{ component: new Rows(["m"]), basis: 0, grow: 1, shrink: 1, minSize: 2 },
			{ component: new Rows(["s"]), basis: 4, grow: 0, minSize: 4, maxSize: 4 },
		]);
		const [line] = stack.render(12);
		expect(cells([line!])).toEqual(["m       s"]);
		expect(visibleWidth(line!)).toBe(12);
	});

	it("clamps a basis into the slot's own bounds", () => {
		const stack = new HStack([
			{ component: new Rows(["a"]), basis: 0, minSize: 3, maxSize: 3 },
			{ component: new Rows(["b"]), basis: 9, maxSize: 2 },
		]);
		expect(cells(stack.render(10))).toEqual(["a  b"]);
	});

	it("measures an auto basis at the granted width", () => {
		const stack = new HStack([
			{ component: new Rows(["abc"]), basis: "auto" },
			{ component: new Rows(["d"]), basis: 1 },
		]);
		expect(cells(stack.render(10))).toEqual(["abcd"]);
	});

	it("inserts the requested gap between slots", () => {
		const stack = new HStack(
			[
				{ component: new Rows(["ab"]), basis: 2 },
				{ component: new Rows(["cd"]), basis: 2 },
			],
			{ gap: 3 },
		);
		expect(cells(stack.render(10))).toEqual(["ab   cd"]);
	});

	it("pads a short child down to the tallest child's height", () => {
		const stack = new HStack([
			{ component: new Rows(["a"]), basis: 1 },
			{ component: new Rows(["b", "b", "b"]), basis: 1 },
		]);
		expect(cells(stack.render(6))).toEqual(["ab", " b", " b"]);
	});

	it("aligns a shorter child to the end when asked", () => {
		const stack = new HStack(
			[
				{ component: new Rows(["a"]), basis: 1 },
				{ component: new Rows(["b", "b", "b"]), basis: 1 },
			],
			{ align: "end" },
		);
		expect(cells(stack.render(6))).toEqual([" b", " b", "ab"]);
	});

	it("drops a child whose visible predicate rejects the granted width", () => {
		const seen: number[] = [];
		const stack = new HStack([
			{ component: new Rows(["m"]), basis: 2 },
			{
				component: new Rows(["s"]),
				basis: 2,
				visible: ({ width }) => {
					seen.push(width);
					return width >= 8;
				},
			},
		]);
		expect(cells(stack.render(6))).toEqual(["m"]);
		expect(cells(stack.render(8))).toEqual(["ms"]);
		// Pi measures against the whole stack width, not the child's own slot.
		expect(seen).toContain(6);
		expect(seen).toContain(8);
	});

	it("renders nothing when no child is visible", () => {
		const stack = new HStack([{ component: new Rows(["x"]), visible: () => false }]);
		expect(stack.render(10)).toEqual([]);
	});

	it("detaches children by identity and clears them all", () => {
		const first = new Rows(["first"]);
		const second = new Rows(["second"]);
		const stack = new HStack([
			{ component: first, basis: 5 },
			{ component: second, basis: 5 },
		]);
		expect(cells(stack.render(10))).toEqual(["firstsecon"]);

		stack.removeChild(first);
		expect(stack.children).toEqual([second]);
		expect(cells(stack.render(10))).toEqual(["second"]);

		stack.addChild(first, { basis: 4 });
		expect(cells(stack.render(10))).toEqual(["secondfirs"]);

		stack.clear();
		expect(stack.children).toEqual([]);
		expect(stack.render(10)).toEqual([]);
	});

	it("keeps the slot table stable while the child list is unchanged", () => {
		const stack = new HStack([{ component: new Rows(["x"]), basis: 4 }]);
		const first = stack.render(10);
		expect(stack.render(10)).toBe(first);
	});
});

/** A fixed set of rows, as a leaf component. */
class Rows implements Component {
	readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): readonly string[] {
		return this.lines;
	}
}
