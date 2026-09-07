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
 *
 * The latch is held open (but the session kept alive and undisposed) by gating
 * the durability flush inside requestRestart(), so the assertions run in the
 * real post-latch / pre-dispose window rather than against a torn-down session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
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
		onRestartRequested?: () => void | Promise<void>;
		/** Where #doRequestRestart parks while latched. "flush" gates the
		 *  durability barrier (default); "waitForIdle" gates the earlier quiescence
		 *  wait, leaving sessionManager.flush real for transitions that flush. */
		gateAt?: "flush" | "waitForIdle";
		/** When true, releasing the gated flush REJECTS it (a durability failure)
		 *  instead of resolving, exercising the recoverable catch branch. */
		flushRejects?: boolean;
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
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			customCommands: config?.customCommands,
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

	it("refuses moveSession while a restart is latched so the captured file is not renamed away", async () => {
		await buildSession();
		const capturedFile = session.sessionFile;
		void session.requestRestart();

		// moveSession returns void; the observable is that the current file is
		// untouched. A move to a different cwd would rename the captured path away,
		// leaving #doRequestRestart to hand the host a path that no longer exists.
		await session.moveSession(tempDir.join("moved"));

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
});
