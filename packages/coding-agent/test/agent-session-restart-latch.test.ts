/**
 * Contract: once a cooperative restart is latched (`#restarting`), no turn may
 * start — but the latch must not silently swallow the input a caller handed in.
 * Every prompt path gives the caller an OBSERVABLE signal so it can persist /
 * restore the input and never leave a protocol host waiting for an `agent_end`
 * that will never fire:
 *  - prompt() hands a dropped user prompt back through the drop hook.
 *  - promptCustomMessage() reports `false` (no turn started), and hands a
 *    user-typed `/skill:` invocation back through the same drop hook — its
 *    interactive callers consume the draft before dispatch and ignore the
 *    `false`, so without the hook the typed text vanishes into the restart.
 *  - sendCustomMessage({ triggerTurn }) reports `false` instead of a false `true`.
 *  - a model mutation (setModel / setModelTemporary / the cycle methods) is
 *    REFUSED rather than admitted: each one awaits
 *    `refreshSelectedModelMetadata()` before `appendModelChange()`, so one
 *    admitted after the latch parks in that probe, resumes against a sealed
 *    SessionManager, and reports a switch the replacement session never sees.
 *
 * The latch is held open (but the session kept alive and undisposed) by gating
 * the durability flush inside requestRestart(), so the assertions run in the
 * real post-latch / pre-dispose window rather than against a torn-down session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { scheduler } from "node:timers/promises";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { DroppedPrompt } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession restart-latch prompt contract", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	let mock: MockModel;
	let releaseFlush: (() => void) | undefined;
	// Resolves when the gated flush spy is entered — the exact post-first-check
	// window a durability failure would strand input over.
	let flushReached: Promise<void> | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-restart-latch-");
	});

	afterEach(async () => {
		releaseFlush?.();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
		vi.restoreAllMocks();
	});

	/**
	 * Build a live, file-backed session whose durability flush is gated open, so
	 * a restart requested against it latches `#restarting` and then parks before
	 * dispose. The gate is released in afterEach via `releaseFlush`.
	 */
	async function buildSession(config?: {
		customCommands?: LoadedCustomCommand[];
		onRestartRequested?: (info: { sessionId: string; sessionFile: string }) => void | Promise<void>;
		/** Where #doRequestRestart parks while latched. "flush" gates the
		 *  durability barrier (default); "waitForIdle" gates the earlier quiescence
		 *  wait, leaving sessionManager.flush real for transitions that flush. */
		gateAt?: "flush" | "waitForIdle";
		/** When true, releasing the gated flush REJECTS it (a durability failure)
		 *  instead of resolving, exercising the recoverable catch branch. */
		flushRejects?: boolean;
		/** Leave compaction enabled AND shrink the keep-recent window, so
		 *  `handoff()`'s prepareCompaction has older turns to summarize rather
		 *  than keeping the whole short test transcript as "recent". */
		compactionEnabled?: boolean;
		/** Stub runner supplying a gated session_before_switch / session_before_branch
		 *  handler, so a transition can be parked inside its awaited hook. */
		extensionRunner?: { hasHandlers: (eventType: string) => boolean; emit: () => Promise<undefined> };
	}): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(
				config?.compactionEnabled
					? { "compaction.enabled": true, "compaction.keepRecentTokens": 1 }
					: { "compaction.enabled": false },
			),
			modelRegistry,
			customCommands: config?.customCommands,
			extensionRunner: config?.extensionRunner as never,
			onRestartRequested: config?.onRestartRequested ?? (() => {}),
		});

		const gate = Promise.withResolvers<void>();
		// A rejected gate must not surface as an unhandled rejection before the
		// awaiting flush observes it; attach a no-op catch to the raw promise.
		if (config?.flushRejects) gate.promise.catch(() => {});
		releaseFlush = config?.flushRejects ? () => gate.reject(new Error("durability write failed")) : gate.resolve;
		// Park #doRequestRestart after latching #restarting but before dispose —
		// the exact post-latch/pre-dispose window. Released in afterEach.
		if (config?.gateAt === "waitForIdle") {
			vi.spyOn(session, "waitForIdle").mockReturnValue(gate.promise);
		} else {
			const reached = Promise.withResolvers<void>();
			flushReached = reached.promise;
			vi.spyOn(sessionManager, "flush").mockImplementation(() => {
				reached.resolve();
				return gate.promise;
			});
		}
	}

	/**
	 * Build a live, file-backed session and latch a restart that hangs at the
	 * durability flush, so `#restarting` is set but dispose never completes.
	 * Returns once the latch is committed.
	 */
	async function latchedSession(): Promise<void> {
		await buildSession();
		// requestRestart() sets #restarting synchronously before its first await,
		// so the session is latched the moment this returns. The returned promise
		// stays pending on the gated flush; released in afterEach.
		void session.requestRestart();
	}

	it("hands a latched user prompt back through the drop hook instead of losing it", async () => {
		await latchedSession();
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const forwarded = await session.prompt("please do the thing");

		expect(forwarded).toBe(false);
		expect(dropped).toEqual([{ text: "please do the thing", images: undefined }]);
	});

	it("does not surface a synthetic latched prompt (agent-initiated input is not replayed)", async () => {
		await latchedSession();
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const forwarded = await session.prompt("auto-continue", { synthetic: true });

		expect(forwarded).toBe(false);
		expect(dropped).toEqual([]);
	});

	it("returns false and drops a user prompt latched mid-flight after passing the top guard", async () => {
		// The real race prompt() must survive: a user prompt clears the
		// top-of-prompt() latch check, then a concurrent restart latches
		// #restarting while the prompt is still in async preprocessing, so the
		// SECOND guard inside #promptWithMessage refuses it. A custom slash
		// command reproduces that window deterministically — its execute() runs
		// AFTER the top guard but BEFORE #promptWithMessage, and requestRestart()
		// sets #restarting synchronously, so the shared chokepoint sees the latch
		// and returns false. prompt() must propagate that false (not a stale
		// unconditional true) so a lifecycle host does not await a dead agent_end,
		// and must still hand the input back through the drop hook.
		const latch: LoadedCustomCommand = {
			path: "latch.ts",
			resolvedPath: "latch.ts",
			source: "project",
			command: {
				name: "latch",
				description: "latch a restart mid-prompt",
				execute: () => {
					void session.requestRestart();
					return "do the thing";
				},
			},
		};
		await buildSession({ customCommands: [latch] });
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const forwarded = await session.prompt("/latch");

		expect(forwarded).toBe(false);
		expect(dropped).toEqual([{ text: "/latch", images: undefined }]);
	});

	it("reports promptCustomMessage as not-dispatched when latched", async () => {
		await latchedSession();

		const dispatched = await session.promptCustomMessage({
			customType: "skill-prompt",
			content: "run skill",
			display: true,
			attribution: "user",
		});

		expect(dispatched).toBe(false);
	});

	it("hands a latched user /skill: prompt back through the drop hook instead of losing it", async () => {
		// The interactive `/skill:` path consumes the composer draft BEFORE
		// dispatching and then reports success regardless of the outcome
		// (input-controller's #invokeSkillCommand returns true after the await),
		// so a bare `false` here loses the user's typed invocation outright.
		// `queueChipText` carries the text exactly as typed — the expanded
		// SKILL.md body is not restorable — and is what both interactive callers
		// pass, so the drop hook must receive that, not the expanded content.
		await latchedSession();
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const dispatched = await session.promptCustomMessage(
			{
				customType: "skill-prompt",
				content: "Expanded SKILL.md body: run the thing",
				display: true,
				details: { name: "review", args: "the diff" },
				attribution: "user",
			},
			{ streamingBehavior: "steer", queueChipText: "/skill:review the diff" },
		);

		expect(dispatched).toBe(false);
		expect(dropped).toEqual([{ text: "/skill:review the diff", images: undefined }]);
	});

	it("restores the images attached to a latched user /skill: prompt", async () => {
		// The draft a registered skill consumes includes pending images, so a
		// restore that returns only the text still loses the attachments.
		await latchedSession();
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

		const dispatched = await session.promptCustomMessage(
			{
				customType: "skill-prompt",
				content: [{ type: "text", text: "Expanded SKILL.md body" }, image],
				display: true,
				attribution: "user",
			},
			{ streamingBehavior: "steer", queueChipText: "/skill:review" },
		);

		expect(dispatched).toBe(false);
		expect(dropped).toEqual([{ text: "/skill:review", images: [image] }]);
	});

	it("does not restore a latched agent-attributed skill prompt (autoloaded, never typed)", async () => {
		// Autoload injections are hidden, non-user context: replaying one into the
		// operator's editor would paste text they never wrote.
		await latchedSession();
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const dispatched = await session.promptCustomMessage(
			{
				customType: "skill-prompt",
				content: "Autoloaded skill body",
				display: false,
				attribution: "agent",
			},
			{ streamingBehavior: "steer", queueChipText: "/skill:autoloaded" },
		);

		expect(dispatched).toBe(false);
		expect(dropped).toEqual([]);
	});

	it("does not restore a latched collab guest prompt into the host editor", async () => {
		// A collab guest prompt is user-attributed but carries ANOTHER operator's
		// text; host.ts reports the drop back over the wire instead. Pasting it
		// into this host's composer would put a guest's words in the user's draft.
		await latchedSession();
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const dispatched = await session.promptCustomMessage(
			{
				customType: "collab_prompt",
				content: "guest asks for a refactor",
				display: true,
				attribution: "user",
			},
			{ streamingBehavior: "steer", queueChipText: "guest asks for a refactor" },
		);

		expect(dispatched).toBe(false);
		expect(dropped).toEqual([]);
	});

	it("reports sendCustomMessage({ triggerTurn }) as no-turn-started when latched", async () => {
		await latchedSession();

		const started = await session.sendCustomMessage(
			{ customType: "advisor", content: "note", display: false, attribution: "agent" },
			{ triggerTurn: true },
		);

		expect(started).toBe(false);
	});

	it("refuses newSession while a restart is latched so the transition cannot swap the captured file", async () => {
		await buildSession();
		const capturedFile = session.sessionFile;
		void session.requestRestart();

		const started = await session.newSession();

		expect(started).toBe(false);
		// The session file the restart captured is untouched: no transition ran,
		// so #doRequestRestart cannot pair a new id with the old file.
		expect(session.sessionFile).toBe(capturedFile);
	});

	it("refuses switchSession while a restart is latched", async () => {
		await buildSession();
		const capturedFile = session.sessionFile;
		void session.requestRestart();

		const switched = await session.switchSession(tempDir.join("other-session.jsonl"));

		expect(switched).toBe(false);
		expect(session.sessionFile).toBe(capturedFile);
	});

	it("reports branch as cancelled while a restart is latched", async () => {
		await buildSession();
		// A persisted user entry gives branch() a valid target so the latch guard,
		// not target validation, is what makes it a no-op.
		session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		const userEntry = session.sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected a persisted user entry");
		void session.requestRestart();

		const result = await session.branch(userEntry.id);

		expect(result.cancelled).toBe(true);
	});

	it("reports moveSession as refused while a restart is latched so callers do not re-scope past a move that never ran", async () => {
		await buildSession();
		const capturedFile = session.sessionFile;
		void session.requestRestart();

		// A silent return is indistinguishable from success, and BOTH callers
		// (/move in command-controller, the headless relocate path) re-scope the
		// process/UI workspace to the target on success — leaving the workspace and
		// the persisted session rooted in different directories. The refusal must be
		// observable so they stop.
		const moved = await session.moveSession(tempDir.join("moved"));

		expect(moved).toBe(false);
		// The captured file is untouched: a move would have renamed it away, leaving
		// #doRequestRestart to hand the host a path that no longer exists.
		expect(session.sessionFile).toBe(capturedFile);
	});

	it("reports branchFromBtw as cancelled while a restart is latched so the captured file is not swapped", async () => {
		await buildSession();
		session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		const leafId = session.sessionManager.getLeafId();
		if (!leafId) throw new Error("Expected a persisted leaf entry");
		const sessionId = session.sessionManager.getSessionId();
		const capturedFile = session.sessionFile;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "side answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		void session.requestRestart();

		const result = await session.branchFromBtw("why?", assistantMessage, leafId, sessionId);

		expect(result.cancelled).toBe(true);
		// The captured file is untouched: no branch swapped it out from under the
		// in-flight restart.
		expect(session.sessionFile).toBe(capturedFile);
	});

	it("refuses resetSessionContext while a restart is latched so the boundary is not dropped", async () => {
		await buildSession();
		const boundary = vi.spyOn(session.sessionManager, "appendResetBoundary");
		session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		void session.requestRestart();

		const result = await session.resetSessionContext();

		// Refused whole, not half-done: no caller-visible success, and the
		// boundary append never ran against a manager the restart is sealing.
		expect(result).toBeUndefined();
		expect(boundary).not.toHaveBeenCalled();
	});

	// The inverse race: the reset enters FIRST and parks in one of its awaits,
	// then the restart latches. Nothing else counts this op, so without the
	// barrier the quiescence wait reads zeros and disposes mid-reset — after the
	// in-memory state is cleared but before the boundary is recorded.
	it("refuses busy while a resetSessionContext that entered first is still running", async () => {
		const onRestart = vi.fn();
		const resetReached = Promise.withResolvers<void>();
		await buildSession({ gateAt: "waitForIdle", onRestartRequested: onRestart });
		session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		// Park the reset inside its own await, past its latch check and before the
		// boundary append. That is the window where a disposal loses the boundary:
		// the in-memory state is already cleared, the durable record is not
		// written, and the caller is still owed its result.
		vi.spyOn(session.sessionManager, "appendResetBoundary").mockImplementation((() => {
			resetReached.resolve();
			return "boundary-id";
		}) as never);

		const reset = session.resetSessionContext();
		await resetReached.promise;

		const restart = session.requestRestart();
		releaseFlush?.();

		expect(await restart).toEqual({ ok: false, reason: "busy" });
		// Refused before the point of no return: the session is still alive, so
		// the reset owns its own completion.
		expect(onRestart).not.toHaveBeenCalled();
		expect(session.isDisposed).toBe(false);
		expect(await reset).toEqual({ droppedCount: expect.any(Number) });
	});

	it("refuses busy while manual context maintenance is still running", async () => {
		// An SDK caller's compact() runs with the foreground agent IDLE, so the
		// quiescence wait (promptInFlight / queuedInputPrep / modelMutation) sees
		// nothing and lets the restart through. Disposal then aborts the in-flight
		// pass, so the summary the caller is awaiting is destroyed and the
		// replacement session reopens without it. `branchFromBtw` already refuses
		// over exactly this getter; restart must agree.
		//
		// `isCompacting` is backed by a private abort controller, and bun's spyOn
		// cannot stub an accessor, so drive the real thing: a compaction whose
		// model call never settles holds the controller open for the assertion.
		await buildSession();
		// A summary call that never settles holds the compaction abort controller
		// open for the duration of the assertion.
		const summaryGate = Promise.withResolvers<never>();
		mock.push(() => summaryGate.promise);
		const compacting = session.compact();
		for (let i = 0; i < 200 && !session.isCompacting; i++) await scheduler.wait(5);
		expect(session.isCompacting).toBe(true);

		expect(await session.requestRestart()).toEqual({ ok: false, reason: "busy" });

		session.abortCompaction();
		await compacting.catch(() => {});
	});

	it("refuses busy while a handoff is still generating", async () => {
		// Same hazard on the handoff path: restart disposal aborts handoff
		// generation too, so a caller awaiting the document loses it.
		await buildSession({ compactionEnabled: true });
		// handoff() refuses both an empty transcript and one prepareCompaction
		// finds nothing to summarize, so record a few real turns first.
		for (let i = 0; i < 4; i++) await session.prompt(`turn ${i} ${"padding ".repeat(200)}`);
		const handoffGate = Promise.withResolvers<never>();
		mock.push(() => handoffGate.promise);
		const generating = session.handoff();
		for (let i = 0; i < 200 && !session.isGeneratingHandoff; i++) await scheduler.wait(5);
		expect(session.isGeneratingHandoff).toBe(true);

		expect(await session.requestRestart()).toEqual({ ok: false, reason: "busy" });

		session.abortHandoff();
		await generating.catch(() => {});
	});

	it("drains input queued during the post-wait busy refusal so a direct SDK restart does not strand the turn", async () => {
		// Park the restart at the post-idle quiescence wait, so input queued while
		// it awaits lands in the exact window the busy branch refuses over. A direct
		// SDK requestRestart() has no restart-tool refusal message to incidentally
		// start another turn, so unless the busy branch resumes the drains the
		// queued turn stays stranded and a host waits forever.
		await buildSession({ gateAt: "waitForIdle" });
		const restart = session.requestRestart();
		// A host/extension steer that calls agent.steer directly (never the
		// turn-start latch) after the restart latched.
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "queued while waiting" }],
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// Release the quiescence gate: #doRequestRestart resumes, sees the queued
		// input, and refuses busy.
		releaseFlush?.();
		expect(await restart).toEqual({ ok: false, reason: "busy" });

		// The resumed drain must start a turn that consumes the queued input. Poll
		// until the provider call lands (the drain schedules a post-prompt continue,
		// so the queue empties a tick before the turn actually reaches the model).
		for (let i = 0; i < 200 && mock.calls.length === 0; i++) {
			await scheduler.wait(5);
		}

		expect(mock.calls.length).toBe(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("redrains input queued during a rejected durability flush so a direct SDK restart does not strand the turn", async () => {
		// Park the restart at the durability flush and make it REJECT. A steer
		// enqueues while the flush awaits under #restarting; when the flush rejects,
		// the recoverable catch (dispose never began) unlatches — but a direct SDK
		// requestRestart() has no restart-tool refusal message to incidentally start
		// another turn, so unless the catch resumes the drains the queued turn stays
		// stranded and a host waits forever.
		await buildSession({ gateAt: "flush", flushRejects: true });
		const restart = session.requestRestart();
		// Wait until the barrier has passed its pre-flush #hasUnpersistedInput
		// checks and entered the (gated) durability flush. Steering earlier would
		// trip the earlier busy refusal instead of the durability-failure path.
		await flushReached;
		// A host/extension steer that calls agent.steer directly (never the
		// turn-start latch), landing while the durability flush awaits.
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "queued during flush" }],
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// Release the gate as a rejection: #doRequestRestart's catch runs. dispose
		// never began, so it is the recoverable branch — it must unlatch and resume
		// the drains, then rethrow.
		releaseFlush?.();
		await expect(restart).rejects.toThrow("durability write failed");

		// The resumed drain must start a turn that consumes the queued input. Poll
		// until the provider call lands (the drain schedules a post-prompt continue,
		// so the queue empties a tick before the turn actually reaches the model).
		for (let i = 0; i < 200 && mock.calls.length === 0; i++) {
			await scheduler.wait(5);
		}

		expect(mock.calls.length).toBe(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("drops a slash-command prompt whose restart latches during the manual-compaction-cleanup await, before the handler runs", async () => {
		// prompt() awaits #maintenance.manualCompactionCleanup (a real yield point)
		// BEFORE the local slash-command handlers. A concurrent SDK restart can
		// latch #restarting during that await; the extension/custom handlers run
		// locally and return WITHOUT reaching #promptWithMessage's shared recheck or
		// #beginInFlight, so an async handler would keep using the disposed
		// extension/session runtime past the durability barrier. The post-await
		// recheck must observe the latch, hand the typed text back through the drop
		// hook, and return false — the command handler must never run.
		const execSpy = vi.fn(() => "do the thing");
		const command: LoadedCustomCommand = {
			path: "runme.ts",
			resolvedPath: "runme.ts",
			source: "project",
			command: {
				name: "runme",
				description: "a local custom command",
				execute: execSpy,
			},
		};
		await buildSession({ customCommands: [command] });
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		// requestRestart() latches #restarting synchronously (before its first
		// await), so ordering alone opens the window deterministically: prompt()'s
		// only await before the slash handlers is
		// `await this.#maintenance.manualCompactionCleanup` (undefined here, so it
		// yields one microtask). Starting the prompt schedules that continuation;
		// latching the restart on the SAME synchronous tick sets #restarting before
		// the continuation runs. When prompt() resumes, the post-await recheck must
		// see the latch and bail before the command handler.
		const forwarded = session.prompt("/runme");
		void session.requestRestart();

		expect(await forwarded).toBe(false);
		// The command handler never ran — the recheck closed the window before it.
		expect(execSpy).not.toHaveBeenCalled();
		// The typed text is handed back for restore/resubmit across the recycle.
		expect(dropped).toEqual([{ text: "/runme", images: undefined }]);
	});

	it("cancels the restart when a non-restart teardown already owns disposal, without recreating the session", async () => {
		// dispose() coalesces via #disposeCall. If an ordinary host shutdown calls
		// dispose() (WITHOUT preserveSessionFile) after the restart latched
		// #restarting but before the restart reaches its own dispose, that host
		// disposal already owns #disposeCall. The restart's dispose would merely
		// JOIN it — preserveSessionFile ignored — yet the restart would still
		// resetCapabilities() and fire onRestartRequested(), so a compliant host
		// recreates the session during shutdown. The guard must detect the
		// already-owned disposal and refuse recoverably (busy) WITHOUT firing the
		// restart callback.
		const onRestart = vi.fn();
		await buildSession({ onRestartRequested: onRestart });
		// Materialize the captured file on disk so the recreation-cancellation is
		// observable against a real reattach target.
		await session.sessionManager.ensureOnDisk();
		const capturedFile = session.sessionFile;
		if (!capturedFile) throw new Error("Expected a persisted session file");

		// Latch the restart; it parks at the gated durability flush, BEFORE the
		// point where it would join disposal.
		const restart = session.requestRestart();
		await flushReached;

		// An ordinary host shutdown wins the disposal race: dispose() (no
		// preserveSessionFile) synchronously claims #disposeCall. Drive it to
		// completion so #disposeCall is a settled, non-restart-owned disposal.
		await session.dispose();

		// Release the restart's flush gate: it resumes and reaches the guard, which
		// sees the already-owned disposal and refuses.
		releaseFlush?.();

		expect(await restart).toEqual({ ok: false, reason: "busy" });
		// The restart did NOT recreate the session over the shutting-down host.
		expect(onRestart).not.toHaveBeenCalled();
		// The captured reattach file survives the host's normal disposal.
		expect(fs.existsSync(capturedFile)).toBe(true);
	});

	it("cancels the restart during the SDK wrapper's in-progress teardown, before the inner dispose() is called", async () => {
		// #disposeCall alone under-detects an in-progress
		// teardown. `createAgentSession()`'s dispose wrapper calls beginDispose()
		// synchronously (setting #isDisposed), then AWAITS the agent lifecycle
		// cleanup, and only then invokes the original dispose() — so #disposeCall
		// stays unset across that whole async gap while the host is already
		// shutting down. A restart resuming inside the gap passed a
		// #disposeCall-only guard and went on to fire onRestartRequested(),
		// recreating the session over a dying host.
		//
		// This reproduces the wrapper's exact shape: beginDispose() -> pending
		// lifecycle await -> original dispose(). The restart resumes strictly
		// inside the await, so #isDisposed is set but #disposeCall is not.
		//
		// RED (pre-fix): the guard checked only #disposeCall, so the restart
		// resolved `{ ok: true }` and onRestart fired.
		const onRestart = vi.fn();
		await buildSession({ onRestartRequested: onRestart });
		await session.sessionManager.ensureOnDisk();

		// Stand in for the wrapper's `await AgentLifecycleManager.global().dispose()`.
		const lifecycle = Promise.withResolvers<void>();
		const originalDispose = session.dispose.bind(session);
		let innerDisposeCalled = false;
		const wrapperDispose = (async () => {
			session.beginDispose();
			await lifecycle.promise;
			innerDisposeCalled = true;
			await originalDispose();
		})();

		// Latch the restart AFTER the wrapper began: it parks at the gated flush.
		const restart = session.requestRestart();
		await flushReached;

		// Pin the precise gap the finding describes: teardown has begun
		// (#isDisposed set by beginDispose) but the inner dispose() — and so
		// #disposeCall — has not been reached.
		expect(session.isDisposed).toBe(true);
		expect(innerDisposeCalled).toBe(false);

		// Release the restart's flush gate while the wrapper is still awaiting
		// lifecycle cleanup, so the restart reaches the guard inside the gap.
		releaseFlush?.();

		expect(await restart).toEqual({ ok: false, reason: "busy" });
		// The restart must not recreate the session while its host tears down.
		expect(onRestart).not.toHaveBeenCalled();
		expect(innerDisposeCalled).toBe(false);

		// Let the wrapper finish so afterEach's dispose() is a no-op join.
		lifecycle.resolve();
		await wrapperDispose;
	});

	// F1/F7: the transition latch check is not atomic with the file swap. A
	// transition that entered BEFORE the restart latched parks in its awaited
	// `session_before_switch` hook; `waitForIdle()` observes none of that, and the
	// coherence check compares against a file the transition has not renamed YET.
	// So the restart could flush, dispose, and hand the host a path the resuming
	// transition swaps out from under the replacement.
	//
	// RED (pre-fix): the restart resolved `{ ok: true }` and fired the callback
	// while newSession() was still parked in its hook.
	it("refuses busy while a newSession that entered first is parked in its transition hook", async () => {
		// Gate at waitForIdle so the restart's own park is the quiescence wait —
		// the transition's flush must stay real, since newSession() calls it.
		const onRestart = vi.fn();
		const hookEntered = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		await buildSession({
			gateAt: "waitForIdle",
			onRestartRequested: onRestart,
			extensionRunner: {
				hasHandlers: (eventType: string) => eventType === "session_before_switch",
				emit: async () => {
					hookEntered.resolve();
					await releaseHook.promise;
					return undefined;
				},
			},
		});
		const capturedFile = session.sessionFile;

		// The transition enters FIRST and parks inside its awaited hook — past its
		// own latch check, before any file swap.
		const transition = session.newSession();
		await hookEntered.promise;

		// Only now does the restart latch. It must observe the in-flight
		// transition rather than racing it to the file.
		const restart = session.requestRestart();
		releaseFlush?.();

		expect(await restart).toEqual({ ok: false, reason: "busy" });
		// Refused BEFORE the point of no return: no callback, session still alive.
		expect(onRestart).not.toHaveBeenCalled();
		expect(session.isDisposed).toBe(false);

		// The transition then completes normally and swaps the file, proving the
		// restart really would have handed the host a stale path.
		releaseHook.resolve();
		expect(await transition).toBe(true);
		expect(session.sessionFile).not.toBe(capturedFile);
	});

	// Same race on the branch path, which awaits `session_before_branch` instead.
	// Covers the second hook family so the barrier is not newSession-specific.
	it("refuses busy while a branch that entered first is parked in its transition hook", async () => {
		const onRestart = vi.fn();
		const hookEntered = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		await buildSession({
			gateAt: "waitForIdle",
			onRestartRequested: onRestart,
			extensionRunner: {
				hasHandlers: (eventType: string) => eventType === "session_before_branch",
				emit: async () => {
					hookEntered.resolve();
					await releaseHook.promise;
					return undefined;
				},
			},
		});
		// A persisted user entry gives branch() a valid target, so the barrier —
		// not target validation — is what the assertion measures.
		session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.sessionManager.flush();
		const userEntry = session.sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected a persisted user entry");

		const transition = session.branch(userEntry.id);
		await hookEntered.promise;

		const restart = session.requestRestart();
		releaseFlush?.();

		expect(await restart).toEqual({ ok: false, reason: "busy" });
		expect(onRestart).not.toHaveBeenCalled();
		expect(session.isDisposed).toBe(false);

		releaseHook.resolve();
		await transition;
	});

	// F2: the coherence check compares PATHS, not disk. A captured file deleted
	// while the barrier's awaits were parked (empty-move cleanup driven over the
	// same path) still matches the manager's own path, so the restart disposed and
	// handed the host a `sessionFile` that `SessionManager.open()` cannot reopen —
	// even though `ensureOnDisk()` had just succeeded.
	//
	// RED (pre-fix): the restart resolved `{ ok: true }` and the callback received
	// the deleted path.
	it("refuses rather than handing the host a captured session file that no longer exists", async () => {
		const callbackFiles: string[] = [];
		await buildSession({
			gateAt: "waitForIdle",
			onRestartRequested: (info: { sessionId: string; sessionFile: string }) => {
				callbackFiles.push(info.sessionFile);
			},
		});
		await session.sessionManager.ensureOnDisk();
		const capturedFile = session.sessionFile;
		if (!capturedFile) throw new Error("Expected a persisted session file");
		expect(fs.existsSync(capturedFile)).toBe(true);

		// Latch the restart, then delete the captured file while it is parked at
		// the quiescence gate — exactly what empty-move cleanup does to a moved
		// session whose file is removed out from under the reattachment handle.
		const restart = session.requestRestart();
		fs.rmSync(capturedFile);
		releaseFlush?.();

		// `no-session-file` is the existing reason for "nothing to re-attach to",
		// which is precisely the post-deletion state.
		expect(await restart).toEqual({ ok: false, reason: "no-session-file" });
		// The host is never handed a path it cannot reopen, and the session stays
		// alive so the refusal is recoverable.
		expect(callbackFiles).toEqual([]);
		expect(session.isDisposed).toBe(false);
	});

	// The in-flight direction is already covered (a mutation
	// that starts FIRST blocks the barrier). This is the reverse ordering, which
	// the counter cannot help with: the restart has already latched — or an
	// external `beginDispose()` has already run — and only THEN does an SDK/RPC
	// caller invoke a model mutation. #trackModelMutation counted it but still
	// ran it, so it parked in `refreshSelectedModelMetadata()`, the restart's
	// final busy check passed, disposal sealed the old SessionManager, and the
	// mutation resumed to report a successful switch whose `model_change` append
	// was silently dropped — leaving the replacement on the previous model.
	//
	// The wrapper must REFUSE while `#restarting` / `#isDisposed` is set, using
	// each method's own no-op shape so no caller has to learn a new one.
	it("refuses a setModel latched behind a restart instead of dropping its model_change", async () => {
		await latchedSession();
		const target = getBundledModel("anthropic", "claude-opus-4-1");
		if (!target) throw new Error("Expected a second bundled anthropic model");
		// Fails the test loudly if the mutation is admitted: reaching the probe at
		// all is the defect, and parking here would otherwise hang on the gate.
		const probed = vi.spyOn(modelRegistry, "refreshSelectedModelMetadata");

		// setModel already reports refusal as `{ switched: false }`, which
		// selector-controller.ts:1020 bails on — so the existing shape is reused.
		await expect(session.setModel(target)).resolves.toEqual({ switched: false });

		expect(probed).not.toHaveBeenCalled();
		// The session stays on its original model, and nothing was appended for a
		// switch that did not happen.
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(session.sessionManager.getEntries().some(entry => entry.type === "model_change")).toBe(false);
	});

	it("refuses a setModel invoked after an external beginDispose(), before its dispose() lands", async () => {
		// The SDK wrapper's teardown shape: beginDispose() runs synchronously
		// (setting #isDisposed), then the wrapper AWAITS the agent lifecycle before
		// calling the real dispose(). A mutation arriving in that gap saw neither
		// #restarting nor a settled #disposeCall, so it was admitted against a
		// session already committed to teardown.
		await buildSession();
		const target = getBundledModel("anthropic", "claude-opus-4-1");
		if (!target) throw new Error("Expected a second bundled anthropic model");
		const probed = vi.spyOn(modelRegistry, "refreshSelectedModelMetadata");

		session.beginDispose();
		expect(session.isDisposed).toBe(true);

		await expect(session.setModel(target)).resolves.toEqual({ switched: false });
		expect(probed).not.toHaveBeenCalled();
		expect(session.model?.id).toBe("claude-sonnet-4-5");
	});

	it("refuses every latched model-mutation delegate in that delegate's own no-op shape", async () => {
		// All six public delegates share the same drop window, so all six must
		// refuse — each returning what its callers already treat as "nothing
		// happened" rather than a new sentinel: `{ switched: false }` for
		// setModel, `undefined` for the cycle methods, and a plain return for the
		// two void ones.
		await latchedSession();
		const target = getBundledModel("anthropic", "claude-opus-4-1");
		if (!target) throw new Error("Expected a second bundled anthropic model");
		const probed = vi.spyOn(modelRegistry, "refreshSelectedModelMetadata");

		await expect(session.setModelTemporary(target)).resolves.toBeUndefined();
		await expect(session.cycleModel("forward")).resolves.toBeUndefined();
		await expect(
			session.applyRoleModel({ role: "default", model: target, explicitThinkingLevel: false }),
		).resolves.toBeUndefined();
		await expect(session.cycleRoleModels(["default"], "forward")).resolves.toBeUndefined();

		// None of them reached the probe, so none of them can append past the
		// durability barrier.
		expect(probed).not.toHaveBeenCalled();
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(session.sessionManager.getEntries().some(entry => entry.type === "model_change")).toBe(false);
	});

	// The counter the asynchronous delegates keep exists for a mid-flight seal:
	// they await refreshSelectedModelMetadata() before appending. The
	// SYNCHRONOUS persisted model controls have no such gap, so they were left
	// unguarded — and that is the loss, not the safety. Latched, they still
	// mutated this session's observable state while the sealed SessionManager
	// dropped the matching thinking_level_change / service_tier_change entry, so
	// the replacement restored the PREVIOUS selection and the user's last change
	// silently vanished.
	//
	// RED (pre-fix): thinkingLevel moved to the new value and no entry was
	// persisted for it.
	it("refuses a latched setThinkingLevel instead of mutating state the sealed manager will not persist", async () => {
		await latchedSession();
		const before = session.thinkingLevel;
		const target = before === ThinkingLevel.High ? ThinkingLevel.Low : ThinkingLevel.High;

		session.setThinkingLevel(target);

		// Observable state is unchanged, so it cannot disagree with the transcript.
		expect(session.thinkingLevel).toBe(before);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "thinking_level_change")).toBe(false);
	});

	it("refuses a latched cycleThinkingLevel in its own no-op shape", async () => {
		await latchedSession();
		const before = session.thinkingLevel;

		// `undefined` is what a model without reasoning already returns, so no
		// caller has to learn a new refusal shape.
		expect(session.cycleThinkingLevel()).toBeUndefined();
		expect(session.thinkingLevel).toBe(before);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "thinking_level_change")).toBe(false);
	});

	it("refuses the latched service-tier controls, including the one that bypasses the tier delegate", async () => {
		await latchedSession();
		const before = session.serviceTierByFamily;

		session.setServiceTierFamily("anthropic", "priority");
		// setFastMode/toggleFastMode reach the tier through ModelControls rather
		// than through setServiceTierFamily, so guarding that one delegate is not
		// enough — each entry point must refuse. `false` is what an unsupported
		// model family already returns.
		expect(session.setFastMode(true)).toBe(false);
		expect(session.toggleFastMode()).toBe(false);

		expect(session.serviceTierByFamily).toEqual(before);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "service_tier_change")).toBe(false);
	});

	it("refuses the synchronous model controls after an external beginDispose(), before its dispose() lands", async () => {
		// Same teardown gap the setModel case covers, for the synchronous side:
		// beginDispose() runs before the SDK wrapper awaits the agent lifecycle.
		await buildSession();
		const before = session.thinkingLevel;
		const target = before === ThinkingLevel.High ? ThinkingLevel.Low : ThinkingLevel.High;

		session.beginDispose();
		expect(session.isDisposed).toBe(true);

		session.setThinkingLevel(target);
		expect(session.cycleThinkingLevel()).toBeUndefined();
		expect(session.setFastMode(true)).toBe(false);

		expect(session.thinkingLevel).toBe(before);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "thinking_level_change")).toBe(false);
	});
});
