import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

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

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prune-persistence-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
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

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
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
});
