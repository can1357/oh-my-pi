import type { Api } from "@pk-nerdsaver-ai/pi-ai";
import type { Shape } from "@pk-nerdsaver-ai/snapcompact";

export interface BackgroundPackModelProfile {
	provider: string;
	api: Api;
	id: string;
	requestModelId: string;
	baseUrl: string;
	input: readonly ("text" | "image")[];
}

export interface BackgroundPackModelQualification {
	modelFingerprint: string;
	shapeFingerprint: string;
	artifact: string;
}

export function backgroundPackModelFingerprint(model: BackgroundPackModelProfile): string {
	return JSON.stringify({
		provider: model.provider,
		api: model.api,
		id: model.id,
		requestModelId: model.requestModelId,
		baseUrl: model.baseUrl,
		input: [...model.input],
	});
}

export function backgroundPackShapeFingerprint(shape: Shape): string {
	return JSON.stringify({
		font: shape.font,
		cellWidth: shape.cellWidth,
		cellHeight: shape.cellHeight,
		stretch: shape.stretch,
		variant: shape.variant,
		stopwordDim: shape.stopwordDim,
		columns: shape.columns,
		lineRepeat: shape.lineRepeat,
		frameSize: shape.frameSize,
		frameTokenEstimate: shape.frameTokenEstimate,
		imageDetail: shape.imageDetail,
	});
}
