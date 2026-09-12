import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm, isUserInterruptAbort } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now(), attribution: "user" };
}

function hidden(text: string, customType = "image-attachment-description"): AgentMessage {
	return { role: "custom", customType, content: text, display: false, attribution: "user", timestamp: Date.now() };
}

describe("native queued-message control", () => {
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;
	beforeAll(async () => {
		auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "test-key");
		registry = new ModelRegistry(auth);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			session.agent.clearAllQueues();
			await session.abort();
			await session.dispose();
			session = undefined;
		}
	});
	afterAll(() => auth.close());

	function create() {
		const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				started[Math.min(calls++, 1)]!.resolve();
				return { content: ["held response"], delayMs: 60_000 };
			},
		});
		const agent = new Agent({
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			steeringMode: "all",
			followUpMode: "all",
			streamFn: mock.stream,
			convertToLlm,
			getApiKey: () => "test-key",
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.usageAwareFallback": false }),
			modelRegistry: registry,
		});
		return { session, agent, mock, started };
	}

	test("identical text has separate IDs, edits retain identity and images, and stale/foreign mutations are refused", async () => {
		const { session, agent } = create();
		const first = user("same");
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		if (first.role !== "user") throw new Error("Expected a user message");
		first.content = [{ type: "text", text: "same" }, image];
		agent.followUp(first);
		agent.followUp(user("same"));
		const before = session.getMessageQueue(session.sessionId);
		expect(before.items[0]!.id).not.toBe(before.items[1]!.id);
		const after = await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: before.revision,
			itemId: before.items[0]!.id,
			action: "edit",
			text: "edited",
		});
		expect(after.items[0]).toMatchObject({ id: before.items[0]!.id, text: "edited", imageCount: 1 });
		expect(agent.peekFollowUpQueue()[0]).toMatchObject({ content: [{ type: "text", text: "edited" }, image] });
		await expect(
			session.updateMessageQueue({
				sessionId: session.sessionId,
				expectedRevision: before.revision,
				itemId: before.items[1]!.id,
				action: "delete",
			}),
		).rejects.toThrow("queue changed");
		await expect(
			session.updateMessageQueue({
				sessionId: "other-session",
				expectedRevision: after.revision,
				itemId: after.items[0]!.id,
				action: "delete",
			}),
		).rejects.toThrow("session changed");
		expect(session.getMessageQueue(session.sessionId).items).toEqual(after.items);
	});

	test("delete removes only the selected user's companions and preserves advisor/internal messages", async () => {
		const { session, agent } = create();
		const advisor: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "Advice",
			display: true,
			attribution: "agent",
			timestamp: 0,
		};
		const system = hidden("internal", "internal-work");
		const keep = user("keep");
		agent.replaceQueues(
			[advisor, system, hidden("selected companion"), user("remove"), hidden("keep companion"), keep],
			[],
		);
		const before = session.getMessageQueue(session.sessionId);
		const selected = before.items.find(item => item.text === "remove")!;
		const after = await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: before.revision,
			itemId: selected.id,
			action: "delete",
		});
		expect(after.items.map(item => item.text)).toEqual(["keep"]);
		expect(agent.peekSteeringQueue()).toEqual([
			advisor,
			system,
			expect.objectContaining({ content: "keep companion" }),
			keep,
		]);
		expect(after.otherPendingCount).toBe(1);
		expect(after.items.length + after.otherPendingCount).toBe(session.queuedMessageCount);
	});

	test("editing complete multi-block text and image-only messages preserves images without manufacturing a caption", async () => {
		const { session, agent } = create();
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "first" }, image, { type: "text", text: "second" }],
			timestamp: 0,
		});
		agent.followUp({ role: "user", content: [image], timestamp: 1 });
		const before = session.getMessageQueue(session.sessionId);
		expect(before.items.map(item => item.text)).toEqual(["first\nsecond", ""]);
		const edited = await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: before.revision,
			itemId: before.items[0]!.id,
			action: "edit",
			text: before.items[0]!.text,
		});
		const after = await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: edited.revision,
			itemId: before.items[1]!.id,
			action: "edit",
			text: "",
		});
		expect(after.items.map(item => [item.id, item.text, item.imageCount])).toEqual([
			[before.items[0]!.id, "first\nsecond", 1],
			[before.items[1]!.id, "", 1],
		]);
		expect(agent.peekFollowUpQueue()).toMatchObject([
			{ content: [{ type: "text", text: "first\nsecond" }, image] },
			{ content: [{ type: "text", text: "" }, image] },
		]);
	});

	test("a consumed message cannot be edited using an earlier queue revision", async () => {
		const { session, agent } = create();
		agent.followUp(user("queued"));
		const before = session.getMessageQueue(session.sessionId);
		agent.popLastFollowUp();
		await expect(
			session.updateMessageQueue({
				sessionId: session.sessionId,
				expectedRevision: before.revision,
				itemId: before.items[0]!.id,
				action: "edit",
				text: "too late",
			}),
		).rejects.toThrow("already be consumed");
		await expect(
			session.updateMessageQueue({
				sessionId: session.sessionId,
				expectedRevision: session.messageQueueRevision,
				itemId: before.items[0]!.id,
				action: "delete",
			}),
		).rejects.toThrow("consumed or removed");
	});

	test("user command cards remain visible and removable but cannot be rewritten as ordinary text", async () => {
		const { session, agent } = create();
		agent.followUp({
			role: "custom",
			customType: "skill-prompt",
			content: "structured command",
			display: true,
			attribution: "user",
			timestamp: 0,
		});
		const before = session.getMessageQueue(session.sessionId);
		expect(before.items[0]!.editable).toBe(false);
		await expect(
			session.updateMessageQueue({
				sessionId: session.sessionId,
				expectedRevision: before.revision,
				itemId: before.items[0]!.id,
				action: "edit",
				text: "replace",
			}),
		).rejects.toThrow("cannot be edited");
		const after = await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: before.revision,
			itemId: before.items[0]!.id,
			action: "delete",
		});
		expect(after.items).toEqual([]);
	});

	test("agent-authored user-role messages remain internal queue work rather than editable operator rows", () => {
		const { session, agent } = create();
		agent.steer({ role: "user", content: "agent-origin instruction", attribution: "agent", timestamp: 0 });
		agent.followUp(user("operator message"));
		const queue = session.getMessageQueue(session.sessionId);
		expect(queue.items.map(item => item.text)).toEqual(["operator message"]);
		expect(queue.otherPendingCount).toBe(1);
		expect(queue.items.length + queue.otherPendingCount).toBe(session.queuedMessageCount);
	});

	test("Send now aborts the reply and dispatches only the selected batch first in all mode, preserving concurrent arrivals", async () => {
		const { session, agent, mock, started } = create();
		const initial = session.prompt("original reply");
		await started[0]!.promise;
		const advisor: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "Advice stays queued",
			display: true,
			attribution: "agent",
			timestamp: 0,
		};
		agent.replaceQueues(
			[user("other steer"), advisor],
			[user("first followup"), hidden("selected image description"), user("selected"), user("last followup")],
		);
		const before = session.getMessageQueue(session.sessionId);
		const selected = before.items.find(item => item.text === "selected")!;
		const originalAbort = session.abort.bind(session);
		const abortEntered = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		const abortSpy = vi.spyOn(session, "abort").mockImplementation(async options => {
			await originalAbort(options);
			abortEntered.resolve();
			await releaseAbort.promise;
		});
		const action = session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: before.revision,
			itemId: selected.id,
			action: "send-now",
		});
		await abortEntered.promise;
		agent.followUp(user("arrived during abort"));
		expect(session.getMessageQueue(session.sessionId).items.some(item => item.id === selected.id)).toBe(false);
		releaseAbort.resolve();
		const after = await action;
		await started[1]!.promise;
		expect(session.isStreaming).toBe(true);
		expect(after.items.map(item => item.text)).toEqual([
			"other steer",
			"first followup",
			"last followup",
			"arrived during abort",
		]);
		expect(agent.peekSteeringQueue()).toContain(advisor);
		const texts = JSON.stringify(mock.calls[1]!.context.messages);
		expect(texts).toContain("selected");
		expect(texts).toContain("selected image description");
		expect(texts).not.toContain("other steer");
		expect(texts).not.toContain("first followup");
		expect(abortSpy).toHaveBeenCalledTimes(1);
		abortSpy.mockRestore();
		agent.clearAllQueues();
		await session.abort();
		await initial.catch(() => {});
	});

	test("a failed abort restores only the reserved item without overwriting concurrent queue work", async () => {
		const { session, agent, mock } = create();
		agent.followUp(user("selected"));
		agent.followUp(user("existing"));
		const before = session.getMessageQueue(session.sessionId);
		vi.spyOn(session, "abort").mockImplementation(async () => {
			agent.followUp(user("concurrent"));
			throw new Error("Abort failed");
		});
		await expect(
			session.updateMessageQueue({
				sessionId: session.sessionId,
				expectedRevision: before.revision,
				itemId: before.items[0]!.id,
				action: "send-now",
			}),
		).rejects.toThrow("Abort failed");
		const after = session.getMessageQueue(session.sessionId);
		expect(after.items.map(item => item.text)).toEqual(["selected", "existing", "concurrent"]);
		expect(after.items[0]!.id).toBe(before.items[0]!.id);
		expect(mock.calls).toEqual([]);
	});

	test("a dispatch hook failure restores the selected item and preserves messages that arrived before dequeue", async () => {
		const { session, agent, mock } = create();
		agent.followUp(user("selected"));
		agent.followUp(user("existing"));
		const before = session.getMessageQueue(session.sessionId);
		agent.addBeforeQueuedMessageDequeueHook(() => {
			agent.followUp(user("arrived at dispatch"));
			throw new Error("Queue admission failed");
		});
		await expect(
			session.updateMessageQueue({
				sessionId: session.sessionId,
				expectedRevision: before.revision,
				itemId: before.items[0]!.id,
				action: "send-now",
			}),
		).rejects.toThrow("Queue admission failed");
		expect(session.getMessageQueue(session.sessionId).items.map(item => item.text)).toEqual([
			"selected",
			"existing",
			"arrived at dispatch",
		]);
		expect(mock.calls).toEqual([]);
	});

	test("deferred next-turn work changes the revision and count even without a core queue mutation", async () => {
		const { session, agent, started } = create();
		const running = session.prompt("original");
		await started[0]!.promise;
		agent.followUp(user("user followup"));
		const before = session.getMessageQueue(session.sessionId);
		const coreRevision = agent.queueRevision;
		await session.sendCustomMessage(
			{ customType: "internal-next-turn", content: "deferred context", display: false },
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
		const after = session.getMessageQueue(session.sessionId);
		expect(agent.queueRevision).toBe(coreRevision);
		expect(after.revision).not.toBe(before.revision);
		expect(after.otherPendingCount).toBe(1);
		expect(after.items.length + after.otherPendingCount).toBe(session.queuedMessageCount);
		await expect(
			session.updateMessageQueue({
				sessionId: session.sessionId,
				expectedRevision: before.revision,
				itemId: before.items[0]!.id,
				action: "delete",
			}),
		).rejects.toThrow("queue changed");
		agent.clearAllQueues();
		await session.abort();
		await running;
	});

	test("session change during abort refuses dispatch into the replacement session", async () => {
		const { session, agent, mock } = create();
		agent.followUp(user("old session message"));
		const before = session.getMessageQueue(session.sessionId);
		vi.spyOn(session, "abort").mockImplementation(async () => {
			await session.sessionManager.newSession();
		});
		await expect(
			session.updateMessageQueue({
				sessionId: before.sessionId,
				expectedRevision: before.revision,
				itemId: before.items[0]!.id,
				action: "send-now",
			}),
		).rejects.toThrow("session changed");
		expect(mock.calls).toEqual([]);
		expect(session.getMessageQueue(session.sessionId).items).toEqual([]);
	});

	test("video-attachment notices ride their prompt through delete and send-now", async () => {
		const { session, agent, mock, started } = create();
		// Insert a hidden video companion ahead of the selected prompt exactly
		// the way #queueUserMessage does for a video attachment.
		const video: AgentMessage = {
			role: "custom",
			customType: "video-attachment",
			content: "video notice",
			display: false,
			attribution: "user",
			timestamp: 0,
		};
		agent.followUp(video);
		const prompt = user("watch this");
		agent.followUp(prompt);
		const initial = session.prompt("running");
		await started[0]!.promise;
		const before = session.getMessageQueue(session.sessionId);
		const selected = before.items.find(item => item.text === "watch this")!;
		await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: before.revision,
			itemId: selected.id,
			action: "delete",
		});
		// The companion goes with it; the notice must not strand as an orphan.
		expect(agent.peekFollowUpQueue()).toEqual([]);
		// Re-queue the pair and use send-now: the companion must be dispatched
		// WITH the prompt into the replacement run, not left in the queue.
		agent.followUp(video);
		agent.followUp(prompt);
		const again = session.getMessageQueue(session.sessionId);
		const againSelected = again.items.find(item => item.text === "watch this")!;
		const after = await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: again.revision,
			itemId: againSelected.id,
			action: "send-now",
		});
		// The companion moved with the prompt: no orphan notice remains queued,
		// and both messages reach the dispatched model context together.
		expect(agent.peekFollowUpQueue()).toEqual([]);
		expect(after.items).toEqual([]);
		await started[1]!.promise;
		const texts = JSON.stringify(mock.calls[1]!.context.messages);
		expect(texts).toContain("video notice");
		expect(texts).toContain("watch this");
	});

	test("send-now with an advisor card queued keeps the card queued afterwards", async () => {
		const { session, agent, started } = create();
		const initial = session.prompt("running");
		await started[0]!.promise;
		const advisor: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "Advice arrives with a send-now in flight",
			display: true,
			attribution: "agent",
			timestamp: 0,
		};
		agent.steer(advisor);
		agent.followUp(user("the selected one"));
		const before = session.getMessageQueue(session.sessionId);
		const selected = before.items.find(item => item.text === "the selected one")!;
		const after = await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: before.revision,
			itemId: selected.id,
			action: "send-now",
		});
		// The stranded-drain advisor reclaim must not have fired during the
		// send-now abort: the card persists in its queue, not as early advice,
		// and neither the dispatch nor a rollback pass removed it.
		expect(agent.peekSteeringQueue().some(m => m.role === "custom" && m.customType === "advisor")).toBe(true);
		agent.clearAllQueues();
		await session.abort();
		await initial.catch(() => {});
	});

	test("send-now on an idle session leaves no user-interrupt marker for a later direct abort", async () => {
		const { session, agent, started } = create();
		agent.followUp(user("selected while idle"));
		const before = session.getMessageQueue(session.sessionId);
		// No turn is running: the send-now abort has nothing to interrupt, so its
		// one-shot user-interrupt marker must not survive into the replacement run.
		const after = await session.updateMessageQueue({
			sessionId: session.sessionId,
			expectedRevision: before.revision,
			itemId: before.items[0]!.id,
			action: "send-now",
		});
		expect(after.items).toEqual([]);
		await started[0]!.promise;
		expect(session.isStreaming).toBe(true);
		// TTSR and streaming guards abort through agent-core directly, bypassing
		// session.abort(). A leaked marker reaches the pending-ID classification
		// branch first and persists this unrelated abort as a user interruption.
		agent.abort("tool-supervisor rule");
		await agent.waitForIdle();
		const aborted = agent.state.messages.filter(
			(message): message is AssistantMessage =>
				message.role === "assistant" && message.stopReason === "aborted",
		);
		expect(aborted.length).toBeGreaterThan(0);
		for (const message of aborted) expect(isUserInterruptAbort(message)).toBe(false);
	});
});
