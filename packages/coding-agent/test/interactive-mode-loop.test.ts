import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

const LOOP_REMINDER_TYPE = "loop-reminder";

const isLoopReminder = (m: AgentMessage): m is Extract<AgentMessage, { role: "custom" }> =>
	m.role === "custom" && m.customType === LOOP_REMINDER_TYPE;

/** Whether a reminder is queued on the non-interrupting aside queue — where a mid-turn tick
 *  delivers it (never the steering queue: a queued steer would abort an in-flight interruptible
 *  tool wait under the default `interruptMode: "immediate"`). A regression back to steer delivery
 *  has to fail the dedicated aside-delivery test below, which checks both queues directly. */
function hasAsideReminder(session: AgentSession): boolean {
	return session.hasQueuedAside(LOOP_REMINDER_TYPE);
}

/** Whether a reminder survives on any queue it could hide in — steering, follow-up, or the aside
 *  queue — for cleanup/retraction assertions where nothing may survive anywhere. */
function anyQueuedReminders(session: AgentSession): boolean {
	return (
		session.agent.peekSteeringQueue().some(isLoopReminder) ||
		session.agent.peekFollowUpQueue().some(isLoopReminder) ||
		session.hasQueuedAside(LOOP_REMINDER_TYPE)
	);
}

describe("InteractiveMode loop auto-submit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let pendingInput: Promise<SubmittedUserInput> | undefined;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-auto-submit-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	beforeEach(() => {
		settings.set("loop.mode", "prompt");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode.disableLoopMode("Loop mode disabled.");
		mode.cancelPendingSubmission();
		if (mode.onInputCallback) {
			mode.onInputCallback({ text: "", cancelled: true, started: false });
		}
		await pendingInput;
		pendingInput = undefined;
		mode.vibeModeEnabled = false;
		Reflect.deleteProperty(session, "isCompacting");
		Reflect.deleteProperty(session, "isStreaming");
		Reflect.deleteProperty(session, "hasPostPromptWork");
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("does not resolve the next loop prompt while compaction is running", async () => {
		vi.useFakeTimers();
		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		compacting = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat this");
	});

	it("does not recompact when a compact loop turn starts another prompt before resubmitting", async () => {
		vi.useFakeTimers();
		settings.set("loop.mode", "compact");
		let streaming = false;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const compact = vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			streaming = true;
			return "ok";
		});

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat after compact";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(0);

		streaming = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat after compact");
	});

	it("does not resolve the next loop prompt while post-prompt background work is pending", async () => {
		vi.useFakeTimers();
		let hasPendingWork = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => hasPendingWork });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "deliver this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		// Loop timer fires while an idle-flush / delivery turn is still pending.
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		// Background delivery completes; loop may now fire.
		hasPendingWork = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("deliver this");
	});

	it("starts an interval loop's cadence at its first prompt, not when /loop was typed", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", {
			configurable: true,
			get: () => false,
		});
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => false,
		});

		// Bare `/loop 30s`: there is no instruction to deliver yet.
		await mode.handleLoopCommand("30s");
		mode.editor.setText("");
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then((input) => resolved.push(input));

		// Deliberately not a multiple of the interval: if the clock had started at
		// command entry, its next tick would land inside the 29s window below.
		vi.advanceTimersByTime(100_000);
		await flushMicrotasks();
		// Ticks before a prompt exists would be dropped anyway; the clock must not
		// have been spending the user's typing time either.
		expect(resolved).toHaveLength(0);

		mode.setLoopPrompt("keep going");
		vi.advanceTimersByTime(29_000);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.text).toBe("keep going");
	});

	it("drops a queued interval reminder on a user interrupt, leaving other queued work alone", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", {
			configurable: true,
			get: () => false,
		});
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => true,
		});

		await mode.handleLoopCommand("30s remind me");
		mode.setLoopPrompt("remind me");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		// A real user steer queued alongside it, on the unrelated steering queue, must survive.
		const userSteer = {
			role: "user" as const,
			content: "mine",
			steering: true,
			attribution: "user" as const,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		session.agent.replaceQueues(
			[...session.agent.peekSteeringQueue(), userSteer],
			[],
		);
		expect(hasAsideReminder(session)).toBe(true);

		// Esc routes here. A reminder left queued on either queue would make the
		// abort's drain resume immediately or fire again on a later tick.
		mode.dropQueuedLoopReminders();

		expect(anyQueuedReminders(session)).toBe(false);
		expect(session.agent.peekSteeringQueue()).toEqual([userSteer]);
	});

	it("scopes aside retraction to the reminder's customType, leaving an unrelated aside queued", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });

		await mode.handleLoopCommand("30s remind me");
		mode.setLoopPrompt("remind me");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(hasAsideReminder(session)).toBe(true);

		// An unrelated aside (e.g. an extension's `deliverAs: "aside"` send) riding the same
		// queue must survive a loop-reminder retraction — dropQueuedAsides is customType-scoped.
		await session.sendCustomMessage(
			{ customType: "unrelated-aside", content: "keep me", display: false, attribution: "user" },
			{ deliverAs: "aside" },
		);
		expect(session.hasQueuedAside("unrelated-aside")).toBe(true);

		mode.dropQueuedLoopReminders();

		expect(hasAsideReminder(session)).toBe(false);
		expect(session.hasQueuedAside("unrelated-aside")).toBe(true);
	});

	it("disables reset loops when vibe blocks the session transition", async () => {
		vi.useFakeTimers();
		settings.set("loop.mode", "reset");
		mode.vibeModeEnabled = true;
		mode.loopModeEnabled = true;
		mode.loopPrompt = "do not resubmit";
		const showStatus = vi.spyOn(mode, "showStatus");
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(0);
		expect(mode.loopModeEnabled).toBe(false);
		expect(mode.loopPrompt).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");
	});

	it("reports waiting, running, paused, resumed, and disabled loop states", async () => {
		const setLoopModeStatus = vi.spyOn(mode.statusLine, "setLoopModeStatus");

		await mode.handleLoopCommand("3");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "waiting",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("repeat this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.pauseLoop();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "paused",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("resume this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.disableLoopMode();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith(undefined);
	});

	it("hands an interval loop's inline prompt to the normal submit path, busy or idle", async () => {
		Object.defineProperty(session, "isCompacting", {
			configurable: true,
			get: () => false,
		});
		let streaming = false;
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => streaming,
		});

		// Idle: submitted immediately. loopPrompt is recorded by the submit path,
		// not pre-set here.
		expect(await mode.handleLoopCommand("30s do it now")).toBe("do it now");
		expect(mode.loopPrompt).toBeUndefined();
		mode.disableLoopMode();

		// Busy: also handed back. It goes out like any typed prompt — steered into
		// the live turn, carrying its own attachments — and the interval nudges from
		// there. Withholding it here would consume the command and orphan those
		// attachments in the composer, where `/loop` has already cleared the
		// `[Image #N]` markers that keep them alive.
		streaming = true;
		expect(await mode.handleLoopCommand("30s do it now")).toBe("do it now");
		mode.disableLoopMode();

		Object.defineProperty(session, "isCompacting", {
			configurable: true,
			get: () => true,
		});
		streaming = false;
		expect(await mode.handleLoopCommand("30s do it later")).toBe("do it later");
	});

	it("keeps a composer attachment out of an interval reminder, since reminders are text-only", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", {
			configurable: true,
			get: () => false,
		});
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => false,
		});
		const image = {
			type: "image",
			data: "aGk=",
			mimeType: "image/png",
		} as unknown as ImageContent;

		await mode.handleLoopCommand("30s keep going");
		mode.setLoopPrompt("keep going");
		mode.editor.setText("");
		// An attachment in the composer belongs to the user's next message. The
		// reminder must neither consume it nor stall behind it forever.
		mode.editor.pendingImages = [image];
		mode.editor.pendingImageLinks = [undefined];

		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then((input) => resolved.push(input));
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();

		expect(resolved).toHaveLength(0);
		expect(mode.editor.pendingImages).toEqual([image]);

		// Once the composer is clear the reminder goes out, text only.
		mode.editor.pendingImages = [];
		mode.editor.pendingImageLinks = [];
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.text).toBe("keep going");
		expect(resolved[0]?.images).toBeUndefined();
	});

	it("delivers an interval reminder into a streaming turn as a non-interrupting aside, not a steer, and never duplicates it", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const promptSpy = vi.spyOn(session, "promptCustomMessage");

		// The inline prompt goes out through the normal submit path, which is what
		// records it as the loop prompt; stand in for that here.
		await mode.handleLoopCommand("30s remind me");
		mode.setLoopPrompt("remind me");

		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		// Delivered as a non-interrupting aside — never a steer, which under the
		// default interruptMode:"immediate" would abort an in-flight interruptible
		// tool wait (hub wait, vibe) the streaming turn happens to be running.
		expect(promptSpy.mock.calls[0]?.[1]).toMatchObject({ streamingBehavior: "aside" });
		expect(hasAsideReminder(session)).toBe(true);
		expect(session.agent.peekSteeringQueue().filter(isLoopReminder)).toEqual([]);
		expect(session.agent.peekFollowUpQueue().filter(isLoopReminder)).toEqual([]);

		// A second tick before the first reminder is consumed (still streaming)
		// must not pile up a duplicate.
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});

	it("delivers a fresh aside each interval once the run has consumed the previous one, so a long turn is reminded repeatedly", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });

		await mode.handleLoopCommand("30m keep going");
		mode.setLoopPrompt("keep going");

		// One long turn spanning two hours on a 30-minute interval: the run's
		// step-boundary aside poll consumes each reminder, so the next tick
		// delivers the next one. Four ticks must produce four deliveries, not one.
		let delivered = 0;
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(30 * 60_000);
			await flushMicrotasks();
			if (hasAsideReminder(session)) delivered++;
			// The run's aside poll consumes it mid-run.
			session.dropQueuedAsides(LOOP_REMINDER_TYPE);
		}

		expect(delivered).toBe(4);
	});

	it("drops a still-queued interval reminder when the loop is disabled", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });

		await mode.handleLoopCommand("30s remind me");
		mode.setLoopPrompt("remind me");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(hasAsideReminder(session)).toBe(true);

		mode.disableLoopMode();

		expect(anyQueuedReminders(session)).toBe(false);
	});

	it("drops a stale queued reminder and queues fresh content when the loop prompt changes mid-turn", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const promptSpy = vi.spyOn(session, "promptCustomMessage");

		await mode.handleLoopCommand("30s remind me");
		mode.setLoopPrompt("remind me");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(promptSpy.mock.calls.map(call => call[0].content)).toEqual(["remind me"]);
		expect(hasAsideReminder(session)).toBe(true);

		// The user replaces the loop prompt before the queued reminder drains —
		// the stale "remind me" reminder must not survive to fire after the fact.
		mode.setLoopPrompt("new instructions");
		expect(anyQueuedReminders(session)).toBe(false);

		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(promptSpy.mock.calls.map(call => call[0].content)).toEqual(["remind me", "new instructions"]);
	});

	it("consumes a reminder retained across an interrupted turn so one cadence produces one turn", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });

		await mode.handleLoopCommand("30s remind me");
		mode.setLoopPrompt("remind me");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(hasAsideReminder(session)).toBe(true);

		// The user interrupts (Esc) before the reminder is consumed: the session
		// deliberately retains the hidden message while suppressing auto-resume.
		streaming = false;
		mode.editor.setText("");

		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();

		// The visible submission *is* this tick. Leaving the retained reminder
		// queued would re-enable auto-resume and drain it after the new turn —
		// two model turns running the same loop instruction for one cadence.
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.text).toBe("remind me");
		expect(anyQueuedReminders(session)).toBe(false);
	});

	it("skips an idle interval tick while the user is composing, preserving the draft until the composer clears", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		await mode.handleLoopCommand("30s do it");
		mode.setLoopPrompt("do it");
		mode.editor.setText("half-typed draft");

		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		// A tick that submitted here would clear the draft via startPendingSubmission.
		expect(resolved).toHaveLength(0);
		expect(mode.editor.getText()).toBe("half-typed draft");

		mode.editor.setText("");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("do it");
	});

	// Final test: it calls mode.stop(), permanently tearing down the shared
	// harness instance, so nothing after it may reuse mode.
	it("cancels the timer and drops an already-queued reminder on stop() so nothing fires after teardown", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });

		await mode.handleLoopCommand("30s remind me");
		mode.setLoopPrompt("remind me");

		// Let one tick queue a reminder onto the live turn before teardown.
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(hasAsideReminder(session)).toBe(true);

		mode.stop();

		// Teardown must both drop the queued reminder and stop future ticks.
		expect(anyQueuedReminders(session)).toBe(false);
		vi.advanceTimersByTime(120_000);
		await flushMicrotasks();
		expect(anyQueuedReminders(session)).toBe(false);
	});
});
