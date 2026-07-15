import type { Api } from "@pk-nerdsaver-ai/pi-ai";
import {
	type BackgroundPackModelProfile,
	type BackgroundPackModelQualification,
	backgroundPackModelFingerprint,
} from "./qualification-contract";

export const BACKGROUND_PACK_QUALIFICATION_SUITE_REVISION = "background-pack-qualification-v1";
export const BACKGROUND_PACK_QUALIFICATION_CORPUS_REVISION = "background-pack-corpus-v1";
export const BACKGROUND_PACK_RENDERER_REVISION = "@pk-nerdsaver-ai/snapcompact@16.2.6:renderMany-v1";
export const MIN_QUALIFICATION_REPETITIONS = 3;
export const MIN_GIST_CASES = 50;
export const MIN_EXACT_VALUE_CASES = 25;
export const MIN_ABSENT_FACT_CASES = 25;
export const MIN_INSTRUCTION_BOUNDARY_CASES = 10;
export const MIN_GIST_SCORE = 0.95;
export const MIN_GIST_PARITY_DELTA = -0.02;
export const MIN_QUALIFICATION_SAVINGS_RATIO = 0.15;
export const MIN_QUALIFICATION_SAVINGS_TOKENS = 128;
const QUALIFICATION_CORPUS_CONTRACT = {
	revision: BACKGROUND_PACK_QUALIFICATION_CORPUS_REVISION,
	partitions: [
		{ id: "general-background-gist-v1", kind: "gist", cases: MIN_GIST_CASES },
		{ id: "exact-value-recall-v1", kind: "exact-value", cases: MIN_EXACT_VALUE_CASES },
		{ id: "absent-fact-resistance-v1", kind: "absent-fact", cases: MIN_ABSENT_FACT_CASES },
		{
			id: "non-authoritative-instruction-boundary-v1",
			kind: "instruction-boundary",
			cases: MIN_INSTRUCTION_BOUNDARY_CASES,
		},
	],
};
export const BACKGROUND_PACK_QUALIFICATION_CORPUS_HASH = new Bun.CryptoHasher("sha256")
	.update(JSON.stringify(QUALIFICATION_CORPUS_CONTRACT))
	.digest("hex");
const QUALIFICATION_SUITE_CONTRACT = {
	revision: BACKGROUND_PACK_QUALIFICATION_SUITE_REVISION,
	rendererRevision: BACKGROUND_PACK_RENDERER_REVISION,
	corpusRevision: BACKGROUND_PACK_QUALIFICATION_CORPUS_REVISION,
	corpusHash: BACKGROUND_PACK_QUALIFICATION_CORPUS_HASH,
	repetitions: MIN_QUALIFICATION_REPETITIONS,
	cases: {
		gist: MIN_GIST_CASES,
		exactValue: MIN_EXACT_VALUE_CASES,
		absentFact: MIN_ABSENT_FACT_CASES,
		instructionBoundary: MIN_INSTRUCTION_BOUNDARY_CASES,
	},
	gates: {
		gistScore: MIN_GIST_SCORE,
		gistParityDelta: MIN_GIST_PARITY_DELTA,
		savingsRatio: MIN_QUALIFICATION_SAVINGS_RATIO,
		savingsTokens: MIN_QUALIFICATION_SAVINGS_TOKENS,
		exactValueAccuracy: 1,
		inventedFacts: 0,
		instructionBoundaryAccuracy: 1,
	},
};
export const BACKGROUND_PACK_QUALIFICATION_SUITE_SOURCE_HASH = new Bun.CryptoHasher("sha256")
	.update(JSON.stringify(QUALIFICATION_SUITE_CONTRACT))
	.digest("hex");

export type QualificationFailureCode =
	| "artifact-invalid"
	| "suite-revision-mismatch"
	| "suite-source-mismatch"
	| "corpus-hash-mismatch"
	| "renderer-revision-mismatch"
	| "model-fingerprint-mismatch"
	| "shape-fingerprint-missing"
	| "provenance-invalid"
	| "repetitions-insufficient"
	| "corpus-insufficient"
	| "gist-parity-failed"
	| "exact-value-failed"
	| "invented-facts"
	| "instruction-boundary-failed"
	| "savings-insufficient";

export interface QualificationFailure {
	code: QualificationFailureCode;
	resultIndex?: number;
}

export interface ValidatedQualificationArtifact {
	qualifications: Readonly<Record<string, BackgroundPackModelQualification>>;
	failures: QualificationFailure[];
}

