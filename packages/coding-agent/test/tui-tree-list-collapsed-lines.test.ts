import { describe, expect, it } from "bun:test";
import { renderTreeList } from "@oh-my-pi/pi-coding-agent/tui/tree-list";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

const stubTheme = {
	fg: (_color: string, text: string) => text,
	tree: { branch: "├", last: "└", vertical: "│", horizontal: "─", hook: "╰" },
} as Parameters<typeof renderTreeList>[1];

function expectWithinBudget(lines: string[], budget: number) {
	expect(lines.length).toBeLessThanOrEqual(budget);
}

describe("renderTreeList maxCollapsedLines", () => {
	it("reserves custom branch and continuation widths in both rendering paths", () => {
		const customTheme = {
			...stubTheme,
			tree: { ...stubTheme.tree, branch: "界├", last: "界界└", vertical: "界界│" },
		} as typeof stubTheme;
		for (const trailingSummary of [undefined, "", "summary"]) {
			const lines = renderTreeList(
				{
					items: ["first item with long details", "second item with long details"],
					trailingSummary,
					renderItem: (item, context) => [
						truncateToWidth(item, 18 - (context.prefixWidth ?? 0)),
						truncateToWidth("continued details", 18 - (context.prefixWidth ?? 0)),
					],
				},
				customTheme,
			);
			expect(lines[0]).toStartWith("界├ ");
			expect(lines[2]).toStartWith(trailingSummary ? "界├ " : "界界└ ");
			expect(lines[1]).toStartWith("界界│");
			expect(lines[1]).toContain("continued");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(18);
		}
	});

	it("skips oversized first item instead of rendering broken fragments", () => {
		const largeGroup = Array.from({ length: 15 }, (_, i) => `line-${i}`);
		const smallGroup = ["a", "b"];

		const collapsed = renderTreeList(
			{
				items: [largeGroup, smallGroup],
				expanded: false,
				maxCollapsedLines: 6,
				itemType: "match",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 6);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("2 more matches");
	});

	it("counts the summary row inside the collapsed line budget", () => {
		const items = [["a", "b"], ["c", "d", "e"], ["f"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 4,
				itemType: "match",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 4);
		expect(collapsed).toHaveLength(3);
		expect(collapsed[0]).toContain("a");
		expect(collapsed[1]).toContain("b");
		expect(collapsed[2]).toContain("2 more matches");
	});

	it("does not cap lines in expanded mode", () => {
		const largeGroup = Array.from({ length: 15 }, (_, i) => `line-${i}`);

		const expanded = renderTreeList(
			{
				items: [largeGroup],
				expanded: true,
				maxCollapsedLines: 6,
				itemType: "match",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(expanded.length).toBe(15);
		expect(expanded.some(l => l.includes("more"))).toBe(false);
	});

	it("shows correct remaining count when multiple items are hidden", () => {
		const items = [
			["a1", "a2", "a3"],
			["b1", "b2", "b3"],
			["c1", "c2"],
		];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 4,
				itemType: "change",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 4);
		expect(collapsed).toHaveLength(4);
		expect(collapsed.at(-1)).toContain("2 more changes");
	});

	it("renders all items when total lines fit within budget", () => {
		const items = [["a"], ["b"], ["c"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 10,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed.length).toBe(3);
		expect(collapsed.some(l => l.includes("more"))).toBe(false);
	});

	it("uses non-last tree branch when summary line follows", () => {
		const items = [["a"], ["b", "c"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 2,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 2);
		expect(collapsed).toHaveLength(2);
		expect(collapsed[0]).toContain("├");
		expect(collapsed[0]).toContain("a");
		expect(collapsed[1]).toContain("└");
		expect(collapsed[1]).toContain("1 more item");
	});

	it("uses last tree branch when no summary follows", () => {
		const items = [["a"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 10,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed.length).toBe(1);
		expect(collapsed[0]).toContain("└");
		expect(collapsed.some(l => l.includes("more"))).toBe(false);
	});

	it("budget=0 renders nothing instead of exceeding the limit", () => {
		const items = [["a"], ["b"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 0,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed).toHaveLength(0);
	});

	it("budget exactly matching total lines shows no summary", () => {
		const items = [["a", "b"], ["c"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 3,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed.length).toBe(3);
		expect(collapsed.some(l => l.includes("more"))).toBe(false);
	});

	it("empty items do not inflate remaining count", () => {
		const items = [["a"], [], ["b"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 10,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed.length).toBe(2);
		expect(collapsed.some(l => l.includes("more"))).toBe(false);
	});

	it("maxCollapsed limits items even when line budget has room", () => {
		const items = [["a"], ["b"], ["c"], ["d"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsed: 2,
				maxCollapsedLines: 100,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 100);
		expect(collapsed).toHaveLength(3);
		expect(collapsed[2]).toContain("2 more items");
	});

	it("truncates from the start when maxCollapsed limits items", () => {
		const items = [["a"], ["b"], ["c"], ["d"], ["e"]];
		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsed: 3,
				itemType: "todo",
				truncateFrom: "start",
				renderItem: group => group,
			},
			stubTheme,
		);

		// With 5 items and maxCollapsed: 3, we show:
		// 1. Summary line: ├ … 2 more todos
		// 2. Item 'c' (index 2): ├ c
		// 3. Item 'd' (index 3): ├ d
		// 4. Item 'e' (index 4): └ e
		expect(collapsed).toHaveLength(4);
		expect(collapsed[0]).toContain("2 more todos");
		expect(collapsed[0]).toContain("├");
		expect(collapsed[1]).toBe("├ c");
		expect(collapsed[2]).toBe("├ d");
		expect(collapsed[3]).toBe("└ e");
	});

	it("truncates from the start when maxCollapsedLines limits items", () => {
		const items = [
			["a", "a2"],
			["b", "b2"],
			["c", "c2"],
			["d", "d2"],
		];
		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 5,
				itemType: "todo",
				truncateFrom: "start",
				renderItem: group => group,
			},
			stubTheme,
		);

		// items are each 2 lines. Total budget is 5.
		// Moving backwards:
		// - item 3 ('d', 'd2'): fits. lines used: 2. summary lines needed (remainingBefore > 0): 1. total = 3.
		// - item 2 ('c', 'c2'): fits. lines used: 4. summary lines needed: 1. total = 5.
		// - item 1 ('b', 'b2'): does not fit (would be 6 + 1 = 7 > 5).
		// So we show:
		// 1. Summary line: ├ … 2 more todos
		// 2. Item 'c' (2 lines: ├ c, │  c2)
		// 3. Item 'd' (2 lines: └ d,    d2)
		expectWithinBudget(collapsed, 5);
		expect(collapsed).toHaveLength(5);
		expect(collapsed[0]).toContain("2 more todos");
		expect(collapsed[1]).toBe("├ c");
		expect(collapsed[2]).toBe("│  c2");
		expect(collapsed[3]).toBe("└ d");
		expect(collapsed[4]).toBe("   d2");
	});
});
