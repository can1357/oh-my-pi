import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";

let darkTheme: Theme | undefined;

beforeAll(async () => {
	darkTheme = await getThemeByName("dark");
});

beforeEach(() => {
	if (!darkTheme) throw new Error("dark theme unavailable");
	setThemeInstance(darkTheme);
});

function makePanel(canBranch: () => boolean) {
	const onBranch = vi.fn();
	const panel = new BtwHistoryPanel({
		records: [
			{
				id: "topic",
				leafId: "leaf",
				question: "Why?",
				answer: "Because.",
				status: "complete",
				createdAt: 1,
				updatedAt: 2,
			},
		],
		onClose: vi.fn(),
		onCopy: vi.fn(),
		onCancel: vi.fn(),
		canBranch,
		onBranch,
		requestRender: vi.fn(),
		getHeight: () => 24,
	});
	return { panel, onBranch };
}

function findBranchAction(root: NativeNode): NativeNode | undefined {
	if (root.key === "branch" && root.p?.actions?.click) return root;
	for (const child of root.c ?? []) {
		if (!("k" in child)) continue;
		const found = findBranchAction(child);
		if (found) return found;
	}
	return undefined;
}

describe("BtwHistoryPanel branch promotion", () => {
	it("promotes the selected answer with b only while it is eligible", () => {
		let eligible = true;
		const { panel, onBranch } = makePanel(() => eligible);

		panel.handleInput("b");
		expect(onBranch).toHaveBeenCalledWith(expect.objectContaining({ id: "topic" }));

		eligible = false;
		panel.handleInput("b");
		expect(onBranch).toHaveBeenCalledTimes(1);
	});

	it("dispatches the rendered Tern button and rejects its stale action after eligibility changes", () => {
		let eligible = true;
		const { panel, onBranch } = makePanel(() => eligible);
		const button = findBranchAction(panel.describe());
		const act = button?.p?.actions?.click;
		if (!button?.key || !act) throw new Error("expected a branch button with a click action");
		const event: NativeUiEvent = { type: "action", key: `actions/${button.key}`, act, mods: [] };

		panel.handleNativeEvent(event);
		expect(onBranch).toHaveBeenCalledWith(expect.objectContaining({ id: "topic" }));

		eligible = false;
		expect(findBranchAction(panel.describe())).toBeUndefined();
		panel.handleNativeEvent(event);
		expect(onBranch).toHaveBeenCalledTimes(1);
	});
});
