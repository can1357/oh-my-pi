import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as thinkingSelectorModule from "@oh-my-pi/pi-tui/overlays/thinking-selector";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
interface CapturedEffortPrompt {
	current: Effort;
	levels: Effort[];
	onSelect: (level: Effort) => void;
	onCancel: () => void;
}

let captured: CapturedEffortPrompt | undefined;

vi.spyOn(thinkingSelectorModule, "ThinkingSelectorComponent").mockImplementation(function (...args: unknown[]) {
	const [current, levels, onSelect, onCancel] = args as [Effort, Effort[], (level: Effort) => void, () => void];
	captured = { current, levels, onSelect, onCancel };
	return {};
} as never);

afterEach(() => {
	captured = undefined;
	vi.clearAllMocks();
});

const reasoningModel = {
	provider: "anthropic",
	id: "claude-opus-4-5",
	reasoning: true,
	thinking: { efforts: [ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.High] },
} as unknown as Model;

const plainModel = {
	provider: "anthropic",
	id: "claude-opus-4-5",
	reasoning: false,
} as unknown as Model;

function start(configuredThinkingLevel: ConfiguredThinkingLevel | undefined = undefined) {
	const setModelTemporary = vi.fn(async () => {});
	const resolveTemporaryModelThinkingLevel = vi.fn(() => undefined);
	const showOverlay = vi.fn(() => ({ hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false }));
	const ctx = createInteractiveModeContext({
		session: {
			getContextUsage: () => undefined,
			configuredThinkingLevel: () => configuredThinkingLevel,
			resolveTemporaryModelThinkingLevel,
			setModelTemporary,
		},
		ui: {
			showOverlay,
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		},
	});
	return {
		ctx,
		controller: new SelectorController(ctx),
		setModelTemporary,
		resolveTemporaryModelThinkingLevel,
		showOverlay,
	};
}

describe("SelectorController.switchSessionModel effort prompt", () => {
	it("applies an explicit :level without prompting", async () => {
		const harness = start();

		await harness.controller.switchSessionModel(reasoningModel, ThinkingLevel.High);

		expect(harness.showOverlay).not.toHaveBeenCalled();
		expect(harness.setModelTemporary).toHaveBeenCalledWith(reasoningModel, ThinkingLevel.High);
	});

	it("offers the target's efforts and applies the chosen one", async () => {
		const harness = start(ThinkingLevel.Medium);

		const switched = harness.controller.switchSessionModel(reasoningModel);
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		if (!captured) throw new Error("effort prompt was not shown");
		expect(captured.levels).toEqual([ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.High]);
		expect(captured.current).toBe(ThinkingLevel.Medium);

		captured.onSelect(ThinkingLevel.High);
		await switched;

		expect(harness.setModelTemporary).toHaveBeenCalledWith(reasoningModel, ThinkingLevel.High);
	});

	it("cancelling the prompt keeps the previous fallback behavior", async () => {
		const harness = start();

		const switched = harness.controller.switchSessionModel(reasoningModel);
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		if (!captured) throw new Error("effort prompt was not shown");

		captured.onCancel();
		await switched;

		expect(harness.resolveTemporaryModelThinkingLevel).toHaveBeenCalledWith(reasoningModel);
		expect(harness.setModelTemporary).toHaveBeenCalledWith(reasoningModel, undefined);
	});

	it("switches immediately with no prompt for non-reasoning models", async () => {
		const harness = start();

		await harness.controller.switchSessionModel(plainModel);

		expect(harness.showOverlay).not.toHaveBeenCalled();
		expect(harness.setModelTemporary).toHaveBeenCalledWith(plainModel, undefined);
	});
});
