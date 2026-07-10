export type TaskType =
	| "chat"
	| "classification"
	| "coding"
	| "translation"
	| "summarization"
	| "extraction"
	| "reasoning"
	| "retrieval"
	| "planning"
	| "multimodal"
	| "safety"
	| "unknown";

export type Preference = "speed" | "quality" | "cost" | "safety" | "balanced";

export interface AttachmentInfo {
	name?: string;
	mimeType?: string;
	kind?: "image" | "audio" | "video" | "pdf" | "spreadsheet" | "slides" | "text" | "binary" | "unknown";
	tokenEstimate?: number;
}

export interface RuntimeState {
	modelAvailability?: Record<string, boolean>;
	degradedModels?: string[];
	queueDepth?: number;
	providerHealth?: Record<string, "healthy" | "degraded" | "down">;
	rateLimitedProviders?: string[];
	latencyBudgetMs?: number;
	costBudgetUsd?: number;
	now?: string;
}

export interface RequestInput {
	message: string;
	system?: string;
	tags?: string[];
	user?: {
		id?: string;
		tier?: "free" | "paid" | "internal" | "enterprise" | string;
		preference?: Preference;
	};
	attachments?: AttachmentInfo[];
	expectedOutput?: {
		format?: "text" | "json" | "markdown" | "code" | "csv" | "xml";
		schema?: JsonSchemaLike;
		requiredCitations?: boolean;
		maxLatencyMs?: number;
		maxCostUsd?: number;
	};
	runtime?: RuntimeState;
	metadata?: Record<string, unknown>;
}

export type StepKind = "plan" | "tool_call" | "tool_result" | "code_edit" | "browser" | "final" | "other";

export type StepRisk = "low" | "medium" | "high";

export type VerifierSignal = "pass" | "fail" | "uncertain";

export interface StepContextMetadata {
	stepId?: string;
	stepIndex?: number;
	stepKind?: StepKind;
	agentRole?: string;
	stepRisk?: StepRisk;
	irreversible?: boolean;
	conversationTurns?: number;
	recentToolCalls?: ToolUseContextSummary[];
	recentFailures?: number;
	lastVerifier?: VerifierSignal;
	escalationCount?: number;
	priorModelSelector?: string;
	stablePrefixHash?: string;
	estimatedCacheHit?: boolean;
	providerAffinity?: string;
	remainingTokens?: number;
}

export interface StepContext {
	request: RequestInput;
	step: {
		id?: string;
		index?: number;
		kind?: StepKind;
		agentRole?: string;
		risk?: StepRisk;
		irreversible?: boolean;
	};
	trajectory?: {
		conversationTurns?: number;
		recentToolCalls?: ToolUseContextSummary[];
		recentFailures?: number;
		lastVerifier?: VerifierSignal;
		escalationCount?: number;
		priorModelSelector?: string;
	};
	cache?: {
		stablePrefixHash?: string;
		estimatedCacheHit?: boolean;
		providerAffinity?: string;
	};
	budgets?: {
		latencyMs?: number;
		costUsd?: number;
		remainingTokens?: number;
	};
}


export interface RouterFeatureVector {
	taskType: TaskType;
	taskScores: Record<TaskType, number>;
	approxInputTokens: number;
	approxOutputTokens: number;
	totalTokenEstimate: number;
	language: string;
	hasCode: boolean;
	hasUrl: boolean;
	hasJsonRequirement: boolean;
	hasStructuredData: boolean;
	hasToolNeed: boolean;
	hasRetrievalNeed: boolean;
	hasMultimodalInput: boolean;
	hasLongContextNeed: boolean;
	reasoningComplexity: number;
	ambiguity: number;
	safetySensitivity: number;
	userTier: string;
	userPreference: Preference;
	latencyBudgetMs?: number;
	costBudgetUsd?: number;
	runtimePressure: number;
	stepKind?: StepKind;
	stepRisk?: StepRisk;
	stepIndex?: number;
	agentRole?: string;
	irreversible?: boolean;
	recentFailures?: number;
	lastVerifier?: VerifierSignal;
	lastVerifierFailed?: boolean;
	escalationCount?: number;
	estimatedCacheHit?: boolean;
	providerAffinity?: string;
	remainingTokens?: number;
	tags: string[];
	signals: string[];
}

