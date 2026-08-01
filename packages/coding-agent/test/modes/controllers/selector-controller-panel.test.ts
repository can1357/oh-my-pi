import { beforeAll, describe, expect, it, vi } from "bun:test";
import { PanelConfirmationComponent } from "@oh-my-pi/pi-coding-agent/modes/components/panel-confirmation";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { PanelRunPlan, PanelRunPreview, PanelRunResult } from "@oh-my-pi/pi-coding-agent/panel";

const ENTER = "\r";
const DOWN = "\x1b[B";

beforeAll(async () => {
	await initTheme();
});

function preview(): PanelRunPreview {
	return {
		role: {
			roleId: "frontier",
			role: {
				strategy: "independent",
				members: [{ model: "anthropic/claude-opus-4-5" }, { model: "openai/gpt-5.5" }],
			},
		},
		members: [
			{
				index: 0,
				model: "anthropic/claude-opus-4-5",
				selector: "anthropic/claude-opus-4-5",
				modelId: "claude-opus-4-5",
				family: "claude",
			},
			{
				index: 1,
				model: "openai/gpt-5.5",
				selector: "openai/gpt-5.5",
				modelId: "gpt-5.5",
				family: "gpt",
			},
		],
	};
}

function result(statuses: Array<"completed" | "failed" | "aborted">, cancelled = false): PanelRunResult {
	const resolved = preview();
	return {
		role: resolved.role,
		members: resolved.members,
		results: statuses.map((status, index) => ({
			member: resolved.members[index]!,
			status,
			output: status === "completed" ? "completed output" : "",
			truncated: false,
			durationMs: 1,
			tokens: 1,
			requests: 1,
			cost: 0,
		})),
		cancelled,
		usage: { tokens: statuses.length, requests: statuses.length, cost: 0 },
		synthesisInput: "synthesis prompt",
	};
}

function createHarness(panelResult: PanelRunResult) {
	const editor = { id: "editor" };
	const editorContainer = {
		children: [editor] as unknown[],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const showStatus = vi.fn();
	const completion = Promise.withResolvers<PanelRunResult>();
	const plan = {
		preview: preview(),
		taskMode: "answer",
		request: "review this change",
	} as PanelRunPlan;
	const runPanel = vi.fn(options => {
		options.onProgress({ id: "member-1", status: panelResult.results[0]!.status });
		return completion.promise;
	});
	const ctx = {
		editor,
		editorContainer,
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		showStatus,
		session: { preparePanelRun: vi.fn(() => plan), runPanel },
	} as unknown as InteractiveModeContext;
	return {
		controller: new SelectorController(ctx),
		editorContainer,
		finishPanel: () => completion.resolve(panelResult),
		runPanel,
		showStatus,
		plan,
	};
}

function currentConfirmation(editorContainer: { children: unknown[] }): PanelConfirmationComponent {
	const component = editorContainer.children[0];
	if (!(component instanceof PanelConfirmationComponent)) throw new Error("Expected a panel confirmation");
	return component;
}

describe("SelectorController panel confirmations", () => {
	it("reviews the resolved lineup, reports progress, and discards partial synthesis on cancel", async () => {
		const h = createHarness(result(["completed", "aborted"], true));
		const pending = h.controller.runPanelWithConfirmation({ taskMode: "answer", request: "review this change" });

		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);
		await Promise.resolve();
		expect(h.runPanel).toHaveBeenCalledWith(
			expect.objectContaining({ taskMode: "answer", request: "review this change", plan: h.plan }),
		);
		expect(h.showStatus).toHaveBeenCalledWith("Panel: 1 completed, 0 failed, 0 aborted, 0 running, 1 pending.");

		h.finishPanel();
		await Promise.resolve();
		currentConfirmation(h.editorContainer).getSelectList().handleInput(DOWN);
		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);
		await expect(pending).resolves.toBeUndefined();
		expect(h.showStatus).toHaveBeenLastCalledWith("Panel partial synthesis discarded.");
	});

	it("does not dispatch when the resolved-lineup review is declined", async () => {
		const h = createHarness(result(["completed", "completed"]));
		const pending = h.controller.runPanelWithConfirmation({ taskMode: "answer", request: "review this change" });

		currentConfirmation(h.editorContainer).getSelectList().handleInput(DOWN);
		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);
		await expect(pending).resolves.toBeUndefined();
		expect(h.runPanel).not.toHaveBeenCalled();
	});

	it("returns retained results only after partial synthesis is approved", async () => {
		const panelResult = result(["completed", "aborted"], true);
		const h = createHarness(panelResult);
		const pending = h.controller.runPanelWithConfirmation({ taskMode: "answer", request: "review this change" });

		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);
		await Promise.resolve();
		h.finishPanel();
		await Promise.resolve();
		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);
		await expect(pending).resolves.toEqual(panelResult);
	});

	it("requires partial-synthesis confirmation after cancellation with all members completed", async () => {
		const panelResult = result(["completed", "completed"], true);
		const h = createHarness(panelResult);
		const pending = h.controller.runPanelWithConfirmation({ taskMode: "answer", request: "review this change" });

		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);
		await Promise.resolve();
		h.finishPanel();
		await Promise.resolve();
		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);
		await expect(pending).resolves.toEqual(panelResult);
	});

	it("synthesizes a member-only abort without a cancellation prompt", async () => {
		const panelResult = result(["completed", "aborted"]);
		const h = createHarness(panelResult);
		const pending = h.controller.runPanelWithConfirmation({ taskMode: "plan", request: "plan this change" });

		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);
		await Promise.resolve();
		h.finishPanel();
		await expect(pending).resolves.toEqual(panelResult);
		expect(h.editorContainer.children).toEqual([{ id: "editor" }]);
	});

	it("skips the partial-synthesis prompt when no member completed", async () => {
		const h = createHarness(result(["aborted", "aborted"], true));
		const pending = h.controller.runPanelWithConfirmation({ taskMode: "plan", request: "plan this change" });
		currentConfirmation(h.editorContainer).getSelectList().handleInput(ENTER);

		await Promise.resolve();
		h.finishPanel();
		await Promise.resolve();
		await expect(pending).resolves.toBeUndefined();
		expect(h.showStatus).toHaveBeenLastCalledWith("Panel cancelled before any member completed.");
		expect(h.editorContainer.children).toEqual([{ id: "editor" }]);
	});
});
