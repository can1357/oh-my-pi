export { createRouter, LLMRouter } from "./agent.js";
export { loadRouterConfig, mergeConfig, normalizeConfig, validateRouterConfig } from "./config.js";
export { cloneDefaultConfig, DEFAULT_CONFIG } from "./defaults.js";
export { default as extension } from "./extension.js";
export { estimateTokens, extractFeatures, preferenceFromString } from "./features.js";
export { decideRoute } from "./policy.js";
export { decisionTelemetry, summarizeTelemetry, validationTelemetry, writeTelemetry } from "./telemetry.js";
export {
	captureToolUse,
	createToolUseCaptureRecord,
	exportToolRoutingExamplesFromTelemetry,
	formatToolUseRecord,
	normalizeToolCaptureConfig,
	parseToolUseRecord,
	shouldCaptureToolUse,
	summarizeToolUseTelemetry,
	ToolUseCaptureLayer,
	toolUseRecordToTrainingExample,
	toolUseTelemetry,
	writeToolUseCapture,
} from "./tool-capture.js";
export type * from "./types.js";
export { validateOutput } from "./validation.js";
