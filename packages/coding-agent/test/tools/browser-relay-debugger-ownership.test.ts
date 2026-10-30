import { expect, it } from "bun:test";
import { ownedDebuggerTabs } from "../../../browser-relay/extension/debugger-ownership";

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
