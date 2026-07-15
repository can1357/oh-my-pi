import type { Shape } from "@pk-nerdsaver-ai/snapcompact";
import { validateBackgroundPackQualificationArtifact } from "./qualification-artifact";
import {
	type BackgroundPackModelProfile,
	type BackgroundPackModelQualification,
	backgroundPackModelFingerprint,
	backgroundPackShapeFingerprint,
} from "./qualification-contract";
import qualificationResults from "./qualification-results.v1.json" with { type: "json" };

const checkedQualificationArtifact = validateBackgroundPackQualificationArtifact(qualificationResults);

export const VALIDATED_BACKGROUND_PACK_MODELS: Readonly<Record<string, BackgroundPackModelQualification>> =
	checkedQualificationArtifact.qualifications;

export const BACKGROUND_PACK_QUALIFICATION_ARTIFACT_FAILURES = checkedQualificationArtifact.failures;

export function qualificationForBackgroundPackModel(
	model: BackgroundPackModelProfile,
	shape: Shape,
): BackgroundPackModelQualification | undefined {
	const modelFingerprint = backgroundPackModelFingerprint(model);
	const qualification = VALIDATED_BACKGROUND_PACK_MODELS[modelFingerprint];
	if (!qualification) return undefined;
	if (qualification.modelFingerprint !== modelFingerprint) return undefined;
	if (qualification.shapeFingerprint !== backgroundPackShapeFingerprint(shape)) return undefined;
	return qualification;
}

export * from "./qualification-contract";
