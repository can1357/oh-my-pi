/**
 * `/tree` re-answer for a past `ask` toolResult (issue #5642).
 *
 * Selecting an `ask` toolResult in the tree must not silently reposition the
 * leaf onto the old answer. `navigateTree()` instead hands back the original
 * questions (`reopenAsk`) so the caller can re-open the picker, then a
 * follow-up call with `reanswerAskResult` branches a *new* sibling toolResult
 * off the same `ask` toolCall — leaving the original answer's branch intact.
 *
 * The two-phase protocol is opt-in via `allowAskReopen`: only the
 * interactive `/tree` selector understands `reopenAsk`, so every other
 * `navigateTree()` caller (extensions, hooks, ACP, session-extension
 * actions) must keep getting the pre-#5642 plain leaf move instead of
 * silently reporting a successful no-op navigation (review on #5895).
 */
import { describe, expect, it, vi } from "bun:test";
import { Agent, AgentBusyError, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AskToolDetails } from "@oh-my-pi/pi-coding-agent/tools/ask";

const TEST_MODEL = getBundledModel("anthropic", "claude-sonnet-4-5")!;

async function createTestSession(
	options: { inMemory?: boolean; extensionRunner?: ExtensionRunner; obfuscator?: SecretObfuscator } = {},
) {
	const sessionManager = SessionManager.inMemory();
	const settings = Settings.isolated();
	const modelRegistry = {} as never;
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: TEST_MODEL,
				systemPrompt: ["test"],
				tools: [],
			},
		}),
		sessionManager,
		settings,
		modelRegistry,
		extensionRunner: options.extensionRunner,
		obfuscator: options.obfuscator,
	});
	return {
		session,
		sessionManager,
		cleanup: () => session.dispose(),
	};
}

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
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
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

const ORIGINAL_QUESTIONS = [
	{
		id: "deploy_target",
		question: "Which deploy target?",
		options: [{ label: "staging" }, { label: "production" }],
	},
];

/** Assistant message whose only content is a single `toolCall` block. */
function toolCallMsg(toolCallId: string, toolName: string, args: Record<string, unknown>) {
	return {
		...assistantMsg(""),
		content: [{ type: "toolCall" as const, id: toolCallId, name: toolName, arguments: args }],
		stopReason: "toolUse" as const,
	};
}

/** Assistant message emitting multiple `toolCall` blocks in one turn. */
function multiToolCallMsg(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
	return {
		...assistantMsg(""),
		content: calls.map(c => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args })),
		stopReason: "toolUse" as const,
	};
}

function toolResultMsg(toolCallId: string, toolName: string, text: string, details?: unknown) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

function staleAnswerResult(): AgentToolResult<AskToolDetails> {
	return {
		content: [{ type: "text", text: "User selected: staging" }],
		details: {
			question: ORIGINAL_QUESTIONS[0]!.question,
			options: ["staging", "production"],
			multi: false,
			selectedOptions: ["staging"],
		},
	};
}

function newAnswerResult(): AgentToolResult<AskToolDetails> {
	return {
		content: [{ type: "text", text: "User selected: production" }],
		details: {
			question: ORIGINAL_QUESTIONS[0]!.question,
			options: ["staging", "production"],
			multi: false,
			selectedOptions: ["production"],
		},
	};
}

