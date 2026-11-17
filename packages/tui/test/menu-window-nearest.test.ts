import { describe, expect, it } from "bun:test";
import { getMenuWindow } from "@oh-my-pi/pi-tui/components/menu-selection";

describe("getMenuWindow", () => {
	it("defaults to centered windowing when alignment is unspecified or center", () => {
		// 10 items of 3 rows each, budget of 15 rows (fits 5 items)
		const rowCounts = Array(10).fill(3);
		// Selecting item 6 (7th item)
		const centeredDefault = getMenuWindow(rowCounts, 6, 15);
		const centeredExplicit = getMenuWindow(rowCounts, 6, 15, { alignment: "center" });
		const nearest = getMenuWindow(rowCounts, 6, 15, { alignment: "nearest", currentStartIndex: 0 });

		// Both default and explicit center must produce exact centered window (items 4..8)
		expect(centeredDefault).toEqual({ startIndex: 4, endIndex: 9, rowOffset: 12, totalRows: 30 });
		expect(centeredExplicit).toEqual({ startIndex: 4, endIndex: 9, rowOffset: 12, totalRows: 30 });

		// Nearest mode with start 0 must produce an edge-aligned window (items 2..6)
		expect(nearest).toEqual({ startIndex: 2, endIndex: 7, rowOffset: 6, totalRows: 30 });
	});

	describe("alignment: nearest (edge-triggered scrolling)", () => {
		it("does not scroll while cursor navigates within the visible viewport", () => {
			// 10 items, 3 rows each, budget 15 (fits 5 items: indices 0..4)
			const rowCounts = Array(10).fill(3);
			let currentStart = 0;

			// Moving down within the first page (0..4) should NOT shift the window
			for (let selected = 0; selected <= 4; selected++) {
				const win = getMenuWindow(rowCounts, selected, 15, {
					alignment: "nearest",
					currentStartIndex: currentStart,
				});
				expect(win.startIndex).toBe(0);
				expect(win.endIndex).toBe(5);
				currentStart = win.startIndex;
			}
		});

		it("scrolls one item at a time only when navigating past the bottom edge", () => {
			const rowCounts = Array(10).fill(3);
			let currentStart = 0;

			// Step 1: Navigating to item 5 (6th item, exceeds 15-row budget of 5 items)
			const win5 = getMenuWindow(rowCounts, 5, 15, {
				alignment: "nearest",
				currentStartIndex: currentStart,
			});
			expect(win5.startIndex).toBe(1);
			expect(win5.endIndex).toBe(6);
			currentStart = win5.startIndex;

			// Step 2: Navigating to item 6
			const win6 = getMenuWindow(rowCounts, 6, 15, {
				alignment: "nearest",
				currentStartIndex: currentStart,
			});
			expect(win6.startIndex).toBe(2);
			expect(win6.endIndex).toBe(7);
			currentStart = win6.startIndex;
		});

		it("keeps viewport stationary when moving cursor up until reaching top edge", () => {
			const rowCounts = Array(10).fill(3);
			// Currently scrolled so items 2..6 are visible
			let currentStart = 2;

			// Moving cursor up from 6 to 5, 4, 3, 2 should keep currentStart at 2
			for (let selected = 6; selected >= 2; selected--) {
				const win = getMenuWindow(rowCounts, selected, 15, {
					alignment: "nearest",
					currentStartIndex: currentStart,
				});
				expect(win.startIndex).toBe(2);
				expect(win.endIndex).toBe(7);
				currentStart = win.startIndex;
			}

			// Moving up past top edge (to item 1) shifts window up by 1
			const win1 = getMenuWindow(rowCounts, 1, 15, {
				alignment: "nearest",
				currentStartIndex: currentStart,
			});
			expect(win1.startIndex).toBe(1);
			expect(win1.endIndex).toBe(6);
			currentStart = win1.startIndex;

			// Moving to item 0 shifts window up to 0
			const win0 = getMenuWindow(rowCounts, 0, 15, {
				alignment: "nearest",
				currentStartIndex: currentStart,
			});
			expect(win0.startIndex).toBe(0);
			expect(win0.endIndex).toBe(5);
		});

		it("handles variable row heights correctly", () => {
			// Alternating 3 and 4 row items
			// 0: 3, 1: 4, 2: 3, 3: 4, 4: 3 -> sum(0..3) = 14, sum(0..4) = 17
			const rowCounts = [3, 4, 3, 4, 3, 4, 3, 4];
			const budget = 14;

			// Indices 0, 1, 2, 3 sum to 3 + 4 + 3 + 4 = 14 (fits exactly)
			const win3 = getMenuWindow(rowCounts, 3, budget, {
				alignment: "nearest",
				currentStartIndex: 0,
			});
			expect(win3.startIndex).toBe(0);
			expect(win3.endIndex).toBe(4);

			// Moving to index 4: 0..4 is 17 > 14. Dropping index 0 (cost 3) leaves 14 (indices 1..4)
			const win4 = getMenuWindow(rowCounts, 4, budget, {
				alignment: "nearest",
				currentStartIndex: 0,
			});
			expect(win4.startIndex).toBe(1);
			expect(win4.endIndex).toBe(5);
		});

		it("retains an oversized item taller than the budget", () => {
			const rowCounts = [3, 20, 3];
			const budget = 10;
			const win = getMenuWindow(rowCounts, 1, budget, {
				alignment: "nearest",
				currentStartIndex: 0,
			});
			expect(win.startIndex).toBe(1);
			expect(win.endIndex).toBe(2);
		});
	});
});
