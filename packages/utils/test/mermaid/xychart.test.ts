/**
 * Tests for xychart-beta ASCII rendering.
 *
 * Tests bar charts, line charts, mixed charts, horizontal orientation,
 * multi-series support, staircase line routing, and edge cases.
 */
import { describe, expect, it } from "bun:test";
import { renderMermaidASCII } from "../../src/vendor/mermaid-ascii/ascii/index";

// ============================================================================
// Helper — render with no colors for easy string matching
// ============================================================================

function render(text: string, useAscii = false): string {
	return renderMermaidASCII(text, { colorMode: "none", useAscii });
}

// ============================================================================
// Bar charts
// ============================================================================

describe("xychart ASCII – bar charts", () => {
	it("renders a basic bar chart with block characters", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C]
      bar [10, 20, 30]`);
		expect(result).toContain("█");
		expect(result).toContain("A");
		expect(result).toContain("B");
		expect(result).toContain("C");
	});

	it("renders bars with # in ASCII mode", () => {
		const result = render(
			`xychart-beta
      x-axis [A, B, C]
      bar [10, 20, 30]`,
			true,
		);
		expect(result).toContain("#");
		expect(result).not.toContain("█");
	});

	it("renders a bar chart with title", () => {
		const result = render(`xychart-beta
      title "Sales Report"
      x-axis [Q1, Q2, Q3, Q4]
      bar [100, 200, 150, 250]`);
		expect(result).toContain("Sales Report");
		expect(result).toContain("Q1");
		expect(result).toContain("Q4");
	});

	it("renders y-axis tick labels", () => {
		const result = render(`xychart-beta
      x-axis [A, B]
      y-axis 0 --> 100
      bar [25, 75]`);
		// Should have at least some tick values visible
		expect(result).toContain("┤");
		expect(result).toContain("┼");
	});

	it("renders multi-series bars", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C]
      bar [10, 20, 30]
      bar [15, 25, 35]`);
		// Should contain legend for multi-series
		expect(result).toContain("Bar 1");
		expect(result).toContain("Bar 2");
	});
});

// ============================================================================
// Line charts
// ============================================================================

describe("xychart ASCII – line charts", () => {
	it("renders a line chart with staircase routing", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C, D]
      line [10, 30, 20, 40]`);
		// Should use box-drawing corners for staircase
		expect(result).toContain("╭");
		expect(result).toContain("─");
	});

	it("does NOT use dot markers on line charts", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C, D]
      line [10, 30, 20, 40]`);
		expect(result).not.toContain("●");
		expect(result).not.toContain("*");
	});

	it("uses vertical segments for row transitions", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C]
      line [10, 50, 20]`);
		// Vertical segments connect rows
		expect(result).toContain("│");
	});

	it("renders ascending line with ╯ and ╭ corners", () => {
		const result = render(`xychart-beta
      x-axis [A, B]
      line [10, 50]`);
		// Ascending: ╯ at bottom (left+up), ╭ at top (bottom+right)
		expect(result).toContain("╯");
		expect(result).toContain("╭");
	});

	it("renders descending line with ╮ and ╰ corners", () => {
		const result = render(`xychart-beta
      x-axis [A, B]
      line [50, 10]`);
		// Descending: ╮ at top (left+down), ╰ at bottom (top+right)
		expect(result).toContain("╮");
		expect(result).toContain("╰");
	});

	it("renders flat line with only ─", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C]
      line [50, 50, 50]`);
		expect(result).toContain("─");
		// No corners needed for flat lines
		expect(result).not.toContain("╭");
		expect(result).not.toContain("╮");
	});

	it("uses + for corners in ASCII mode", () => {
		const result = render(
			`xychart-beta
      x-axis [A, B]
      line [10, 50]`,
			true,
		);
		expect(result).toContain("+");
		expect(result).not.toContain("╭");
		expect(result).not.toContain("╰");
	});
});

// ============================================================================
// Mixed bar + line
// ============================================================================

