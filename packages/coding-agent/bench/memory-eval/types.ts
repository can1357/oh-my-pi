export type DatasetName = "beam-100k" | "beam-500k" | "lme-s" | "lme-s-dev";

export interface EvalMessage {
	messageId: string;
	sessionId: string;
	role: "user" | "assistant";
	content: string;
}

export interface EvalQuestion {
	questionId: string;
	text: string;
	category: string;
	goldMessageIds: string[];
	goldSessionIds: string[];
}

export interface EvalCase {
	caseId: string;
	dataset: DatasetName;
	messages: EvalMessage[];
	questions: EvalQuestion[];
}

export interface ExcludedQuestion {
	questionId: string;
	reason: "abstention" | "no-gold" | "blank-gold";
}

export interface LoadResult {
	cases: EvalCase[];
	excluded: ExcludedQuestion[];
}

export interface UpstreamCompatConversation {
	messages: string[];
	questions: { text: string; goldIndices: number[] }[];
}
