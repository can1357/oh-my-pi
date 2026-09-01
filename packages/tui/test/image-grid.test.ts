import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Component,
	getKittyGraphics,
	Image,
	ImageBudget,
	ImageGrid,
	ImageProtocol,
	setKittyGraphics,
	setTerminalImageProtocol,
	TERMINAL,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
class TaggedLines implements Component {
	#lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	canRenderAsKittyPlaceholders(_width: number): boolean {
		return true;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return this.#lines;
	}
}

class UnmarkedLines implements Component {
	#lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return this.#lines;
	}
}

const originalProtocol = TERMINAL.imageProtocol;
const originalGraphics = { ...getKittyGraphics() };

beforeEach(() => {
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setKittyGraphics({ unicodePlaceholders: true });
});

afterEach(() => {
	setTerminalImageProtocol(originalProtocol);
	setKittyGraphics(originalGraphics);
});

describe("ImageGrid layout safety", () => {
	it("composes Kitty placeholder rows side by side with the configured gap", () => {
		const grid = new ImageGrid([new TaggedLines(["A0", "A1"]), new TaggedLines(["B0"])]);

		const rows = grid.render(70).map(row => Bun.stripANSI(row));

		expect(rows).toHaveLength(2);
		expect(visibleWidth(rows[0] ?? "")).toBe(70);
		expect(rows[0]?.slice(0, 34)).toBe(`A0${" ".repeat(32)}`);
		expect(rows[0]?.slice(34, 36)).toBe("  ");
		expect(rows[0]?.slice(36)).toBe(`B0${" ".repeat(32)}`);
		expect(rows[1]?.slice(0, 34)).toBe(`A1${" ".repeat(32)}`);
		expect(rows[1]?.slice(36)).toBe(" ".repeat(34));
	});
	it("uses three columns when the available width fits the minimum tile width", () => {
		const grid = new ImageGrid([new TaggedLines(["A"]), new TaggedLines(["B"]), new TaggedLines(["C"])]);
		const row = Bun.stripANSI(grid.render(100)[0] ?? "");

		expect(visibleWidth(row)).toBe(100);
		expect(row[0]).toBe("A");
		expect(row[34]).toBe("B");
		expect(row[68]).toBe("C");
	});

	it("uses four columns when the available width fits the minimum tile width", () => {
		const grid = new ImageGrid([
			new TaggedLines(["A"]),
			new TaggedLines(["B"]),
			new TaggedLines(["C"]),
			new TaggedLines(["D"]),
		]);
		const row = Bun.stripANSI(grid.render(134)[0] ?? "");

		expect(visibleWidth(row)).toBe(134);
		expect(row[0]).toBe("A");
		expect(row[34]).toBe("B");
		expect(row[68]).toBe("C");
		expect(row[102]).toBe("D");
	});

	it("collapses to fewer than three columns when the width is just below the fit threshold", () => {
		const grid = new ImageGrid([
			new TaggedLines(["A"]),
			new TaggedLines(["B"]),
			new TaggedLines(["C"]),
			new TaggedLines(["D"]),
		]);
		const rows = grid.render(99).map(row => Bun.stripANSI(row));

		expect(rows[0]?.[0]).toBe("A");
		expect(rows[0]?.[50]).toBe("B");
		expect(rows[1]).toBe("");
		expect(rows[2]?.[0]).toBe("C");
		expect(rows[2]?.[50]).toBe("D");
		expect(rows.filter(Boolean).every(row => visibleWidth(row) === 99)).toBe(true);
	});

	it("honors an explicit maximum column count", () => {
		const grid = new ImageGrid([new TaggedLines(["A"]), new TaggedLines(["B"]), new TaggedLines(["C"])], {
			maxColumns: 2,
		});
		const rows = grid.render(140).map(row => Bun.stripANSI(row));

		expect(rows).toHaveLength(3);
		expect(rows[0]?.[0]).toBe("A");
		expect(rows[0]?.[71]).toBe("B");
		expect(rows[1]).toBe("");
		expect(rows[2]?.[0]).toBe("C");
	});

	it("keeps mixed-height rows padded to the full available width", () => {
		const grid = new ImageGrid([
			new TaggedLines(["A0", "A1", "A2"]),
			new TaggedLines(["B0"]),
			new TaggedLines(["C0", "C1"]),
			new TaggedLines(["D0", "D1", "D2"]),
		]);
		const rows = grid.render(134).map(row => Bun.stripANSI(row));

		expect(rows).toHaveLength(3);
		expect(rows.every(row => visibleWidth(row) === 134)).toBe(true);
		expect(rows[0]?.[0]).toBe("A");
		expect(rows[0]?.[34]).toBe("B");
		expect(rows[0]?.[68]).toBe("C");
		expect(rows[0]?.[102]).toBe("D");
	});

	it("truncates an overlong child before padding the adjacent tile", () => {
		const grid = new ImageGrid([new TaggedLines(["A".repeat(80)]), new TaggedLines(["B"])]);
		const row = grid.render(70)[0] ?? "";

		expect(visibleWidth(row)).toBe(70);
		expect(Bun.stripANSI(row)).toContain("B");
	});

	it("collapses to one column when the available width cannot fit two columns", () => {
		const grid = new ImageGrid([new TaggedLines(["A0", "A1"]), new TaggedLines(["B0"])]);

		const rows = grid.render(65).map(row => Bun.stripANSI(row).trimEnd());

		expect(rows).toEqual(["A0", "A1", "", "B0"]);
	});

	it("keeps direct Kitty placement children vertical even when four columns fit", () => {
		setKittyGraphics({ unicodePlaceholders: false });
		const directA = "\x1b_Ga=p,i=1\x1b\\A";
		const directB = "\x1b_Ga=p,i=2\x1b\\B";
		const grid = new ImageGrid([new TaggedLines([directA]), new TaggedLines([directB])]);

		const rows = grid.render(140);
		const aRow = rows.findIndex(row => row.includes(directA));
		const bRow = rows.findIndex(row => row.includes(directB));

		expect(aRow).toBeGreaterThanOrEqual(0);
		expect(bRow).toBeGreaterThan(aRow);
		expect(rows.some(row => row.includes(directA) && row.includes(directB))).toBe(false);
		expect(rows[bRow - 1]).toBe("");
	});
	it("stacks unmarked children under Kitty placeholder mode", () => {
		const directA = "\x1b_Ga=p,i=1\x1b\\A";
		const directB = "\x1b_Ga=p,i=2\x1b\\B";
		const grid = new ImageGrid([new UnmarkedLines([directA]), new UnmarkedLines([directB])]);

		const rows = grid.render(140);
		const aRow = rows.findIndex(row => row.includes(directA));
		const bRow = rows.findIndex(row => row.includes(directB));

		expect(aRow).toBeGreaterThanOrEqual(0);
		expect(bRow).toBeGreaterThan(aRow);
		expect(rows.some(row => row.includes(directA) && row.includes(directB))).toBe(false);
		expect(rows[bRow - 1]).toBe("");
	});

	it("composes real Kitty placeholder images side by side", () => {
		const budget = new ImageBudget(8, () => {});
		const grid = new ImageGrid([
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 16, maxHeightCells: 4, budget, imageKey: "grid-a" },
				{ widthPx: 100, heightPx: 100 },
			),
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 16, maxHeightCells: 4, budget, imageKey: "grid-b" },
				{ widthPx: 100, heightPx: 100 },
			),
		]);

		budget.beginPass();
		const rows = grid.render(70);
		budget.endPass();
		const placementRows = rows.filter(row => row.includes("\x1b_Ga=p,U=1"));

		expect(placementRows).toHaveLength(1);
		expect(placementRows[0]?.match(/\x1b_Ga=p,U=1/g)).toHaveLength(2);
	});

	it("stacks Kitty images when a fitted grid exceeds placeholder bounds", () => {
		const budget = new ImageBudget(8, () => {});
		const image = (imageKey: string) =>
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 16, maxHeightCells: 300, budget, imageKey },
				{ widthPx: 1, heightPx: 1000 },
			);
		const grid = new ImageGrid([image("tall-a"), image("tall-b")]);

		budget.beginPass();
		const rows = grid.render(70);
		budget.endPass();
		const placementRows = rows.filter(row => row.includes("\x1b_Ga=p"));

		expect(placementRows.length).toBeGreaterThan(1);
		expect(placementRows.every(row => (row.match(/\x1b_Ga=p/g) ?? []).length === 1)).toBe(true);
	});
});
