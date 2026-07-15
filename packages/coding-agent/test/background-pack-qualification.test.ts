import { describe, expect, it } from "bun:test";
import {
	BACKGROUND_PACK_QUALIFICATION_ARTIFACT_FAILURES,
	BACKGROUND_PACK_QUALIFICATION_CORPUS_HASH,
	BACKGROUND_PACK_QUALIFICATION_SUITE_SOURCE_HASH,
	BACKGROUND_PACK_RENDERER_REVISION,
	type BackgroundPackModelProfile,
	backgroundPackModelFingerprint,
	type QualificationFailureCode,
	VALIDATED_BACKGROUND_PACK_MODELS,
	validateBackgroundPackQualificationArtifact,
} from "../src/context/background-packs";

interface QualificationTestArtifact {
	version: number;
	suiteRevision: string;
	results: Array<{
		model: BackgroundPackModelProfile;
		modelFingerprint: string;
		shapeFingerprint: string;
		provenance: { suiteSourceHash: string; corpusHash: string; rendererVersion: string; evaluatedAt: string };
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
	}>;
}

const profile: BackgroundPackModelProfile = {
	provider: "test-provider",
	api: "openai-responses",
	id: "qualified-model",
	requestModelId: "qualified-model-2026-07-01",
	baseUrl: "https://example.test/v1",
	input: ["text", "image"],
};

function passingArtifact(): QualificationTestArtifact {
	const model: BackgroundPackModelProfile = { ...profile, input: [...profile.input] };
	return {
		version: 1,
		suiteRevision: "background-pack-qualification-v1",
		results: [
			{
				model,
				modelFingerprint: backgroundPackModelFingerprint(model),
				shapeFingerprint: "exact-render-shape",
				provenance: {
					suiteSourceHash: BACKGROUND_PACK_QUALIFICATION_SUITE_SOURCE_HASH,
					corpusHash: BACKGROUND_PACK_QUALIFICATION_CORPUS_HASH,
					rendererVersion: BACKGROUND_PACK_RENDERER_REVISION,
					evaluatedAt: "2026-07-13T12:00:00.000Z",
				},
				samples: { repetitions: 3, gist: 50, exactValue: 25, absentFact: 25, instructionBoundary: 10 },
				metrics: {
					nativeGistScore: 0.97,
					imageGistScore: 0.96,
					exactValueCorrect: 75,
					inventedFacts: 0,
					instructionBoundaryCorrect: 30,
					nativeUncachedTokens: 10_000,
					imageUncachedTokens: 8_000,
				},
			},
		],
	};
}

