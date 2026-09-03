import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, AgentBusyError, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import type { HookSelectorSlider } from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import {
	type PlanReviewAnnotationState,
	PlanReviewOverlay,
} from "@oh-my-pi/pi-coding-agent/modes/components/plan-review-overlay";
import { InteractiveMode, planSaveFileName } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SILENT_ABORT_MARKER, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { type OverlayHandle, type OverlayOptions, setKeybindings } from "@oh-my-pi/pi-tui";
import { formatNumber, TempDir } from "@oh-my-pi/pi-utils";

/**
 * Matches the plan-approved synthetic-prompt dispatch. `#approvePlan` calls
 * `session.prompt(rendered, { synthetic: true })` exclusively for that case,
 * so the `synthetic: true` option flag is the unique discriminator.
 */
const isPlanApprovedCall = (args: unknown[]): boolean =>
	args.length >= 2 &&
	typeof args[0] === "string" &&
	typeof args[1] === "object" &&
	args[1] !== null &&
	(args[1] as { synthetic?: boolean }).synthetic === true;

function usageWithInput(input: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantWithUsage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: usageWithInput(0),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function compactNumber(value: number): string {
	return formatNumber(value).toLowerCase();
}

describe("InteractiveMode plan review rendering", () => {
	// Per-test, mutated by tests (planMode flags, spies, model roles, dispose/recreate).
	let tempDir: TempDir;
	let session: AgentSession;
	let mode: InteractiveMode;
	// Shared across the whole describe: global Settings initialization, AuthStorage
	// (a SQLite db), and ModelRegistry are immutable inputs here. Tests mutate only
	// their per-session Settings.isolated() instances, so rebuilding these process-
	// global resources for every InteractiveMode adds I/O without isolation.
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		sharedTempDir = TempDir.createSync("@pi-plan-review-shared-");
		await Settings.init({ inMemory: true, cwd: sharedTempDir.path() });
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage?.close();
		sharedTempDir?.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-plan-review-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		const currentMode = mode;
		const currentSession = session;
		const currentTempDir = tempDir;
		mode = undefined as unknown as InteractiveMode;
		session = undefined as unknown as AgentSession;
		tempDir = undefined as unknown as TempDir;
		currentMode?.stop();
		await currentSession?.dispose();
		currentTempDir?.removeSync();
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("exits empty plan mode without confirmation", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "\n\t\n");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const confirm = vi.spyOn(mode, "showHookConfirm");

		await mode.handlePlanModeCommand();

		expect(confirm).not.toHaveBeenCalled();
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(true);
	});

	it("keeps confirmation before exiting a non-empty plan", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nDo the thing.\n");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const confirm = vi.spyOn(mode, "showHookConfirm").mockResolvedValue(false);

		await mode.handlePlanModeCommand();

		expect(confirm).toHaveBeenCalledWith("Exit plan mode?", "This exits plan mode without approving a plan.");
		expect(mode.planModeEnabled).toBe(true);
	});

	it("keeps confirmation when a slug plan file exists", async () => {
		const defaultPlanFilePath = "local://PLAN.md";
		const slugPlanFilePath = "local://auth-token-refresh-plan.md";
		const defaultPlanPath = resolveLocalUrlToPath(defaultPlanFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const slugPlanPath = resolveLocalUrlToPath(slugPlanFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(defaultPlanPath, "\n");
		await Bun.write(slugPlanPath, "# Auth token refresh plan\n\nDo the thing.\n");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = defaultPlanFilePath;
		const confirm = vi.spyOn(mode, "showHookConfirm").mockResolvedValue(false);

		await mode.handlePlanModeCommand();

		expect(confirm).toHaveBeenCalledWith("Exit plan mode?", "This exits plan mode without approving a plan.");
		expect(mode.planModeEnabled).toBe(true);
	});

	it("forwards each submitted plan to the review overlay", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# First plan\n\nalpha");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const review = vi.spyOn(mode, "showPlanReview").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(review.mock.calls[0]?.[0]).toContain("First plan");

		await Bun.write(resolvedPlanPath, "# Second plan\n\nbeta");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// Each approval shows the current plan in the overlay, not a stale one.
		expect(review.mock.calls[1]?.[0]).toContain("Second plan");
		expect(review.mock.calls[1]?.[0]).not.toContain("First plan");
	});

	it("restores dismissed annotations only when reopening the same plan", async () => {
		const firstPlanFilePath = "local://first-plan.md";
		const secondPlanFilePath = "local://second-plan.md";
		const localOptions = {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		};
		await Bun.write(resolveLocalUrlToPath(firstPlanFilePath, localOptions), "# First plan\n\nbody");
		await Bun.write(resolveLocalUrlToPath(secondPlanFilePath, localOptions), "# Second plan\n\nbody");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = firstPlanFilePath;
		const annotationState: PlanReviewAnnotationState = {
			annotations: [
				{
					section: { index: 0, title: "First plan" },
					target: { kind: "line", row: 2, context: "body" },
					note: "Add the rollback path.",
				},
			],
		};
		const restoredStates: Array<PlanReviewAnnotationState | undefined> = [];
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			restoredStates.push(dialogOptions?.annotationState);
			if (restoredStates.length === 1) dialogOptions?.onAnnotationStateChange?.(annotationState);
			return undefined;
		});

		await mode.handlePlanApproval({ planFilePath: firstPlanFilePath, planExists: true, title: "FIRST" });
		await mode.handlePlanApproval({ planFilePath: firstPlanFilePath, planExists: true, title: "FIRST" });
		await mode.handlePlanApproval({ planFilePath: secondPlanFilePath, planExists: true, title: "SECOND" });

		expect(restoredStates).toEqual([undefined, annotationState, undefined]);
	});

	it("consumes annotations after Refine dispatches their feedback", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const annotationState: PlanReviewAnnotationState = {
			annotations: [
				{
					section: { index: 0, title: "Plan" },
					target: { kind: "line", row: 2, context: "body" },
					note: "Clarify the rollback path.",
				},
			],
		};
		const feedback = "Refinement feedback on the plan:\n\n> Line: body\n- Clarify the rollback path.\n";
		let reviewCount = 0;
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			reviewCount++;
			if (reviewCount === 1) {
				dialogOptions?.onAnnotationStateChange?.(annotationState);
				dialogOptions?.onFeedbackChange?.(feedback);
				return "Refine plan";
			}
			expect(dialogOptions?.annotationState).toBeUndefined();
			return undefined;
		});
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });
		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(promptSpy).toHaveBeenCalledWith(feedback);
	});

	it("retains queued Refine annotations until the pending submission starts", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const annotationState: PlanReviewAnnotationState = {
			annotations: [
				{
					section: { index: 0, title: "Plan" },
					target: { kind: "line", row: 2, context: "body" },
					note: "Clarify the rollback path.",
				},
			],
		};
		const feedback = "Refinement feedback on the plan:\n\n> Line: body\n- Clarify the rollback path.\n";
		const restoredStates: Array<PlanReviewAnnotationState | undefined> = [];
		let reviewCount = 0;
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			reviewCount++;
			restoredStates.push(dialogOptions?.annotationState);
			if (reviewCount === 1) dialogOptions?.onAnnotationStateChange?.(annotationState);
			if (reviewCount <= 2) {
				dialogOptions?.onFeedbackChange?.(feedback);
				return "Refine plan";
			}
			return undefined;
		});
		const submissions: SubmittedUserInput[] = [];
		mode.onInputCallback = input => submissions.push(input);
		const promptSpy = vi.spyOn(session, "prompt");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });
		expect(mode.cancelPendingSubmission()).toBe(true);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });
		expect(mode.markPendingSubmissionStarted(submissions[1]!)).toBe(true);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(restoredStates).toEqual([undefined, annotationState, undefined]);
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("re-prompts the model with annotation feedback when Refine is chosen", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const feedback = "Refinement feedback on the plan:\n\n## Goal\n- needs detail\n";
		// The overlay reports annotation feedback through onFeedbackChange before the
		// operator picks "Refine plan".
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			dialogOptions?.onFeedbackChange?.(feedback);
			return "Refine plan";
		});
		const startSpy = vi
			.spyOn(mode, "startPendingSubmission")
			.mockReturnValue({ text: feedback, cancelled: false, started: false });
		const onInput = vi.fn();
		mode.onInputCallback = onInput;

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("needs detail") }));
		expect(onInput).toHaveBeenCalledTimes(1);
	});

	it("promotes the reviewed plan path into plan-mode state before refining", async () => {
		const resolve = (url: string) =>
			resolveLocalUrlToPath(url, {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			});
		const oldPlanPath = "local://old-plan.md";
		const newPlanPath = "local://new-draft-plan.md";
		await Bun.write(resolve(oldPlanPath), "# Old\n\nold body");
		await Bun.write(resolve(newPlanPath), "# New\n\nnew body");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = oldPlanPath;
		// State still points at the previously reviewed (older) plan.
		session.setPlanModeState({ enabled: true, planFilePath: oldPlanPath, workflow: "parallel", reentry: true });

		const feedback = "Refinement feedback:\n- add more detail\n";
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			dialogOptions?.onFeedbackChange?.(feedback);
			return "Refine plan";
		});
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath: newPlanPath, planExists: true, title: "NEW" });

		expect(session.getPlanModeState()?.planFilePath).toBe(newPlanPath);
	});

	it("opens the annotation external editor from the real plan review overlay", async () => {
		const editorPath = path.join(tempDir.path(), "annotation-editor.sh");
		await Bun.write(
			editorPath,
			"#!/bin/sh\nprintf '%s\\n%s\\n' '- add rollback command' '- include smoke test' > \"$1\"\n",
		);
		await fs.chmod(editorPath, 0o755);
		const previousEditor = Bun.env.EDITOR;
		const previousVisual = Bun.env.VISUAL;
		const keybindings = KeybindingsManager.inMemory({
			"app.editor.external": "ctrl+e",
			"tui.select.cancel": "ctrl+g",
		});
		mode.keybindings = keybindings;
		setKeybindings(keybindings);
		let capturedOverlay: PlanReviewOverlay | undefined;
		vi.spyOn(mode.ui, "showOverlay").mockImplementation(component => {
			capturedOverlay = component as PlanReviewOverlay;
			return { hide: vi.fn() } as never;
		});
		let feedback = "";
		// Resolve the instant the real $EDITOR subprocess commits its output back
		// through onFeedbackChange — a deterministic signal, not a polled timer.
		const { promise: editorApplied, resolve: markEditorApplied } = Promise.withResolvers<void>();

		try {
			Bun.env.EDITOR = editorPath;
			delete Bun.env.VISUAL;
			const choice = mode.showPlanReview(
				"# Plan\n\nIntro\n\n## Rollout\n\nSteps\n\n## Verify\n\nChecks\n",
				"Plan mode - next step",
				["Approve and execute", "Refine plan"],
				{
					onFeedbackChange: value => {
						feedback = value;
						if (value.includes("- include smoke test")) markEditorApplied();
					},
				},
			);

			expect(capturedOverlay).toBeDefined();
			const overlay = capturedOverlay!;
			overlay.render(80);
			overlay.handleInput("\t"); // -> toc (Rollout)
			overlay.handleInput("a");
			for (const ch of "draft") overlay.handleInput(ch);
			overlay.handleInput("\x05"); // ctrl+e
			// The subprocess is real; block on its commit signal instead of polling.
			await editorApplied;
			expect(feedback).toContain("## Rollout\n```md\n- add rollback command\n- include smoke test\n```");

			overlay.handleInput("\x1b[B"); // Rollout -> Verify
			overlay.handleInput("\x1b[B"); // toc -> actions
			overlay.handleInput("\x1b[B"); // select Refine plan
			overlay.handleInput("\r");
			expect(await choice).toBe("Refine plan");
		} finally {
			if (previousEditor === undefined) delete Bun.env.EDITOR;
			else Bun.env.EDITOR = previousEditor;
			if (previousVisual === undefined) delete Bun.env.VISUAL;
			else Bun.env.VISUAL = previousVisual;
		}
	});

	it("leaves terminal mouse tracking disabled while Plan Review is open", async () => {
		let capturedOverlay: PlanReviewOverlay | undefined;
		let capturedOptions: OverlayOptions | undefined;
		const overlayHandle: OverlayHandle = {
			hide: vi.fn(),
			setHidden: vi.fn(),
			isHidden: vi.fn(() => false),
		};
		vi.spyOn(mode.ui, "showOverlay").mockImplementation((component, options) => {
			if (!(component instanceof PlanReviewOverlay)) throw new Error("Expected Plan Review overlay");
			capturedOverlay = component;
			capturedOptions = options;
			return overlayHandle;
		});

		const choice = mode.showPlanReview("# Plan\n\nSelectable body", "Plan mode - next step", ["Approve"]);

		expect(capturedOptions).toMatchObject({ fullscreen: true, mouseTracking: false });
		capturedOverlay?.handleInput("\x1b");
		await expect(choice).resolves.toBeUndefined();
	});

	it("dismisses Plan Review and restores input when a provider error is pinned", async () => {
		mode.ui.setFocus(mode.editor);
		const choice = mode.showPlanReview("# Plan\n\nReady for approval.", "Plan mode - next step", ["Approve"]);

		expect(mode.ui.hasOverlay()).toBe(true);

		mode.showPinnedError("Codex rate limit reached");

		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.errorBannerContainer.render(80).join("\n")).toContain("Codex rate limit reached");
		await expect(choice).resolves.toBeUndefined();
	});

	it("copies the overlay's current edited plan markdown from the real plan review overlay", async () => {
		let capturedOverlay: PlanReviewOverlay | undefined;
		const overlayHandle = { hide: vi.fn() };
		vi.spyOn(mode.ui, "showOverlay").mockImplementation(component => {
			capturedOverlay = component as PlanReviewOverlay;
			return overlayHandle as never;
		});
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const statusSpy = vi.spyOn(mode, "showStatus");
		const constructorPlan = "# Plan\n\nOriginal constructor body.\n";
		const editedPlan = "# Plan\n\nEdited in overlay.\n\n## Verify\n\n- run focused test\n";

		const choice = mode.showPlanReview(constructorPlan, "Plan mode - next step", [
			"Approve and execute",
			"Refine plan",
		]);

		expect(capturedOverlay).toBeDefined();
		const overlay = capturedOverlay!;
		overlay.setPlanContent(editedPlan);
		overlay.handleInput("c");
		await Promise.resolve();

		expect(copySpy).toHaveBeenCalledTimes(1);
		expect(copySpy).toHaveBeenCalledWith(editedPlan);
		expect(copySpy).not.toHaveBeenCalledWith(constructorPlan);
		expect(statusSpy).toHaveBeenCalledWith("Copied plan to clipboard");

		overlay.handleInput("\x1b");
		await expect(choice).resolves.toBeUndefined();
		// showPlanReview no longer hides on settle: the plan-approval caller fuses
		// #hidePlanReview() with the replacement paint to avoid stale-buffer flicker.
		expect(overlayHandle.hide).not.toHaveBeenCalled();
	});

	it("Refine with no annotations silently aborts approval and returns to the editor", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		let streaming = false;
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => streaming,
		});
		const abortSpy = vi.spyOn(session, "abort").mockImplementation(async () => {
			streaming = false;
		});
		vi.spyOn(mode, "showPlanReview").mockImplementation(async () => {
			streaming = true;
			return "Refine plan";
		});
		const statusSpy = vi.spyOn(mode, "showStatus");
		const errorSpy = vi.spyOn(mode, "showError");
		const startSpy = vi.spyOn(mode, "startPendingSubmission");
		const onInput = vi.fn();
		mode.onInputCallback = onInput;

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(abortSpy).toHaveBeenCalledTimes(1);
		expect(statusSpy).toHaveBeenCalledWith("Refine plan: enter a follow-up prompt.");
		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Failed to refine plan"));
		expect(startSpy).not.toHaveBeenCalled();
		expect(onInput).not.toHaveBeenCalled();
		expect(session.isPlanInternalAbortPending).toBe(false);
	});

	it("approves with in-overlay edits and mirrors them to the plan file", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\noriginal body\n");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const edited = "# Plan\n\nedited body\n";
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			dialogOptions?.onPlanEdited?.(edited);
			return "Approve and execute";
		});
		vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
		const promptSpy = vi.spyOn(session, "prompt").mockImplementation(async promptText => {
			if (typeof promptText === "string" && promptText.startsWith("Plan approved.")) {
				const persisted = await Bun.file(resolvedPlanPath).text();
				expect(persisted).toContain("edited body");
				expect(persisted).not.toContain("original body");
			}
			return undefined as never;
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// The plan-approved prompt stays reference-only; approval must instead
		// await the durable file mirror before dispatch so read sees the edit.
		const call = promptSpy.mock.calls.find(isPlanApprovedCall);
		expect(call).toBeDefined();
		expect(call?.[0] as string).not.toContain("edited body");
		expect(call?.[0] as string).not.toContain("original body");
		// onPlanEdited mirrored the edit to the plan file.
		expect(await Bun.file(resolvedPlanPath).text()).toContain("edited body");
	});

	it("saves the final plan to the chosen path and starts a new session", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Draft plan\n\noriginal body\n");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const edited = "# Auto QA\n\nSave the final plan.\n\n## Verify\n\n- run focused tests\n";
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			dialogOptions?.onPlanEdited?.(edited);
			return "Save and quit";
		});
		const generateTitle = vi.spyOn(session, "generateTitle").mockResolvedValue("Auto QA");
		const destination = path.join(tempDir.path(), "AUTO_QA_PLAN.md");
		vi.spyOn(mode, "showHookCustom").mockResolvedValue({ path: "AUTO_QA_PLAN.md" });
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue();

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "DRAFT",
		});

		expect(generateTitle).toHaveBeenCalledWith(
			"# Auto QA\nSave the final plan.\n## Verify\n- run focused tests",
			expect.any(String),
		);
		expect(await Bun.file(destination).text()).toBe(edited);
		expect(clear).toHaveBeenCalledTimes(1);
		expect(mode.planModeEnabled).toBe(false);
	});

	it("carries pre-approval local artifacts into the fresh approve-and-execute session", async () => {
		const planFilePath = "local://handoff-plan.md";
		const localOptions = {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		};
		const oldLocalRoot = resolveLocalUrlToPath("local://", localOptions);
		const oldPlanPath = resolveLocalUrlToPath(planFilePath, localOptions);
		const oldArtifactPath = resolveLocalUrlToPath("local://handoff/nested/context.txt", localOptions);
		await fs.mkdir(path.dirname(oldArtifactPath), { recursive: true });
		await Bun.write(oldArtifactPath, "pre-approval handoff");
		await Bun.write(oldPlanPath, "# Plan\n\noriginal body\n");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const planContent = "# Plan\n\nfinal approved body\n";
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			dialogOptions?.onPlanEdited?.(planContent);
			return "Approve and execute";
		});
		vi.spyOn(mode, "handleClearCommand").mockImplementation(async () => {
			await session.sessionManager.newSession();
		});
		let artifactAtPrompt = "";
		let planAtPrompt = "";
		const prompt = vi.spyOn(session, "prompt").mockImplementation(async () => {
			const promptArtifactPath = resolveLocalUrlToPath("local://handoff/nested/context.txt", localOptions);
			const promptPlanPath = resolveLocalUrlToPath(planFilePath, localOptions);
			artifactAtPrompt = (await Bun.file(promptArtifactPath).exists())
				? await Bun.file(promptArtifactPath).text()
				: "<missing>";
			planAtPrompt = (await Bun.file(promptPlanPath).exists()) ? await Bun.file(promptPlanPath).text() : "<missing>";
			return undefined as never;
		});

		expect(await Bun.file(oldArtifactPath).text()).toBe("pre-approval handoff");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "HANDOFF",
		});

		const newLocalRoot = resolveLocalUrlToPath("local://", localOptions);
		const newArtifactPath = resolveLocalUrlToPath("local://handoff/nested/context.txt", localOptions);
		const newPlanPath = resolveLocalUrlToPath(planFilePath, localOptions);
		expect(newLocalRoot).not.toBe(oldLocalRoot);
		expect(await Bun.file(newArtifactPath).text()).toBe("pre-approval handoff");
		expect(await Bun.file(newPlanPath).text()).toBe(planContent);
		expect(artifactAtPrompt).toBe("pre-approval handoff");
		expect(planAtPrompt).toBe(planContent);
		expect(await Bun.file(oldArtifactPath).text()).toBe("pre-approval handoff");
		expect(prompt).toHaveBeenCalledWith(expect.any(String), { synthetic: true });
	});

	it("offers approve-and-keep-context as a distinct plan approval path", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nDo the thing.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 7320, contextWindow: 10000, percent: 73.2 });
		const selector = vi.spyOn(mode, "showPlanReview").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(selector).toHaveBeenCalledWith(
			expect.any(String),
			"Plan mode - next step",
			[
				"Approve and execute",
				"Approve and compact context",
				"Approve and keep context (~7.3k / 10k)",
				"Refine plan",
				"Save and quit",
			],
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("ignores aborted zero-usage assistant messages when estimating context usage", () => {
		session.agent.appendMessage(assistantWithUsage({ usage: usageWithInput(7320), stopReason: "stop" }));
		session.agent.appendMessage(assistantWithUsage({ usage: usageWithInput(0), stopReason: "aborted" }));

		expect(session.getContextUsage({ contextWindow: 10000 })).toMatchObject({
			tokens: 7320,
			contextWindow: 10000,
			percent: 73.2,
		});
	});

	it("measures keep-context approval against the execution model restored after plan mode", async () => {
		mode.stop();
		await session.dispose();

		const executionModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const planModel = modelRegistry.find("anthropic", "claude-opus-4-6");
		if (!executionModel?.contextWindow || !planModel?.contextWindow) {
			throw new Error("Expected test models with context windows");
		}
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: executionModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ modelRoles: { plan: `anthropic/${planModel.id}` } }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(planModel.id);

		const planFilePath = mode.planModePlanFilePath ?? "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nUse execution context.");

		const tokens = 180000;
		const contextSpy = vi.spyOn(session, "getContextUsage").mockImplementation(options => {
			const contextWindow = options?.contextWindow ?? 0;
			return {
				tokens,
				contextWindow,
				percent: (tokens / contextWindow) * 100,
			};
		});
		const selector = vi.spyOn(mode, "showPlanReview").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(contextSpy).toHaveBeenCalledWith({ contextWindow: executionModel.contextWindow });
		expect(selector.mock.calls[0]?.[2]).toEqual([
			"Approve and execute",
			"Approve and compact context",
			`Approve and keep context (~${compactNumber(tokens)} / ${compactNumber(executionModel.contextWindow)})`,
			"Refine plan",
			"Save and quit",
		]);
	});

	it("disables keep-context approval when execution context usage is above ninety-five percent", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nToo much context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 9600, contextWindow: 10000, percent: 96 });
		const selector = vi.spyOn(mode, "showPlanReview").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(selector.mock.calls[0]?.[3]).toEqual(
			expect.objectContaining({
				disabledIndices: [2],
			}),
		);
	});

	it("keeps keep-context approval enabled at exactly ninety-five percent", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nAt the threshold.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 9500, contextWindow: 10000, percent: 95 });
		const selector = vi.spyOn(mode, "showPlanReview").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(selector.mock.calls[0]?.[3]).toEqual(
			expect.objectContaining({
				disabledIndices: undefined,
			}),
		);
	});

	it("keeps the keep-context label plain when context usage is unknown", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nDo the thing.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		// Post-compaction: tokens unknown until the next LLM response.
		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		const selector = vi.spyOn(mode, "showPlanReview").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(selector).toHaveBeenCalledWith(
			expect.any(String),
			"Plan mode - next step",
			[
				"Approve and execute",
				"Approve and compact context",
				"Approve and keep context",
				"Refine plan",
				"Save and quit",
			],
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("approves a plan without clearing the session when keeping context", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const resolvedFinalPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nKeep context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and keep context");
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(clear).not.toHaveBeenCalled();
		expect(await Bun.file(resolvedFinalPlanPath).text()).toBe("# Plan\n\nKeep context.");
		expect(prompt).toHaveBeenCalledWith(expect.any(String), {
			synthetic: true,
		});
	});

	it("hides the review overlay before the blocking execution turn resolves", async () => {
		// Regression (issue #5688): the flicker fix moved #hidePlanReview out of the
		// picker's `finish` and into a `closePlanReview()` reached only AFTER
		// #approvePlan returns. #approvePlan awaits `session.prompt(planApproved)`,
		// which blocks for the whole execution turn — so the operator stayed stuck on
		// the plan-review screen until work finished. The overlay must be hidden once
		// execution BEGINS (after the async transcript rebuild), not when it ends.
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nKeep context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);

		// Drive the pick synchronously the moment the real overlay mounts: move to
		// "Approve and keep context" (index 2) — that branch keeps the session, so no
		// clear machinery runs — and confirm with Enter. `showOverlay` runs inside
		// `showPlanReview`, so the pick resolves the picker promise without a wait.
		const overlayHandle = { hide: vi.fn() };
		vi.spyOn(mode.ui, "showOverlay").mockImplementation(component => {
			const overlay = component as PlanReviewOverlay;
			overlay.handleInput("j");
			overlay.handleInput("j");
			overlay.handleInput("\n");
			return overlayHandle as never;
		});

		// Block the execution dispatch until released, mirroring a real turn that
		// streams for a long time. Record whether the overlay was already hidden when
		// the blocking prompt began, and signal that the prompt was reached.
		const gate = Promise.withResolvers<boolean>();
		const promptEntered = Promise.withResolvers<void>();
		let hiddenWhenPromptEntered: boolean | undefined;
		vi.spyOn(session, "prompt").mockImplementation(async () => {
			hiddenWhenPromptEntered = overlayHandle.hide.mock.calls.length > 0;
			promptEntered.resolve();
			return gate.promise;
		});

		const approval = mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		// Await the real dispatch signal instead of a wall-clock guess.
		await promptEntered.promise;
		expect(hiddenWhenPromptEntered).toBe(true);
		expect(overlayHandle.hide).toHaveBeenCalledTimes(1);

		gate.resolve(true);
		await approval;
	});

	it("queues the approved plan as a synthetic follow-up when a turn is already in flight", async () => {
		// Regression: the previous fix aborted the in-flight turn and re-dispatched
		// the plan-approved prompt. When the in-flight turn was an operator turn
		// queued during compaction and just flushed by `flushCompactionQueue`, that
		// abort discarded the operator's work. The correct shape is a synthetic
		// follow-up: land the hidden execution directive behind the in-flight turn
		// and preserve it.
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;

		let streaming = false;
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => streaming,
		});
		vi.spyOn(session, "abort").mockResolvedValue();
		const promptSpy = vi.spyOn(session, "prompt").mockImplementation(async (_text, opts) => {
			if (streaming && !(opts as { streamingBehavior?: string } | undefined)?.streamingBehavior)
				throw new AgentBusyError();
			return true;
		});
		const followUpSpy = vi.spyOn(session, "followUp").mockResolvedValue();
		// Simulate a re-stream landing during the overlay, then pick keep-context
		// (options[2]) — that branch skips clear/compact so `this.session` stays the
		// instance the spies are on.
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, options) => {
			streaming = true;
			return options[2];
		});
		const errorSpy = vi.spyOn(mode, "showError");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Failed to finalize approved plan"));
		expect(promptSpy).not.toHaveBeenCalled();
		expect(followUpSpy).toHaveBeenCalledTimes(1);
		const [text, images, options] = followUpSpy.mock.calls[0] as unknown[];
		expect(isPlanApprovedCall([text, options])).toBe(true);
		expect(images).toBeUndefined();
		expect(options).toMatchObject({ synthetic: true });
		// `handlePlanApproval` aborts once on entry (unrelated to the finalize path);
		// this test asserts the finalize path routes to followUp instead of prompt.
	});

	it("falls back to a synthetic follow-up when prompt() races into AgentBusyError", async () => {
		// Narrow race: `isStreaming` reads false but the fire-and-forget turn queued
		// by `flushCompactionQueue` flips it true before `session.prompt()` executes.
		// The core guard throws `AgentBusyError`; the finalize path must catch it and
		// queue the same synthetic follow-up instead of surfacing the error.
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;

		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => false,
		});
		vi.spyOn(session, "abort").mockResolvedValue();
		const promptSpy = vi.spyOn(session, "prompt").mockImplementation(async () => {
			throw new AgentBusyError();
		});
		const followUpSpy = vi.spyOn(session, "followUp").mockResolvedValue();
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, options) => options[2]);
		const errorSpy = vi.spyOn(mode, "showError");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Failed to finalize approved plan"));
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(isPlanApprovedCall(promptSpy.mock.calls[0] as unknown[])).toBe(true);
		expect(followUpSpy).toHaveBeenCalledTimes(1);
		const [text, images, options] = followUpSpy.mock.calls[0] as unknown[];
		expect(isPlanApprovedCall([text, options])).toBe(true);
		expect(images).toBeUndefined();
		expect(options).toMatchObject({ synthetic: true });
	});

	it("lands the approved plan behind a user turn queued during approve-and-compact", async () => {
		// End-to-end contract: choosing "Approve and compact context" runs
		// `handleCompactCommand`, which after compaction calls `flushCompactionQueue`.
		// A user turn typed during compaction is fired first via `session.prompt(...,
		// { streamingBehavior: "followUp" })` (which flips `isStreaming` in the
		// mock). The finalize path must then land the plan-approved prompt as a
		// synthetic follow-up — not surface `AgentBusyError` (the previous shape)
		// and not abort the queued user turn.
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nbody");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;

		let streaming = false;
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => streaming,
		});
		vi.spyOn(session, "abort").mockResolvedValue();

		const calls: { type: "prompt" | "followUp"; text: string; options?: unknown }[] = [];
		vi.spyOn(session, "prompt").mockImplementation(async (text, opts) => {
			calls.push({ type: "prompt", text, options: opts });
			if (text === "queued message") {
				streaming = true;
			}
			if (streaming && !(opts as { streamingBehavior?: string } | undefined)?.streamingBehavior) {
				throw new AgentBusyError();
			}
			return true;
		});
		vi.spyOn(session, "followUp").mockImplementation(async (text, _images, options) => {
			calls.push({ type: "followUp", text, options });
		});

		// `handleCompactCommand` gates on messageCount >= 2 from `sessionManager.getEntries()`.
		session.sessionManager.appendMessage({ role: "user", content: "seed one", timestamp: Date.now() - 2 });
		session.sessionManager.appendMessage({ role: "user", content: "seed two", timestamp: Date.now() - 1 });
		vi.spyOn(session, "compact").mockImplementation(async () => {
			// Operator types a follow-up while compaction is running.
			mode.queueCompactionMessage("queued message", "followUp");
			return undefined as never;
		});
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, options) => options[1]);
		const errorSpy = vi.spyOn(mode, "showError");

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Failed to finalize approved plan"));

		const queuedIndex = calls.findIndex(c => c.text === "queued message");
		const planIndex = calls.findIndex(c => isPlanApprovedCall([c.text, c.options]));
		expect(queuedIndex).toBeGreaterThanOrEqual(0);
		expect(planIndex).toBeGreaterThan(queuedIndex);
		expect(calls[planIndex]).toMatchObject({
			type: "followUp",
			options: { synthetic: true },
		});
		// Queued user turn was preserved (not silently aborted by the old fix).
		expect(calls[queuedIndex]).toMatchObject({
			type: "prompt",
			options: { streamingBehavior: "followUp" },
		});
	});

	it("keeps the existing approve-and-execute path clearing the session", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nClear context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and execute");
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(clear).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith(expect.any(String), {
			synthetic: true,
		});
	});

	it("executes on the slider-selected tier, surviving #exitPlanMode's model restore", async () => {
		// Regression: the model-tier slider's choice used to be applied BEFORE
		// #approvePlan ran. #approvePlan → #exitPlanMode restores the model that
		// was active before plan mode (#planModePreviousModelState), which silently
		// reverted the operator's pick — sliding to "slow" still executed on the
		// default model. The fix defers application until after the plan-mode exit.
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const slow = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		const def = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!slow || !def) throw new Error("Expected sonnet + opus to exist in registry");

		// plan === default === the session model: this is what makes plan-mode entry
		// record a previous-model state for #exitPlanMode to restore. slow differs,
		// so an early application would be clobbered by that restore.
		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("slow", "anthropic/claude-opus-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-sonnet-4-5");

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nRun this on the slow tier.");

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(session.model?.id).toBe(def.id);

		// Keep-context path avoids newSession() so the assertion isolates the
		// exit-plan-mode restore from session-clear effects.
		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		let observedSegments: string[] = [];
		vi.spyOn(mode, "showPlanReview").mockImplementation(
			async (_planContent, _title, _options, _dialogOptions, extra?: { slider?: HookSelectorSlider }) => {
				const slider = extra?.slider;
				expect(slider).toBeDefined();
				observedSegments = slider!.segments.map(segment => segment.label);
				const slowIndex = slider!.segments.findIndex(segment => segment.label === "slow");
				expect(slowIndex).toBeGreaterThanOrEqual(0);
				// Simulate the operator sliding the tier to "slow" before approving.
				slider!.onChange?.(slowIndex);
				return "Approve and keep context";
			},
		);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(observedSegments).toEqual(["default", "slow"]);
		// The load-bearing assertion: the approved plan executes on the operator's
		// selected tier, not the restored default.
		expect(session.model?.id).toBe(slow.id);
	});

	it("retains the plan model when the slider selection matches the active plan tier", async () => {
		const planModel = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		const prePlanModel = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!planModel || !prePlanModel) throw new Error("Expected sonnet + opus to exist in registry");

		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("slow", "anthropic/claude-opus-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nKeep executing on the planning tier.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(planModel.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		vi.spyOn(mode, "showPlanReview").mockImplementation(
			async (_planContent, _title, _options, _dialogOptions, extra?: { slider?: HookSelectorSlider }) => {
				const slider = extra?.slider;
				expect(slider).toBeDefined();
				const slowIndex = slider!.segments.findIndex(segment => segment.label === "slow");
				expect(slowIndex).toBeGreaterThanOrEqual(0);
				slider!.onChange?.(slowIndex);
				return "Approve and keep context";
			},
		);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(session.model?.id).toBe(planModel.id);
	});

	it("treats matching-model slider tier as explicit when its thinking differs from the pre-plan thinking", async () => {
		const sonnet = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const opus = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!sonnet || !opus) throw new Error("Expected sonnet + opus to exist in registry");

		// default tier explicitly turns thinking off on sonnet; the session enters
		// plan mode with thinking already bumped to high. A model-only match check
		// treats the slider's "stay on default" pick as implicit, so #exitPlanMode
		// restores thinking=high instead of the configured off override. The fix
		// must compare thinking levels too and pass the default entry through
		// applyRoleModel.
		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5:off");
		session.settings.setModelRole("slow", "anthropic/claude-opus-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");
		session.setThinkingLevel(ThinkingLevel.High);

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nDifferent thinking on the same model.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(opus.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		const applyRoleSpy = vi.spyOn(session, "applyRoleModel");

		vi.spyOn(mode, "showPlanReview").mockImplementation(
			async (_planContent, _title, _options, _dialogOptions, extra?: { slider?: HookSelectorSlider }) => {
				const slider = extra?.slider;
				expect(slider).toBeDefined();
				const defaultIndex = slider!.segments.findIndex(segment => segment.label === "default");
				expect(defaultIndex).toBeGreaterThanOrEqual(0);
				slider!.onChange?.(defaultIndex);
				return "Approve and keep context";
			},
		);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		const defaultApply = applyRoleSpy.mock.calls.find(call => call[0]?.role === "default");
		expect(defaultApply).toBeDefined();
		expect(defaultApply?.[0]?.model.id).toBe(sonnet.id);
		expect(defaultApply?.[0]?.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(defaultApply?.[0]?.explicitThinkingLevel).toBe(true);
	});

	it("preserves DEFAULT(auto) when plan approval restores the default tier", async () => {
		const sonnet = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const opus = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!sonnet || !opus) throw new Error("Expected sonnet + opus to exist in registry");

		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("slow", "anthropic/claude-opus-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");
		session.setThinkingLevel(AUTO_THINKING, true);

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nPreserve the configured auto selector.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(opus.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		vi.spyOn(mode, "showPlanReview").mockImplementation(
			async (_planContent, _title, _options, _dialogOptions, extra?: { slider?: HookSelectorSlider }) => {
				const slider = extra?.slider;
				expect(slider).toBeDefined();
				const defaultIndex = slider!.segments.findIndex(segment => segment.label === "default");
				expect(defaultIndex).toBeGreaterThanOrEqual(0);
				slider!.onChange?.(defaultIndex);
				return "Approve and keep context";
			},
		);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(session.model?.id).toBe(sonnet.id);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("falls back to the pre-plan model when only plan is configured and the slider is hidden", async () => {
		const sonnet = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const opus = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!sonnet || !opus) throw new Error("Expected sonnet + opus to exist in registry");
		expect(session.model?.id).toBe(sonnet.id);

		// Only the plan role is configured. getRoleModelCycle synthesizes a
		// singleton `default` entry from the active plan model (opus), so the
		// slider is hidden — the operator made no selection and approval must
		// fall through to the pre-plan sonnet restore instead of pinning the
		// lone plan tier.
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nNo slider, restore default.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(opus.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		let sliderShown: HookSelectorSlider | undefined;
		vi.spyOn(mode, "showPlanReview").mockImplementation(
			async (_planContent, _title, _options, _dialogOptions, extra?: { slider?: HookSelectorSlider }) => {
				sliderShown = extra?.slider;
				return "Approve and keep context";
			},
		);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(sliderShown).toBeUndefined();
		expect(session.model?.id).toBe(sonnet.id);
	});

	it("compaction runs on the plan model and restores the pre-plan model after success", async () => {
		const planModel = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		const prePlanModel = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!planModel || !prePlanModel) throw new Error("Expected sonnet + opus to exist in registry");

		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCompact on the plan model.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(planModel.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		let compactModelId: string | undefined;
		vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			compactModelId = session.model?.id;
			return "ok";
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(compactModelId).toBe(planModel.id);
		expect(session.model?.id).toBe(prePlanModel.id);
	});

	it("failed compaction stays on the plan model and still dispatches", async () => {
		const planModel = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!planModel) throw new Error("Expected opus to exist in registry");

		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCompact failure still dispatches.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(planModel.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		let compactModelId: string | undefined;
		vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			compactModelId = session.model?.id;
			return "failed";
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(compactModelId).toBe(planModel.id);
		expect(session.model?.id).toBe(planModel.id);
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(true);
	});

	it("slider tier on the compact path applies after successful compaction", async () => {
		const planModel = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		const execModel = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!planModel || !execModel) throw new Error("Expected sonnet + opus to exist in registry");

		// Plan model (opus) differs from the execution tier the operator slides to
		// (default = sonnet). Successful compaction must keep running on opus, then
		// end on the slider-selected default tier.
		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("slow", "anthropic/claude-opus-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCompact on plan model, execute on default.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(planModel.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		let compactModelId: string | undefined;
		vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			compactModelId = session.model?.id;
			return "ok";
		});

		vi.spyOn(mode, "showPlanReview").mockImplementation(
			async (_planContent, _title, _options, _dialogOptions, extra?: { slider?: HookSelectorSlider }) => {
				const slider = extra?.slider;
				expect(slider).toBeDefined();
				const defaultIndex = slider!.segments.findIndex(segment => segment.label === "default");
				expect(defaultIndex).toBeGreaterThanOrEqual(0);
				// Operator planned on opus but slides execution down to the default tier.
				slider!.onChange?.(defaultIndex);
				return "Approve and compact context";
			},
		);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// Compaction ran on the plan model (defer-restore kept it warm), then the
		// successful transition ended on the slider-selected default tier.
		expect(compactModelId).toBe(planModel.id);
		expect(session.model?.id).toBe(execModel.id);
	});

	it("cancelled compaction restores the pre-plan model before exiting", async () => {
		// Regression: under defer-restore the cancel path returned without restoring
		// #planModePreviousModelState, so an aborted "Approve and compact context"
		// left the next turn stranded on the plan model. The transition now runs
		// for "cancelled" too (the operator aborted only compaction, not approval).
		const planModel = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		const prePlanModel = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!planModel || !prePlanModel) throw new Error("Expected sonnet + opus to exist in registry");

		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCancel compaction, restore pre-plan model.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(planModel.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		let compactModelId: string | undefined;
		vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			compactModelId = session.model?.id;
			return "cancelled";
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// Compaction was attempted on the plan model …
		expect(compactModelId).toBe(planModel.id);
		// … and the abort restored the pre-plan model instead of stranding the
		// session on the plan model.
		expect(session.model?.id).toBe(prePlanModel.id);
		// The synthetic plan-approved prompt is still skipped on cancel.
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
	});

	it("runs the compact-path model transition before the compaction queue flushes", async () => {
		// Regression: handleCompactCommand flushes queued input before it returns,
		// so the model transition must run inside the before-flush hook. Otherwise a
		// turn queued during compaction dispatches on the plan model (the restore,
		// recorded while streaming, lands one turn later via #pendingModelSwitch).
		const planModel = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		const prePlanModel = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!planModel || !prePlanModel) throw new Error("Expected sonnet + opus to exist in registry");

		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-opus-4-5");

		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nTransition before the queue flushes.");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(planModel.id);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		let hookWasFunction = false;
		let modelAtFlushTime: string | undefined;
		// Mirror executeCompaction's ordering: invoke beforeFlush, THEN observe the
		// model the queue would flush on.
		vi.spyOn(mode, "handleCompactCommand").mockImplementation(async (_instructions, _mode, beforeFlush) => {
			hookWasFunction = typeof beforeFlush === "function";
			if (beforeFlush) await beforeFlush("ok");
			modelAtFlushTime = session.model?.id;
			return "ok";
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(hookWasFunction).toBe(true);
		// By the time the queue flushes, the session is already on the pre-plan model.
		expect(modelAtFlushTime).toBe(prePlanModel.id);
		expect(session.model?.id).toBe(prePlanModel.id);
	});

	it("re-enters plan mode on the approved titled artifact after approve-and-execute", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nExecute then edit.");

		await mode.handlePlanModeCommand();

		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and execute");
		vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "APPROVED",
		});

		expect(mode.planModeEnabled).toBe(false);
		expect(session.getPlanReferencePath()).toBe(planFilePath);

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()).toMatchObject({
			enabled: true,
			planFilePath,
			reentry: true,
		});
	});

	it("Approve and compact context: ok outcome dispatches plan-approved after compaction", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCompact and execute.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		const compactSpy = vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("ok");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// Plan-mode compaction rides through as `internalGuidance` (arg 4) so it
		// reaches native summarization without leaking into the public
		// `customInstructions` channel of the `session_before_compact` hook —
		// extensions there treat that field as user focus (issue #4359).
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [customInstructions, mode_, beforeFlush, internalGuidance] = compactSpy.mock.calls[0]!;
		expect(customInstructions).toBeUndefined();
		expect(mode_).toBeUndefined();
		expect(typeof beforeFlush).toBe("function");
		expect(typeof internalGuidance).toBe("string");
		expect(internalGuidance as string).toContain(planFilePath);

		// Plan-approved synthetic prompt was dispatched.
		const planApprovedIdx = promptSpy.mock.calls.findIndex(isPlanApprovedCall);
		expect(planApprovedIdx).toBeGreaterThanOrEqual(0);

		// markPlanReferenceSent fires on the dispatch path so the executor's first
		// turn doesn't double-inject the plan reference (it was just dispatched
		// inside the synthetic prompt).
		expect(markSentSpy).toHaveBeenCalledTimes(1);
	});

	it("Approve and compact context: cancelled outcome skips plan-approved dispatch", async () => {
		// Mock `handleCompactCommand` to surface the "cancelled" outcome directly.
		// (Testing the consumer — `#approvePlan`'s outcome handling — at the
		// CompactionOutcome boundary; the underlying executeCompaction → sentinel
		// classification path is producer-layer and not under T3's contract.)
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCancel mid-compact.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("cancelled");
		const showWarningSpy = vi.spyOn(mode, "showWarning");
		const setPlanRefSpy = vi.spyOn(session, "setPlanReferencePath");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// Operator was told the dispatch was deferred.
		expect(showWarningSpy).toHaveBeenCalledWith(
			expect.stringContaining("Plan approved, but compaction was cancelled"),
		);
		// Plan reference path was recorded so the session knows about the approved
		// plan at its final destination …
		expect(setPlanRefSpy).toHaveBeenCalledWith(planFilePath);
		// … but markPlanReferenceSent was NOT called, so the next operator turn
		// will inject the reference fresh via #buildPlanReferenceMessage. This is
		// the load-bearing assertion that the cancel path leaves the executor
		// with the plan in its first turn.
		expect(markSentSpy).not.toHaveBeenCalled();
		// And — the contract — the plan-approved synthetic prompt was NOT dispatched.
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
	});

	it("Approve and compact context retains annotations when compaction cancels before dispatch", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCancel mid-compact.");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		const annotationState: PlanReviewAnnotationState = {
			annotations: [
				{
					section: { index: 0, title: "Plan" },
					target: { kind: "line", row: 2, context: "Cancel mid-compact." },
					note: "Keep the rollback path.",
				},
			],
		};
		const restoredStates: Array<PlanReviewAnnotationState | undefined> = [];
		let reviewCount = 0;
		vi.spyOn(mode, "showPlanReview").mockImplementation(async (_plan, _title, _options, dialogOptions) => {
			reviewCount++;
			restoredStates.push(dialogOptions?.annotationState);
			if (reviewCount === 1) {
				dialogOptions?.onAnnotationStateChange?.(annotationState);
				return "Approve and compact context";
			}
			return undefined;
		});
		vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("cancelled");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN" });

		expect(restoredStates).toEqual([undefined, annotationState]);
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
	});

	it("Approve and compact context: failed outcome still dispatches plan-approved (best-effort)", async () => {
		// Mock `handleCompactCommand` to surface the "failed" outcome directly.
		// Failure → approval intent stands → synthetic dispatch fires.
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nFail mid-compact.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("failed");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// Plan-approved synthetic prompt WAS dispatched despite the failure.
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(true);
		// markPlanReferenceSent fires on this dispatch path.
		expect(markSentSpy).toHaveBeenCalledTimes(1);
	});
	it("Approve and compact context: setPlanReferencePath is pinned BEFORE compaction flushes the queue", async () => {
		// Regression: handleCompactCommand internally awaits flushCompactionQueue,
		// which can deliver a user-queued message back to the session. If
		// setPlanReferencePath had not been called yet, that queued turn would
		// hit #buildPlanReferenceMessage with the stale plan-mode path. Pin it
		// before the compaction await.
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nQueue race.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		const setPlanRefSpy = vi.spyOn(session, "setPlanReferencePath");
		let planRefSetWhenCompactionRan = false;
		vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			planRefSetWhenCompactionRan = setPlanRefSpy.mock.calls.some(call => call[0] === planFilePath);
			return "ok";
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// The contract: by the time handleCompactCommand runs (and flushes the
		// compaction queue inside), setPlanReferencePath has already pinned the
		// approved plan path, so any user message queued during compaction is
		// dispatched against the approved plan, not the plan-mode draft.
		expect(planRefSetWhenCompactionRan).toBe(true);
	});

	// ==========================================================================
	// Phase 6 — B layer: #approvePlan flag lifecycle via try/finally.
	//
	// asserts `session.isPlanInternalAbortPending === false` after `#approvePlan`
	// resolves/rejects. The flag is the only state that can leak into later
	// unrelated aborts; the `try/finally` in `#approvePlan` is what protects it.
	// ==========================================================================

	/**
	 * Drives `handlePlanApproval` with the "Approve and compact context"
	 * picker outcome and the given compaction-outcome mock. Returns the promise
	 * the harness produces so the caller decides between `await` (B1-B3 happy
	 * paths) and `expect(...).rejects` (B4 throw path). Does NOT swallow errors.
	 */
	async function approveWithCompact(
		compactOutcome: "ok" | "cancelled" | "failed" | "throw",
		throwError?: Error,
	): Promise<void> {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nBody.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and compact context");
		if (compactOutcome === "throw") {
			vi.spyOn(mode, "handleCompactCommand").mockRejectedValue(throwError ?? new Error("compact boom"));
		} else {
			vi.spyOn(mode, "handleCompactCommand").mockResolvedValue(compactOutcome);
		}
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});
	}

	// B1-B3: every terminal compaction outcome must leave the flag cleared by
	// `#approvePlan`'s `finally`. No aborted message_end is required to consume it,
	// so a stranded flag could otherwise silence the next unrelated abort. One
	// parametrized case per outcome keeps ok/cancelled/failed each covered.
	it.each(["ok", "cancelled", "failed"] as const)(
		"B1-B3: Approve and compact context + %s outcome → flag cleared by finally",
		async outcome => {
			await approveWithCompact(outcome);
			expect(session.isPlanInternalAbortPending).toBe(false);
		},
	);

	it("B4: Approve and compact context + handleCompactCommand throws → showError surfaces the failure AND flag cleared by finally before the outer catch", async () => {
		// `handlePlanApproval` wraps `#approvePlan` in a try/catch
		// in `InteractiveMode` that consumes the throw and reports via
		// `showError`. The contract under test is:
		//   1. `#approvePlan`'s own `try/finally` clears the flag BEFORE the
		//      throw bubbles up to that outer catch.
		//   2. The outer catch surfaces the failure via `showError` (not
		//      silenced).
		const showErrorSpy = vi.spyOn(mode, "showError");
		await approveWithCompact("throw", new Error("synthetic compaction failure"));
		expect(session.isPlanInternalAbortPending).toBe(false);
		expect(showErrorSpy).toHaveBeenCalledWith(expect.stringContaining("synthetic compaction failure"));
	});

	it("B5: Approve and execute (no compact) → internal abort flag is cleared", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nBody.");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and execute");
		const markSpy = vi.spyOn(session, "markPlanInternalAbortPending");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		expect(markSpy).toHaveBeenCalledTimes(1);
		expect(session.isPlanInternalAbortPending).toBe(false);
	});

	it("re-enters plan mode on the approved titled artifact after approval", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nKeep editing this artifact.");

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()?.planFilePath).toBe(planFilePath);

		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		const selector = vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and keep context");
		const showError = vi.spyOn(mode, "showError");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "APPROVED",
		});

		expect(mode.planModeEnabled).toBe(false);
		expect(session.getPlanReferencePath()).toBe(planFilePath);

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()).toMatchObject({
			enabled: true,
			planFilePath,
			reentry: true,
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "APPROVED",
		});

		expect(selector).toHaveBeenCalledTimes(2);
		expect(showError).not.toHaveBeenCalled();
	});

	describe("openPlanReview (manual /plan-review)", () => {
		const localPath = (url: string): string =>
			resolveLocalUrlToPath(url, {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			});

		it("forwards the newest local plan file and its heading title to the approval flow", async () => {
			await Bun.write(localPath("local://old-plan.md"), "# Old plan\n\nstale body");
			await Bun.write(localPath("local://auth-refactor-plan.md"), "# Auth refactor\n\nfresh body");
			// #listLocalPlanFiles sorts by mtime, newest first — pin mtimes so the
			// "latest plan" selection is deterministic regardless of write timing.
			await fs.utimes(localPath("local://old-plan.md"), new Date(1_000), new Date(1_000));
			await fs.utimes(localPath("local://auth-refactor-plan.md"), new Date(2_000), new Date(2_000));

			mode.planModeEnabled = true;
			// The default points at a file that never exists; the scan must still find
			// the real plan, and getPlanReferencePath() is empty before any approval.
			mode.planModePlanFilePath = "local://PLAN.md";
			const approval = vi.spyOn(mode, "handlePlanApproval").mockResolvedValue();

			await mode.openPlanReview();

			expect(approval).toHaveBeenCalledTimes(1);
			expect(approval).toHaveBeenCalledWith({
				planFilePath: "local://auth-refactor-plan.md",
				title: "Auth-refactor",
				planExists: true,
			});
		});

		it("warns and does not start approval when plan mode is inactive", async () => {
			await Bun.write(localPath("local://auth-plan.md"), "# Auth\n\nbody");
			mode.planModeEnabled = false;
			const approval = vi.spyOn(mode, "handlePlanApproval").mockResolvedValue();
			const warn = vi.spyOn(mode, "showWarning");

			await mode.openPlanReview();

			expect(approval).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith("Plan mode is not active.");
		});

		it("warns when no plan file has been written yet", async () => {
			mode.planModeEnabled = true;
			const approval = vi.spyOn(mode, "handlePlanApproval").mockResolvedValue();
			const warn = vi.spyOn(mode, "showWarning");

			await mode.openPlanReview();

			expect(approval).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("No plan to review"));
		});
	});
});

