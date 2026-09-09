import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let counter = 0;
function makeNode(role: "user" | "assistant", text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${counter++}`;
	const message: AgentMessage =
		role === "user"
			? { role: "user", content: text, timestamp: counter }
			: ({
					role: "assistant",
					content: [{ type: "text", text }],
					timestamp: counter,
					stopReason: "stop",
				} as AgentMessage);
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function renderStripped(tree: SessionTreeNode[], leafId: string, width = 120): string[] {
	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		60,
		() => {},
		() => {},
	);
	return selector.renderContent(width).map(line => Bun.stripANSI(line));
}

describe("issue #7332: linear branch continuations stay compact", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	// Linear continuations should align with their branch head. Indenting them
	// another level leaves the vertical anchor disconnected from the branch
	// connector and makes heavily branched conversations drift right.
	it("aligns descendants of a last sibling with the branch head", () => {
		const root = makeNode("user", "original");
		const rootAsst = makeNode("assistant", "resp", root.entry.id);
		root.children.push(rootAsst);

		// rootAsst branches; branch2 is active (renders first), branch1 is last.
		const branch1 = makeNode("user", "branch1 head", rootAsst.entry.id);
		const branch2 = makeNode("user", "branch2 head", rootAsst.entry.id);
		rootAsst.children.push(branch1, branch2);

		// Chain descendants under branch1 (the LAST sibling) — these are the
		// rows that used to lose the gutter.
		const chain1 = makeNode("assistant", "chain-asst-1", branch1.entry.id);
		branch1.children.push(chain1);
		const chain2 = makeNode("user", "chain-user-2", chain1.entry.id);
		chain1.children.push(chain2);

		const fixIt = makeNode("user", "fix it all", branch2.entry.id);
		branch2.children.push(fixIt);

		const rendered = renderStripped([root], fixIt.entry.id);

		const findRow = (needle: string): string => {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			return row;
		};

		// Branch1 is the last sibling at level 1, so its own connector is `└─`.
		const branch1Row = findRow("user: branch1 head");
		expect(branch1Row).toMatch(/└─\s+user: branch1 head/);

		// The terminal branch has no continuing sibling gutter. Its linear
		// descendants align with the branch head instead of inventing a
		// disconnected vertical one level farther right.
		for (const needle of ["assistant: chain-asst-1", "user: chain-user-2"]) {
			const row = findRow(needle);
			expect(row).not.toContain("│");
			expect(row).toMatch(/^\s{5}\S/);
		}
	});

	// Branched grandchildren and their continuations must stay on the standard
	// tree convention so a `│` never floats below an unrelated `└─`. Only the
	// nearest connector gutter is extended for chain rows.
	it("does not extend the gutter through branched descendants of a last-sibling parent", () => {
		const root = makeNode("user", "original");
		const rootAsst = makeNode("assistant", "resp", root.entry.id);
		root.children.push(rootAsst);

		const branch1 = makeNode("user", "branch1 head", rootAsst.entry.id);
		const branch2 = makeNode("user", "branch2 head", rootAsst.entry.id);
		rootAsst.children.push(branch1, branch2);

		// branch1 itself branches into c, d (both have their own connectors),
		// and each grandchild continues linearly.
		const c = makeNode("user", "grandchild c", branch1.entry.id);
		const d = makeNode("user", "grandchild d", branch1.entry.id);
		branch1.children.push(c, d);
		const cContinuation = makeNode("assistant", "c continuation", c.entry.id);
		c.children.push(cContinuation);
		const dContinuation = makeNode("assistant", "d continuation", d.entry.id);
		d.children.push(dContinuation);

		const fixIt = makeNode("user", "fix it all", branch2.entry.id);
		branch2.children.push(fixIt);

		const rendered = renderStripped([root], fixIt.entry.id);

		// The grandchildren carry their own connectors; the inherited gutter at
		// branch1's column must stay as space so the standard `└─` semantics
		// survive for proper tree drawings.
		for (const needle of ["grandchild c", "grandchild d"]) {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			expect(row).not.toMatch(/^\s{2}│/);
			expect(row).toMatch(/[├└]─/);
		}

		// Linear continuations stay at their branch head's content depth. The
		// non-last branch keeps its sibling gutter; the terminal branch needs
		// no synthetic anchor.
		{
			const row = rendered.find(line => line.includes("c continuation"));
			if (!row) throw new Error("row containing c continuation not rendered");
			expect(row).not.toMatch(/^\s{2}│/);
			expect(row).toMatch(/^\s{5}│\s{2}\S/);
		}
		{
			const row = rendered.find(line => line.includes("d continuation"));
			if (!row) throw new Error("row containing d continuation not rendered");
			expect(row).not.toContain("│");
			expect(row).toMatch(/^\s{8}\S/);
		}
	});
});
