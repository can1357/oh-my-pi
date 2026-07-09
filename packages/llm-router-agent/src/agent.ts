import { type LoadedConfig, loadRouterConfig } from "./config.js";
import { extractFeatures } from "./features.js";
import { decideRoute } from "./policy.js";
import { decisionTelemetry, validationTelemetry, writeTelemetry, writeTrace } from "./telemetry.js";
import { captureToolUse, ToolUseCaptureLayer } from "./tool-capture.js";
import type {
	RequestInput,
	RouteDecision,
	RouterConfig,
	ToolUseCaptureInput,
	ToolUseCaptureRecord,
	ValidationResult,
} from "./types.js";
import { validateOutput } from "./validation.js";

export class LLMRouter {
	readonly config: RouterConfig;
	readonly configPath?: string;
	readonly warnings: string[];
	readonly toolCapture: ToolUseCaptureLayer;

	constructor(config: RouterConfig, options: { configPath?: string; warnings?: string[] } = {}) {
		this.config = config;
		this.configPath = options.configPath;
		this.warnings = options.warnings ?? [];
		this.toolCapture = new ToolUseCaptureLayer(config);
	}

	static async load(
		options: { cwd?: string; path?: string; env?: Record<string, string | undefined> } = {},
	): Promise<LLMRouter> {
		const loaded: LoadedConfig = await loadRouterConfig(options);
		return new LLMRouter(loaded.config, { configPath: loaded.path, warnings: loaded.warnings });
	}

	decide(input: RequestInput): RouteDecision {
		const features = extractFeatures(input);
		return decideRoute(input, features, this.config);
	}

	async decideAndLog(input: RequestInput, metadata: Record<string, unknown> = {}): Promise<RouteDecision> {
		const decision = this.decide(input);
		const record = decisionTelemetry(decision, metadata, input, {
			includePromptPreview: this.config.traces?.includePromptPreview,
			maxPromptPreviewChars: this.config.traces?.maxPromptPreviewChars,
		});
		await writeTelemetry(this.config, record);
		await writeTrace(this.config, record);
		return decision;
	}

	async captureTool(
		input: ToolUseCaptureInput,
		metadata: Record<string, unknown> = {},
	): Promise<ToolUseCaptureRecord | undefined> {
		return captureToolUse(this.config, input, metadata);
	}

	validate(requestId: string, output: string, decision: RouteDecision): ValidationResult {
		const result = validateOutput(output, decision.validationPlan, this.config.validation?.unsafePatternHints ?? []);
		void writeTelemetry(this.config, validationTelemetry(requestId, result)).catch(() => undefined);
		return result;
	}
}

export async function createRouter(
	options: { cwd?: string; path?: string; env?: Record<string, string | undefined> } = {},
): Promise<LLMRouter> {
	return LLMRouter.load(options);
}
