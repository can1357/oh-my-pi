/**
 * Contract: `SessionMaintenance.contextFitsModel(model)` judges the request
 * `model` itself would receive. Native Responses reasoning replays only to the
 * model that produced it, and only while its session replays native history,
 * so a different retry candidate is not charged the active model's replayed
 * reasoning, in the local floor or in the provider usage that carried it, while
 * the producing model still is. Images likewise: a candidate whose requests
 * carry text in place of each image is not charged the pixels the active
 * model's request carried. The status count is the active model's figure, so
 * it judges only the active model, and only when that model produced the usage
 * it anchors on; any other candidate is judged by its own count.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const active = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol");
// Same encoding, another model: it gets the turns re-encoded without their reasoning.
const candidate: Model<"openai-codex-responses"> = {
	...getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6-sol"),
	contextWindow: 2_000,
};
const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "e".repeat(16_000) };

function responsesTurn(producer: Model, text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: producer.api,
		provider: producer.provider,
		model: producer.id,
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: producer.provider,
			dt: true,
			items: [reasoningItem, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
		},
		usage: {
			input: 0,
			output: 6_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 6_000,
			reasoningTokens: 5_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

const codexTurn = (text: string, timestamp: number) => responsesTurn(active, text, timestamp);

/**
 * A context window whose fit budget is at least `budgetTokens`: a window this
 * size reserves 15% of itself, more than the configured 200 tokens.
 */
function windowFor(budgetTokens: number): number {
	return Math.ceil(budgetTokens / 0.85);
}

/**
 * Maintenance over `messages`. Without `usageTokens` there is no provider usage,
 * so the local floor decides (rebuilt history); with it, provider usage anchored
 * to the active model's last request competes, as on the live retry path.
 * `activeModel` defaults to the Codex model; `imagePlaceholder` is the agent's
 * image policy (none: every request carries its images).
 */
function maintenance(
	messages: AgentMessage[],
	options: {
		usageTokens?: number;
		providerSessionState?: Map<string, ProviderSessionState>;
		sessionManager?: SessionManager;
		activeModel?: Model;
		imagePlaceholder?: (model: Model) => string | undefined;
	} = {},
): SessionMaintenance {
	const activeModel = options.activeModel ?? active;
	const agent = new Agent({
		initialState: { model: activeModel, systemPrompt: [], tools: [], messages },
		imagePlaceholder: options.imagePlaceholder,
	});
	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const host = {
		agent,
		settings: Settings.isolated({ "compaction.reserveTokens": 200 }),
		model: () => activeModel,
		messages: () => agent.state.messages,
		nonMessageTokenSource: () => ({}),
		providerSessionState: options.providerSessionState,
		sessionManager,
		buildDisplaySessionContext: (model: Model = activeModel) => sessionManager.buildSessionContext({ model }),
		getContextUsage: ({ contextWindow }: { contextWindow: number }) =>
			options.usageTokens === undefined
				? undefined
				: { tokens: options.usageTokens, contextWindow, percent: (options.usageTokens / contextWindow) * 100 },
	} as unknown as SessionMaintenanceHost;
	return new SessionMaintenance(host);
}

