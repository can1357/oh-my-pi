import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, ApiKey, Model, ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { $env } from "@pk-nerdsaver-ai/pi-utils";
import { parseFileDiffs } from "../../commit/git/diff";
import type { ConventionalAnalysis } from "../../commit/types";
import { isExcludedFile } from "../../commit/utils/exclusions";
import { runMapPhase } from "./map-phase";
import { runReducePhase } from "./reduce-phase";
import { estimateTokens } from "./utils";

const MIN_FILES_FOR_MAP_REDUCE = 4;
const MAX_FILE_TOKENS = 50_000;

export interface MapReduceSettings {
	enabled?: boolean;
	minFiles?: number;
	maxFileTokens?: number;
	maxConcurrency?: number;
	timeoutMs?: number;
}

export interface MapReduceInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	smolModel: Model<Api>;
	smolApiKey: ApiKey;
	smolThinkingLevel?: ThinkingLevel;
	smolServiceTier?: ServiceTier;
	diff: string;
	stat: string;
	scopeCandidates: string;
	typesDescription?: string;
	settings?: MapReduceSettings;
}

export function shouldUseMapReduce(diff: string, settings?: MapReduceSettings): boolean {
	if ($env.PI_COMMIT_MAP_REDUCE?.toLowerCase() === "false") return false;
	if (settings?.enabled === false) return false;
	const minFiles = settings?.minFiles ?? MIN_FILES_FOR_MAP_REDUCE;
	const maxFileTokens = settings?.maxFileTokens ?? MAX_FILE_TOKENS;
	const files = parseFileDiffs(diff).filter(file => !isExcludedFile(file.filename));
	const fileCount = files.length;
	if (fileCount >= minFiles) return true;
	return files.some(file => estimateTokens(file.content) > maxFileTokens);
}

/**
 * Run map-reduce analysis for large diffs using smol + primary models.
 */

export async function runMapReduceAnalysis(input: MapReduceInput): Promise<ConventionalAnalysis> {
	const fileDiffs = parseFileDiffs(input.diff).filter(file => !isExcludedFile(file.filename));
	const observations = await runMapPhase({
		model: input.smolModel,
		apiKey: input.smolApiKey,
		thinkingLevel: input.smolThinkingLevel,
		serviceTier: input.smolServiceTier,
		files: fileDiffs,
		config: input.settings,
	});
	return runReducePhase({
		model: input.model,
		apiKey: input.apiKey,
		thinkingLevel: input.thinkingLevel,
		serviceTier: input.serviceTier,
		observations,
		stat: input.stat,
		scopeCandidates: input.scopeCandidates,
		typesDescription: input.typesDescription,
	});
}
