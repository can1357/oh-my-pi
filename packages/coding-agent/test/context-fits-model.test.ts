/**
 * Contract: `SessionMaintenance.contextFitsModel(model)` judges the request
 * `model` itself would receive. Native Responses reasoning replays only to the
 * model that produced it, and only while its session replays native history,
 * so a different retry candidate is not charged the active model's replayed
 * reasoning, in the local floor or in the provider usage that carried it, while
 * the producing model still is.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

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
 * Maintenance over `messages`. Without `usageTokens` there is no provider usage,
 * so the local floor decides (rebuilt history); with it, provider usage anchored
 * to the active model's last request competes, as on the live retry path.
 */
function maintenance(
	messages: AgentMessage[],
	options: { usageTokens?: number; providerSessionState?: Map<string, ProviderSessionState> } = {},
): SessionMaintenance {
	const agent = new Agent({ initialState: { model: active, systemPrompt: [], tools: [], messages } });
	const host = {
		agent,
		settings: Settings.isolated({ "compaction.reserveTokens": 200 }),
		model: () => active,
		messages: () => agent.state.messages,
		nonMessageTokenSource: () => ({}),
		providerSessionState: options.providerSessionState,
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
});