describe("background-pack qualification artifacts", () => {
	it("qualifies only an exact profile that passes every safety and savings threshold", () => {
		const artifact = passingArtifact();
		const result = validateBackgroundPackQualificationArtifact(artifact);
		expect(result.failures).toEqual([]);
		expect(Object.keys(result.qualifications)).toEqual([artifact.results[0]?.modelFingerprint]);
		expect(Object.isFrozen(result.qualifications)).toBe(true);
		expect(Object.isFrozen(Object.values(result.qualifications)[0])).toBe(true);
	});

	it("keeps failing profiles out of the registry for every mandatory gate", () => {
		const cases: Array<{ code: QualificationFailureCode; mutate: (artifact: QualificationTestArtifact) => void }> = [
			{ code: "model-fingerprint-mismatch", mutate: artifact => (artifact.results[0]!.modelFingerprint = "wrong") },
			{
				code: "suite-source-mismatch",
				mutate: artifact => (artifact.results[0]!.provenance.suiteSourceHash = "a".repeat(64)),
			},
			{
				code: "corpus-hash-mismatch",
				mutate: artifact => (artifact.results[0]!.provenance.corpusHash = "a".repeat(64)),
			},
			{
				code: "renderer-revision-mismatch",
				mutate: artifact =>
					(artifact.results[0]!.provenance.rendererVersion = "@pk-nerdsaver-ai/snapcompact@wrong"),
			},
			{ code: "provenance-invalid", mutate: artifact => (artifact.results[0]!.provenance.corpusHash = "stale") },
			{
				code: "repetitions-insufficient",
				mutate: artifact => {
					artifact.results[0]!.samples.repetitions = 2;
					artifact.results[0]!.metrics.exactValueCorrect = 50;
					artifact.results[0]!.metrics.instructionBoundaryCorrect = 20;
				},
			},
			{
				code: "corpus-insufficient",
				mutate: artifact => {
					artifact.results[0]!.samples.exactValue = 24;
					artifact.results[0]!.metrics.exactValueCorrect = 72;
				},
			},
			{ code: "gist-parity-failed", mutate: artifact => (artifact.results[0]!.metrics.imageGistScore = 0.9) },
			{ code: "exact-value-failed", mutate: artifact => (artifact.results[0]!.metrics.exactValueCorrect = 74) },
			{ code: "invented-facts", mutate: artifact => (artifact.results[0]!.metrics.inventedFacts = 1) },
			{
				code: "instruction-boundary-failed",
				mutate: artifact => (artifact.results[0]!.metrics.instructionBoundaryCorrect = 29),
			},
			{
				code: "savings-insufficient",
				mutate: artifact => (artifact.results[0]!.metrics.imageUncachedTokens = 8_600),
			},
		];
		for (const testCase of cases) {
			const artifact = passingArtifact();
			testCase.mutate(artifact);
			const result = validateBackgroundPackQualificationArtifact(artifact);
			expect(result.failures.map(failure => failure.code)).toContain(testCase.code);
			expect(Object.keys(result.qualifications)).toEqual([]);
		}
	});

	it("rejects malformed scores, counts, token totals, and profile strings before registry admission", () => {
		const mutations: Array<(artifact: QualificationTestArtifact) => void> = [
			artifact => (artifact.results[0]!.metrics.nativeGistScore = 42),
			artifact => (artifact.results[0]!.metrics.imageGistScore = -0.01),
			artifact => (artifact.results[0]!.metrics.exactValueCorrect = -1),
			artifact => (artifact.results[0]!.metrics.inventedFacts = 1.5),
			artifact => (artifact.results[0]!.metrics.nativeUncachedTokens = 0),
			artifact => (artifact.results[0]!.metrics.nativeUncachedTokens = 1.5),
			artifact => (artifact.results[0]!.metrics.imageUncachedTokens = -1_000),
			artifact => (artifact.results[0]!.samples.gist = Number.MAX_SAFE_INTEGER + 1),
			artifact => (artifact.results[0]!.samples.exactValue = Number.MAX_SAFE_INTEGER),
			artifact => (artifact.results[0]!.model.provider = ""),
			artifact => (artifact.results[0]!.model.api = ""),
			artifact => (artifact.results[0]!.model.id = " whitespace "),
			artifact => (artifact.results[0]!.model.requestModelId = `bad${String.fromCharCode(0)}id`),
			artifact => (artifact.results[0]!.model.baseUrl = "not-a-url"),
		];

		for (const mutate of mutations) {
			const artifact = passingArtifact();
			mutate(artifact);
			const result = validateBackgroundPackQualificationArtifact(artifact);
			expect(result.failures).toEqual([{ code: "artifact-invalid", resultIndex: 0 }]);
			expect(result.qualifications).toEqual({});
		}
	});

	it("rejects counts beyond their repeated sample totals", () => {
		const mutations: Array<(artifact: QualificationTestArtifact) => void> = [
			artifact => (artifact.results[0]!.metrics.exactValueCorrect = 76),
			artifact => (artifact.results[0]!.metrics.inventedFacts = 76),
			artifact => (artifact.results[0]!.metrics.instructionBoundaryCorrect = 31),
		];

		for (const mutate of mutations) {
			const artifact = passingArtifact();
			mutate(artifact);
			const result = validateBackgroundPackQualificationArtifact(artifact);
			expect(result.failures).toEqual([{ code: "artifact-invalid", resultIndex: 0 }]);
			expect(result.qualifications).toEqual({});
		}
	});

	it("rejects the malformed bad-probe row instead of admitting artificial savings", () => {
		const artifact = passingArtifact();
		artifact.results[0]!.metrics.nativeGistScore = 42;
		artifact.results[0]!.metrics.imageUncachedTokens = -1_000;
		artifact.results[0]!.provenance.rendererVersion = "16.2.6";

		const result = validateBackgroundPackQualificationArtifact(artifact);
		expect(result.failures).toEqual([{ code: "artifact-invalid", resultIndex: 0 }]);
		expect(result.qualifications).toEqual({});
	});

	it("the checked-in registry remains empty until a result artifact passes", () => {
		expect(BACKGROUND_PACK_QUALIFICATION_ARTIFACT_FAILURES).toEqual([]);
		expect(VALIDATED_BACKGROUND_PACK_MODELS).toEqual({});
	});
});