export type ModelCapability =
	| "text"
	| "json"
	| "code"
	| "vision"
	| "audio"
	| "long-context"
	| "tools"
	| "reasoning"
	| "safe"
	| "fast"
	| "cheap";

export interface ModelProfile {
	id: string;
	selector: string;
	fallbackSelectors?: string[];
	label?: string;
	provider?: string;
	modelId?: string;
	quality: number;
	latencyMsP95: number;
	costPerMillionTokens: number;
	safety: number;
	contextWindow: number;
	maxOutputTokens?: number;
	capabilities: ModelCapability[];
	enabled?: boolean;
	metadata?: Record<string, unknown>;
}

export interface ObjectiveWeights {
	quality: number;
	latency: number;
	cost: number;
	safety: number;
}

export interface PolicyRule {
	name: string;
	description?: string;
	priority?: number;
	enabled?: boolean;
	when: {
		taskType?: TaskType | TaskType[];
		minTokens?: number;
		maxTokens?: number;
		hasCode?: boolean;
		hasJsonRequirement?: boolean;
		hasRetrievalNeed?: boolean;
		hasMultimodalInput?: boolean;
		minReasoningComplexity?: number;
		maxReasoningComplexity?: number;
		minSafetySensitivity?: number;
		userTier?: string | string[];
		preference?: Preference | Preference[];
		tag?: string | string[];
		stepKind?: StepKind | StepKind[];
		stepRisk?: StepRisk | StepRisk[];
		irreversible?: boolean;
		minRecentFailures?: number;
		lastVerifier?: VerifierSignal | VerifierSignal[];
		minEscalationCount?: number;
		estimatedCacheHit?: boolean;
	};
	route: {
		model: string;
		fallback?: string[];
		force?: boolean;
		reason?: string;
	};
}

export interface LearnedPolicyConfig {
	enabled: boolean;
	intercept?: number;
	modelWeights?: Record<string, Record<string, number>>;
	globalWeights?: Record<string, number>;
	minConfidenceToOverride?: number;
}

export interface TelemetryConfig {
	enabled: boolean;
	path?: string;
	sampleRate?: number;
}

export interface TraceCaptureConfig {
	enabled: boolean;
	path?: string;
	includePromptPreview?: boolean;
	maxPromptPreviewChars?: number;
}

export interface ExtensionConfig {
	mode: "recommend" | "try-set-model";
	routeOnInput: boolean;
	notifyOnInput: boolean;
	exposeTools: boolean;
	exposeCommand: boolean;
}

/** Maps classifier labels to eligible candidate tiers. */
export interface TaskSpawnLabelMappings {
	light: "light" | "mid" | "frontier";
	mid: "light" | "mid" | "frontier";
	heavy: "light" | "mid" | "frontier";
}

/**
 * Optional spawn-only Qwen classifier settings.
 * `enabled` defaults to false; task-spawn enablement never turns on per-input routing.
 */
export interface TaskSpawnConfig {
	enabled: boolean;
	endpoint?: string;
	timeoutMs?: number;
	systemPrompt?: string;
	model?: string;
	labelMappings?: TaskSpawnLabelMappings;
}

export interface RouterConfig {
	version: number;
	objectives: ObjectiveWeights;
	models: Record<string, ModelProfile>;
	rules: PolicyRule[];
	learned?: LearnedPolicyConfig;
	telemetry?: TelemetryConfig;
	traces?: TraceCaptureConfig;
	toolCapture?: ToolCaptureConfig;
	extension?: ExtensionConfig;
	taskSpawn?: TaskSpawnConfig;
	validation?: {
		unsafePatternHints?: string[];
		maxRepairAttempts?: number;
	};
}

