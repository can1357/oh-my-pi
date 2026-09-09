import { beforeAll, describe, expect, it } from "bun:test";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

function freshSessionTree(): SessionTreeNode[] {
	// Mirror what `sdk.ts` writes on session start: a `model_change` plus a
	// `thinking_level_change`. Both are settings/bookkeeping entries that the
	// tree selector's default filter hides — a fresh session contains nothing
	// else, so the selector sees `flatNodes.length === 2`, `filteredNodes.length === 0`.
	const modelChange: SessionEntry = {
		type: "model_change",
		id: "e1",
		parentId: null,
		timestamp: new Date().toISOString(),
		model: "anthropic/claude-sonnet-4-20250514",
	};
	const thinkingChange: SessionEntry = {
		type: "thinking_level_change",
		id: "e2",
		parentId: "e1",
		timestamp: new Date().toISOString(),
		thinkingLevel: "medium",
	};
	return [
		{
			entry: modelChange,
			children: [{ entry: thinkingChange, children: [] }],
		},
	];
}

function userMessageTree(): SessionTreeNode[] {
	const entry: SessionEntry = {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "hello there", timestamp: 1 },
	};
	return [{ entry, children: [] }];
}

function renderSelector(selector: TreeSelectorComponent): string {
	const lines = (selector as unknown as { render: (w: number) => string[] }).render(120);
	return Bun.stripANSI(lines.join("\n"));
}

describe("issue #1909: tree-selector empty-state messaging", () => {
	it("explains that the filter — not missing data — is hiding entries on a fresh session", () => {
		const selector = new TreeSelectorComponent(
			freshSessionTree(),
			"e2",
			60,
			() => {},
			() => {},
		);
		const text = renderSelector(selector);

		// Filter-hiding hint and recovery key must both be present so the user knows
		// the panel isn't broken and can widen the view without leaving the screen.
		expect(text).toContain("hidden by the current filter");
		expect(text).toContain("[default]");
		expect(text.toLowerCase()).toContain("alt+a");
		// Total count must reflect the real flatNodes count, not 0/0 (otherwise the
		// "filter hides things" framing is unconvincing).
		expect(text).toContain("(0/2)");
	});

	it("explains a zero-result search as a search problem, not a filter problem", () => {
		const selector = new TreeSelectorComponent(
			userMessageTree(),
			"e1",
			60,
			() => {},
			() => {},
		);
		// Type a character that won't match anything in the tree.
		selector.handleInput("z");
		const text = renderSelector(selector);

		expect(text).toContain('No entries match search "z"');
		expect(text.toLowerCase()).toContain("backspace");
		// Must NOT misattribute the empty result to the filter mode.
		expect(text).not.toContain("hidden by the current filter");
	});

	it("falls back to the bare 'No entries found' line when the tree is genuinely empty", () => {
		const selector = new TreeSelectorComponent(
			[],
			null,
			60,
			() => {},
			() => {},
		);
		const text = renderSelector(selector);

		expect(text).toContain("No entries found");
		expect(text).toContain("(0/0)");
		// Don't tell the user to widen the filter when there's nothing to widen to.
		expect(text).not.toContain("hidden by the current filter");
	});
});
