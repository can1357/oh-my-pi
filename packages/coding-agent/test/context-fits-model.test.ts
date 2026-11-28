/**
 * Contract: `SessionMaintenance.contextFitsModel(model)` judges the request
 * `model` itself would receive. Native Responses reasoning replays only to the
 * model that produced it, and only while its session replays native history,
 * so a different retry candidate is not charged the active model's replayed
 * reasoning, in the local floor or in the provider usage that carried it, while
 * the producing model still is. The latest answer the context figure adds to
 * the provider usage counts as `model`'s request replays it in the same way.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type ContextAnswerReader,
	SessionStatsTracker,
	type SessionStatsTrackerHost,
} from "@oh-my-pi/pi-coding-agent/session/session-stats";

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
 * Maintenance over `messages` for a session on `activeModel` (the codex model
 * when omitted). Without `usageTokens` there is no provider usage, so the local
 * floor decides (rebuilt history); with it, provider usage anchored to the
 * active model's last request competes, as on the live retry path. With
 * `tracked`, a real `SessionStatsTracker` reads that usage off the anchor on
 * `sessionManager`'s branch instead.
 */
function maintenance(
	messages: AgentMessage[],
	options: {
		activeModel?: Model;
		usageTokens?: number;
		tracked?: boolean;
		providerSessionState?: Map<string, ProviderSessionState>;
		sessionManager?: SessionManager;
	} = {},
): SessionMaintenance {
	const activeModel = options.activeModel ?? active;
	const agent = new Agent({ initialState: { model: activeModel, systemPrompt: [], tools: [], messages } });
	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	// The tracker reads no model registry for the context figure.
	const stats = options.tracked
		? new SessionStatsTracker({
				session: {},
				agent,
				sessionManager,
				model: () => activeModel,
			} as unknown as SessionStatsTrackerHost)
		: undefined;
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
		// Stubbed usage adds no answer to the provider's prompt.
		getContextAnswer: () => undefined,
		...(stats && {
			getContextUsage: (usageOptions: { contextWindow: number }) => stats.getContextUsage(usageOptions),
			getContextAnswer: (reader: ContextAnswerReader) => stats.getContextAnswer(reader),
		}),
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

	it("moves provider usage off the reasoning the active model's request replayed", () => {
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

	it("moves provider usage off a replay with no reported reasoning tokens at its signature price", () => {
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

	it("counts the latest answer in the provider usage as the candidate's request replays it", () => {
		const claudeApi = getBundledModel("anthropic", "claude-opus-5-5");
		const bedrock = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "Find the call sites.", timestamp: 1 });
		// The Claude API bills this turn's signed thinking at its 3,000-token output when the next request replays
		// it; Bedrock's replay strips the signature, so only the few visible tokens reach it.
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Check the call sites first.", thinkingSignature: "s".repeat(4_000) },
				{ type: "text", text: "The call sites are in a.ts." },
			],
			api: claudeApi.api,
			provider: claudeApi.provider,
			model: claudeApi.id,
			usage: {
				input: 10_000,
				output: 3_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 13_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		// A 14,117-token window less its 15% reserve (2,117) leaves a 12,000-token budget.
		const fits = (target: Model): boolean =>
			maintenance(sessionManager.buildSessionContext().messages, {
				activeModel: claudeApi,
				tracked: true,
				sessionManager,
			}).contextFitsModel({ ...target, contextWindow: 14_117 });

		expect(fits(bedrock)).toBe(true);
		// Control: the producing model's next request carries the 10,000-token prompt and the 3,000-token answer.
		expect(fits(claudeApi)).toBe(false);
	});

	it("charges a native server-tool result in the latest answer only to a candidate whose request replays it", () => {
		const claudeApi = getBundledModel("anthropic", "claude-opus-5-5");
		const bedrock = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "Find the call sites.", timestamp: 1 });
		// A native web search: its call and its ~2,500-token result, under the turn's 3,000-token output, so the
		// output cap cannot hide them.
		const answer: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "anthropicServerTool",
					block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "call sites" } },
				},
				{
					type: "anthropicServerTool",
					block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_1",
						content: [
							{
								type: "web_search_result",
								url: "https://example.com/a.ts",
								title: "a.ts",
								encrypted_content: "e".repeat(10_000),
							},
						],
					},
				},
				{ type: "text", text: "The call sites are in a.ts." },
			],
			api: claudeApi.api,
			provider: claudeApi.provider,
			model: claudeApi.id,
			usage: {
				input: 10_000,
				output: 3_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 13_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		sessionManager.appendMessage(answer);
		// A 14,117-token window less its 15% reserve (2,117) leaves a 12,000-token budget.
		const fits = (target: Model): boolean =>
			maintenance(sessionManager.buildSessionContext().messages, {
				activeModel: claudeApi,
				tracked: true,
				sessionManager,
			}).contextFitsModel({ ...target, contextWindow: 14_117 });

		// Bedrock's request carries the 10,000-token prompt and the answer's text.
		expect(fits(bedrock)).toBe(true);
		// Control: the producing model's next request also carries the search.
		expect(fits(claudeApi)).toBe(false);
	});
});
