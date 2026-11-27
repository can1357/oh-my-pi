/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import { type Signal, signal } from "@oh-my-pi/pi-tui";
import "../../../src/ui/styles/composer/popup";
import { mountLayer } from "../../helpers/layer-terminal";

const WRAPPING = "Re-encode verbose prose into a dense telegraphic register with punctuation as connectives";
const NAMES = Array.from({ length: 12 }, (_, i) => `skill:entry-${String(i).padStart(2, "0")}`);

function mountPopup(
	selected: Signal<string>,
	detail: string,
	{ names = NAMES, width }: { names?: string[]; width?: number } = {},
) {
	return mountLayer(
		() => (
			<overlay key="complete" role="omp.autocomplete" term={{ columns: [12, 32], descriptionRows: 2, width }}>
				<col role="omp.select">
					<list key="list" max={{ lines: 10 }} selected={selected}>
						{names.map(name => (
							<item key={name} label={name} term={{ label: name, detail }} />
						))}
					</list>
				</col>
			</overlay>
		),
		{ columns: 100, focusKind: "list" },
	);
}

/** Painted popup rows (each ends in the scrollbar column). */
function popupRows(lines: string[]): string[] {
	return lines.filter(line => /[█│]$/.test(line));
}

/** Label of the row carrying the cursor marker (unselected rows start with the label), or null when none is painted. */
function cursorLabel(rows: string[]): string | null {
	const row = rows.map(line => line.trimStart()).find(line => /^\S.*skill:entry-\d\d/.test(line) && !line.startsWith("skill:"));
	return row?.match(/skill:entry-\d\d/)?.[0] ?? null;
}

describe("composer completion popup", () => {
	test("keeps the selected entry painted while two-row entries scroll", () => {
		const selected = signal(NAMES[0]!);
		const popup = mountPopup(selected, WRAPPING);
		try {
			const thumbs: number[] = [];
			for (const name of NAMES) {
				selected.set(name);
				const rows = popupRows(popup.lines());
				expect(rows).toHaveLength(10);
				expect(cursorLabel(rows)).toBe(name);
				thumbs.push(rows.findIndex(row => row.endsWith("█")));
			}
			expect(thumbs[0]).toBe(0);
			// The thumb tracks the window down to the end instead of freezing midway.
			expect(thumbs.at(-1)).toBeGreaterThan(thumbs[6]!);
			expect(popupRows(popup.lines()).at(-1)).toEndWith("█");
		} finally {
			popup.dispose();
		}
	});

	test("one-row entries keep the window centred on the selection", () => {
		const selected = signal(NAMES[6]!);
		const popup = mountPopup(selected, "short desc");
		try {
			const rows = popupRows(popup.lines());
			expect(rows.flatMap(row => row.match(/skill:entry-\d\d/) ?? [])).toEqual(NAMES.slice(1, 11));
			expect(cursorLabel(rows)).toBe(NAMES[6]!);
		} finally {
			popup.dispose();
		}
	});

	test("omits the scrollbar when narrowing hides descriptions and all entries fit", () => {
		const names = NAMES.slice(0, 10);
		const selected = signal(names.at(-1)!);
		const popup = mountPopup(selected, WRAPPING, { names, width: 41 });
		try {
			const lines = popup.lines();
			expect(lines.flatMap(row => row.match(/skill:entry-\d\d/) ?? [])).toEqual(names);
			expect(cursorLabel(lines)).toBe(selected());
			expect(popupRows(lines)).toEqual([]);
		} finally {
			popup.dispose();
		}
	});
});
