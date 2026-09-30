import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "bun:test";
import { ThinkingLevel, type ThinkingLevel as ThinkingLevelType } from "@oh-my-pi/pi-agent-core";
import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ModelPickerCallbacks } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as thinkingSelectorModule from "@oh-my-pi/pi-tui/overlays/thinking-selector";
import * as modelPickerModule from "@oh-my-pi/pi-tui/overlays/model-picker";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

interface CapturedEffortPrompt {
	current: Effort;
	levels: Effort[];
	onSelect: (level: Effort) => void;
	onCancel: () => void;
}

let captured: CapturedEffortPrompt | undefined;
let pickerCallbacks: ModelPickerCallbacks | undefined;

beforeEach(() => {
	vi.spyOn(thinkingSelectorModule, "ThinkingSelectorComponent").mockImplementation(function (...args: unknown[]) {
		const [current, levels, onSelect, onCancel] = args as [Effort, Effort[], (level: Effort) => void, () => void];
		captured = { current, levels, onSelect, onCancel };
		return {};
	} as never);
});

afterEach(() => {
	captured = undefined;
	pickerCallbacks = undefined;
	vi.restoreAllMocks();
});

const EFFORTS = [ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.High];

const reasoningModel = {
	provider: "anthropic",
	id: "claude-opus-4-5",
	reasoning: true,
	thinking: { efforts: EFFORTS },
} as unknown as Model;

const defaultedModel = {
	provider: "anthropic",
	id: "claude-opus-4-5",
	reasoning: true,
	thinking: { efforts: EFFORTS, defaultLevel: ThinkingLevel.High },
} as unknown as Model;

const plainModel = {
	provider: "anthropic",
	id: "claude-opus-4-5",
	reasoning: false,
} as unknown as Model;