describe("xychart ASCII – mixed charts", () => {
	it("renders bars and lines together", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C, D]
      bar [20, 40, 30, 50]
      line [25, 35, 40, 45]`);
		// Should have both bar blocks and line corners
		expect(result).toContain("█");
		expect(result).toContain("─");
		// Legend for multi-series
		expect(result).toContain("Bar 1");
		expect(result).toContain("Line 1");
	});
});

// ============================================================================
// Horizontal orientation
// ============================================================================

describe("xychart ASCII – horizontal", () => {
	it("renders horizontal bar chart", () => {
		const result = render(`xychart-beta horizontal
      x-axis [Python, JavaScript, Go]
      bar [30, 25, 12]`);
		// Category labels on left side
		expect(result).toContain("Python");
		expect(result).toContain("JavaScript");
		expect(result).toContain("Go");
		expect(result).toContain("█");
	});

	it("renders horizontal line chart with staircase", () => {
		const result = render(`xychart-beta horizontal
      x-axis [A, B, C]
      line [10, 30, 20]`);
		// Should have horizontal staircase routing
		expect(result).toContain("─");
		expect(result).toContain("│");
	});
});

// ============================================================================
// Titles and axis labels
// ============================================================================

describe("xychart ASCII – titles and axes", () => {
	it("renders chart title centered", () => {
		const result = render(`xychart-beta
      title "My Chart"
      x-axis [A, B]
      bar [10, 20]`);
		const titleLine = result.split("\n").find(l => l.includes("My Chart"));
		expect(titleLine).toBeDefined();
	});

	it("renders x-axis title", () => {
		const result = render(`xychart-beta
      x-axis "Category" [A, B, C]
      bar [10, 20, 30]`);
		expect(result).toContain("Category");
	});

	it("renders y-axis with explicit range", () => {
		const result = render(`xychart-beta
      x-axis [A, B]
      y-axis "Score" 0 --> 100
      bar [25, 75]`);
		// Y-axis ticks should appear
		expect(result).toContain("0");
		expect(result).toContain("100");
	});

	it("renders without title when not specified", () => {
		const result = render(`xychart-beta
      x-axis [A, B]
      bar [10, 20]`);
		// First non-empty line should be chart content, not a title
		const lines = result.split("\n").filter(l => l.trim().length > 0);
		expect(lines.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// Edge cases
// ============================================================================

describe("xychart ASCII – edge cases", () => {
	it("handles single data point", () => {
		const result = render(`xychart-beta
      x-axis [Only]
      bar [42]`);
		expect(result).toContain("Only");
		expect(result).toContain("█");
	});

	it("handles two data points", () => {
		const result = render(`xychart-beta
      x-axis [A, B]
      bar [10, 20]`);
		expect(result).toContain("A");
		expect(result).toContain("B");
	});

	it("handles all zeros", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C]
      bar [0, 0, 0]`);
		expect(result).toContain("A");
		// Should still render axes
		expect(result).toContain("┼");
	});

	it("handles large values", () => {
		const result = render(`xychart-beta
      x-axis [A, B]
      bar [1000000, 2000000]`);
		expect(result).toContain("A");
		expect(result).toContain("B");
	});

	it("renders line chart with single data point", () => {
		const result = render(`xychart-beta
      x-axis [A]
      line [50]`);
		expect(result).toContain("A");
		expect(result).toContain("─");
	});
});

// ============================================================================
// Axis structure
// ============================================================================

describe("xychart ASCII – axis structure", () => {
	it("has y-axis ticks (┤) at value positions", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C]
      y-axis 0 --> 100
      bar [25, 50, 75]`);
		expect(result).toContain("┤");
	});

	it("has x-axis ticks (┬) at category positions", () => {
		const result = render(`xychart-beta
      x-axis [A, B, C]
      bar [25, 50, 75]`);
		expect(result).toContain("┬");
	});

	it("has origin marker (┼)", () => {
		const result = render(`xychart-beta
      x-axis [A, B]
      bar [10, 20]`);
		expect(result).toContain("┼");
	});

	it("uses + for axis characters in ASCII mode", () => {
		const result = render(
			`xychart-beta
      x-axis [A, B, C]
      y-axis 0 --> 100
      bar [25, 50, 75]`,
			true,
		);
		expect(result).toContain("+");
		expect(result).not.toContain("┤");
		expect(result).not.toContain("┬");
		expect(result).not.toContain("┼");
	});
});
