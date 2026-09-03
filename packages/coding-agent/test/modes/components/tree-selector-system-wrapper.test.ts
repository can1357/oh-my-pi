import { beforeAll, describe, expect, it } from "bun:test";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

function customMessageTree(customType: string, content: string): SessionTreeNode[] {
	return [
		{
			entry: {
				type: "custom_message",
				id: "wrapper-entry",
				parentId: null,
				timestamp: "2026-08-25T00:00:00.000Z",
				customType,
				content,
				display: true,
			},
			children: [],
		},
	];
}

function arrayCustomMessageTree(customType: string, blocks: string[]): SessionTreeNode[] {
	return [
		{
			entry: {
				type: "custom_message",
				id: "wrapper-entry",
				parentId: null,
				timestamp: "2026-08-25T00:00:00.000Z",
				customType,
				content: blocks.map(text => ({ type: "text" as const, text })),
				display: true,
			},
			children: [],
		},
	];
}

function searchResult(tree: SessionTreeNode[], query: string): string {
	const selector = new TreeSelectorComponent(
		tree,
		tree[0]?.entry.id ?? null,
		60,
		() => {},
		() => {},
	);
	for (const ch of query) selector.handleInput(ch);
	return Bun.stripANSI(selector.render(120).join("\n"));
}

function render(tree: SessionTreeNode[]): string {
	const selector = new TreeSelectorComponent(
		tree,
		tree[0]?.entry.id ?? null,
		60,
		() => {},
		() => {},
	);
	return Bun.stripANSI(selector.render(120).join("\n"));
}

describe("TreeSelectorComponent system-wrapper message rendering", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("strips the <system-reminder> wrapper from a mid-run-todo-nudge row", () => {
		const rendered = render(
			customMessageTree(
				"mid-run-todo-nudge",
				"<system-reminder>\n2 todo items still open. Keep working.\n</system-reminder>",
			),
		);

		expect(rendered).toContain("[mid-run-todo-nudge]: 2 todo items still open. Keep working.");
		expect(rendered).not.toContain("<system-reminder>");
		expect(rendered).not.toContain("</system-reminder>");
	});

	it("strips the <system-notice> wrapper from an async-result row", () => {
		const rendered = render(
			customMessageTree(
				"async-result",
				"<system-notice>\nBackground job bg_1 has completed.\nDone.\n</system-notice>",
			),
		);

		expect(rendered).toContain("[async-result]: Background job bg_1 has completed. Done.");
		expect(rendered).not.toContain("<system-notice>");
		expect(rendered).not.toContain("</system-notice>");
	});

	it("strips a system wrapper that carries attributes", () => {
		const rendered = render(
			customMessageTree(
				"background-tan-dispatch",
				'<system-notice reason="background_task_dispatched" job="bg_9">\nDispatched.\n</system-notice>',
			),
		);

		expect(rendered).toContain("[background-tan-dispatch]: Dispatched.");
		expect(rendered).not.toContain("<system-notice");
		expect(rendered).not.toContain("reason=");
	});

	it("strips a system wrapper whose quoted attributes contain greater-than signs", () => {
		const rendered = render(
			customMessageTree(
				"ttsr-interrupt",
				'<system-interrupt reason="rule_violation" rule="coverage > 80%" path="rules/watch>dog.md">\nOutput interrupted.\n</system-interrupt>',
			),
		);

		expect(rendered).toContain("[ttsr-interrupt]: Output interrupted.");
		expect(rendered).not.toContain("coverage > 80%");
		expect(rendered).not.toContain("watch>dog.md");
	});

	it("preserves system tags contained in an async-result payload", () => {
		const rendered = render(
			customMessageTree(
				"async-result",
				"<system-notice>\nResult: <system-reminder>literal payload</system-reminder>\n</system-notice>",
			),
		);

		expect(rendered).toContain("[async-result]: Result: <system-reminder>literal payload</system-reminder>");
		expect(rendered).not.toContain("<system-notice>");
	});

	it("leaves a long unterminated system-looking message unchanged without stalling", () => {
		const rendered = render(customMessageTree("async-result", `<system-notice>${" ".repeat(5_000)}`));

		expect(rendered).toContain("[async-result]: <system-notice>");
	});

	it("keeps the outer wrapper out of the search index for a long array-valued message", () => {
		const body = `Background job bg_1 completed. ${"detail ".repeat(60)}`.trim();
		const tree = arrayCustomMessageTree("async-result", [`<system-notice>\n${body}\n</system-notice>`]);

		expect(searchResult(tree, "system-notice")).toContain("No entries match");
		expect(searchResult(tree, "Background")).not.toContain("No entries match");
	});
});