export interface CandidateScore {
	modelId: string;
	selector: string;
	score: number;
	normalized: {
		quality: number;
		latency: number;
		cost: number;
		safety: number;
		fit: number;
		learned: number;
	};
	reasons: string[];
	rejected?: boolean;
	rejectionReason?: string;
}

export interface RouteDecision {
	requestId: string;
	selectedModel: string;
	selector: string;
	provider?: string;
	modelId?: string;
	confidence: number;
	objectiveWeights: ObjectiveWeights;
	taskType: TaskType;
	features: RouterFeatureVector;
	fallbackChain: string[];
	fallbackSelectors: string[];
	validationPlan: ValidationPlan;
	reasons: string[];
	scores: CandidateScore[];
	ruleMatches: string[];
	createdAt: string;
}

export type ValidationRequirement =
	| { type: "json"; schema?: JsonSchemaLike }
	| { type: "required_fields"; fields: string[] }
	| { type: "regex"; pattern: string; flags?: string }
	| { type: "no_unsafe_content" }
	| { type: "non_empty" }
	| { type: "max_length"; characters: number };

export interface ValidationPlan {
	requirements: ValidationRequirement[];
	onFailure: "retry-same" | "repair" | "escalate" | "block";
	maxAttempts: number;
}

export interface ValidationIssue {
	type: string;
	message: string;
	path?: string;
}

export interface ValidationResult {
	passed: boolean;
	issues: ValidationIssue[];
	parsedJson?: unknown;
	recommendedAction?: "accept" | "retry-same" | "repair" | "escalate" | "block";
}

export type ToolUsePhase = "requested" | "started" | "completed" | "failed" | "skipped";

export type ToolPayloadCaptureMode = "none" | "metadata" | "summary" | "redacted" | "full";

export interface ToolCaptureConfig {
	enabled: boolean;
	path?: string;
	sampleRate?: number;
	/** How much of tool arguments to retain. Defaults to redacted previews. */
	captureArgs?: ToolPayloadCaptureMode;
	/** How much of tool results/errors to retain. Defaults to summary previews. */
	captureResults?: ToolPayloadCaptureMode;
	/** Maximum retained characters per args/result/error payload after redaction/summarization. */
	maxPayloadChars?: number;
	/** Maximum characters in the context-saving summary. */
	maxSummaryChars?: number;
	/** Keys that should always be replaced with [REDACTED]. Matching is case-insensitive. */
	redactKeys?: string[];
	/** Regex source strings applied to serialized payloads before persistence. */
	redactPatterns?: string[];
	/** Skip telemetry for these tool names. Supports exact names and '*' suffix prefixes. */
	ignoredToolNames?: string[];
	/** Also emit tool-use records into the primary telemetry stream. */
	emitToTelemetry?: boolean;
	/** Soft budget for summaries retained in live context. */
	contextBudgetTokens?: number;
	/** Include compact supervised examples in captured records. */
	includeTrainingHints?: boolean;
}

export interface ToolPayloadSnapshot {
	mode: ToolPayloadCaptureMode;
	kind: "empty" | "text" | "json" | "array" | "binary" | "error" | "unknown";
	tokenEstimate: number;
	characterEstimate: number;
	keys?: string[];
	preview?: string;
	hash?: string;
	truncated: boolean;
	redacted: boolean;
}

export interface ToolUseFeatures {
	namespace?: string;
	operation: string;
	phase: ToolUsePhase;
	status: "pending" | "success" | "failure" | "skipped" | "unknown";
	argumentKeys: string[];
	hasUrl: boolean;
	hasFileRef: boolean;
	hasSecretLikeValue: boolean;
	argTokenEstimate: number;
	resultTokenEstimate: number;
	errorTokenEstimate: number;
	totalPayloadTokens: number;
	resultKind?: ToolPayloadSnapshot["kind"];
	contextPressure: number;
}

export interface ToolUseContextSummary {
	text: string;
	tokenEstimate: number;
	savedContextTokensEstimate: number;
	keepFields: string[];
	droppedFields: string[];
}

