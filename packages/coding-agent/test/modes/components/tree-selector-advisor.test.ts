import { afterAll, describe, expect, it } from "bun:test";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { renderTreeSelector } from "../../helpers/tree-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

interface AdvisorNoteFixture {
	note: string;
	severity?: "nit" | "concern" | "blocker";
	advisor?: string;
}

function advisorTree(...notes: AdvisorNoteFixture[]): SessionTreeNode[] {
	return [
		{
			entry: {
				type: "custom_message",
				id: "advisor-entry",
				parentId: null,
				timestamp: "2026-08-25T00:00:00.000Z",
				customType: "advisor",
				// Model-facing wrapper that must never surface in the tree row.
				content: notes.map(n => `<advisory severity="${n.severity ?? ""}">\n${n.note}\n</advisory>`).join("\n"),
				details: { notes },
				display: true,
			},
			children: [],
		},
	];
}

function render(tree: SessionTreeNode[]): string {
	return renderTreeSelector({ roots: tree, currentLeafId: tree[0]?.entry.id ?? null }, { rows: 60 });
}

describe("TreeSelectorComponent advisor message rendering", () => {
	it("shows advisor notes with severity and without their model-facing XML wrapper", () => {
		const rendered = render(advisorTree({ note: "Check error handling.", severity: "concern" }));

		expect(rendered).toContain("advisor (concern): Check error handling.");
		expect(rendered).not.toContain("[advisor]");
		expect(rendered).not.toContain("<advisory");
		expect(rendered).not.toContain("</advisory>");
	});

	it("tags a named advisor with its name before the severity", () => {
		const rendered = render(advisorTree({ note: "Nitpick.", severity: "nit", advisor: "sec" }));

		expect(rendered).toContain("advisor (sec, nit): Nitpick.");
	});

	it("omits the qualifier for a default advisor with no severity", () => {
		const rendered = render(advisorTree({ note: "Continue.", advisor: "default" }));

		expect(rendered).toContain("advisor: Continue.");
		expect(rendered).not.toContain("advisor (");
	});

	it("folds tabs/newlines in a WATCHDOG-supplied advisor name into a single-line qualifier", () => {
		const rendered = render(advisorTree({ note: "Careful.", severity: "blocker", advisor: "sec\tteam\nlead" }));

		expect(rendered).toContain("advisor (sec team lead, blocker): Careful.");
		expect(rendered).not.toContain("\t");
		expect(rendered.split("\n").filter(line => line.includes("advisor ("))).toHaveLength(1);
	});
});
