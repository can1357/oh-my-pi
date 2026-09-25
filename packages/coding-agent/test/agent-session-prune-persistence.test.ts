import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AdvisorOutputQuarantinedError, AdvisorRuntime } from "@oh-my-pi/pi-coding-agent/advisor/runtime";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: the per-turn supersede/useless prune pass rewrote the LIVE agent
 * context but never persisted the rewrite, so the session file kept the
 * original (un-pruned) history. Anything that rebuilds from the file — `/tan`
 * and `/fork` clones, session resume — then produced a divergent, larger
 * prefix and cold-missed the provider prompt cache the parent had populated.
 *
 * Contract: after the prune fires, rebuilding the session from disk yields the
 * same message content as the live agent state.
 */
describe("AgentSession per-turn prune persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	const BIG_CALL_ID = "call-big-useless";
	const ADVISOR_REPLY = "ADVISOR_REPLY_SENTINEL";
	let advisorRequests: Context[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prune-persistence-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const now = Date.now();
		const usageZero = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate every module of the project.",
			timestamp: now - 200,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: BIG_CALL_ID, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: usageZero,
			timestamp: now - 180,
		});
		// The only prune candidate: a big result flagged useless whose suffix
		// stays inside the cache-warm window, so the pass rewrites it.
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: BIG_CALL_ID,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20000) }],
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Nothing relevant found; moving on." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: usageZero,
			timestamp: now - 160,
		});

		const primary = createMockModel({ provider: "anthropic", handler: { content: ["Primary step done."] } });
		const advisorModel = createMockModel({ provider: "anthropic", handler: { content: [ADVISOR_REPLY] } });
		advisorRequests = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: primary.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": true,
				"compaction.supersedeReads": true,
			}),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (streamModel, context, options) => {
				advisorRequests.push({
					systemPrompt: context.systemPrompt?.slice(),
					messages: structuredClone(context.messages),
				});
				return advisorModel.stream(streamModel, context, options);
			},
			// Enough for `#withEvalStateContext` to append its synthetic message
			// once the history holds an `eval` call.
			evalToolSession: {
				cwd: tempDir.path(),
				getEvalSessionId: () => "prune-persistence-eval",
			} as unknown as ToolSession,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	function liveResultText(): string {
		const message = session.agent.state.messages.find(
			candidate => candidate.role === "toolResult" && candidate.toolCallId === BIG_CALL_ID,
		);
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
			throw new Error("Expected the seeded tool result in live agent state");
		}
		const text = message.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("Expected text content on the seeded tool result");
		return text.text;
	}

	it("persists the pruned rewrite so a from-disk rebuild matches the live context", async () => {
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await session.waitForIdle();

		// The per-turn pass rewrote the live context…
		expect(liveResultText()).toBe(USELESS_NOTICE);

		// …and the persisted file must rebuild to the SAME content (fork/resume
		// read this file; a divergent prefix cold-misses the provider cache).
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		const rebuilt = reloaded
			.buildSessionContext()
			.messages.find(candidate => candidate.role === "toolResult" && candidate.toolCallId === BIG_CALL_ID);
		if (rebuilt?.role !== "toolResult" || !Array.isArray(rebuilt.content)) {
			throw new Error("Expected the seeded tool result in the from-disk rebuild");
		}
		const rebuiltText = rebuilt.content.find(block => block.type === "text");
		expect(rebuiltText?.type === "text" ? rebuiltText.text : undefined).toBe(USELESS_NOTICE);
	});

	describe("advisor across the per-turn prune", () => {
		const usage = {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		function assistant(content: Array<Record<string, unknown>>): AgentMessage {
			return {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
				usage,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		}

		function toolResult(toolCallId: string, toolName: string, text: string, useless = false): AgentMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				useless,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		}

		/** Commits a turn outside the agent loop (no advisor review); its agent end runs the prune pass. */
		async function commitUnreviewedTurn(messages: AgentMessage[]): Promise<void> {
			for (const message of messages) session.agent.emitExternalEvent({ type: "message_end", message });
			session.agent.emitExternalEvent({ type: "agent_end", messages });
			await session.waitForIdle();
		}

		/** A real primary turn: its turn end renders the next advisor delta, its agent end runs the prune pass. */
		async function reviewedTurn(text: string): Promise<void> {
			await session.agent.prompt(text);
			await session.waitForIdle();
			expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		}

		function enableAdvisor(): void {
			session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
			expect(session.setAdvisorEnabled(true)).toBe(true);
		}

		async function withPrefixResetCount(run: () => Promise<void>): Promise<number> {
			const debug = vi.spyOn(logger, "debug");
			try {
				await run();
				return debug.mock.calls.filter(
					([message, details]) =>
						message === "advisor context reset" &&
						(details as { reason?: string } | undefined)?.reason === "delivered-prefix-changed",
				).length;
			} finally {
				debug.mockRestore();
			}
		}

		/** The advisor kept its own history and was not re-sent the transcript it never needed. */
		function expectLastReviewIncremental(): void {
			const request = JSON.stringify(advisorRequests.at(-1)?.messages);
			expect(request).toContain(ADVISOR_REPLY);
			expect(request).not.toContain("Investigate every module of the project.");
		}

		it("reviews the step after a prune without re-priming or replaying the transcript", async () => {
			enableAdvisor();
			await reviewedTurn("turn one");
			// The prune elided a result the advisor was seeded past.
			expect(liveResultText()).toBe(USELESS_NOTICE);

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("treats a later equal clone of a pruned result as unchanged", async () => {
			enableAdvisor();
			await reviewedTurn("turn one");
			expect(liveResultText()).toBe(USELESS_NOTICE);
			// Context rebuilds (secret deobfuscation, display-context rebuilds) hand
			// the advisor equal clones instead of the objects it last saw, so the
			// comparison falls through to the fingerprint of the pruned content.
			session.agent.replaceMessages(structuredClone(session.agent.state.messages));

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("keeps the advisor's context across two prunes while the eval state message moves to the tail", async () => {
			enableAdvisor();
			// An `eval` call in history makes every display-context rebuild append a
			// fresh synthetic `eval-state-context` message at the tail.
			await commitUnreviewedTurn([
				assistant([{ type: "toolCall", id: "call-eval", name: "eval", arguments: { code: "1 + 1" } }]),
				toolResult("call-eval", "eval", "2"),
				assistant([{ type: "text", text: "Evaluated." }]),
			]);
			const tail = session.agent.state.messages.at(-1);
			expect(tail?.role === "custom" ? tail.customType : undefined).toBe("eval-state-context");
			// Delivers the eval-state message at its current slot.
			await reviewedTurn("turn one");

			// Second prune: the synthetic message moves past the newer entries.
			await commitUnreviewedTurn([
				assistant([{ type: "toolCall", id: "call-big-2", name: "grep", arguments: { pattern: "FIXME" } }]),
				toolResult("call-big-2", "grep", "other line\n".repeat(20000), true),
				assistant([{ type: "text", text: "Nothing there either." }]),
			]);
			const secondTail = session.agent.state.messages.at(-1);
			expect(secondTail?.role === "custom" ? secondTail.customType : undefined).toBe("eval-state-context");

			const resets = await withPrefixResetCount(() => reviewedTurn("turn two"));

			expect(resets).toBe(0);
			expectLastReviewIncremental();
		});

		it("still resets when a delivered message the prune did not elide was replaced", async () => {
			const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });
			const messages: AgentMessage[] = [
				user("delivered one"),
				toolResult("call-a", "read", "file body"),
				user("delivered two"),
			];
			const runtime = new AdvisorRuntime(
				{ prompt: async () => {}, abort: () => {}, reset: () => {}, state: { messages: [] } },
				{ snapshotMessages: () => messages },
			);
			runtime.onTurnEnd(messages);
			await runtime.waitForCatchup(1_000, 1);
			// The prune elides the result (a fresh object after the rebuild) while
			// an unrelated rewrite replaced another delivered message.
			messages[1] = {
				...messages[1],
				content: [{ type: "text", text: USELESS_NOTICE }],
				prunedAt: Date.now(),
			} as AgentMessage;
			messages[2] = user("delivered two, edited");
			runtime.rebaseDeliveredPrefix("prune-tool-outputs");
			messages.push(user("next step"));

			const resets = await withPrefixResetCount(async () => {
				runtime.onTurnEnd(messages);
				await runtime.waitForCatchup(1_000, 1);
			});

			expect(resets).toBe(1);
			runtime.dispose();
		});

		it("re-primes a quarantined review from the pruned transcript, not the pre-prune snapshot", async () => {
			const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });
			const firstPrompt = Promise.withResolvers<void>();
			const firstPromptStarted = Promise.withResolvers<void>();
			const replay = Promise.withResolvers<string>();
			let promptCalls = 0;
			let current: AgentMessage[] = [
				user("delivered one"),
				assistant([{ type: "toolCall", id: "call-big", name: "grep", arguments: { pattern: "TODO" } }]),
				toolResult("call-big", "grep", "match line\n".repeat(30).trimEnd()),
			];
			const runtime = new AdvisorRuntime(
				{
					prompt: input => {
						promptCalls++;
						if (promptCalls === 1) {
							firstPromptStarted.resolve();
							return firstPrompt.promise;
						}
						replay.resolve(JSON.stringify(input));
						return Promise.resolve();
					},
					abort: () => {},
					reset: () => {},
					state: { messages: [] },
				},
				// The live session swaps in a new array on every rebuild; mirror that.
				{ snapshotMessages: () => current },
				0,
			);
			runtime.onTurnEnd(current);
			await firstPromptStarted.promise;
			// Queued while the first review is still running, so the quarantine re-primes.
			current = [...current, user("delivered two")];
			runtime.onTurnEnd(current);
			// The prune rebuilds the transcript into a fresh array with the result elided.
			current = current.map(message =>
				message.role === "toolResult"
					? ({
							...message,
							content: [{ type: "text", text: USELESS_NOTICE }],
							prunedAt: Date.now(),
						} as AgentMessage)
					: message,
			);
			runtime.rebaseDeliveredPrefix("prune-tool-outputs");

			firstPrompt.reject(new AdvisorOutputQuarantinedError("quarantined"));
			const replayed = await replay.promise;

			expect(replayed).toContain("⇒ ok · 1 line");
			expect(replayed).not.toContain("30 lines");
			runtime.dispose();
		});
	});
});
