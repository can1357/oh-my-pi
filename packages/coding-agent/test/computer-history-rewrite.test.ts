import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import * as pruningModule from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The computer prelude reports only what changed against the accessibility tree
 * the model last saw. Every AgentSession path that rewrites the conversation
 * (so an earlier tree may be gone from the model's context) must bump
 * `agent.historyRevision`, which makes the next post-input report forget its
 * baseline and print windows whole.
 */
describe("computer post-input reports across conversation rewrites", () => {
	const BIG_CALL_ID = "call-big-useless";
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			session = undefined;
			authStorage = undefined;
			tempDir = undefined;
		}
	});

	const usage = (input: number, output: number) => ({
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});

	/** A real session whose history ends in a large, tool-flagged useless `grep` result and a closing answer. */
	async function openSession(settings: Parameters<typeof Settings.isolated>[0]) {
		tempDir = TempDir.createSync("@pi-computer-history-rewrite-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const now = Date.now();
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
			usage: usage(0, 0),
			timestamp: now - 180,
		});
		const toolResultId = sessionManager.appendMessage({
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
			usage: usage(0, 0),
			timestamp: now - 160,
		});

		const primary = createMockModel({ provider: "anthropic", handler: { content: ["Primary step done."] } });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: primary.stream,
		});
		const current = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(settings),
			modelRegistry,
		});
		session = current;
		current.agent.replaceMessages(current.buildDisplaySessionContext().messages);
		return { session: current, sessionManager, toolResultId };
	}

	/** Ends a turn the way the agent loop does, so AgentSession's per-turn maintenance runs. */
	async function endTurn(current: AgentSession): Promise<void> {
		const finalAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Continuing." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: usage(100, 10),
			timestamp: Date.now(),
		};
		current.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		current.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await current.waitForIdle();
	}

	function liveResultText(current: AgentSession): string | undefined {
		const message = current.agent.state.messages.find(
			(candidate: AgentMessage) => candidate.role === "toolResult" && candidate.toolCallId === BIG_CALL_ID,
		);
		if (message?.role !== "toolResult") return undefined;
		const text = message.content.find(block => block.type === "text");
		return text?.type === "text" ? text.text : undefined;
	}

	/**
	 * The shipped computer prelude wired to the session's revision, with a controller that records whether each
	 * settle was told to forget its baseline. `act()` runs one cell that reaches the desktop and settles it.
	 */
	function recordingPrelude(current: AgentSession) {
		const forgets: boolean[] = [];
		const toolSession: ToolSession = {
			cwd: import.meta.dir,
			hasUI: false,
			settings: Settings.isolated({ "computer.enabled": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getHistoryRevision: () => current.agent.historyRevision,
		};
		const prelude = createComputerPrelude(toolSession, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async settle(_snapshot, _output, _signal, forget) {
				forgets.push(forget === true);
				return 'window "42": no change';
			},
			async close() {},
		}));
		const press = {
			action: "call",
			chain: [
				{ method: "ref", args: ["e3"] },
				{ method: "press", args: [] },
			],
		};
		let cells = 0;
		const act = async (): Promise<void> => {
			const cell = { signal: new AbortController().signal };
			await prelude.invoke(press, { session: toolSession, toolCallId: `press-${++cells}`, cell });
			await prelude.settleCell?.(cell, { failed: false, output: "" });
		};
		return { forgets, act };
	}

	/** Settles once before `rewrite`, then twice after: only the first settle after it forgets. */
	async function expectRewriteForgets(current: AgentSession, rewrite: () => Promise<void>): Promise<void> {
		const { forgets, act } = recordingPrelude(current);
		await act();
		const before = current.agent.historyRevision;
		await rewrite();
		expect(current.agent.historyRevision).toBeGreaterThan(before);
		await act();
		await act();
		expect(forgets).toEqual([false, true, false]);
	}

	it("forgets the baseline after turn-end tool-output pruning", async () => {
		const { session: current } = await openSession({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.dropUseless": true,
			"compaction.supersedeReads": false,
		});
		// The stale-result pass runs first at turn end and takes every useless result
		// this pass could prune (both share the same cache-warm suffix guard), so it is
		// held empty here to leave the rewrite to `#pruneToolOutputs`.
		const stalePass = vi
			.spyOn(pruningModule, "pruneSupersededToolResults")
			.mockReturnValue({ prunedCount: 0, tokensSaved: 0, undo: () => {} });
		const toolOutputs = vi.spyOn(pruningModule, "pruneToolOutputs");

		await expectRewriteForgets(current, () => endTurn(current));

		expect(stalePass).toHaveBeenCalled();
		expect(toolOutputs.mock.results.at(-1)?.value).toMatchObject({ prunedCount: 1 });
		expect(liveResultText(current)).toBe(USELESS_NOTICE);
	});

	it("forgets the baseline after turn-end stale-result pruning", async () => {
		const { session: current } = await openSession({
			"compaction.enabled": false,
			"compaction.dropUseless": true,
			"compaction.supersedeReads": true,
		});
		const toolOutputs = vi.spyOn(pruningModule, "pruneToolOutputs");

		await expectRewriteForgets(current, () => endTurn(current));

		expect(toolOutputs).not.toHaveBeenCalled();
		expect(liveResultText(current)).toBe(USELESS_NOTICE);
	});

	it("forgets the baseline after compaction", async () => {
		const { session: current, sessionManager } = await openSession({
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"compaction.dropUseless": false,
			"compaction.supersedeReads": false,
		});
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "compacted summary",
			shortSummary: "compacted",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: { provider: model.provider, model: model.id },
		}));

		await expectRewriteForgets(current, async () => {
			await current.compact();
		});

		expect(sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			summary: "compacted summary",
		});
	});

	it("forgets the baseline after rewinding past a tool result", async () => {
		const {
			session: current,
			sessionManager,
			toolResultId,
		} = await openSession({
			"compaction.dropUseless": false,
			"compaction.supersedeReads": false,
		});
		// The assistant turn that called the tool: rewinding to it drops the tool result from the context.
		const callId = sessionManager.getEntry(toolResultId)?.parentId;
		if (!callId) throw new Error("Expected the tool result to follow its call");

		await expectRewriteForgets(current, async () => {
			const result = await current.navigateTree(callId, { summarize: false });
			expect(result.cancelled).toBe(false);
		});

		expect(sessionManager.getLeafId()).toBe(callId);
		expect(current.agent.state.messages.some(message => message.role === "toolResult")).toBe(false);
	});

	it("keeps the baseline after a rewind that keeps every tool result", async () => {
		const { session: current, toolResultId } = await openSession({
			"compaction.dropUseless": false,
			"compaction.supersedeReads": false,
		});
		const { forgets, act } = recordingPrelude(current);
		await act();
		const before = current.agent.historyRevision;
		// Only the closing answer after the tool result is dropped.
		const result = await current.navigateTree(toolResultId, { summarize: false });
		expect(result.cancelled).toBe(false);
		expect(current.agent.state.messages.at(-1)?.role).toBe("toolResult");
		expect(current.agent.historyRevision).toBe(before);
		await act();
		expect(forgets).toEqual([false, false]);
	});
});
