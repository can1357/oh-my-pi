/** @jsxImportSource @oh-my-pi/pi-tui */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ReportPanel } from "../../../../src/ui/overlays/panels/report-panel";
import { printRows } from "../../../../src/ui/print-rows";
import { initTheme } from "../../../../src/ui/theme/service";

describe("report panel in terminal rows", () => {
	beforeAll(() => {
		initTheme();
	});

	it("gives a scrolling body every column before the scrollbar, and a thumb no longer than its share", () => {
		// 30 columns: 26 inside the box, the last of them the scrollbar. Each line is as wide as the rest.
		const line = "x".repeat(25);
		const rows = printRows(
			() => (
				<ReportPanel
					title="T"
					body={<text wrap="word" text={Array.from({ length: 24 }, () => line).join("\n")} />}
					closeKey="Esc"
					maxRows={() => 11}
					onClose={() => {}}
				/>
			),
			30,
		).map(stripVTControlCharacters);

		// 11 rows, 5 of them chrome: 6 body rows of 24, so the thumb is floor(6 * 6 / 24) = 1 row.
		expect(rows).toHaveLength(11);
		expect(rows.slice(2, 8)).toEqual([`│ ${line}█ │`, ...Array.from({ length: 5 }, () => `│ ${line}│ │`)]);
	});
});
