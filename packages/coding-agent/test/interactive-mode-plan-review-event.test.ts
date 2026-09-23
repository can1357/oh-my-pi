import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAPI,
	PlanReviewEvent,
	PlanReviewEventResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/** The plan-approved synthetic prompt is the only `prompt(text, { synthetic: true })` call. */
const isPlanApprovedCall = (args: unknown[]): boolean =>
	args.length >= 2 && (args[1] as { synthetic?: boolean } | null)?.synthetic === true;

/** Component surface the waiting overlay exposes to the focus manager. */
interface FocusedComponent {
	handleInput?: (data: string) => void;
}

type ReviewDecision = PlanReviewEventResult | undefined;

describe("InteractiveMode plan_review event", () => {
	let tempDir: TempDir;
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let runtime: ExtensionRuntime;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		sharedTempDir = TempDir.createSync("@pi-plan-review-event-shared-");
		await Settings.init({ inMemory: true, cwd: sharedTempDir.path() });
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage?.close();
		sharedTempDir?.removeSync();
		resetSettingsForTest();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-plan-review-event-");
		runtime = new ExtensionRuntime();
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

	/** Builds a real InteractiveMode over a real AgentSession wired to `factories`. */
	async function createMode(...factories: Array<(pi: ExtensionAPI) => void>): Promise<void> {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in registry");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const extensions = [];
		for (const [index, factory] of factories.entries()) {
			extensions.push(
				await loadExtensionFromFactory(factory, tempDir.path(), new EventBus(), runtime, `reviewer-${index}.ts`),
			);
		}
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: new ExtensionRunner(extensions, runtime, tempDir.path(), sessionManager, modelRegistry),
		});
		mode = new InteractiveMode(session, "test");
	}

	function localPath(url: string): string {
		return resolveLocalUrlToPath(url, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
	}

	async function enterPlanMode(planFilePath: string, content: string): Promise<void> {
		await Bun.write(localPath(planFilePath), content);
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
	}

	/** Records every component the mode hands focus to, newest last. */
	function captureFocus(): FocusedComponent[] {
		const focused: FocusedComponent[] = [];
		vi.spyOn(mode.ui, "setFocus").mockImplementation(component => {
			focused.push(component as FocusedComponent);
		});
		return focused;
	}

	/** Records each overlay the mode opens and whether it has been hidden yet. */
	function captureOverlays(): Array<{ hidden: boolean }> {
		const opened: Array<{ hidden: boolean }> = [];
		const showOverlay = mode.ui.showOverlay.bind(mode.ui);
		vi.spyOn(mode.ui, "showOverlay").mockImplementation((component, overlayOptions) => {
			const handle = showOverlay(component, overlayOptions);
			const record = { hidden: false };
			opened.push(record);
			return {
				...handle,
				hide: () => {
					record.hidden = true;
					handle.hide();
				},
			};
		});
		return opened;
	}

	it("executes an extension approval without ever opening the picker", async () => {
		let seen: PlanReviewEvent | undefined;
		await createMode(pi =>
			pi.on("plan_review", event => {
				seen = event;
				return { action: "approve" };
			}),
		);
		await enterPlanMode("local://PLAN.md", "# Plan\n\nShip it.");
		// The transcript only repaints after the initial render; before that the
		// rebuild is suppressed to avoid duplicating replayed entries.
		mode.initialChatRendered = true;
		const picker = vi.spyOn(mode, "showPlanReview");
		vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });

		expect(picker).not.toHaveBeenCalled();
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(true);
		// The event carries both the state-shaped path and one an external process
		// can actually open.
		expect(seen?.planFilePath).toBe("local://PLAN.md");
		expect(seen?.resolvedPlanPath).toBe(localPath("local://PLAN.md"));
		expect(seen?.planContent).toContain("Ship it.");
		// Provenance: the transcript records that nobody in this TUI approved, and
		// the record survives a restart.
		expect(
			session.sessionManager
				.getEntries()
				.some(entry => entry.type === "custom_message" && entry.customType === "plan-review-approved"),
		).toBe(true);
		const transcript = Bun.stripANSI(mode.chatContainer.render(100).join("\n"));
		expect(transcript).toContain("Plan approved by extension");
	});

	it("falls back to the picker when no handler returns a decision", async () => {
		let called = 0;
		await createMode(pi =>
			pi.on("plan_review", () => {
				called++;
				return undefined;
			}),
		);
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);

		await mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });

		expect(called).toBe(1);
		expect(picker).toHaveBeenCalledTimes(1);
		expect(mode.planModeEnabled).toBe(true);
	});

	it("delivers refine feedback as a user turn and keeps plan mode active", async () => {
		await createMode(pi => pi.on("plan_review", () => ({ action: "refine", feedback: "Add a rollback step." })));
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		const picker = vi.spyOn(mode, "showPlanReview");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });

		expect(picker).not.toHaveBeenCalled();
		expect(promptSpy).toHaveBeenCalledWith("Add a rollback step.");
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
		expect(mode.planModeEnabled).toBe(true);
	});

	it("keeps plan mode and skips the picker on dismiss", async () => {
		await createMode(pi => pi.on("plan_review", () => ({ action: "dismiss" })));
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		const picker = vi.spyOn(mode, "showPlanReview");
		const status = vi.spyOn(mode, "showStatus");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });

		expect(picker).not.toHaveBeenCalled();
		expect(status).toHaveBeenCalledWith(expect.stringContaining("dismissed"));
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
		expect(mode.planModeEnabled).toBe(true);
	});

	it.each([
		[
			"throws",
			(pi: ExtensionAPI) =>
				pi.on("plan_review", () => {
					throw new Error("reviewer exploded");
				}),
		],
		[
			"returns a malformed decision",
			(pi: ExtensionAPI) => pi.on("plan_review", () => ({ action: "approve!" }) as unknown as PlanReviewEventResult),
		],
		[
			"returns refine with no feedback",
			(pi: ExtensionAPI) => pi.on("plan_review", () => ({ action: "refine" }) as PlanReviewEventResult),
		],
	])("opens the picker and approves nothing when a handler %s", async (_label, factory) => {
		await createMode(factory);
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });

		expect(picker).toHaveBeenCalledTimes(1);
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
		expect(mode.planModeEnabled).toBe(true);
	});

	it("opens the picker with the reviewer's revision when the operator cancels the wait", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<ReviewDecision>();
		let signal: AbortSignal | undefined;
		await createMode(pi =>
			pi.on("plan_review", async event => {
				signal = event.signal;
				// The reviewer rewrote the plan before the operator took over.
				await Bun.write(localPath("local://PLAN.md"), "# Plan\n\nreviewer revision");
				entered.resolve();
				return await release.promise;
			}),
		);
		await enterPlanMode("local://PLAN.md", "# Plan\n\noriginal");
		const focused = captureFocus();
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		const pending = mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });
		await entered.promise;
		focused.at(-1)?.handleInput?.("\x1b");
		// A decision arriving after the operator took over must not be applied.
		release.resolve({ action: "approve" });
		await pending;

		expect(signal?.aborted).toBe(true);
		expect(picker).toHaveBeenCalledTimes(1);
		expect(picker.mock.calls[0]?.[0]).toContain("reviewer revision");
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
	});

	it("routes Ctrl+C in the waiting overlay back to the picker", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<ReviewDecision>();
		let signal: AbortSignal | undefined;
		await createMode(pi =>
			pi.on("plan_review", async event => {
				signal = event.signal;
				entered.resolve();
				return await release.promise;
			}),
		);
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		const focused = captureFocus();
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);

		const pending = mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });
		await entered.promise;
		focused.at(-1)?.handleInput?.("\x03");
		release.resolve(undefined);
		await pending;

		expect(signal?.aborted).toBe(true);
		expect(picker).toHaveBeenCalledTimes(1);
	});

	it("supersedes an in-flight review when a newer proposal arrives", async () => {
		const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const gates = [Promise.withResolvers<ReviewDecision>(), Promise.withResolvers<ReviewDecision>()];
		const signals: AbortSignal[] = [];
		let index = 0;
		await createMode(pi =>
			pi.on("plan_review", async event => {
				const slot = index++;
				signals.push(event.signal);
				entered[slot]?.resolve();
				return await gates[slot]?.promise;
			}),
		);
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		const overlays = captureOverlays();
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);

		const first = mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });
		await entered[0]?.promise;
		const second = mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });
		await entered[1]?.promise;

		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		// The newer review tore the old overlay down when it took over, and its own
		// overlay is the only one on screen.
		expect(overlays.map(overlay => overlay.hidden)).toEqual([true, false]);

		gates[0]?.resolve(undefined);
		await first;
		// The superseded review returns silently: a second picker here would stack
		// two reviews and strand `showPlanReview`'s promise forever — and it must
		// not close the overlay it no longer owns.
		expect(picker).not.toHaveBeenCalled();
		expect(overlays.map(overlay => overlay.hidden)).toEqual([true, false]);

		gates[1]?.resolve(undefined);
		await second;
		expect(picker).toHaveBeenCalledTimes(1);
		// The owning review closes its own overlay before handing over to the picker.
		expect(overlays.map(overlay => overlay.hidden)).toEqual([true, true]);
	});

	it("returns silently when the session switches during a review", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<ReviewDecision>();
		let signal: AbortSignal | undefined;
		await createMode(pi =>
			pi.on("plan_review", async event => {
				signal = event.signal;
				entered.resolve();
				return await release.promise;
			}),
		);
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);

		const pending = mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });
		await entered.promise;
		await mode.prepareSessionSwitch();
		release.resolve({ action: "approve" });
		await pending;

		expect(signal?.aborted).toBe(true);
		expect(picker).not.toHaveBeenCalled();
	});

	it("cancels the reviewer when an error banner dismisses the waiting overlay", async () => {
		// A provider error in the proposing turn pins a banner and drops every
		// review surface. The reviewer must be cancelled with it, or its late
		// approval would clear a session the operator is already typing in.
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<ReviewDecision>();
		let signal: AbortSignal | undefined;
		await createMode(pi =>
			pi.on("plan_review", async event => {
				signal = event.signal;
				entered.resolve();
				return await release.promise;
			}),
		);
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		const pending = mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });
		await entered.promise;
		mode.showPinnedError("provider failed");
		release.resolve({ action: "approve" });
		await pending;

		expect(signal?.aborted).toBe(true);
		expect(picker).not.toHaveBeenCalled();
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
	});

	it("falls back to the picker when an approval asks to keep an over-full context", async () => {
		await createMode(pi => pi.on("plan_review", () => ({ action: "approve", context: "keep" })));
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		vi.spyOn(session, "getContextUsage").mockReturnValue({
			tokens: 99_000,
			contextWindow: 100_000,
			percent: 99,
		} as never);
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);
		const warning = vi.spyOn(mode, "showWarning");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });

		expect(warning).toHaveBeenCalledWith(expect.stringContaining("too full"));
		expect(picker).toHaveBeenCalledTimes(1);
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
	});

	it("does not abort the reviewer's own signal while applying its approval", async () => {
		// #approvePlan → handleClearCommand → prepareSessionSwitch aborts pending
		// reviews. The controller must already be detached, or the consumer would
		// see its approval cancelled mid-flight and kill the reviewer process.
		let signal: AbortSignal | undefined;
		await createMode(pi =>
			pi.on("plan_review", event => {
				signal = event.signal;
				return { action: "approve" };
			}),
		);
		await enterPlanMode("local://PLAN.md", "# Plan\n\nbody");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath: "local://PLAN.md", planExists: true, title: "PLAN" });

		expect(signal?.aborted).toBe(false);
	});

	it("does not emit the event for the operator's own /plan-review", async () => {
		let called = 0;
		await createMode(pi =>
			pi.on("plan_review", () => {
				called++;
				return { action: "approve" };
			}),
		);
		await enterPlanMode("local://demo-plan.md", "# Demo\n\nbody");
		const picker = vi.spyOn(mode, "showPlanReview").mockResolvedValue(undefined);

		await mode.openPlanReview();

		expect(called).toBe(0);
		expect(picker).toHaveBeenCalledTimes(1);
	});
});