function start(options?: {
	roleLevel?: ConfiguredThinkingLevel;
	currentLevel?: ThinkingLevelType | undefined;
	configured?: ConfiguredThinkingLevel;
}) {
	const setModelTemporary = vi.fn(async () => {});
	const resolveTemporaryModelThinkingLevel = vi.fn(() => options?.roleLevel);
	const compact = vi.fn(async () => "ok" as const);
	const shownHides: Array<Mock<() => void>> = [];
	const showOverlay = vi.fn(() => {
		const hide = vi.fn(() => {});
		shownHides.push(hide);
		return { hide, setHidden: () => {}, isHidden: () => false };
	});
	const ctx = createInteractiveModeContext({
		session: {
			getContextUsage: () => undefined,
			thinkingLevel: options?.currentLevel,
			configuredThinkingLevel: () => options?.configured,
			resolveTemporaryModelThinkingLevel,
			setModelTemporary,
			scopedModels: [],
			getRoleModelCycle: () => undefined,
		},
		ui: {
			showOverlay,
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		},
		handleCompactCommand: compact,
	});
	return {
		ctx,
		controller: new SelectorController(ctx),
		setModelTemporary,
		resolveTemporaryModelThinkingLevel,
		showOverlay,
		shownHides,
		compact,
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
		const harness = start({ roleLevel: ThinkingLevel.Medium });

		const switched = harness.controller.switchSessionModel(reasoningModel);
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		if (!captured) throw new Error("effort prompt was not shown");
		expect(captured.levels).toEqual(EFFORTS);
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

	it("preselects the model's default when the role level is auto", async () => {
		const harness = start({ roleLevel: "auto", currentLevel: ThinkingLevel.Medium });

		const switched = harness.controller.switchSessionModel(defaultedModel);
		if (!captured) throw new Error("effort prompt was not shown");
		expect(captured.current).toBe(ThinkingLevel.High);

		captured.onCancel();
		await switched;
	});

	it("preselects the current effective level when the role level is off and there is no default", async () => {
		const harness = start({ roleLevel: ThinkingLevel.Off, currentLevel: ThinkingLevel.Low });

		const switched = harness.controller.switchSessionModel(reasoningModel);
		if (!captured) throw new Error("effort prompt was not shown");
		expect(captured.current).toBe(ThinkingLevel.Low);

		captured.onCancel();
		await switched;
	});

	it("skips the prompt when the session runs auto", async () => {
		const harness = start({ configured: AUTO_THINKING, currentLevel: ThinkingLevel.Medium });

		await harness.controller.switchSessionModel(reasoningModel);

		expect(harness.showOverlay).not.toHaveBeenCalled();
		expect(harness.setModelTemporary).toHaveBeenCalledWith(reasoningModel, undefined);
	});

	it("skips the prompt when thinking is off", async () => {
		const harness = start({ configured: ThinkingLevel.Off, currentLevel: ThinkingLevel.Off });

		await harness.controller.switchSessionModel(reasoningModel);

		expect(harness.showOverlay).not.toHaveBeenCalled();
		expect(harness.setModelTemporary).toHaveBeenCalledWith(reasoningModel, undefined);
	});

	it("switches immediately with no prompt for non-reasoning models", async () => {
		const harness = start();

		await harness.controller.switchSessionModel(plainModel);

		expect(harness.showOverlay).not.toHaveBeenCalled();
		expect(harness.setModelTemporary).toHaveBeenCalledWith(plainModel, undefined);
	});

	it("prompts for effort after an alt+p picker pick", async () => {
		vi.spyOn(modelPickerModule, "ModelPickerComponent").mockImplementation(function (...args: unknown[]) {
			pickerCallbacks = args[4] as ModelPickerCallbacks;
			return {};
		} as never);
		const harness = start({ currentLevel: ThinkingLevel.Medium });

		harness.controller.showModelSelector({ temporaryOnly: true });
		if (!pickerCallbacks) throw new Error("model picker was not shown");

		const picked = pickerCallbacks.onPick(reasoningModel, "anthropic/claude-opus-4-5", {
			overContext: false,
		}) as unknown as Promise<void>;
		if (!captured) throw new Error("effort prompt was not shown");
		expect(captured.current).toBe(ThinkingLevel.Medium);

		captured.onSelect(ThinkingLevel.High);
		await picked;

		expect(harness.setModelTemporary).toHaveBeenCalledWith(reasoningModel, ThinkingLevel.High);
		// Both the effort prompt and the picker close.
		expect(harness.showOverlay).toHaveBeenCalledTimes(2);
		expect(harness.shownHides).toHaveLength(2);
		for (const hide of harness.shownHides) expect(hide).toHaveBeenCalledTimes(1);
	});

	it("prompts before compacting on an over-context picker pick", async () => {
		vi.spyOn(modelPickerModule, "ModelPickerComponent").mockImplementation(function (...args: unknown[]) {
			pickerCallbacks = args[4] as ModelPickerCallbacks;
			return {};
		} as never);
		const harness = start({ currentLevel: ThinkingLevel.Medium });

		harness.controller.showModelSelector({ temporaryOnly: true });
		if (!pickerCallbacks) throw new Error("model picker was not shown");

		const picked = pickerCallbacks.onPick(reasoningModel, "anthropic/claude-opus-4-5", {
			overContext: true,
		}) as unknown as Promise<void>;
		// The effort choice precedes compaction: no compaction starts while
		// the prompt is open.
		if (!captured) throw new Error("effort prompt was not shown");
		expect(harness.compact).not.toHaveBeenCalled();

		captured.onSelect(ThinkingLevel.High);
		await picked;

		expect(harness.compact).toHaveBeenCalledTimes(1);
		expect(harness.setModelTemporary).toHaveBeenCalledWith(reasoningModel, ThinkingLevel.High);
		const [, effortShownAt] = harness.showOverlay.mock.invocationCallOrder;
		const [compactAt] = harness.compact.mock.invocationCallOrder;
		const [appliedAt] = harness.setModelTemporary.mock.invocationCallOrder;
		expect(effortShownAt).toBeLessThan(compactAt);
		expect(compactAt).toBeLessThan(appliedAt);
	});
});
