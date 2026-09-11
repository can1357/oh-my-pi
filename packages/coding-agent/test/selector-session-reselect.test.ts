import { describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

function makeController(current: Model, live: ConfiguredThinkingLevel | undefined, roleLevel: ThinkingLevel) {
	const setModelTemporary = vi.fn(async (_model: Model, _level?: ConfiguredThinkingLevel) => {});
	const controller = new SelectorController({
		session: {
			model: current,
			getContextUsage: () => ({ tokens: 0 }),
			configuredThinkingLevel: () => live,
			resolveTemporaryModelThinkingLevel: () => roleLevel,
			setModelTemporary,
		},
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		keybindings: { getKeys: () => [] as string[] },
	} as unknown as InteractiveModeContext);
	return { controller, setModelTemporary };
}

describe("switchSessionModel reselect", () => {
	test("reselecting the active model preserves the live session effort", async () => {
		// P2 (PR #11330, reselect-active-model thread): session-only high on a
		// model whose role pins low. The picker row advertises high, so Enter
		// must keep high instead of re-resolving the role default.
		const current = makeModel("test", "session-model");
		const { controller, setModelTemporary } = makeController(current, ThinkingLevel.High, ThinkingLevel.Low);

		await controller.switchSessionModel(current);

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary).toHaveBeenCalledWith(current, ThinkingLevel.High);
	});

	test("reselecting the active model preserves auto mode", async () => {
		// Same thread: in auto mode the row advertises auto, so reselecting
		// must keep the auto selector rather than pinning a role level.
		const current = makeModel("test", "session-model");
		const { controller, setModelTemporary } = makeController(current, AUTO_THINKING, ThinkingLevel.Low);

		await controller.switchSessionModel(current);

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary).toHaveBeenCalledWith(current, AUTO_THINKING);
	});

	test("picking a different model still resolves the role default", async () => {
		// The preserve path is same-model only: switching models keeps the
		// long-standing resolve-temporary behavior.
		const current = makeModel("test", "session-model");
		const other = makeModel("test", "other-model");
		const { controller, setModelTemporary } = makeController(current, ThinkingLevel.High, ThinkingLevel.Low);

		await controller.switchSessionModel(other);

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary).toHaveBeenCalledWith(other, ThinkingLevel.Low);
	});
	test("reselecting the active row at no effort applies nothing", async () => {
		// P2 (PR #11330, reselect-undefined thread): the session is
		// deliberately at inherit/no effort and the row renders terminal
		// with no badge. Reselecting must not fall through to a sibling
		// role's level, so the switch is skipped entirely.
		const current = makeModel("test", "session-model");
		const { controller, setModelTemporary } = makeController(current, undefined, ThinkingLevel.Low);

		await controller.switchSessionModel(current);

		expect(setModelTemporary).not.toHaveBeenCalled();
	});
});
