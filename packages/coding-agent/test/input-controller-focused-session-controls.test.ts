import { describe, expect, it, vi } from "bun:test";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import { InputController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";

function createHarness() {
	let editorText = "";
	const model = { provider: "test-provider", id: "focused-reasoner" } as Model;
	const mainCycleRoleModels = vi.fn(async () => ({ model: { id: "main-m" }, role: "default" }));
	const focusedCycleRoleModels = vi.fn(async () => ({ model: { id: "focused-m", name: "Focused M" }, role: "smol" }));
	const mainCycleThinkingLevel = vi.fn(() => "low" as const);
	const focusedCycleThinkingLevel = vi.fn(() => "high" as const);
	const mainSetModel = vi.fn(async () => {});
	const focusedSetModel = vi.fn(async () => {});
	const mainPrompt = vi.fn(async () => {});
	const focusedPrompt = vi.fn(async () => {});
	const showStatus = vi.fn();
	const invalidateStatusLine = vi.fn();
	const updateEditorBorderColor = vi.fn();

	const editor = {
		onSubmit: undefined as undefined | ((text: string) => Promise<void>),
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
		},
	};
	const mainSession = {
		cycleThinkingLevel: mainCycleThinkingLevel,
		cycleRoleModels: mainCycleRoleModels,
		getAvailableModels: () => [model],
		setModel: mainSetModel,
		prompt: mainPrompt,
	};
	const focusedSession = {
		isStreaming: false,
		queuedMessageCount: 0,
		cycleThinkingLevel: focusedCycleThinkingLevel,
		cycleRoleModels: focusedCycleRoleModels,
		getAvailableModels: () => [model],
		setModel: focusedSetModel,
		prompt: focusedPrompt,
	};
	const ctx = {
		editor,
		focusedAgentId: "worker",
		session: mainSession,
		viewSession: focusedSession,
		settings: { get: () => ["default", "smol"] },
		collabGuest: undefined,
		showStatus,
		statusLine: { invalidate: invalidateStatusLine },
		updateEditorBorderColor,
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		model,
		spies: {
			mainCycleThinkingLevel,
			focusedCycleThinkingLevel,
			mainCycleRoleModels,
			focusedCycleRoleModels,
			mainSetModel,
			focusedSetModel,
			mainPrompt,
			focusedPrompt,
			showStatus,
			invalidateStatusLine,
			updateEditorBorderColor,
		},
	};
}

describe("InputController focused subagent controls", () => {
	it("cycles reasoning effort on the focused subagent session", () => {
		const { ctx, spies } = createHarness();
		const controller = new InputController(ctx);

		controller.cycleThinkingLevel();

		expect(spies.focusedCycleThinkingLevel).toHaveBeenCalledTimes(1);
		expect(spies.mainCycleThinkingLevel).not.toHaveBeenCalled();
		expect(spies.invalidateStatusLine).toHaveBeenCalledTimes(1);
		expect(spies.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("cycles role models on the focused subagent session", async () => {
		const { ctx, spies } = createHarness();
		const controller = new InputController(ctx);

		await controller.cycleRoleModel();

		expect(spies.focusedCycleRoleModels).toHaveBeenCalledTimes(1);
		expect(spies.mainCycleRoleModels).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith(expect.stringContaining("worker model: Focused M"));
	});

	it("applies /model <name> to the focused subagent session", async () => {
		const { ctx, editor, model, spies } = createHarness();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.(`/model ${model.id}`);

		expect(spies.focusedSetModel).toHaveBeenCalledWith(model);
		expect(spies.mainSetModel).not.toHaveBeenCalled();
		expect(spies.focusedPrompt).not.toHaveBeenCalled();
		expect(spies.mainPrompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});
});
