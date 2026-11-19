import { describe, expect, it } from "bun:test";
import { computeEditorMaxHeight } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

describe("computeEditorMaxHeight", () => {
	it("caps the editor within the comfortable band on roomy terminals", () => {
		expect(computeEditorMaxHeight(30)).toBe(18);
		expect(computeEditorMaxHeight(18)).toBe(6);
		expect(computeEditorMaxHeight(8)).toBe(4);
		expect(computeEditorMaxHeight(Number.NaN)).toBe(12);
		expect(computeEditorMaxHeight(0)).toBe(12);
	});

	it("reserves at least four chrome rows once the terminal can host both", () => {
		// Editor floor (3 rendered rows, bordered) + chrome reserve (4) = 7 rows.
		for (let rows = 7; rows <= 18; rows += 1) {
			expect(rows - computeEditorMaxHeight(rows)).toBeGreaterThanOrEqual(4);
		}
	});

	it("pins the cap to the bordered editor's real minimum on tinier terminals", () => {
		// Below 7 rows there is no room for both; the cap collapses to the editor's
		// real rendered floor (2 border + 1 content) rather than a fictitious value
		// the editor would silently overshoot.
		expect(computeEditorMaxHeight(6)).toBe(3);
		expect(computeEditorMaxHeight(5)).toBe(3);
		expect(computeEditorMaxHeight(4)).toBe(3);
		expect(computeEditorMaxHeight(1)).toBe(3);
	});
});
