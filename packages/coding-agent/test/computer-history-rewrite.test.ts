import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import * as pruningModule from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * The computer prelude reports only what changed against the accessibility tree
 * the model last saw. Every AgentSession path that rewrites the conversation
 * (so an earlier tree may be gone from the model's context) must bump
 * `agent.historyRevision`, which makes the next post-input report forget its
 * baseline and print windows whole.
 */
describe("conversation rewrites advance the history revision", () => {
	const BIG_CALL_ID = "call-big-useless";
	let session: AgentSession | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	/** A real session whose history ends in a large, tool-flagged useless `grep` result and a closing answer. */
	function openSession(settings: Parameters<typeof Settings.isolated>[0]) {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory(import.meta.dir);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		sessionManager.appendMessage({ role: "user", content: "Investigate every module of the project.", timestamp: 1 });
		const call = { type: "toolCall" as const, id: BIG_CALL_ID, name: "grep", arguments: { pattern: "TODO" } };
		sessionManager.appendMessage({ ...createAssistantMessage(""), content: [call], stopReason: "toolUse" });
		const toolResultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: BIG_CALL_ID,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20000) }],
			isError: false,
			useless: true,
			timestamp: 2,
		});
		sessionManager.appendMessage(createAssistantMessage("Nothing relevant found; moving on."));

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
			modelRegistry: new ModelRegistry(authStorage),
		});
		session = current;
		current.agent.replaceMessages(current.buildDisplaySessionContext().messages);
		return { session: current, sessionManager, toolResultId };
	}

	/** Ends a turn the way the agent loop does, so AgentSession's per-turn maintenance runs. */
	async function endTurn(current: AgentSession): Promise<void> {
		const finalAssistant = createAssistantMessage("Continuing.");
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

	/** Runs `rewrite` and returns how far it moved the revision a computer report compares against. */
	async function revisionStep(current: AgentSession, rewrite: () => Promise<void>): Promise<number> {
		const before = current.agent.historyRevision;
		await rewrite();
		return current.agent.historyRevision - before;
	}

	it("advances after turn-end tool-output pruning", async () => {
		const { session: current } = openSession({
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

		expect(await revisionStep(current, () => endTurn(current))).toBe(1);
		expect(stalePass).toHaveBeenCalled();
		expect(toolOutputs.mock.results.at(-1)?.value).toMatchObject({ prunedCount: 1 });
		expect(liveResultText(current)).toBe(USELESS_NOTICE);
	});

	it("advances after turn-end stale-result pruning", async () => {
		const { session: current } = openSession({
			"compaction.enabled": false,
			"compaction.dropUseless": true,
			"compaction.supersedeReads": true,
		});
		const toolOutputs = vi.spyOn(pruningModule, "pruneToolOutputs");

		expect(await revisionStep(current, () => endTurn(current))).toBe(1);
		expect(toolOutputs).not.toHaveBeenCalled();
		expect(liveResultText(current)).toBe(USELESS_NOTICE);
	});

	it("advances after compaction", async () => {
		const { session: current, sessionManager } = openSession({
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

		expect(await revisionStep(current, async () => void (await current.compact()))).toBeGreaterThan(0);
		expect(sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			summary: "compacted summary",
		});
	});

	it("advances after a rewind past a tool result, not after one that keeps every tool result", async () => {
		const opened = openSession({ "compaction.dropUseless": false, "compaction.supersedeReads": false });
		const { session: current, sessionManager, toolResultId } = opened;
		// Only the closing answer after the tool result is dropped.
		expect(
			await revisionStep(current, async () => void (await current.navigateTree(toolResultId, { summarize: false }))),
		).toBe(0);
		expect(current.agent.state.messages.at(-1)?.role).toBe("toolResult");
		// The assistant turn that called the tool: rewinding to it drops the tool result from the context.
		const callId = sessionManager.getEntry(toolResultId)?.parentId;
		if (!callId) throw new Error("Expected the tool result to follow its call");
		expect(
			await revisionStep(current, async () => void (await current.navigateTree(callId, { summarize: false }))),
		).toBe(1);
		expect(current.agent.state.messages.some(message => message.role === "toolResult")).toBe(false);
	});
});