interface QualificationResult {
	model: BackgroundPackModelProfile;
	modelFingerprint: string;
	shapeFingerprint: string;
	provenance: {
		suiteSourceHash: string;
		corpusHash: string;
		rendererVersion: string;
		evaluatedAt: string;
	};
	samples: {
		repetitions: number;
		gist: number;
		exactValue: number;
		absentFact: number;
		instructionBoundary: number;
	};
	metrics: {
		nativeGistScore: number;
		imageGistScore: number;
		exactValueCorrect: number;
		inventedFacts: number;
		instructionBoundaryCorrect: number;
		nativeUncachedTokens: number;
		imageUncachedTokens: number;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
	return finiteNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
	return finiteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function unitIntervalNumber(value: unknown): value is number {
	return finiteNumber(value) && value >= 0 && value <= 1;
}

function containsControlCharacter(value: string): boolean {
	return [...value].some(character => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
	});
}

function profileString(value: unknown, maxLength = 512): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!containsControlCharacter(value)
	);
}

function profileBaseUrl(value: unknown): value is string {
	if (!profileString(value, 2_048)) return false;
	try {
		const parsed = new URL(value);
		return (
			(parsed.protocol === "https:" || parsed.protocol === "http:") &&
			parsed.username === "" &&
			parsed.password === ""
		);
	} catch {
		return false;
	}
}

function parseProfile(value: unknown): BackgroundPackModelProfile | undefined {
	if (!isRecord(value)) return undefined;
	if (
		!profileString(value.provider) ||
		!profileString(value.api) ||
		!profileString(value.id) ||
		!profileString(value.requestModelId) ||
		!profileBaseUrl(value.baseUrl) ||
		!Array.isArray(value.input) ||
		value.input.length === 0 ||
		!value.input.every(entry => entry === "text" || entry === "image") ||
		!value.input.includes("image")
	) {
		return undefined;
	}
	return {
		provider: value.provider,
		api: value.api as Api,
		id: value.id,
		requestModelId: value.requestModelId,
		baseUrl: value.baseUrl,
		input: value.input,
	};
}

function parseResult(value: unknown): QualificationResult | undefined {
	if (!isRecord(value)) return undefined;
	const model = parseProfile(value.model);
	const provenance = value.provenance;
	const samples = value.samples;
	const metrics = value.metrics;
	if (!model || !isRecord(provenance) || !isRecord(samples) || !isRecord(metrics)) return undefined;
	if (
		typeof value.modelFingerprint !== "string" ||
		typeof value.shapeFingerprint !== "string" ||
		typeof provenance.suiteSourceHash !== "string" ||
		typeof provenance.corpusHash !== "string" ||
		typeof provenance.rendererVersion !== "string" ||
		typeof provenance.evaluatedAt !== "string" ||
		!positiveInteger(samples.repetitions) ||
		!positiveInteger(samples.gist) ||
		!positiveInteger(samples.exactValue) ||
		!positiveInteger(samples.absentFact) ||
		!positiveInteger(samples.instructionBoundary) ||
		!unitIntervalNumber(metrics.nativeGistScore) ||
		!unitIntervalNumber(metrics.imageGistScore) ||
		!nonnegativeInteger(metrics.exactValueCorrect) ||
		!nonnegativeInteger(metrics.inventedFacts) ||
		!nonnegativeInteger(metrics.instructionBoundaryCorrect) ||
		!positiveInteger(metrics.nativeUncachedTokens) ||
		!nonnegativeInteger(metrics.imageUncachedTokens)
	) {
		return undefined;
	}
	const exactValueTotal = samples.exactValue * samples.repetitions;
	const absentFactTotal = samples.absentFact * samples.repetitions;
	const instructionBoundaryTotal = samples.instructionBoundary * samples.repetitions;
	if (
		!Number.isSafeInteger(exactValueTotal) ||
		!Number.isSafeInteger(absentFactTotal) ||
		!Number.isSafeInteger(instructionBoundaryTotal) ||
		metrics.exactValueCorrect > exactValueTotal ||
		metrics.inventedFacts > absentFactTotal ||
		metrics.instructionBoundaryCorrect > instructionBoundaryTotal
	) {
		return undefined;
	}
	return {
		model,
		modelFingerprint: value.modelFingerprint,
		shapeFingerprint: value.shapeFingerprint,
		provenance: {
			suiteSourceHash: provenance.suiteSourceHash,
			corpusHash: provenance.corpusHash,
			rendererVersion: provenance.rendererVersion,
			evaluatedAt: provenance.evaluatedAt,
		},
		samples: {
			repetitions: samples.repetitions,
			gist: samples.gist,
			exactValue: samples.exactValue,
			absentFact: samples.absentFact,
			instructionBoundary: samples.instructionBoundary,
		},
		metrics: {
			nativeGistScore: metrics.nativeGistScore,
			imageGistScore: metrics.imageGistScore,
			exactValueCorrect: metrics.exactValueCorrect,
			inventedFacts: metrics.inventedFacts,
			instructionBoundaryCorrect: metrics.instructionBoundaryCorrect,
			nativeUncachedTokens: metrics.nativeUncachedTokens,
			imageUncachedTokens: metrics.imageUncachedTokens,
		},
	};
}

