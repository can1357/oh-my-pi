import { describe, expect, it } from "bun:test";
import { renderMermaidAscii, renderMermaidAsciiSafe } from "../src/mermaid-ascii";
import { getPath } from "../src/vendor/mermaid-ascii/ascii/pathfinder";
import { type AsciiNode, type GridCoord, gridKey } from "../src/vendor/mermaid-ascii/ascii/types";

describe("renderMermaidAscii", () => {
	it("preserves an existing emoji edge label when a later narrow label collides with it", () => {
		const rendered = renderMermaidAscii(["flowchart LR", "  A -->|🚀| B", "  A -->|A| B"].join("\n"), {
			colorMode: "none",
		});

		expect(rendered).toContain("─🚀─");
		expect(rendered).not.toContain("──A─");
	});

	it("renders Unicode and ASCII state pseudostates with distinct UML markers", () => {
		const source = ["stateDiagram-v2", "  [*] --> Created", "  Created --> [*]"].join("\n");
		const unicode = renderMermaidAscii(source, { colorMode: "none" });
		const ascii = renderMermaidAscii(source, { colorMode: "none", useAscii: true });

		expect(unicode).toMatch(/│\s+●\s+│/);
		expect(unicode).toMatch(/║\s+◎\s+║/);
		expect(ascii).toMatch(/\|\s+\*\s+\|/);
		expect(ascii).toMatch(/‖\s+\*\s+‖/);
		expect(ascii).toMatch(/#=+#/);
	});

	it("keeps rounded pseudostate corners upright in bottom-to-top diagrams", () => {
		const rendered = renderMermaidAscii(["stateDiagram-v2", "  direction BT", "  [*] --> Created"].join("\n"), {
			colorMode: "none",
		});
		const rows = rendered.split("\n");
		const markerRow = rows.findIndex(row => row.includes("●"));

		expect(markerRow).toBeGreaterThan(0);
		expect(rows[markerRow - 1]).toMatch(/╭─+╮/);
		expect(rows[markerRow + 1]).toMatch(/╰─+╯/);
	});

	it("masks routed lines behind spaces in edge labels", () => {
		const horizontal = renderMermaidAscii(
			["graph LR", "  A[Agent] -->|on Mac| B[Server]", "  A -->|on Linux| C[Cluster]"].join("\n"),
			{ colorMode: "none", useAscii: false },
		);
		const vertical = renderMermaidAscii("graph TD\n  A[Agent] -->|to c| C[Cluster]", {
			colorMode: "none",
			useAscii: false,
		});

		expect(horizontal).toContain("on Mac");
		expect(horizontal).toContain("on Linux");
		expect(horizontal).not.toContain("on─Mac");
		expect(horizontal).not.toContain("on─Linux");
		expect(vertical).toContain("to c");
		expect(vertical).not.toContain("to│c");
	});

	it("returns a bounded fallback for declaration orders that make a clean route unreachable", () => {
		const rendered = renderMermaidAsciiSafe(
			[
				"flowchart TD",
				"  Worker[Worker]",
				"  Archive[Archive]",
				"  Gateway[Gateway]",
				"  Audit[Audit]",
				"",
				"  Worker --> Archive",
				"  Gateway --> Worker",
				"  Gateway --> Audit",
			].join("\n"),
			{ colorMode: "none" },
		);

		if (rendered === null) {
			throw new Error("expected Mermaid ASCII renderer to return fallback output");
		}

		expect(rendered).toContain("Archive");
		expect(rendered).toContain("Gateway");
		expect(rendered).toContain("Audit");
	});

	it("renders left-to-right diagrams whose subgraph shifts drawing past the grid extents", () => {
		// The subgraph border extends past the origin, so layout shifts every
		// drawing coordinate right/down after the canvas was already sized from
		// the raw grid. Edges routed to the far column then land outside the
		// allocation, which used to throw and drop the whole diagram.
		const rendered = renderMermaidAscii(
			[
				"graph LR",
				"  subgraph S[Done]",
				"    A",
				"  end",
				"  A --> C",
				"  A --> D",
				"  D --> E",
				"  C --> F",
				"  F --> G",
				"  D --> G",
			].join("\n"),
			{ colorMode: "none" },
		);

		expect(rendered).toContain("Done");
		for (const label of ["A", "C", "D", "E", "F", "G"]) {
			expect(rendered).toContain(label);
		}
		// Every row must be padded to the shifted width, not truncated at the
		// pre-shift canvas edge.
		const rows = rendered.split("\n");
		for (const row of rows) {
			expect(row.length).toBe(rows[0]!.length);
		}
	});

	it("returns null when the destination attachment point is enclosed", () => {
		const node: AsciiNode = {
			name: "blocker",
			displayLabel: "blocker",
			shape: "rectangle",
			index: 0,
			gridCoord: null,
			drawingCoord: null,
			drawing: null,
			drawn: false,
			styleClassName: "",
			styleClass: { name: "", styles: {} },
		};
		const enclosed: GridCoord = { x: 2, y: 2 };
		const blockers: GridCoord[] = [enclosed, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 1 }, { x: 2, y: 3 }];
		const grid = new Map<string, AsciiNode>();

		for (const blocker of blockers) {
			grid.set(gridKey(blocker), node);
		}

		expect(getPath(grid, { x: 0, y: 2 }, enclosed)).toBeNull();
	});
});