describe("AgentSession tree navigation onto an ask toolResult", () => {
	it("(a) hands back reopenAsk with the original questions instead of moving the leaf", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// u1 -> a1(ask toolCall) -> tr1(stale answer) -> a2(next reply, leaf)
			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			sessionManager.appendMessage(toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }));
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			sessionManager.appendMessage(assistantMsg("deploying to staging"));
			const leafBeforeProbe = sessionManager.getLeafId();

			const result = await session.navigateTree(tr1Id, { allowAskReopen: true });

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeDefined();
			expect(result.reopenAsk?.toolCallId).toBe(askCallId);
			expect(result.reopenAsk?.questions).toEqual(ORIGINAL_QUESTIONS);
			// Nothing was mutated: the leaf is exactly where it was before probing.
			expect(sessionManager.getLeafId()).toBe(leafBeforeProbe);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(b)+(c) branches a new sibling toolResult and keeps the original branch reachable", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			const askCallEntryId = sessionManager.appendMessage(
				toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }),
			);
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			const a2Id = sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const probe = await session.navigateTree(tr1Id, { allowAskReopen: true });
			expect(probe.reopenAsk).toBeDefined();

			const result = await session.navigateTree(tr1Id, {
				allowAskReopen: true,
				reanswerAskResult: newAnswerResult(),
			});

			expect(result.cancelled).toBe(false);
			const newLeafId = sessionManager.getLeafId();
			expect(newLeafId).not.toBeNull();
			// (b) sibling, not mutation: a fresh entry, and the old one is untouched.
			expect(newLeafId).not.toBe(tr1Id);
			const newEntry = sessionManager.getEntry(newLeafId!);
			expect(newEntry?.parentId).toBe(askCallEntryId);
			const originalEntry = sessionManager.getEntry(tr1Id);
			expect(originalEntry).toBeDefined();
			expect(originalEntry?.parentId).toBe(askCallEntryId);
			if (originalEntry?.type === "message" && originalEntry.message.role === "toolResult") {
				expect(originalEntry.message.details).toEqual(staleAnswerResult().details);
			} else {
				throw new Error("expected original toolResult entry to survive untouched");
			}
			// The original branch (tr1 -> a2) is still fully reachable.
			expect(sessionManager.getEntry(a2Id)?.parentId).toBe(tr1Id);
			const siblingIds = sessionManager.getChildren(askCallEntryId).map(e => e.id);
			expect(siblingIds).toContain(tr1Id);
			expect(siblingIds).toContain(newLeafId!);

			// (c) the new toolResult reflects the *new* answer, same toolCallId.
			if (newEntry?.type === "message" && newEntry.message.role === "toolResult") {
				expect(newEntry.message.toolCallId).toBe(askCallId);
				expect(newEntry.message.toolName).toBe("ask");
				expect(newEntry.message.details).toEqual(newAnswerResult().details);
				expect(newEntry.message.content).toEqual(newAnswerResult().content);
			} else {
				throw new Error("expected the new leaf to be a toolResult entry");
			}
		} finally {
			await ctx.cleanup();
		}
	});

	it("(d) leaves plain (non-ask) toolResult navigation as a direct leaf move", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("read the config"));
			sessionManager.appendMessage(toolCallMsg("read-call-1", "read", { path: "config.txt" }));
			const tr1Id = sessionManager.appendMessage(toolResultMsg("read-call-1", "read", "file body"));
			sessionManager.appendMessage(assistantMsg("done reading"));

			const result = await session.navigateTree(tr1Id, { allowAskReopen: true });

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeUndefined();
			expect(result.editorText).toBeUndefined();
			// Unlike `ask`, a plain toolResult lands the leaf directly on the target.
			expect(sessionManager.getLeafId()).toBe(tr1Id);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(e) falls back to a plain leaf move when the original ask arguments can't be recovered", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("please deploy"));
			// Legacy/corrupted persisted args: `questions` fails schema validation.
			sessionManager.appendMessage(toolCallMsg("ask-call-bad", "ask", { questions: "not-an-array" }));
			const trBadId = sessionManager.appendMessage(toolResultMsg("ask-call-bad", "ask", "User selected: staging"));
			sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const result = await session.navigateTree(trBadId, { allowAskReopen: true });

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeUndefined();
			expect(sessionManager.getLeafId()).toBe(trBadId);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(f) without allowAskReopen, a caller that doesn't understand reopenAsk gets a direct leaf move", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// Recoverable ask args — proves this is gated on the caller's opt-in,
			// not on corrupted/legacy data like test (e).
			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			sessionManager.appendMessage(toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }));
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			sessionManager.appendMessage(assistantMsg("deploying to staging"));

			// Mirrors extension-ui-controller.ts / runtime-init.ts / acp-agent.ts /
			// the session-extension navigateTree action, none of which pass
			// `allowAskReopen` or handle `reopenAsk`.
			const result = await session.navigateTree(tr1Id);

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeUndefined();
			expect(sessionManager.getLeafId()).toBe(tr1Id);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(g) recovers reopenAsk questions when the ask toolCall isn't the toolResult's direct parent", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// `ask` runs `exclusive` (serialized *execution*), but a single
			// assistant turn can still emit another tool call first — that tool
			// call's persisted toolResult becomes the `ask` toolResult's parent,
			// not the assistant message that issued both toolCalls.
			sessionManager.appendMessage(userMsg("please deploy and check the config"));
			const readCallId = "read-call-1";
			const askCallId = "ask-call-1";
			sessionManager.appendMessage(
				multiToolCallMsg([
					{ id: readCallId, name: "read", args: { path: "config.txt" } },
					{ id: askCallId, name: "ask", args: { questions: ORIGINAL_QUESTIONS } },
				]),
			);
			sessionManager.appendMessage(toolResultMsg(readCallId, "read", "file body"));
			const trAskId = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const result = await session.navigateTree(trAskId, { allowAskReopen: true });

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeDefined();
			expect(result.reopenAsk?.toolCallId).toBe(askCallId);
			expect(result.reopenAsk?.questions).toEqual(ORIGINAL_QUESTIONS);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(g2) recovers reopenAsk questions past a tool_execution_start bookkeeping entry", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// Real persisted sessions insert a `custom` (not `custom_message`)
			// `tool_execution_start` entry between the assistant message and every
			// toolResult — `#recordToolExecutionStart()` appends it before the
			// tool actually runs. The ancestor walk must skip this bookkeeping
			// entry too, not just other `message`-typed toolResults.
			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			sessionManager.appendMessage(toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }));
			sessionManager.appendCustomEntry("tool_execution_start", { toolCallId: askCallId, toolName: "ask" });
			const trAskId = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const result = await session.navigateTree(trAskId, { allowAskReopen: true });

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeDefined();
			expect(result.reopenAsk?.toolCallId).toBe(askCallId);
			expect(result.reopenAsk?.questions).toEqual(ORIGINAL_QUESTIONS);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(h) a reanswer completion summarizes the abandoned branch including the replaced answer", async () => {
		const capturedEntryIds: string[][] = [];
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_tree"),
			emit: vi.fn(async (event: { type: string; preparation?: { entriesToSummarize: Array<{ id: string }> } }) => {
				if (event.type === "session_before_tree" && event.preparation) {
					capturedEntryIds.push(event.preparation.entriesToSummarize.map(e => e.id));
					// Stub summary — skips the default model-backed summarizer so this
					// test needs no API key.
					return { summary: { summary: "stub summary" } };
				}
				return undefined;
			}),
		} as unknown as ExtensionRunner;

		const ctx = await createTestSession({ inMemory: true, extensionRunner });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			const askCallEntryId = sessionManager.appendMessage(
				toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }),
			);
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const probe = await session.navigateTree(tr1Id, { allowAskReopen: true });
			expect(probe.reopenAsk).toBeDefined();

			const result = await session.navigateTree(tr1Id, {
				allowAskReopen: true,
				summarize: true,
				reanswerAskResult: newAnswerResult(),
			});

			expect(result.cancelled).toBe(false);
			expect(result.summaryEntry).toBeDefined();
			expect(capturedEntryIds).toHaveLength(1);
			// The old (staging) answer must be part of the summarized/abandoned
			// range — it's neither reachable from the new (production) leaf nor
			// the branch point, so omitting it from the summary would silently
			// drop the fact that staging was ever chosen.
			expect(capturedEntryIds[0]).toContain(tr1Id);
			expect(capturedEntryIds[0]).not.toContain(askCallEntryId);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(i) deobfuscates recovered ask arguments when secret obfuscation is active", async () => {
		// The recovery path must mirror the live tool path's
		// `transformToolCallArguments`: persisted `ask` toolCall arguments may
		// hold `$$HASH$$` placeholders in place of real secrets, and must be
		// deobfuscated before validation — otherwise the reopened picker shows
		// the raw placeholder instead of the original question text
		// (chatgpt-codex review on #5895).
		const SECRET = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
		const plainQuestion = `Deploy using token ${SECRET}?`;
		const obfuscatedQuestion = obfuscator.obfuscate(plainQuestion);
		// Sanity: the persisted argument actually holds a placeholder, not the secret.
		expect(obfuscatedQuestion).not.toContain(SECRET);

		const ctx = await createTestSession({ inMemory: true, obfuscator });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			sessionManager.appendMessage(
				toolCallMsg(askCallId, "ask", {
					questions: [
						{
							id: "deploy_target",
							question: obfuscatedQuestion,
							options: [{ label: "staging" }, { label: "production" }],
						},
					],
				}),
			);
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const result = await session.navigateTree(tr1Id, { allowAskReopen: true });

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeDefined();
			// The recovered question must be the deobfuscated plaintext, not the
			// raw persisted placeholder.
			expect(result.reopenAsk?.questions[0]?.question).toBe(plainQuestion);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(j) allows probing and completing an ask re-answer when the ask toolResult is already the current leaf", async () => {
		// If the user interrupts right after answering `ask` (before a
		// follow-up assistant message is appended), or another caller navigates
		// straight onto the ask result, the ask toolResult itself is the
		// current leaf. The `targetId === oldLeafId` no-op short-circuit must
		// not swallow the re-answer protocol in that case — a probe still
		// needs to return `reopenAsk`, and a completion still needs to branch
		// a new sibling (chatgpt-codex review on #5895).
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			const askCallEntryId = sessionManager.appendMessage(
				toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }),
			);
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			// No follow-up assistant message: tr1 is the current leaf.
			expect(sessionManager.getLeafId()).toBe(tr1Id);

			const probe = await session.navigateTree(tr1Id, { allowAskReopen: true });
			expect(probe.cancelled).toBe(false);
			expect(probe.reopenAsk).toBeDefined();
			expect(probe.reopenAsk?.toolCallId).toBe(askCallId);
			expect(probe.reopenAsk?.questions).toEqual(ORIGINAL_QUESTIONS);
			// The probe must not mutate anything.
			expect(sessionManager.getLeafId()).toBe(tr1Id);

			const result = await session.navigateTree(tr1Id, {
				allowAskReopen: true,
				reanswerAskResult: newAnswerResult(),
			});

			expect(result.cancelled).toBe(false);
			const newLeafId = sessionManager.getLeafId();
			expect(newLeafId).not.toBe(tr1Id);
			const newEntry = sessionManager.getEntry(newLeafId!);
			expect(newEntry?.parentId).toBe(askCallEntryId);
			if (newEntry?.type === "message" && newEntry.message.role === "toolResult") {
				expect(newEntry.message.details).toEqual(newAnswerResult().details);
			} else {
				throw new Error("expected the new leaf to be a toolResult entry");
			}
			// The original (stale) answer's branch is still reachable.
			const originalEntry = sessionManager.getEntry(tr1Id);
			expect(originalEntry?.parentId).toBe(askCallEntryId);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(k) reports a committed re-answer and resumes the agent only via resumeAfterAskReanswer", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// u1 -> a1(ask toolCall) -> tr1(stale answer) -> a2(next reply, leaf)
			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			sessionManager.appendMessage(toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }));
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue(undefined);

			const probe = await session.navigateTree(tr1Id, { allowAskReopen: true });
			expect(probe.reopenAsk).toBeDefined();
			// The read-only probe commits nothing, so it must not report a re-answer.
			expect(probe.askReanswerCommitted).toBeFalsy();

			const result = await session.navigateTree(tr1Id, {
				allowAskReopen: true,
				reanswerAskResult: newAnswerResult(),
			});
			expect(result.cancelled).toBe(false);
			// navigateTree reports the commit but does NOT resume on its own — the
			// interactive caller owns the timing so the resumed turn renders against
			// the rebuilt transcript (issue #6483).
			expect(result.askReanswerCommitted).toBe(true);
			await session.waitForIdle();
			expect(continueSpy).not.toHaveBeenCalled();
			// The tail the resume will continue from is the new answer toolResult.
			const messages = session.messages;
			expect(messages[messages.length - 1]?.role).toBe("toolResult");

			// The caller resumes explicitly after rebuilding its UI.
			session.resumeAfterAskReanswer();
			await session.waitForIdle();
			expect(continueSpy).toHaveBeenCalledTimes(1);
		} finally {
			await ctx.cleanup();
		}
	});

	it("coalesces concurrent continuation sources instead of calling a busy agent", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const { session } = ctx;
		const releaseContinue = Promise.withResolvers<void>();
		const continueStarted = Promise.withResolvers<void>();
		let continueInFlight = false;
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			if (continueInFlight) throw new AgentBusyError();
			continueInFlight = true;
			continueStarted.resolve();
			await releaseContinue.promise;
			continueInFlight = false;
		});
		try {
			session.resumeAfterAskReanswer();
			session.resumeAfterAskReanswer();
			await continueStarted.promise;
			releaseContinue.resolve();
			await session.waitForIdle();

			expect(continueSpy).toHaveBeenCalledTimes(1);
		} finally {
			releaseContinue.resolve();
			continueSpy.mockRestore();
			await ctx.cleanup();
		}
	});

	it("starts a fresh continue for work queued while a scheduled continuation settles", async () => {
		// A continuation scheduled during the previous attempt's settle drain
		// (#endInFlight -> #drainStrandedQueuedMessages -> queued-message-drain)
		// must run its own agent.continue(), not coalesce onto the finished attempt
		// and strand the queued message until the next prompt.
		const ctx = await createTestSession({ inMemory: true });
		const { session } = ctx;
		let calls = 0;
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				// The turn ended with a steer stranded past its final queue poll.
				session.agent.steer({
					role: "user",
					content: "stranded",
					steering: true,
					attribution: "user",
					timestamp: Date.now(),
				});
			} else {
				session.agent.replaceQueues([], []);
			}
		});
		try {
			session.resumeAfterAskReanswer();
			await session.waitForIdle();

			expect(calls).toBe(2);
			expect(session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			continueSpy.mockRestore();
			await ctx.cleanup();
		}
	});

	it("(l) does not report a committed re-answer for a plain non-ask leaf move", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("read the config"));
			sessionManager.appendMessage(toolCallMsg("read-call-1", "read", { path: "config.txt" }));
			const tr1Id = sessionManager.appendMessage(toolResultMsg("read-call-1", "read", "file body"));
			sessionManager.appendMessage(assistantMsg("done reading"));

			const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue(undefined);

			const result = await session.navigateTree(tr1Id, { allowAskReopen: true });
			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeUndefined();
			expect(result.askReanswerCommitted).toBeFalsy();

			await session.waitForIdle();
			expect(continueSpy).not.toHaveBeenCalled();
		} finally {
			await ctx.cleanup();
		}
	});
});

describe("AgentSession.buildAskReanswerContext", () => {
	it("builds an AgentToolContext backed by real session state, not a fabricated stub", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session } = ctx;
			const uiContext = { select: async () => undefined } as unknown as ExtensionUIContext;

			const toolContext = session.buildAskReanswerContext(uiContext);

			expect(toolContext.sessionManager).toBe(session.sessionManager);
			expect(toolContext.modelRegistry).toBe(session.modelRegistry);
			expect(toolContext.model).toBe(session.model);
			expect(toolContext.settings).toBe(session.settings);
			expect(toolContext.hasUI).toBe(true);
			expect(toolContext.ui).toBe(uiContext);
			expect(toolContext.isIdle?.()).toBe(true);
			expect(toolContext.hasQueuedMessages?.()).toBe(false);
			expect(() => toolContext.abort?.()).not.toThrow();
		} finally {
			await ctx.cleanup();
		}
	});
});