export interface ToolRoutingTrainingHint {
	useTool: boolean;
	toolName: string;
	namespace?: string;
	phase: ToolUsePhase;
	success: boolean | null;
	contextPolicy:
		| "metadata_only"
		| "summary_only"
		| "redacted_preview"
		| "full_payload"
		| "drop_raw_result_keep_summary";
	expectedSavedContextTokens: number;
	confidence: number;
}

export interface ToolUseCaptureInput {
	requestId?: string;
	conversationId?: string;
	turnId?: string;
	messageId?: string;
	toolCallId?: string;
	toolName: string;
	namespace?: string;
	phase?: ToolUsePhase;
	args?: unknown;
	result?: unknown;
	error?: unknown;
	availableTools?: string[];
	promptPreview?: string;
	startedAt?: string;
	endedAt?: string;
	latencyMs?: number;
	timestamp?: string;
	route?: Pick<RouteDecision, "selectedModel" | "selector" | "confidence" | "taskType" | "reasons" | "fallbackChain">;
	runtime?: RuntimeState;
	metadata?: Record<string, unknown>;
}

export interface ToolUseCaptureRecord {
	requestId: string;
	conversationId?: string;
	turnId?: string;
	messageId?: string;
	toolCallId: string;
	timestamp: string;
	toolName: string;
	namespace?: string;
	phase: ToolUsePhase;
	durationMs?: number;
	args?: ToolPayloadSnapshot;
	result?: ToolPayloadSnapshot;
	error?: ToolPayloadSnapshot;
	availableTools?: string[];
	promptPreview?: string;
	route?: ToolUseCaptureInput["route"];
	features: ToolUseFeatures;
	contextSummary: ToolUseContextSummary;
	trainingHint?: ToolRoutingTrainingHint;
	metadata?: Record<string, unknown>;
}

export interface ToolRoutingTrainingExample {
	version: number;
	id: string;
	createdAt: string;
	input: {
		promptPreview?: string;
		availableTools?: string[];
		toolFeatures: ToolUseFeatures;
		argsPreview?: string;
		route?: ToolUseCaptureInput["route"];
		contextSummary: string;
	};
	label: ToolRoutingTrainingHint;
	metadata?: Record<string, unknown>;
}
export interface ModelTrace {
	provider?: string;
	modelId?: string;
	selector: string;
	fallbackSelectors: string[];
	candidateScores: CandidateScore[];
}

export interface ContextTrace {
	promptPreview?: string;
	approxInputTokens?: number;
	approxOutputTokens?: number;
	totalTokenEstimate?: number;
	attachmentCount?: number;
	conversationTurns?: number;
	stepKind?: StepKind;
	stepRisk?: StepRisk;
	stepIndex?: number;
	agentRole?: string;
	irreversible?: boolean;
	recentFailures?: number;
	lastVerifier?: VerifierSignal;
	escalationCount?: number;
	recentToolCallCount?: number;
	estimatedCacheHit?: boolean;
	stablePrefixHash?: string;
	providerAffinity?: string;
}

export interface TelemetryRecord {
	requestId: string;
	timestamp: string;
	kind: "decision" | "validation" | "fallback" | "outcome" | "tool_use" | "tool_training_example" | "task_spawn";
	route?: Pick<RouteDecision, "selectedModel" | "selector" | "confidence" | "taskType" | "reasons" | "fallbackChain">;
	features?: Partial<RouterFeatureVector>;
	validation?: ValidationResult;
	toolUse?: ToolUseCaptureRecord;
	toolTrainingExample?: ToolRoutingTrainingExample;
	modelTrace?: ModelTrace;
	contextTrace?: ContextTrace;
	metrics?: {
		latencyMs?: number;
		inputTokens?: number;
		outputTokens?: number;
		estimatedCostUsd?: number;
		retries?: number;
		success?: boolean;
		userRating?: number;
	};
	metadata?: Record<string, unknown>;
}

export type JsonSchemaLike = {
	type?: string | string[];
	required?: string[];
	properties?: Record<string, JsonSchemaLike>;
	items?: JsonSchemaLike;
	enum?: unknown[];
	additionalProperties?: boolean | JsonSchemaLike;
	[key: string]: unknown;
};
