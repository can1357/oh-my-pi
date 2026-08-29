import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, ApiKey, Model, ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { completeSimple } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import reduceSystemPrompt from "../../commit/prompts/reduce-system.md" with { type: "text" };
import reduceUserPrompt from "../../commit/prompts/reduce-user.md" with { type: "text" };
import type { ConventionalAnalysis, FileObservation } from "../../commit/types";
import { toReasoningEffort } from "../../thinking";
import { createConventionalAnalysisTool, parseConventionalAnalysisResponse } from "../shared-llm";

const ReduceTool = createConventionalAnalysisTool("Synthesize file observations into a conventional commit analysis.");

export interface ReducePhaseInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	observations: FileObservation[];
	stat: string;
	scopeCandidates: string;
	typesDescription?: string;
}

export async function runReducePhase({
	model,
	apiKey,
	thinkingLevel,
	serviceTier,
	observations,
	stat,
	scopeCandidates,
	typesDescription,
}: ReducePhaseInput): Promise<ConventionalAnalysis> {
	const userContent = prompt.render(reduceUserPrompt, {
		types_description: typesDescription,
		observations: observations.flatMap(obs => obs.observations.map(line => `- ${obs.file}: ${line}`)).join("\n"),
		stat,
		scope_candidates: scopeCandidates,
	});
	const response = await completeSimple(
		model,
		{
			systemPrompt: [prompt.render(reduceSystemPrompt)],
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [ReduceTool],
		},
		{ apiKey, maxTokens: 2400, reasoning: toReasoningEffort(thinkingLevel), serviceTier },
	);

	return parseConventionalAnalysisResponse(response, ReduceTool);
}
