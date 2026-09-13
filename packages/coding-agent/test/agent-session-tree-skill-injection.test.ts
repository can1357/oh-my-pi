/**
 * Regression: `/tree` navigation onto a `/skill:` injection node (issue #5374).
 *
 * A user-invoked skill injection is persisted as a `custom_message` entry
 * (customType `skill-prompt`). Selecting it in the tree must leave the leaf ON
 * the injection node so the skill stays on the active branch — not on its
 * parent with the expanded skill body dumped into the editor.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionMemory } from "@oh-my-pi/pi-coding-agent/session/session-memory";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

describe("AgentSession tree navigation onto skill injection", () => {
	it("lands the leaf on the skill injection node and keeps it on the active branch", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// u1 -> skill injection -> a1 -> a2
			sessionManager.appendMessage(userMsg("hello"));
			const skillId = sessionManager.appendCustomMessageEntry(
				SKILL_PROMPT_MESSAGE_TYPE,
				"<skill>huge expanded skill body</skill>",
				true,
				{ name: "some-skill", path: "/skills/some-skill/SKILL.md", lineCount: 1 },
				"user",
			);
			sessionManager.appendMessage(assistantMsg("first reply"));
			sessionManager.appendMessage(assistantMsg("second reply"));

			const result = await session.navigateTree(skillId);

			expect(result.cancelled).toBe(false);
			// Leaf must be the skill node itself, not its parent.
			expect(sessionManager.getLeafId()).toBe(skillId);
			// The skill injection must remain on the active branch.
			expect(sessionManager.getBranch().some(e => e.id === skillId)).toBe(true);
			// The expanded skill body must NOT be dumped into the editor.
			expect(result.editorText).toBeUndefined();
		} finally {
			await ctx.cleanup();
		}
	});
});

describe("AgentSession delayed Hindsight baseline after tree navigation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rebases delayed startup after /tree before installation", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("turn one has enough text"));
			const firstAssistantId = sessionManager.appendMessage(assistantMsg("reply one has enough text"));
			sessionManager.appendMessage(userMsg("turn two has enough text"));
			sessionManager.appendMessage(assistantMsg("reply two has enough text"));
			sessionManager.appendMessage(userMsg("turn three has enough text"));
			sessionManager.appendMessage(assistantMsg("reply three has enough text"));
			session.hindsightCloseRetainBaselineTurns = 3;

			const result = await session.navigateTree(firstAssistantId, { summarize: false });
			expect(result.cancelled).toBe(false);

			sessionManager.appendMessage(userMsg("post-tree turn has enough text"));
			sessionManager.appendMessage(assistantMsg("post-tree reply has enough text"));

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 3,
			});
			await session.getHindsightSessionState()!.drainOnClose();

			expect(retain).toHaveBeenCalledTimes(1);
			const retained = String(retain.mock.calls[0]?.[1]);
			expect(retained).toContain("post-tree turn has enough text");
			expect(retained).not.toContain("turn two has enough text");
			expect(retained).not.toContain("turn three has enough text");
		} finally {
			await ctx.cleanup();
		}
	});

	it("retains a delayed ask re-answer that completes before installation", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("please deploy to a target"));
			const askCallId = "ask-call-delayed";
			sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: askCallId,
						name: "ask",
						arguments: { questions: [{ id: "deploy_target", question: "Which deploy target?" }] },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			});
			const tr1Id = sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: askCallId,
				toolName: "ask",
				content: [{ type: "text", text: "User selected: staging" }],
				details: { selectedOptions: ["staging"] },
				isError: false,
				timestamp: Date.now(),
			});
			session.hindsightCloseRetainBaselineTurns = 1;
			session.hindsightLoadedMessageCount = 1;

			const result = await session.navigateTree(tr1Id, {
				allowAskReopen: true,
				reanswerAskResult: {
					content: [{ type: "text", text: "User selected: production" }],
					details: { selectedOptions: ["production"] },
				},
			});
			expect(result.cancelled).toBe(false);
			expect(result.askReanswerCommitted).toBe(true);

			sessionManager.appendMessage(assistantMsg("deploying to production after the re-answer"));

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 1,
				hindsightLoadedMessageCount: 1,
			});
			await session.getHindsightSessionState()!.drainOnClose();

			expect(retain).toHaveBeenCalledTimes(1);
			const retained = String(retain.mock.calls[0]?.[1]);
			expect(retained).toContain("deploying to production after the re-answer");
		} finally {
			await ctx.cleanup();
		}
	});

	it("restores delayed message baseline when /resume rolls back before install", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const resetContext = SessionMemory.prototype.resetContextForNewTranscript;
		vi.spyOn(SessionMemory.prototype, "resetContextForNewTranscript").mockImplementation(async function (
			this: SessionMemory,
			options?: { closeRetainBaselineTurns?: number },
		) {
			await resetContext.call(this, options);
			throw new Error("switch failed after baseline rebase");
		});
		const ctx = await createTestSession({
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager, tempDir } = ctx;
			sessionManager.appendMessage(userMsg("home turn has enough text"));
			sessionManager.appendMessage(assistantMsg("home reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 1;
			session.hindsightLoadedMessageCount = 2;
			const target = SessionManager.createEmptySessionFile(tempDir);

			await expect(session.switchSession(target)).rejects.toThrow("switch failed after baseline rebase");
			expect(session.hindsightCloseRetainBaselineTurns).toBe(1);
			expect(session.hindsightLoadedMessageCount).toBe(2);

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: tempDir,
				taskDepth: 0,
			});
			await session.getHindsightSessionState()!.drainOnClose();
			expect(retain).not.toHaveBeenCalled();
		} finally {
			await ctx.cleanup();
		}
	});
});

describe("AgentSession Hindsight leave-path retain", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retains a below-cadence tail before /new resets tracking", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("leave-path turn has enough text"));
			sessionManager.appendMessage(assistantMsg("leave-path reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 0,
			});

			expect(await session.newSession()).toBe(true);

			expect(retain).toHaveBeenCalledTimes(1);
			expect(String(retain.mock.calls[0]?.[1])).toContain("leave-path turn has enough text");

			await session.getHindsightSessionState()!.drainOnClose();
			expect(retain).toHaveBeenCalledTimes(1);
		} finally {
			await ctx.cleanup();
		}
	});

	it("awaits delayed Hindsight startup before /new drains a below-cadence tail", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("leave-path turn has enough text"));
			sessionManager.appendMessage(assistantMsg("leave-path reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;

			const gate = Promise.withResolvers<void>();
			const start = (async () => {
				await gate.promise;
				await hindsightBackend.start({
					session,
					settings: session.settings,
					modelRegistry: {} as never,
					agentDir: ctx.tempDir,
					taskDepth: 0,
					hindsightCloseRetainBaselineTurns: 0,
				});
			})();
			session.trackMemoryBackendStart(start);

			const leaving = session.newSession();
			await Promise.resolve();
			expect(retain).not.toHaveBeenCalled();
			expect(session.getHindsightSessionState()).toBeUndefined();
			gate.resolve();
			expect(await leaving).toBe(true);
			expect(retain).toHaveBeenCalledTimes(1);
			expect(String(retain.mock.calls[0]?.[1])).toContain("leave-path turn has enough text");
		} finally {
			await ctx.cleanup();
		}
	});

	it("retains a below-cadence tail before /tree leaves the branch", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("kept turn has enough text"));
			const firstAssistantId = sessionManager.appendMessage(assistantMsg("kept reply has enough text"));
			sessionManager.appendMessage(userMsg("abandoned turn has enough text"));
			sessionManager.appendMessage(assistantMsg("abandoned reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 0,
			});

			const result = await session.navigateTree(firstAssistantId, { summarize: false });
			expect(result.cancelled).toBe(false);
			expect(retain).toHaveBeenCalledTimes(1);
			const treeRetain = String(retain.mock.calls[0]?.[1]);
			expect(treeRetain).toContain("abandoned turn has enough text");
			expect(treeRetain).toContain("kept turn has enough text");

			await session.getHindsightSessionState()!.drainOnClose();
			expect(retain.mock.calls.some(call => String(call[1]).includes("abandoned turn has enough text"))).toBe(true);
			expect(
				retain.mock.calls.slice(1).every(call => !String(call[1]).includes("abandoned turn has enough text")),
			).toBe(true);
		} finally {
			await ctx.cleanup();
		}
	});

	it("does not duplicate a retained tail after /fresh", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 1,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("fresh-path turn has enough text"));
			sessionManager.appendMessage(assistantMsg("fresh-path reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 0,
			});

			const state = session.getHindsightSessionState()!;
			await state.maybeRetainOnAgentEnd();
			expect(retain).toHaveBeenCalledTimes(1);
			const persistedId = sessionManager.getSessionId();
			expect(state.sessionId).toBe(persistedId);

			const fresh = session.freshSession();
			expect(fresh).toBeDefined();
			expect(session.sessionId).not.toBe(persistedId);
			expect(state.sessionId).toBe(persistedId);

			await state.drainOnClose();
			expect(retain).toHaveBeenCalledTimes(1);
			expect(String(retain.mock.calls[0]?.[1])).toContain("fresh-path turn has enough text");
		} finally {
			await ctx.cleanup();
		}
	});

	it("rotates the hindsight document on /clear while keeping /fresh on the persisted id", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 1,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("pre-clear turn has enough text"));
			sessionManager.appendMessage(assistantMsg("pre-clear reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 0,
			});

			const state = session.getHindsightSessionState()!;
			await state.maybeRetainOnAgentEnd();
			expect(retain).toHaveBeenCalledTimes(1);
			const persistedId = sessionManager.getSessionId();
			expect(state.sessionId).toBe(persistedId);
			expect(retain.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ documentId: persistedId }));

			await session.resetSessionContext();
			expect(sessionManager.getSessionId()).toBe(persistedId);
			const resetId = sessionManager.getBranch().findLast(entry => entry.type === "reset_boundary")?.id;
			expect(resetId).toBeDefined();
			const overlayAfterClear = session.hindsightDocumentId;
			if (!overlayAfterClear) throw new Error("expected post-clear hindsight document overlay");
			expect(overlayAfterClear).toBe(`${persistedId}:${resetId}`);
			expect(state.sessionId).toBe(overlayAfterClear);

			sessionManager.appendMessage(userMsg("post-clear turn has enough text"));
			sessionManager.appendMessage(assistantMsg("post-clear reply has enough text"));
			await state.drainOnClose();
			expect(retain).toHaveBeenCalledTimes(2);
			expect(retain.mock.calls[1]?.[2]).toEqual(
				expect.objectContaining({ documentId: session.hindsightDocumentId }),
			);
			expect(String(retain.mock.calls[1]?.[1])).toContain("post-clear turn has enough text");
			expect(String(retain.mock.calls[1]?.[1])).not.toContain("pre-clear turn has enough text");
		} finally {
			await ctx.cleanup();
		}
	});

	it("reconstructs the post-clear document overlay on a new AgentSession", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 1,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		let reconstructed: AgentSession | undefined;
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("pre-clear turn has enough text"));
			sessionManager.appendMessage(assistantMsg("pre-clear reply has enough text"));
			await session.resetSessionContext();
			const overlay = session.hindsightDocumentId;
			expect(overlay).toBeDefined();

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("expected bundled model");
			reconstructed = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["test"], tools: [] },
				}),
				sessionManager,
				settings: session.settings,
				modelRegistry: session.modelRegistry,
			});
			expect(reconstructed.hindsightDocumentId).toBe(overlay);
			expect(reconstructed.hindsightDocumentId).not.toBe(sessionManager.getSessionId());
		} finally {
			await reconstructed?.dispose();
			await ctx.cleanup();
		}
	});

	it("does not reuse the post-clear overlay after branch", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("pre-clear turn has enough text"));
			sessionManager.appendMessage(assistantMsg("pre-clear reply has enough text"));
			const branchUserId = sessionManager.appendMessage(userMsg("branch source turn has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 0,
			});
			const state = session.getHindsightSessionState()!;
			await session.resetSessionContext();
			const overlayAfterClear = session.hindsightDocumentId;
			if (!overlayAfterClear) throw new Error("expected post-clear hindsight document overlay");
			expect(state.sessionId).toBe(overlayAfterClear);

			const result = await session.branch(branchUserId);
			expect(result.cancelled).toBe(false);
			expect(session.hindsightDocumentId).not.toBe(overlayAfterClear);
			expect(state.sessionId).toBe(session.hindsightDocumentId ?? sessionManager.getSessionId());
			expect(state.sessionId).not.toBe(overlayAfterClear);

			sessionManager.appendMessage(userMsg("post-branch turn has enough text"));
			sessionManager.appendMessage(assistantMsg("post-branch reply has enough text"));
			await state.drainOnClose();
			expect(retain).toHaveBeenCalled();
			expect(retain.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({ documentId: state.sessionId }));
			expect(retain.mock.calls.some(call => call[2]?.documentId === overlayAfterClear)).toBe(false);
		} finally {
			await ctx.cleanup();
		}
	});

	it("resets retain cadence after branchFromBtw", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			for (const n of [1, 2, 3, 4, 5]) {
				sessionManager.appendMessage(userMsg(`cadence turn ${n} has enough text`));
				sessionManager.appendMessage(assistantMsg(`cadence reply ${n} has enough text`));
			}
			session.hindsightCloseRetainBaselineTurns = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 0,
			});
			const state = session.getHindsightSessionState()!;
			await state.maybeRetainOnAgentEnd();
			expect(retain).toHaveBeenCalledTimes(1);
			expect(state.lastRetainedTurn).toBe(5);

			const leafId = sessionManager.getLeafId();
			if (!leafId) throw new Error("expected session leaf");
			const result = await session.branchFromBtw(
				"why did this fail with enough text",
				{
					role: "assistant",
					content: [{ type: "text", text: "the fix is to branch the side answer with enough text" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				leafId,
				sessionManager.getSessionId(),
			);
			expect(result.cancelled).toBe(false);
			expect(state.lastRetainedTurn).toBe(0);

			await state.maybeRetainOnAgentEnd();
			expect(retain).toHaveBeenCalledTimes(2);
			expect(String(retain.mock.calls.at(-1)?.[1])).toContain("why did this fail with enough text");
		} finally {
			await ctx.cleanup();
		}
	});

	it("resyncs the post-clear overlay after /tree to a pre-reset leaf", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 1,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("pre-clear turn has enough text"));
			const firstAssistantId = sessionManager.appendMessage(assistantMsg("pre-clear reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 0,
			});
			const state = session.getHindsightSessionState()!;
			await session.resetSessionContext();
			const overlayAfterClear = session.hindsightDocumentId;
			if (!overlayAfterClear) throw new Error("expected post-clear hindsight document overlay");
			expect(state.sessionId).toBe(overlayAfterClear);

			sessionManager.appendMessage(userMsg("post-clear turn has enough text"));
			sessionManager.appendMessage(assistantMsg("post-clear reply has enough text"));
			await state.maybeRetainOnAgentEnd();
			expect(retain).toHaveBeenCalledTimes(2);
			expect(retain.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({ documentId: overlayAfterClear }));
			expect(String(retain.mock.calls.at(-1)?.[1])).toContain("post-clear turn has enough text");

			const result = await session.navigateTree(firstAssistantId, { summarize: false });
			expect(result.cancelled).toBe(false);
			expect(session.hindsightDocumentId).toBeUndefined();
			expect(state.sessionId).toBe(sessionManager.getSessionId());
			expect(state.sessionId).not.toBe(overlayAfterClear);

			sessionManager.appendMessage(userMsg("pre-reset leaf turn has enough text"));
			sessionManager.appendMessage(assistantMsg("pre-reset leaf reply has enough text"));
			await state.drainOnClose();
			expect(retain).toHaveBeenCalledTimes(3);
			expect(retain.mock.calls.at(-1)?.[2]).toEqual(
				expect.objectContaining({ documentId: sessionManager.getSessionId() }),
			);
			expect(String(retain.mock.calls.at(-1)?.[1])).toContain("pre-reset leaf turn has enough text");
			expect(retain.mock.calls.filter(call => call[2]?.documentId === overlayAfterClear)).toHaveLength(1);
		} finally {
			await ctx.cleanup();
		}
	});

	it("resets retain cadence after /tree changes the post-clear overlay", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("pre-clear turn has enough text"));
			const firstAssistantId = sessionManager.appendMessage(assistantMsg("pre-clear reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 0,
			});
			const state = session.getHindsightSessionState()!;
			await session.resetSessionContext();
			const overlayAfterClear = session.hindsightDocumentId;
			if (!overlayAfterClear) throw new Error("expected post-clear hindsight document overlay");
			expect(state.sessionId).toBe(overlayAfterClear);

			for (const n of [1, 2, 3, 4, 5]) {
				sessionManager.appendMessage(userMsg(`post-clear cadence turn ${n} has enough text`));
				sessionManager.appendMessage(assistantMsg(`post-clear cadence reply ${n} has enough text`));
			}
			await state.maybeRetainOnAgentEnd();
			expect(retain).toHaveBeenCalledTimes(2);
			expect(state.lastRetainedTurn).toBe(5);

			const result = await session.navigateTree(firstAssistantId, { summarize: false });
			expect(result.cancelled).toBe(false);
			expect(session.hindsightDocumentId).toBeUndefined();
			expect(state.sessionId).toBe(sessionManager.getSessionId());
			expect(state.sessionId).not.toBe(overlayAfterClear);
			expect(state.lastRetainedTurn).toBe(0);

			for (const n of [1, 2, 3, 4, 5]) {
				sessionManager.appendMessage(userMsg(`pre-reset cadence turn ${n} has enough text`));
				sessionManager.appendMessage(assistantMsg(`pre-reset cadence reply ${n} has enough text`));
			}
			await state.maybeRetainOnAgentEnd();
			expect(retain).toHaveBeenCalledTimes(3);
			expect(retain.mock.calls.at(-1)?.[2]).toEqual(
				expect.objectContaining({ documentId: sessionManager.getSessionId() }),
			);
			expect(String(retain.mock.calls.at(-1)?.[1])).toContain("pre-reset cadence turn 5 has enough text");
			expect(retain.mock.calls.filter(call => call[2]?.documentId === overlayAfterClear)).toHaveLength(1);
		} finally {
			await ctx.cleanup();
		}
	});

	it("does not re-retain drained history after hindsight is re-enabled", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainMode": "last-turn",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("loaded turn has enough text"));
			sessionManager.appendMessage(assistantMsg("loaded reply has enough text"));
			session.hindsightCloseRetainBaselineTurns = 0;
			session.hindsightLoadedMessageCount = 0;

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
			});
			const first = session.getHindsightSessionState()!;
			await first.drainOnClose();
			expect(retain).toHaveBeenCalledTimes(1);

			const previous = session.setHindsightSessionState(undefined);
			previous?.dispose();
			expect(session.hindsightCloseRetainBaselineTurns).toBeUndefined();
			expect(session.hindsightLoadedMessageCount).toBeUndefined();

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
			});
			await session.getHindsightSessionState()!.drainOnClose();
			expect(retain).toHaveBeenCalledTimes(1);
		} finally {
			await ctx.cleanup();
		}
	});
});
