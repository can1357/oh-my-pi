import { expect, it } from "bun:test";
import { ownedDebuggerTabs } from "../../../browser-relay/extension/debugger-ownership";

it("reports only tabs the extension's own debugger is attached to", async () => {
	const probed: number[] = [];
	const owned = await ownedDebuggerTabs(
		[
			{ attached: true, tabId: 1 }, // DevTools or another extension holds this one.
			{ attached: true, tabId: 2 }, // The extension's own attachment.
			{ attached: false, tabId: 3 },
			{ attached: true }, // A worker or other target without a tab.
		],
		async tabId => {
			probed.push(tabId);
			if (tabId === 1) throw new Error("Debugger is not attached to the tab with id: 1.");
			return { targetInfo: { targetId: "page-2" } };
		},
	);
	expect(owned).toEqual([2]);
	// Only tabs reported as attached are probed: no command goes to tabs nobody is debugging.
	expect(new Set(probed)).toEqual(new Set([1, 2]));
});