describe("SessionMaintenance.contextFitsModel", () => {
	it("fits a candidate whose request drops the active model's replayed reasoning", () => {
		const turn = codexTurn("Important conclusion.", 1);
		expect(convertCodexResponsesMessages(candidate, { messages: [turn] }).some(i => i.type === "reasoning")).toBe(
			false,
		);
		expect(maintenance([turn]).contextFitsModel(candidate)).toBe(true);
		// Control: the producing model replays the 5,000 reasoning tokens, so the same window cannot hold them.
		expect(maintenance([turn]).contextFitsModel({ ...active, contextWindow: 2_000 })).toBe(false);
	});

	it("judges a candidate by its own count, not the usage that carried the active model's replayed reasoning", () => {
		const earlier = codexTurn("Important conclusion.", 1);
		const retained: AgentMessage[] = [
			{ role: "user", content: "Question?", timestamp: 0 },
			earlier,
			{ role: "user", content: "And then?", timestamp: 2 },
		];
		// The active model's last prompt replayed `earlier`'s 5,000 reasoning tokens.
		const usageTokens = 5_100;
		expect(maintenance(retained, { usageTokens }).contextFitsModel(candidate)).toBe(true);
		// Control: the producing model replays them again, so its 2,000 window still cannot hold them.
		expect(maintenance(retained, { usageTokens }).contextFitsModel({ ...active, contextWindow: 2_000 })).toBe(false);
	});

	it("judges a candidate by its own count when the active model's replay reported no reasoning tokens", () => {
		const unreported: AssistantMessage = {
			...codexTurn("Important conclusion.", 1),
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem) },
				{ type: "text", text: "Important conclusion." },
			],
		};
		delete unreported.usage.reasoningTokens;
		const retained: AgentMessage[] = [
			{ role: "user", content: "Question?", timestamp: 0 },
			unreported,
			{ role: "user", content: "And then?", timestamp: 2 },
		];
		// The active model's last prompt carried the replayed reasoning; locally only its ciphertext prices it.
		const usageTokens = 5_100;
		expect(maintenance(retained, { usageTokens }).contextFitsModel(candidate)).toBe(true);
		expect(maintenance(retained, { usageTokens }).contextFitsModel({ ...active, contextWindow: 2_000 })).toBe(false);
	});

	it("does not charge a candidate whose cold session rebuilds its own reasoning out of the request", () => {
		const copilot = { ...getBundledModel<"openai-responses">("github-copilot", "gpt-5.4"), contextWindow: 2_000 };
		const turn = responsesTurn(copilot, "Important conclusion.", 1);
		// A connection-bound host starts cold until its first response.
		expect(maintenance([turn], { providerSessionState: new Map() }).contextFitsModel(copilot)).toBe(true);
		// Control: a warm session replays the reasoning, which the window cannot hold.
		expect(maintenance([turn]).contextFitsModel(copilot)).toBe(false);
	});

	it("takes a failed turn off the candidate's floor at the candidate's own count", () => {
		// 1,900 tokens of retained text (test counts are bytes/4) overflow the
		// candidate's 1,800-token budget whether or not the failed turn is dropped.
		const retained: AgentMessage = { role: "user", content: "x".repeat(7_600), timestamp: 0 };
		const failed = codexTurn("Partial answer.", 1);
		expect(maintenance([retained, failed]).contextFitsModel(candidate, failed)).toBe(false);
	});

	it("judges a candidate that cannot replay a remote compaction on the history behind it", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "x".repeat(16_000), timestamp: 0 });
		const keptId = sessionManager.appendMessage(codexTurn("Compacted answer.", 1));
		const compactionItem = { type: "compaction", encrypted_content: "native-state" };
		sessionManager.appendCompaction("Remote compaction placeholder", undefined, keptId, 4_000, {
			preserveData: {
				openaiRemoteCompaction: { provider: active.provider, replacementHistory: [compactionItem], compactionItem },
			},
		});
		sessionManager.appendMessage({ role: "user", content: "After compaction.", timestamp: 2 });
		const live = sessionManager.buildSessionContext({ model: active }).messages;
		const claude = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), contextWindow: 2_000 };

		// The codex candidate replays the payload: the small live context fits.
		expect(maintenance(live, { sessionManager }).contextFitsModel(candidate)).toBe(true);
		// Claude reads the ~4,000-token history behind it, which its window cannot hold.
		expect(maintenance(live, { sessionManager }).contextFitsModel(claude)).toBe(false);
	});

	it("drops only the failed turn from a candidate's rebuilt history, not an earlier reply sharing its millisecond", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "Question?", timestamp: 0 });
		// ~4,000 tokens of earlier reply behind the remote compaction, stamped the same millisecond as the failed turn.
		sessionManager.appendMessage(responsesTurn(active, "x".repeat(16_000), 5));
		const keptId = sessionManager.appendMessage({ role: "user", content: "And then?", timestamp: 6 });
		const compactionItem = { type: "compaction", encrypted_content: "native-state" };
		sessionManager.appendCompaction("Remote compaction placeholder", undefined, keptId, 4_000, {
			preserveData: {
				openaiRemoteCompaction: { provider: active.provider, replacementHistory: [compactionItem], compactionItem },
			},
		});
		const failed: AssistantMessage = { ...responsesTurn(active, "Partial answer.", 5), stopReason: "error" };
		sessionManager.appendMessage(failed);
		// The failed turn is live in the agent; the rebuilt context leaves a trailing error turn out.
		const live = [...sessionManager.buildSessionContext({ model: active }).messages, failed];
		const claude = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), contextWindow: 2_000 };

		expect(maintenance(live, { sessionManager }).contextFitsModel(claude)).toBe(false);
		// Leaving the failed turn out still counts the earlier reply Claude would be sent.
		expect(maintenance(live, { sessionManager }).contextFitsModel(claude, failed)).toBe(false);
	});

	it("does not charge a text-only candidate the pixels the active model's usage paid for", () => {
		const vision = getBundledModel("anthropic", "claude-sonnet-4-5");
		const notice = "[image omitted: the active model does not support image input]";
		// The SDK's policy: a model that cannot read images gets a notice in place of each.
		const imagePlaceholder = (model: Model) => (model.input.includes("image") ? undefined : notice);
		// Unreadable dimensions: each is charged at the reader's full image rate.
		const screenshot: ImageContent = { type: "image", data: "A".repeat(40_000), mimeType: "image/png" };
		const answer: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Two screenshots of the build log." }],
			api: vision.api,
			provider: vision.provider,
			model: vision.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const retained: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "What do these show?" }, screenshot, screenshot],
				timestamp: 0,
			},
			answer,
			{ role: "user", content: "And then?", timestamp: 2 },
		];
		// The vision model's last prompt carried both screenshots' pixels.
		const usageTokens = new Tokenizer(vision).countMessages(retained);
		const options = { usageTokens, activeModel: vision, imagePlaceholder };
		// A text-only fallback is another model than the active one.
		const textOnly: Model = { ...vision, id: `${vision.id}-text-only`, input: ["text"], contextWindow: 2_000 };

		expect(maintenance(retained, options).contextFitsModel(textOnly)).toBe(true);
		// Control: a vision model with the same window is sent the pixels, which its 1,700-token budget cannot hold.
		expect(maintenance(retained, options).contextFitsModel({ ...vision, contextWindow: 2_000 })).toBe(false);
	});

	// After a switch to a cheaper vision model with no reply since, the status
	// count still anchored on the dearer model's usage. That figure is neither
	// model's request: the model that produced the usage is no longer active,
	// and the active one did not produce it, so each is judged by its own count.
	it("judges each model by its own count after a switch away from the model that produced the usage", () => {
		const opus = getBundledModel("anthropic", "claude-opus-4-8");
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		expect(new Tokenizer(opus).imageTokens(null)).toBeGreaterThan(new Tokenizer(sonnet).imageTokens(null));
		const screenshot: ImageContent = { type: "image", data: "A".repeat(40_000), mimeType: "image/png" };
		const retained: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "What do these show?" }, screenshot, screenshot],
				timestamp: 0,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Two screenshots of the build log." }],
				api: opus.api,
				provider: opus.provider,
				model: opus.id,
				usage: {
					input: 1_000,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_010,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			{ role: "user", content: "And then?", timestamp: 2 },
		];
		// Opus answered last, so the usage prices both screenshots at its rate; then Sonnet took over.
		const opusTokens = new Tokenizer(opus).countMessages(retained);
		const sonnetTokens = new Tokenizer(sonnet).countMessages(retained);
		const options = { usageTokens: opusTokens, activeModel: sonnet };
		const fits = (model: Model, budgetTokens: number) =>
			maintenance(retained, options).contextFitsModel({ ...model, contextWindow: windowFor(budgetTokens) });

		expect(fits(opus, opusTokens + 50)).toBe(true);
		expect(fits(sonnet, sonnetTokens + 50)).toBe(true);
		// Controls: 100 tokens short, each model's own count still rules it out.
		expect(fits(opus, opusTokens - 100)).toBe(false);
		expect(fits(sonnet, sonnetTokens - 100)).toBe(false);
	});

	// The status count prices everything after the usage it anchors on at the
	// active model's rate. Opus failed and Sonnet answered; Opus took back over,
	// was sent two screenshots and failed again. Anchored on Sonnet's reply, the
	// figure priced the screenshots as Opus does and kept Sonnet out of a window
	// its own count fits.
	it("judges a candidate that is not the active model by its own count, even when it produced the usage", () => {
		const opus = getBundledModel("anthropic", "claude-opus-4-8");
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		const screenshot: ImageContent = { type: "image", data: "A".repeat(40_000), mimeType: "image/png" };
		const question: AgentMessage = { role: "user", content: "Why does the build fail?", timestamp: 0 };
		const sonnetReply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Send me the build log." }],
			api: sonnet.api,
			provider: sonnet.provider,
			model: sonnet.id,
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const screenshots: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Here is the log." }, screenshot, screenshot],
			timestamp: 2,
		};
		const retained = [question, sonnetReply, screenshots];
		// Sonnet's usage covers its own reply; the active model, Opus, counted the screenshots after it.
		const usageTokens =
			new Tokenizer(sonnet).countMessages([question, sonnetReply]) + new Tokenizer(opus).countMessage(screenshots);
		const sonnetTokens = new Tokenizer(sonnet).countMessages(retained);
		expect(usageTokens).toBeGreaterThan(sonnetTokens + 50);
		const options = { usageTokens, activeModel: opus };

		expect(
			maintenance(retained, options).contextFitsModel({ ...sonnet, contextWindow: windowFor(sonnetTokens + 50) }),
		).toBe(true);
		// Control: 100 tokens short, Sonnet's own count rules it out.
		expect(
			maintenance(retained, options).contextFitsModel({ ...sonnet, contextWindow: windowFor(sonnetTokens - 100) }),
		).toBe(false);
	});
});
