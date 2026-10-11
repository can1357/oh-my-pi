import { expect, it } from "bun:test";
import { extensionOwnedDebuggerTabs, ownedDebuggerTabs } from "../../../browser-relay/extension/debugger-ownership";

it("reports only tabs the extension's own debugger is attached to", async () => {
	const probed: number[] = [];
	const owned = await ownedDebuggerTabs(
		[{ attached: true, tabId: 1 }, { attached: true, tabId: 2 }, { attached: false, tabId: 3 }, { attached: true }],
		async tabId => {
			probed.push(tabId);
			if (tabId === 1) throw new Error("Debugger is not attached to the tab with id: 1.");
			return { targetInfo: { targetId: "page-2" } };
		},
	);
	expect(owned).toEqual([2]);
	expect(probed).toEqual([1, 2]);
});

it("recovers an unpersisted extension attachment without claiming foreign debuggers", async () => {
	const targets = [
		{ attached: true, tabId: 1 },
		{ attached: true, tabId: 2 },
		{ attached: true, tabId: 3 },
	];
	const owned = await extensionOwnedDebuggerTabs(targets, new Set([1]), async tabId => {
		if (tabId !== 2) throw new Error("foreign debugger");
		return { targetInfo: { targetId: "page-2" } };
	});

	expect(owned).toEqual([1, 2]);
});
