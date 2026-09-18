/**
 * Provider-neutral isolated RLM worker completion (subModel + optional structured schema).
 */

import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, Tool } from "@oh-my-pi/pi-ai";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelFromString } from "../config/model-resolver";
import { shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import type { RlmWorkerMessage } from "./query";
import { rlmSubModel } from "./session";

const STRUCTURED_TOOL_NAME = "evidence_packet";

export interface RlmWorkerCompletionHost {
	settings: { get(path: string): unknown };
	modelRegistry?: ModelRegistry;
	getSessionId?: () => string | undefined;
	getTelemetry?: () => unknown;
	getActiveModel?: () => Model<Api> | undefined;
	getThinkingLevel?: () => string | undefined;
}

export interface RlmWorkerCompletionOptions {
	signal?: AbortSignal;
	purpose?: string;
	workerMessages?: readonly RlmWorkerMessage[];
	responseSchema?: Record<string, unknown>;
}

export interface RlmWorkerCompletionResult {
	text: string;
	tokens?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	provider?: string;
	model?: string;
	structured?: unknown;
	providerMessages?: readonly RlmWorkerMessage[];
}

function resolveWorkerModel(host: RlmWorkerCompletionHost): Model<Api> {
	const registry = host.modelRegistry;
	if (!registry) throw new Error("rlm worker: model registry unavailable");
	const sub = rlmSubModel({ settings: host.settings });
	if (sub) {
		const resolved = resolveModelFromString(sub, registry.getAvailable(), {
			settings: host.settings as never,
		});
		if (resolved) return resolved;
		throw new Error(`rlm worker: could not resolve rlm.subModel=${sub}`);
	}
	const active = host.getActiveModel?.();
	if (active) return active;
	throw new Error("rlm worker: no rlm.subModel and no active session model");
}

function workerMessagesToContext(messages: readonly RlmWorkerMessage[]): {
	systemPrompt: string[];
	userText: string;
} {
	const systemParts: string[] = [];
	const userParts: string[] = [];
	for (const m of messages) {
		if (m.role === "system") systemParts.push(m.content);
		else userParts.push(m.content);
	}
	return {
		systemPrompt: systemParts.length > 0 ? systemParts : ["You are an isolated RLM worker."],
		userText: userParts.join("\n\n"),
	};
}

export async function runRlmWorkerCompletion(
	host: RlmWorkerCompletionHost,
	prompt: string,
	options?: RlmWorkerCompletionOptions,
): Promise<RlmWorkerCompletionResult> {
	const registry = host.modelRegistry;
	if (!registry) throw new Error("rlm worker: model registry unavailable");

	const messages: RlmWorkerMessage[] =
		options?.workerMessages && options.workerMessages.length > 0
			? [...options.workerMessages]
			: [
					{ role: "system", content: "You are an isolated RLM worker." },
					{ role: "user", content: prompt },
				];

	const { systemPrompt, userText } = workerMessagesToContext(messages);
	const model = resolveWorkerModel(host);
	const schema = options?.responseSchema;
	const tools: Tool[] | undefined = schema
		? [
				{
					name: STRUCTURED_TOOL_NAME,
					description: "Return EvidencePacketV2 as structured JSON fields.",
					parameters: schema,
					strict: true,
				},
			]
		: undefined;

	const sessionId = host.getSessionId?.();
	const apiKey = await registry.getApiKey(model, sessionId, { signal: options?.signal });
	if (!apiKey) throw new Error(`rlm worker: no API key for ${model.provider}/${model.id}`);
	const thinkingLevel = host.getThinkingLevel?.();
	const telemetry = resolveTelemetry(host.getTelemetry?.() as never, sessionId);

	const completeOnce = async (): Promise<AssistantMessage> =>
		instrumentedCompleteSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: registry.resolver(model, sessionId),
				signal: options?.signal,
				reasoning: toReasoningEffort(thinkingLevel as never),
				disableReasoning: shouldDisableReasoning(thinkingLevel as never),
				toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
			},
			{ telemetry, oneshotKind: "rlm_worker" },
		);

	let response: AssistantMessage | undefined;
	let text: string | undefined;
	let structured: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		response = await completeOnce();
		if (response.stopReason === "aborted") throw new Error("rlm worker: aborted");
		if (response.stopReason === "error") throw new Error(response.errorMessage ?? "rlm worker: provider error");

		if (schema) {
			const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
			if (call) {
				structured = call.arguments;
				text = JSON.stringify(call.arguments);
				break;
			}
			const raw = extractTextContent(response);
			if (raw) {
				structured = parseJsonPayload(raw);
				text = JSON.stringify(structured);
				break;
			}
			if (attempt === 0) continue;
			throw new Error("rlm worker: empty structured response");
		}

		text = extractTextContent(response);
		if (text) break;
		if (attempt === 0) continue;
		throw new Error("rlm worker: empty response");
	}

	if (!response || text === undefined) throw new Error("rlm worker: empty response");

	const usage = response.usage;
	return {
		text,
		tokens: usage?.totalTokens,
		cost: usage?.cost?.total,
		inputTokens: usage?.input,
		outputTokens: usage?.output,
		cacheReadTokens: usage?.cacheRead,
		provider: model.provider,
		model: model.id,
		structured,
		providerMessages: messages,
	};
}