describe("AssistantMessageComponent aborted replay", () => {
	beforeAll(() => {
		initTheme();
	});

	// ==========================================================================
	// Phase 6 — D layer: replay-side render branches in AssistantMessageComponent.
	//
	// D1 asserts that the persisted `SILENT_ABORT_MARKER` suppresses the red abort
	// line. D2 is the over-suppression regression guard — an aborted message with
	// NO marker still renders the generic label. D3 covers the Esc interrupt label:
	// it remains persisted but does not render as a redundant assistant line.
	// ==========================================================================

	function renderAssistant(message: AssistantMessage, width = 120): string {
		const component = new AssistantMessageComponent(message);
		return Bun.stripANSI(component.render(width).join("\n"));
	}

	/** Build an aborted assistant message with the minimum required fields. */
	function buildAbortedAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "Approved plan; transitioning to compaction." }],
			api: "openai-completions",
			provider: "github-copilot",
			model: "gpt-4o",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
			...overrides,
		};
	}

	it("D1: Replay of an assistant message with SILENT_ABORT_MARKER + aborted: rendered component contains no abort line", () => {
		const message = buildAbortedAssistantMessage({ errorMessage: SILENT_ABORT_MARKER });
		const rendered = renderAssistant(message);
		expect(rendered).not.toContain("Operation aborted");
		expect(rendered).not.toContain(USER_INTERRUPT_LABEL);
		// The marker itself MUST NOT leak into rendered output either.
		expect(rendered).not.toContain(SILENT_ABORT_MARKER);
	});

	it("D1b: Replay of an assistant message with silent-abort errorId contains no abort line", () => {
		const message = buildAbortedAssistantMessage({
			content: [],
			errorId: AIError.create(AIError.Flag.SilentAbort),
			errorMessage: undefined,
		});
		const rendered = renderAssistant(message);
		expect(rendered).not.toContain("Operation aborted");
		expect(rendered).not.toContain("Error:");
	});

	it("D2: Replay of an aborted message with no threaded reason + empty content: rendered component DOES contain the generic label", () => {
		// Over-suppression regression guard: silent path is opt-in via the
		// persisted marker. An abort with no marker and no threaded reason still
		// surfaces the generic operator-facing label.
		const message = buildAbortedAssistantMessage({ content: [], errorMessage: undefined });
		const rendered = renderAssistant(message);
		expect(rendered).toContain("Operation aborted");
	});

	it("D3: Replay of an aborted message carrying a user-interrupt reason suppresses the redundant line", () => {
		const message = buildAbortedAssistantMessage({ content: [], errorMessage: USER_INTERRUPT_LABEL });
		const rendered = renderAssistant(message);
		expect(rendered).not.toContain(USER_INTERRUPT_LABEL);
		expect(rendered).not.toContain("Operation aborted");
	});
});

describe("planSaveFileName", () => {
	it("turns a short topic into <TOPIC>_PLAN.md", () => {
		expect(planSaveFileName("PyO3 types")).toBe("PYO3_TYPES_PLAN.md");
		expect(planSaveFileName("Auth storage plan")).toBe("AUTH_STORAGE_PLAN.md");
	});

	it("trims verbose fallback titles at a word boundary", () => {
		expect(planSaveFileName("Split PyEnvironmentBackend request into PyO3 methods")).toBe(
			"SPLIT_PYENVIRONMENTBACKEND_PLAN.md",
		);
	});

	it("falls back to PLAN.md for empty or plan-only titles", () => {
		expect(planSaveFileName("  ")).toBe("PLAN.md");
		expect(planSaveFileName("Plan")).toBe("PLAN.md");
	});
});

afterAll(() => {
	resetSettingsForTest();
});
