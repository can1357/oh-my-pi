import { type } from "arktype";

export const evolutionCaseSchema = type({ id: "string", prompt: "string", expected: "string" });
export const evolutionInputSchema = type({
	lessons: "string",
	training: evolutionCaseSchema.array(),
	holdout: evolutionCaseSchema.array(),
	"rounds?": "number.integer >= 1 & number <= 3",
	"candidates?": "number.integer >= 1 & number <= 3",
});
export type EvolutionInput = typeof evolutionInputSchema.infer;
export type EvolutionCase = typeof evolutionCaseSchema.infer;

export const evolutionCandidateSchema = type({ description: "string", body: "string" });
const resultSchema = type({ id: "string", actual: "string" });
const snapshotSchema = type({ content: "string", description: "string", body: "string" });
const attemptSchema = type({
	round: "number",
	candidate: evolutionCandidateSchema,
	training: resultSchema.array(),
});
export const evolutionReportSchema = type({
	version: "1",
	id: "string",
	name: "string",
	createdAt: "string",
	model: "string",
	state: "'eligible' | 'rejected' | 'promoted' | 'failed'",
	input: evolutionInputSchema,
	baseline: snapshotSchema.or("null"),
	candidate: evolutionCandidateSchema.or("null"),
	baselineTraining: resultSchema.array(),
	baselineHoldout: resultSchema.array(),
	training: resultSchema.array(),
	holdout: resultSchema.array(),
	attempts: attemptSchema.array(),
	calls: "number",
	"error?": "string",
});
export type EvolutionReport = typeof evolutionReportSchema.infer;
export type EvolutionCandidate = typeof evolutionCandidateSchema.infer;
export type EvolutionResult = typeof resultSchema.infer;