function resultFailures(result: QualificationResult, resultIndex: number): QualificationFailure[] {
	const failures: QualificationFailure[] = [];
	const add = (code: QualificationFailureCode): void => {
		failures.push({ code, resultIndex });
	};
	if (result.modelFingerprint !== backgroundPackModelFingerprint(result.model)) add("model-fingerprint-mismatch");
	if (result.shapeFingerprint.length === 0) add("shape-fingerprint-missing");
	const hashPattern = /^[a-f0-9]{64}$/;
	if (result.provenance.suiteSourceHash !== BACKGROUND_PACK_QUALIFICATION_SUITE_SOURCE_HASH)
		add("suite-source-mismatch");
	if (result.provenance.corpusHash !== BACKGROUND_PACK_QUALIFICATION_CORPUS_HASH) add("corpus-hash-mismatch");
	if (result.provenance.rendererVersion !== BACKGROUND_PACK_RENDERER_REVISION) add("renderer-revision-mismatch");
	if (
		!hashPattern.test(result.provenance.suiteSourceHash) ||
		!hashPattern.test(result.provenance.corpusHash) ||
		!Number.isFinite(Date.parse(result.provenance.evaluatedAt))
	) {
		add("provenance-invalid");
	}
	if (result.samples.repetitions < MIN_QUALIFICATION_REPETITIONS) add("repetitions-insufficient");
	if (
		result.samples.gist < MIN_GIST_CASES ||
		result.samples.exactValue < MIN_EXACT_VALUE_CASES ||
		result.samples.absentFact < MIN_ABSENT_FACT_CASES ||
		result.samples.instructionBoundary < MIN_INSTRUCTION_BOUNDARY_CASES
	) {
		add("corpus-insufficient");
	}
	if (
		result.metrics.nativeGistScore < MIN_GIST_SCORE ||
		result.metrics.imageGistScore < MIN_GIST_SCORE ||
		result.metrics.imageGistScore - result.metrics.nativeGistScore < MIN_GIST_PARITY_DELTA
	) {
		add("gist-parity-failed");
	}
	if (result.metrics.exactValueCorrect !== result.samples.exactValue * result.samples.repetitions) {
		add("exact-value-failed");
	}
	if (result.metrics.inventedFacts !== 0) add("invented-facts");
	if (result.metrics.instructionBoundaryCorrect !== result.samples.instructionBoundary * result.samples.repetitions) {
		add("instruction-boundary-failed");
	}
	const tokenSavings = result.metrics.nativeUncachedTokens - result.metrics.imageUncachedTokens;
	if (
		result.metrics.nativeUncachedTokens <= 0 ||
		tokenSavings < MIN_QUALIFICATION_SAVINGS_TOKENS ||
		tokenSavings / result.metrics.nativeUncachedTokens < MIN_QUALIFICATION_SAVINGS_RATIO
	) {
		add("savings-insufficient");
	}
	return failures;
}

function qualificationArtifactFingerprint(result: QualificationResult): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(result)).digest("hex");
}

export function validateBackgroundPackQualificationArtifact(value: unknown): ValidatedQualificationArtifact {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.results)) {
		return { qualifications: Object.freeze({}), failures: [{ code: "artifact-invalid" }] };
	}
	if (value.suiteRevision !== BACKGROUND_PACK_QUALIFICATION_SUITE_REVISION) {
		return { qualifications: Object.freeze({}), failures: [{ code: "suite-revision-mismatch" }] };
	}
	const qualifications: Record<string, BackgroundPackModelQualification> = {};
	const failures: QualificationFailure[] = [];
	for (const [resultIndex, rawResult] of value.results.entries()) {
		const result = parseResult(rawResult);
		if (!result) {
			failures.push({ code: "artifact-invalid", resultIndex });
			continue;
		}
		const failuresForResult = resultFailures(result, resultIndex);
		failures.push(...failuresForResult);
		if (failuresForResult.length > 0) continue;
		qualifications[result.modelFingerprint] = Object.freeze({
			modelFingerprint: result.modelFingerprint,
			shapeFingerprint: result.shapeFingerprint,
			artifact: qualificationArtifactFingerprint(result),
		});
	}
	return { qualifications: Object.freeze(qualifications), failures };
}
