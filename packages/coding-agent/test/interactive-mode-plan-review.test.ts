import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, AgentBusyError, ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AssistantMessage, Usage } from "@pk-nerdsaver-ai/pi-ai";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import { KeybindingsManager } from "@pk-nerdsaver-ai/pi-coding-agent/config/keybindings";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import { AssistantMessageComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/assistant-message";
import type { HookSelectorSlider } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/hook-selector";
import type { PlanReviewOverlay } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/plan-review-overlay";
import { InteractiveMode } from "@pk-nerdsaver-ai/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SILENT_ABORT_MARKER, USER_INTERRUPT_LABEL } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { setKeybindings } from "@pk-nerdsaver-ai/pi-tui";
import { formatNumber, TempDir } from "@pk-nerdsaver-ai/pi-utils";

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
	// Shared across the whole describe: AuthStorage (a SQLite db) and ModelRegistry
	// are the expensive pieces (~14ms/test combined) and tests only ever read from
	// them — `find()` is a pure lookup over a model list frozen at construction, and
	// the lone `setRuntimeApiKey` re-call is idempotent. Hoisting them out of
	// `beforeEach` is the dominant body-time win.
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

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-plan-review-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
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
		resetSettingsForTest();
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
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
		});

		// The synthetic plan-approved prompt carries the in-overlay edit, not the
		// stale on-disk content (preferring editedContent avoids the write race).
		const call = promptSpy.mock.calls.find(isPlanApprovedCall);
		expect(call).toBeDefined();
		expect(call?.[0] as string).toContain("edited body");
		expect(call?.[0] as string).not.toContain("original body");
		// onPlanEdited mirrored the edit to the plan file.
		expect(await Bun.file(resolvedPlanPath).text()).toContain("edited body");
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
			["Approve and execute", "Approve and compact context", "Approve and keep context", "Refine plan"],
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

	it("aborts an in-flight turn before dispatching the approved plan instead of surfacing AgentBusyError", async () => {
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
			// Clear the streaming flag only after an awaited tick, so the test fails
			// if #approvePlan dispatches the prompt without awaiting abort() — the
			// real abort() resolves only once the agent loop is idle.
			await Promise.resolve();
			streaming = false;
		});
		const promptSpy = vi.spyOn(session, "prompt").mockImplementation(async (_text, opts) => {
			if (streaming && !(opts as { streamingBehavior?: string } | undefined)?.streamingBehavior)
				throw new AgentBusyError();
			return true;
		});
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
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(isPlanApprovedCall(promptSpy.mock.calls[0] as unknown[])).toBe(true);
		expect(abortSpy).toHaveBeenCalled();
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

		// Compaction was run with the rendered planning-specific custom instruction.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [compactInstruction] = compactSpy.mock.calls[0]!;
		expect(typeof compactInstruction).toBe("string");
		expect(compactInstruction as string).toContain(planFilePath);

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
	it.each([
		"ok",
		"cancelled",
		"failed",
	] as const)("B1-B3: Approve and compact context + %s outcome → flag cleared by finally", async outcome => {
		await approveWithCompact(outcome);
		expect(session.isPlanInternalAbortPending).toBe(false);
	});

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
