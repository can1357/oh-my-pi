import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-tui/overlays/btw-history";
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

function makeRecord(): BtwHistoryRecord {
	return {
		id: "topic",
		leafId: "leaf",
		question: "Why?",
		answer: "Because.",
		status: "complete",
		createdAt: 1,
		updatedAt: 2,
	};
}

function makePanel(canBranch: boolean) {
	const onBranch = vi.fn();
	const panel = new BtwHistoryPanel({
		records: [makeRecord()],
		onClose: vi.fn(),
		onCopy: vi.fn(),
		onCancel: vi.fn(),
		canBranch: () => canBranch,
		onBranch,
		requestRender: vi.fn(),
		getHeight: () => 24,
	});
	return { panel, onBranch };
}

function textActions(panel: BtwHistoryPanel): string {
	return Bun.stripANSI(panel.render(120).join("\n"));
}

function described(panel: BtwHistoryPanel): string {
	return JSON.stringify(panel.describe());
}

const branchAction = { type: "action", act: "branch" } as NativeUiEvent;

describe("BtwHistoryPanel branch promotion", () => {
	it("offers the branch action in both renderers and runs it with b", () => {
		const { panel, onBranch } = makePanel(true);

		expect(textActions(panel)).toContain("branch to chat");
		expect(described(panel)).toContain("Branch to chat");

		panel.handleInput("b");
		expect(onBranch).toHaveBeenCalledWith(expect.objectContaining({ id: "topic" }));
	});

	it("routes the Tern branch button to the same promotion", () => {
		const { panel, onBranch } = makePanel(true);

		panel.handleNativeEvent(branchAction);
		expect(onBranch).toHaveBeenCalledWith(expect.objectContaining({ id: "topic" }));
	});

	it("keeps the action and the key out when the answer cannot branch", () => {
		const { panel, onBranch } = makePanel(false);

		expect(textActions(panel)).not.toContain("branch");
		expect(described(panel)).not.toContain("Branch to chat");

		panel.handleInput("b");
		panel.handleNativeEvent(branchAction);
		expect(onBranch).not.toHaveBeenCalled();
	});
});
