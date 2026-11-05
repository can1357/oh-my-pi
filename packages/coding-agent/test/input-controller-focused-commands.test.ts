/**
 * Focused subagent views are chat-only, except for viewer-scoped commands: `/btw`
 * asks a side question about the focused transcript, `/export` writes the focused
 * agent's own transcript (with its nested subagents), `/jobs` lists the focused
 * agent's background jobs, `/usage` reports account-wide limits, and the model and
 * thinking controls (`/model`, `/switch`, `/effort`, their keys) act on the focused
 * agent's session. Everything else, and mutating forms such as `/usage reset` and
 * `/jobs kill`, still requires returning to main.
 *
 * Failure mode if this regresses: these commands silently do nothing (or steer the
 * agent) in a focused view, `/export` writes the main session instead of the viewed
 * one, or a model/thinking change lands on the main session instead of the agent.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

function createFocusedContext() {
	let editorText = "";
	const editor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory: vi.fn(),
		imageLinks: undefined,
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft: vi.fn(),
	};
	const prompt = vi.fn(async () => {});
	const resume = vi.fn(async () => {});
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		session: {
			isStreaming: false,
			isCompacting: false,
			extensionRunner: undefined,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
		},
		viewSession: { isStreaming: false, queuedMessageCount: 0, prompt, resume, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		collabGuest: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		handleUsageCommand: vi.fn(async () => {}),
		handleExportCommand: vi.fn(async () => {}),
		handleBtwCommand: vi.fn(async () => {}),
		handleJobsCommand: vi.fn(async () => {}),
		showResetUsageSelector: vi.fn(async () => {}),
		withLocalSubmission: vi.fn(async <T>(_text: string, fn: () => Promise<T>) => fn()),
	};
	return { ctx: ctx as unknown as InteractiveModeContext, raw: ctx, editor, prompt, resume };
}

async function submit(text: string) {
	const focused = createFocusedContext();
	const controller = new InputController(focused.ctx);
	controller.setupEditorSubmitHandler();
	focused.editor.setText(text);
	await focused.ctx.editor.onSubmit?.(text);
	return focused;
}

describe("focused subagent view slash commands", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resumes the focused session for . and c", async () => {
		for (const shortcut of [".", "c"]) {
			const { prompt, resume, editor, raw } = await submit(shortcut);
			expect(resume).toHaveBeenCalledTimes(1);
			expect(prompt).not.toHaveBeenCalled();
			expect(editor.clearDraft).toHaveBeenCalledWith(shortcut);
			expect(raw.withLocalSubmission).not.toHaveBeenCalled();
		}
	});

	it("restores a focused continue shortcut when the target is busy", async () => {
		const { ctx, raw, editor, resume } = createFocusedContext();
		resume.mockRejectedValueOnce(new AgentBusyError());
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		await ctx.editor.onSubmit?.(".");

		expect(editor.getText()).toBe(".");
		expect(raw.showError).toHaveBeenCalledTimes(1);
	});

	it("runs /usage from the focused view", async () => {
		const { raw, prompt } = await submit("/usage");
		expect(raw.handleUsageCommand).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("runs /jobs from the focused view", async () => {
		for (const [text, full] of [
			["/jobs", false],
			["/jobs full", true],
		] as const) {
			const { raw, prompt } = await submit(text);
			expect(raw.handleJobsCommand).toHaveBeenCalledTimes(1);
			expect(raw.handleJobsCommand).toHaveBeenCalledWith({ full });
			expect(prompt).not.toHaveBeenCalled();
		}
	});

	it("runs /export with its arguments from the focused view", async () => {
		const { raw, prompt } = await submit("/export out.html");
		expect(raw.handleExportCommand).toHaveBeenCalledWith("/export out.html");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("runs /btw with its question from the focused view instead of steering the agent", async () => {
		const { raw, prompt } = await submit("/btw what is it doing?");
		expect(raw.handleBtwCommand).toHaveBeenCalledWith("what is it doing?", undefined);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("answers a side file command from the focused view and releases its draft", async () => {
		const focused = createFocusedContext();
		Object.assign(focused.raw, { fileSlashCommands: new Set(["sitrep"]) });
		Object.assign(focused.raw.session, {
			slashCommands: [
				{
					name: "sitrep",
					description: "",
					content: "Report. Focus: $ARGUMENTS",
					side: true,
					source: "via OMP User",
				},
			],
		});
		const controller = new InputController(focused.ctx);
		controller.setupEditorSubmitHandler();
		focused.editor.setText("/sitrep the migration");
		await focused.ctx.editor.onSubmit?.("/sitrep the migration");
		expect(focused.raw.handleBtwCommand).toHaveBeenCalledWith(
			"Report. Focus: the migration",
			undefined,
			"/sitrep the migration",
		);
		expect(focused.editor.clearDraft).toHaveBeenCalledTimes(1);
		expect(focused.prompt).not.toHaveBeenCalled();
	});

	it("keeps a builtin gated to the main session when a side file command shares its name", async () => {
		const focused = createFocusedContext();
		Object.assign(focused.raw, { fileSlashCommands: new Set(["clear"]) });
		Object.assign(focused.raw.session, {
			slashCommands: [{ name: "clear", description: "", content: "Side", side: true, source: "via OMP User" }],
		});
		const controller = new InputController(focused.ctx);
		controller.setupEditorSubmitHandler();
		focused.editor.setText("/clear");
		await focused.ctx.editor.onSubmit?.("/clear");
		expect(focused.raw.handleBtwCommand).not.toHaveBeenCalled();
		expect(focused.raw.showStatus).toHaveBeenCalledTimes(1);
		expect(focused.editor.getText()).toBe("/clear");
	});

	it("sets the focused agent's thinking level with /effort, leaving the main session alone", async () => {
		const focused = createFocusedContext();
		const setFocusedThinking = vi.fn();
		const setMainThinking = vi.fn();
		Object.assign(focused.raw.viewSession, {
			model: { provider: "anthropic", id: "claude-sonnet", reasoning: true },
			getAvailableEffortSelectors: () => ["off", "auto", "low", "medium", "high"],
			setThinkingLevel: setFocusedThinking,
		});
		Object.assign(focused.raw.session, { setThinkingLevel: setMainThinking });
		const controller = new InputController(focused.ctx);
		controller.setupEditorSubmitHandler();
		focused.editor.setText("/effort high");
		await focused.ctx.editor.onSubmit?.("/effort high");

		expect(setFocusedThinking).toHaveBeenCalledWith("high");
		expect(setMainThinking).not.toHaveBeenCalled();
		expect(focused.prompt).not.toHaveBeenCalled();
	});

	it("opens the model selector for /model aliases from the focused view", async () => {
		const focused = createFocusedContext();
		const showModelSelector = vi.fn();
		Object.assign(focused.raw, { showModelSelector });
		const controller = new InputController(focused.ctx);
		controller.setupEditorSubmitHandler();
		focused.editor.setText("/models");
		await focused.ctx.editor.onSubmit?.("/models");

		expect(showModelSelector).toHaveBeenCalledTimes(1);
		expect(focused.prompt).not.toHaveBeenCalled();
		expect(focused.editor.getText()).toBe("");
	});

	it("cycles the focused agent's thinking level and role model, not the main session's", async () => {
		const focused = createFocusedContext();
		const focusedCycleThinking = vi.fn(() => "high");
		const focusedCycleRoles = vi.fn(async () => ({ role: "slow" }));
		const mainCycleThinking = vi.fn(() => "low");
		const mainCycleRoles = vi.fn(async () => ({ role: "default" }));
		Object.assign(focused.raw.viewSession, {
			cycleThinkingLevel: focusedCycleThinking,
			cycleRoleModels: focusedCycleRoles,
		});
		Object.assign(focused.raw.session, { cycleThinkingLevel: mainCycleThinking, cycleRoleModels: mainCycleRoles });
		Object.assign(focused.raw, {
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showModelCycleTrack: vi.fn(),
		});
		const controller = new InputController(focused.ctx);
		const settingsState = beginSettingsTest();
		try {
			await Settings.init({ inMemory: true });
			controller.cycleThinkingLevel();
			await controller.cycleRoleModel("forward");
		} finally {
			restoreSettingsTestState(settingsState);
		}

		expect(focusedCycleThinking).toHaveBeenCalledTimes(1);
		expect(focusedCycleRoles).toHaveBeenCalledTimes(1);
		expect(mainCycleThinking).not.toHaveBeenCalled();
		expect(mainCycleRoles).not.toHaveBeenCalled();
	});

	it("keeps other commands gated to the main session, draft intact", async () => {
		const { editor, prompt } = await submit("/compact");
		expect(editor.getText()).toBe("/compact");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("keeps the mutating /usage reset form gated to the main session", async () => {
		for (const text of ["/usage reset", "/usage reset anthropic/active"]) {
			const { raw, editor } = await submit(text);
			expect(raw.showResetUsageSelector).not.toHaveBeenCalled();
			expect(raw.handleUsageCommand).not.toHaveBeenCalled();
			expect(editor.getText()).toBe(text);
		}
	});

	it("keeps the mutating /jobs kill form gated to the main session", async () => {
		for (const text of ["/jobs kill all", "/jobs kill job-1"]) {
			const { raw, editor } = await submit(text);
			expect(raw.handleJobsCommand).not.toHaveBeenCalled();
			expect(raw.showStatus).toHaveBeenCalled();
			expect(editor.getText()).toBe(text);
		}
	});

	it("exports the viewed (focused) session rather than the main session", async () => {
		const mainExport = vi.fn(async () => "main.html");
		const viewExport = vi.fn(async () => "worker.html");
		const showStatus = vi.fn();
		const ctx = {
			session: { exportToHtml: mainExport },
			viewSession: { exportToHtml: viewExport },
			showStatus,
			showError: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		vi.spyOn(controller, "openInBrowser").mockImplementation(() => {});

		await controller.handleExportCommand("/export");

		expect(viewExport).toHaveBeenCalledTimes(1);
		expect(mainExport).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session exported to: worker.html");
	});
});
