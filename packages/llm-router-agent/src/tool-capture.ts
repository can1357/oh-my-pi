import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { estimateTokens } from "./features.js";
import { writeTelemetry } from "./telemetry.js";
import type {
	RouterConfig,
	TelemetryRecord,
	ToolCaptureConfig,
	ToolPayloadCaptureMode,
	ToolPayloadSnapshot,
	ToolRoutingTrainingExample,
	ToolRoutingTrainingHint,
	ToolUseCaptureInput,
	ToolUseCaptureRecord,
	ToolUseContextSummary,
	ToolUseFeatures,
	ToolUsePhase,
} from "./types.js";

interface NormalizedToolCaptureConfig extends Required<Omit<ToolCaptureConfig, "path">> {
	path: string;
}

const DEFAULT_REDACT_KEYS = [
	"api_key",
	"apikey",
	"authorization",
	"cookie",
	"password",
	"secret",
	"token",
	"access_token",
	"refresh_token",
	"private_key",
	"client_secret",
];

const DEFAULT_REDACT_PATTERNS = [
	"Bearer\\s+[A-Za-z0-9._~+/=-]+",
	"sk-[A-Za-z0-9]{16,}",
	"(api[_-]?key|token|secret|password)\\s*[:=]\\s*[^\\s,}]+",
];

const SECRET_LIKE_VALUE = /(?:bearer\s+|sk-[a-z0-9]|api[_-]?key\s*[:=]|token\s*[:=]|secret\s*[:=]|password\s*[:=])/i;
const URL_RE = /https?:\/\/|www\./i;
const FILE_REF_RE = /\bfile_[a-z0-9]+\b|sandbox:|\/mnt\/data|attachment_id|file_id|filename/i;

export function normalizeToolCaptureConfig(config: RouterConfig): NormalizedToolCaptureConfig {
	const toolCapture = config.toolCapture ?? { enabled: false };
	return {
		enabled: toolCapture.enabled ?? false,
		path: toolCapture.path ?? ".llm-router/tool-use.jsonl",
		sampleRate: clamp(toolCapture.sampleRate ?? 1, 0, 1),
		captureArgs: toolCapture.captureArgs ?? "redacted",
		captureResults: toolCapture.captureResults ?? "summary",
		maxPayloadChars: Math.max(0, toolCapture.maxPayloadChars ?? 2_000),
		maxSummaryChars: Math.max(0, toolCapture.maxSummaryChars ?? 900),
		redactKeys: toolCapture.redactKeys ?? DEFAULT_REDACT_KEYS,
		redactPatterns: toolCapture.redactPatterns ?? DEFAULT_REDACT_PATTERNS,
		ignoredToolNames: toolCapture.ignoredToolNames ?? [],
		emitToTelemetry: toolCapture.emitToTelemetry ?? false,
		contextBudgetTokens: Math.max(32, toolCapture.contextBudgetTokens ?? 400),
		includeTrainingHints: toolCapture.includeTrainingHints ?? true,
	};
}

export function shouldCaptureToolUse(config: RouterConfig, input: Pick<ToolUseCaptureInput, "toolName">): boolean {
	const capture = normalizeToolCaptureConfig(config);
	if (!capture.enabled) return false;
	if (!input.toolName.trim()) return false;
	return !matchesIgnoredTool(input.toolName, capture.ignoredToolNames);
}

export function createToolUseCaptureRecord(config: RouterConfig, input: ToolUseCaptureInput): ToolUseCaptureRecord {
	const capture = normalizeToolCaptureConfig(config);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const phase = input.phase ?? inferPhase(input);
	const toolName = input.toolName.trim() || "unknown_tool";
	const parsedName = parseToolName(toolName);
	const namespace = input.namespace ?? parsedName.namespace;
	const operation = parsedName.operation;
	const metadataRequestId = typeof input.metadata?.requestId === "string" ? input.metadata.requestId : undefined;
	const requestId = input.requestId ?? metadataRequestId ?? `req_${randomUUID()}`;
	const toolCallId =
		input.toolCallId ?? `tool_${hashString(`${requestId}:${toolName}:${timestamp}:${Math.random()}`).slice(0, 16)}`;

	const args =
		input.args === undefined ? undefined : snapshotPayload(input.args, capture.captureArgs, capture, "unknown");
	const result =
		input.result === undefined
			? undefined
			: snapshotPayload(input.result, capture.captureResults, capture, "unknown");
	const error =
		input.error === undefined ? undefined : snapshotPayload(input.error, capture.captureResults, capture, "error");
	const durationMs = input.latencyMs ?? durationFromTimes(input.startedAt, input.endedAt);
	const features = buildToolUseFeatures({
		namespace,
		operation,
		phase,
		args,
		result,
		error,
		runtimePressure: input.runtime?.queueDepth ? Math.min(1, input.runtime.queueDepth / 100) : 0,
	});
	const contextSummary = buildContextSummary({
		toolName,
		namespace,
		phase,
		durationMs,
		args,
		result,
		error,
		features,
		maxSummaryChars: capture.maxSummaryChars,
		contextBudgetTokens: capture.contextBudgetTokens,
	});
	const trainingHint = capture.includeTrainingHints
		? buildTrainingHint(toolName, namespace, phase, contextSummary, capture, Boolean(error))
		: undefined;

	return {
		requestId,
		conversationId: input.conversationId,
		turnId: input.turnId,
		messageId: input.messageId,
		toolCallId,
		timestamp,
		toolName,
		namespace,
		phase,
		durationMs,
		args,
		result,
		error,
		availableTools: input.availableTools,
		promptPreview: input.promptPreview
			? truncateText(redactString(input.promptPreview, capture).text, capture.maxSummaryChars).text
			: undefined,
		route: input.route,
		features,
		contextSummary,
		trainingHint,
		metadata: input.metadata,
	};
}

export async function captureToolUse(
	config: RouterConfig,
	input: ToolUseCaptureInput,
	metadata: Record<string, unknown> = {},
): Promise<ToolUseCaptureRecord | undefined> {
	if (!shouldCaptureToolUse(config, input)) return undefined;
	const record = createToolUseCaptureRecord(config, {
		...input,
		metadata: { ...(input.metadata ?? {}), ...metadata },
	});
	await writeToolUseCapture(config, record);
	return record;
}

export async function writeToolUseCapture(config: RouterConfig, record: ToolUseCaptureRecord): Promise<void> {
	const capture = normalizeToolCaptureConfig(config);
	if (!capture.enabled) return;
	if (Math.random() > capture.sampleRate) return;
	await appendJsonl(capture.path, record);
	if (capture.emitToTelemetry) {
		await writeTelemetry(config, toolUseTelemetry(record));
	}
}

export function toolUseTelemetry(record: ToolUseCaptureRecord): TelemetryRecord {
	return {
		requestId: record.requestId,
		timestamp: record.timestamp,
		kind: "tool_use",
		route: record.route,
		toolUse: record,
		metrics: {
			latencyMs: record.durationMs,
			inputTokens: record.features.argTokenEstimate,
			outputTokens: record.features.resultTokenEstimate,
			success:
				record.features.status === "success" ? true : record.features.status === "failure" ? false : undefined,
		},
		metadata: record.metadata,
	};
}

export class ToolUseCaptureLayer {
	private inFlight = new Map<string, { input: ToolUseCaptureInput; startedAt: string; startedMs: number }>();

	constructor(private config: RouterConfig) {}

	setConfig(config: RouterConfig): void {
		this.config = config;
	}

	async record(
		input: ToolUseCaptureInput,
		metadata: Record<string, unknown> = {},
	): Promise<ToolUseCaptureRecord | undefined> {
		return captureToolUse(this.config, input, metadata);
	}

	async start(input: Omit<ToolUseCaptureInput, "phase">): Promise<ToolUseCaptureRecord | undefined> {
		const startedAt = input.startedAt ?? new Date().toISOString();
		const toolCallId = input.toolCallId ?? `tool_${randomUUID()}`;
		const startInput: ToolUseCaptureInput = {
			...input,
			toolCallId,
			phase: "started",
			startedAt,
			timestamp: startedAt,
		};
		this.inFlight.set(toolCallId, { input: startInput, startedAt, startedMs: Date.now() });
		return this.record(startInput);
	}

	async complete(
		toolCallId: string,
		input: Partial<ToolUseCaptureInput> = {},
	): Promise<ToolUseCaptureRecord | undefined> {
		const active = this.inFlight.get(toolCallId);
		this.inFlight.delete(toolCallId);
		const base = active?.input ?? { toolName: input.toolName ?? "unknown_tool", toolCallId };
		return this.record({
			...base,
			...input,
			toolCallId,
			phase: "completed",
			startedAt: input.startedAt ?? active?.startedAt,
			endedAt: input.endedAt ?? new Date().toISOString(),
			latencyMs: input.latencyMs ?? (active ? Date.now() - active.startedMs : undefined),
		});
	}

	async fail(toolCallId: string, input: Partial<ToolUseCaptureInput> = {}): Promise<ToolUseCaptureRecord | undefined> {
		const active = this.inFlight.get(toolCallId);
		this.inFlight.delete(toolCallId);
		const base = active?.input ?? { toolName: input.toolName ?? "unknown_tool", toolCallId };
		return this.record({
			...base,
			...input,
			toolCallId,
			phase: "failed",
			startedAt: input.startedAt ?? active?.startedAt,
			endedAt: input.endedAt ?? new Date().toISOString(),
			latencyMs: input.latencyMs ?? (active ? Date.now() - active.startedMs : undefined),
		});
	}

	wrapTool<TArgs extends unknown[], TResult>(
		toolName: string,
		handler: (...args: TArgs) => TResult | Promise<TResult>,
		options: {
			namespace?: string;
			requestId?: string;
			conversationId?: string;
			turnId?: string;
			availableTools?: string[];
			promptPreview?: string;
			metadata?: Record<string, unknown>;
			getArgsPayload?: (...args: TArgs) => unknown;
			getResultPayload?: (result: TResult) => unknown;
		} = {},
	): (...args: TArgs) => Promise<TResult> {
		return async (...args: TArgs) => {
			const toolCallId = `tool_${randomUUID()}`;
			const startedAt = new Date().toISOString();
			await this.record({
				toolName,
				namespace: options.namespace,
				requestId: options.requestId,
				conversationId: options.conversationId,
				turnId: options.turnId,
				toolCallId,
				phase: "started",
				startedAt,
				timestamp: startedAt,
				args: options.getArgsPayload ? options.getArgsPayload(...args) : args,
				availableTools: options.availableTools,
				promptPreview: options.promptPreview,
				metadata: options.metadata,
			});
			const startedMs = Date.now();
			try {
				const result = await handler(...args);
				await this.record({
					toolName,
					namespace: options.namespace,
					requestId: options.requestId,
					conversationId: options.conversationId,
					turnId: options.turnId,
					toolCallId,
					phase: "completed",
					startedAt,
					endedAt: new Date().toISOString(),
					latencyMs: Date.now() - startedMs,
					args: options.getArgsPayload ? options.getArgsPayload(...args) : args,
					result: options.getResultPayload ? options.getResultPayload(result) : result,
					availableTools: options.availableTools,
					promptPreview: options.promptPreview,
					metadata: options.metadata,
				});
				return result;
			} catch (error) {
				await this.record({
					toolName,
					namespace: options.namespace,
					requestId: options.requestId,
					conversationId: options.conversationId,
					turnId: options.turnId,
					toolCallId,
					phase: "failed",
					startedAt,
					endedAt: new Date().toISOString(),
					latencyMs: Date.now() - startedMs,
					args: options.getArgsPayload ? options.getArgsPayload(...args) : args,
					error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
					availableTools: options.availableTools,
					promptPreview: options.promptPreview,
					metadata: options.metadata,
				});
				throw error;
			}
		};
	}
}

export function formatToolUseRecord(record: ToolUseCaptureRecord): string {
	const saved =
		record.contextSummary.savedContextTokensEstimate > 0
			? ` saved≈${record.contextSummary.savedContextTokensEstimate}t`
			: "";
	return [
		`tool=${record.toolName}`,
		`phase=${record.phase}`,
		`status=${record.features.status}`,
		record.durationMs !== undefined ? `latency=${record.durationMs}ms` : undefined,
		`payload≈${record.features.totalPayloadTokens}t`,
		saved,
		`summary=${record.contextSummary.text}`,
	]
		.filter(Boolean)
		.join("\n");
}

export function toolUseRecordToTrainingExample(record: ToolUseCaptureRecord): ToolRoutingTrainingExample {
	const label =
		record.trainingHint ??
		buildTrainingHint(
			record.toolName,
			record.namespace,
			record.phase,
			record.contextSummary,
			{
				...normalizeToolCaptureConfig({
					version: 1,
					objectives: { quality: 1, latency: 0, cost: 0, safety: 0 },
					models: {},
					rules: [],
					toolCapture: { enabled: true },
				}),
			},
			record.features.status === "failure",
		);
	return {
		version: 1,
		id: `${record.toolCallId}:${record.phase}`,
		createdAt: record.timestamp,
		input: {
			promptPreview: record.promptPreview,
			availableTools: record.availableTools,
			toolFeatures: record.features,
			argsPreview: record.args?.preview,
			route: record.route,
			contextSummary: record.contextSummary.text,
		},
		label,
		metadata: record.metadata,
	};
}

export async function exportToolRoutingExamplesFromTelemetry(
	inputPath: string,
	options: { outputPath?: string; includeFailures?: boolean; minSavedContextTokens?: number } = {},
): Promise<{ read: number; exported: number; outputPath?: string; examples: ToolRoutingTrainingExample[] }> {
	const text = await readFile(inputPath, "utf8");
	const examples: ToolRoutingTrainingExample[] = [];
	let read = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const record = parseToolUseRecord(line);
		if (!record) continue;
		read += 1;
		if (!options.includeFailures && record.features.status === "failure") continue;
		if ((options.minSavedContextTokens ?? 0) > record.contextSummary.savedContextTokensEstimate) continue;
		examples.push(toolUseRecordToTrainingExample(record));
	}
	if (options.outputPath) {
		await mkdir(nodePath.dirname(options.outputPath), { recursive: true });
		await writeFile(
			options.outputPath,
			examples.map(example => JSON.stringify(example)).join("\n") + (examples.length ? "\n" : ""),
			"utf8",
		);
	}
	return { read, exported: examples.length, outputPath: options.outputPath, examples };
}

export async function summarizeToolUseTelemetry(path: string): Promise<{
	total: number;
	byTool: Record<string, number>;
	byPhase: Record<ToolUsePhase, number>;
	failures: number;
	savedContextTokensEstimate: number;
}> {
	const text = await readFile(path, "utf8");
	const byTool: Record<string, number> = {};
	const byPhase: Record<ToolUsePhase, number> = { requested: 0, started: 0, completed: 0, failed: 0, skipped: 0 };
	let total = 0;
	let failures = 0;
	let savedContextTokensEstimate = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const record = parseToolUseRecord(line);
		if (!record) continue;
		total += 1;
		byTool[record.toolName] = (byTool[record.toolName] ?? 0) + 1;
		byPhase[record.phase] += 1;
		if (record.features.status === "failure") failures += 1;
		savedContextTokensEstimate += record.contextSummary.savedContextTokensEstimate;
	}
	return { total, byTool, byPhase, failures, savedContextTokensEstimate };
}

export function parseToolUseRecord(line: string): ToolUseCaptureRecord | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		if (!isRecord(parsed)) return undefined;
		if (parsed.kind === "tool_use" && isRecord(parsed.toolUse))
			return parsed.toolUse as unknown as ToolUseCaptureRecord;
		if (typeof parsed.toolName === "string" && isRecord(parsed.features) && isRecord(parsed.contextSummary))
			return parsed as unknown as ToolUseCaptureRecord;
		return undefined;
	} catch {
		return undefined;
	}
}

function snapshotPayload(
	value: unknown,
	mode: ToolPayloadCaptureMode,
	capture: NormalizedToolCaptureConfig,
	forcedKind: ToolPayloadSnapshot["kind"],
): ToolPayloadSnapshot {
	const normalized = normalizePayload(value, capture.redactKeys);
	const raw = safeStringify(normalized.value);
	const redacted = redactString(raw, capture);
	const kind = forcedKind === "unknown" ? inferKind(value) : forcedKind;
	const tokenEstimate = estimateTokens(raw);
	const characterEstimate = raw.length;
	const keys = getTopLevelKeys(value);
	const hash = mode === "none" ? undefined : hashString(redacted.text);
	const truncatedPreview = truncateText(
		buildPreview(redacted.text, mode, capture.maxPayloadChars),
		capture.maxPayloadChars,
	);
	return {
		mode,
		kind,
		tokenEstimate,
		characterEstimate,
		keys,
		preview: mode === "none" || mode === "metadata" ? undefined : truncatedPreview.text,
		hash,
		truncated: truncatedPreview.truncated,
		redacted: normalized.redacted || redacted.redacted,
	};
}

function buildPreview(text: string, mode: ToolPayloadCaptureMode, maxChars: number): string {
	if (mode === "none" || mode === "metadata") return "";
	if (mode === "summary") return summarizeSerializedPayload(text, maxChars);
	return text;
}

function summarizeSerializedPayload(text: string, maxChars: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxChars) return compact;
	const head = compact.slice(0, Math.max(0, Math.floor(maxChars * 0.72))).trim();
	const tail = compact.slice(Math.max(0, compact.length - Math.floor(maxChars * 0.2))).trim();
	return `${head} … ${tail}`;
}

function buildToolUseFeatures(input: {
	namespace?: string;
	operation: string;
	phase: ToolUsePhase;
	args?: ToolPayloadSnapshot;
	result?: ToolPayloadSnapshot;
	error?: ToolPayloadSnapshot;
	runtimePressure: number;
}): ToolUseFeatures {
	const combined = [input.args?.preview, input.result?.preview, input.error?.preview].filter(Boolean).join("\n");
	const argTokens = input.args?.tokenEstimate ?? 0;
	const resultTokens = input.result?.tokenEstimate ?? 0;
	const errorTokens = input.error?.tokenEstimate ?? 0;
	return {
		namespace: input.namespace,
		operation: input.operation,
		phase: input.phase,
		status: statusFromPhase(input.phase, Boolean(input.error)),
		argumentKeys: input.args?.keys ?? [],
		hasUrl: URL_RE.test(combined),
		hasFileRef: FILE_REF_RE.test(combined),
		hasSecretLikeValue: SECRET_LIKE_VALUE.test(combined),
		argTokenEstimate: argTokens,
		resultTokenEstimate: resultTokens,
		errorTokenEstimate: errorTokens,
		totalPayloadTokens: argTokens + resultTokens + errorTokens,
		resultKind: input.result?.kind,
		contextPressure: clamp(input.runtimePressure, 0, 1),
	};
}

function buildContextSummary(input: {
	toolName: string;
	namespace?: string;
	phase: ToolUsePhase;
	durationMs?: number;
	args?: ToolPayloadSnapshot;
	result?: ToolPayloadSnapshot;
	error?: ToolPayloadSnapshot;
	features: ToolUseFeatures;
	maxSummaryChars: number;
	contextBudgetTokens: number;
}): ToolUseContextSummary {
	const parts = [
		`Tool ${input.toolName} ${input.phase}`,
		input.durationMs !== undefined ? `in ${input.durationMs}ms` : undefined,
		input.args?.keys?.length ? `args: ${input.args.keys.slice(0, 12).join(", ")}` : undefined,
		input.result?.preview ? `result: ${input.result.preview}` : undefined,
		input.error?.preview ? `error: ${input.error.preview}` : undefined,
	]
		.filter(Boolean)
		.join("; ");
	const truncated = truncateText(parts, input.maxSummaryChars);
	const summaryTokens = estimateTokens(truncated.text);
	const saved = Math.max(0, input.features.totalPayloadTokens - summaryTokens);
	const droppedFields = [];
	if ((input.args?.tokenEstimate ?? 0) > (input.args?.preview ? estimateTokens(input.args.preview) : 0))
		droppedFields.push("raw_args");
	if ((input.result?.tokenEstimate ?? 0) > (input.result?.preview ? estimateTokens(input.result.preview) : 0))
		droppedFields.push("raw_result");
	if ((input.error?.tokenEstimate ?? 0) > (input.error?.preview ? estimateTokens(input.error.preview) : 0))
		droppedFields.push("raw_error");
	return {
		text: truncateText(truncated.text, Math.max(80, input.contextBudgetTokens * 4)).text,
		tokenEstimate: summaryTokens,
		savedContextTokensEstimate: saved,
		keepFields: ["toolName", "phase", "status", "argumentKeys", "preview", "hash", "latency"],
		droppedFields,
	};
}

function buildTrainingHint(
	toolName: string,
	namespace: string | undefined,
	phase: ToolUsePhase,
	contextSummary: ToolUseContextSummary,
	capture: NormalizedToolCaptureConfig,
	failed: boolean,
): ToolRoutingTrainingHint {
	const success = phase === "failed" || failed ? false : phase === "completed" ? true : null;
	const contextPolicy =
		capture.captureResults === "none" || capture.captureResults === "metadata"
			? "metadata_only"
			: capture.captureResults === "summary"
				? "drop_raw_result_keep_summary"
				: capture.captureResults === "redacted"
					? "redacted_preview"
					: "full_payload";
	return {
		useTool: phase !== "skipped",
		toolName,
		namespace,
		phase,
		success,
		contextPolicy,
		expectedSavedContextTokens: contextSummary.savedContextTokensEstimate,
		confidence: success === true ? 0.85 : success === false ? 0.35 : 0.55,
	};
}

function inferPhase(input: ToolUseCaptureInput): ToolUsePhase {
	if (input.error !== undefined) return "failed";
	if (input.result !== undefined) return "completed";
	return "requested";
}

function statusFromPhase(phase: ToolUsePhase, hasError: boolean): ToolUseFeatures["status"] {
	if (hasError || phase === "failed") return "failure";
	if (phase === "completed") return "success";
	if (phase === "skipped") return "skipped";
	if (phase === "requested" || phase === "started") return "pending";
	return "unknown";
}

function durationFromTimes(startedAt?: string, endedAt?: string): number | undefined {
	if (!startedAt || !endedAt) return undefined;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
	return Math.max(0, end - start);
}

function parseToolName(toolName: string): { namespace?: string; operation: string } {
	const match = toolName.match(/^(.+?)[.:/](.+)$/);
	if (!match) return { operation: toolName };
	const namespace = match[1];
	const operation = match[2] ?? toolName;
	return namespace ? { namespace, operation } : { operation };
}

function matchesIgnoredTool(toolName: string, ignored: string[]): boolean {
	return ignored.some(pattern => {
		if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
		return toolName === pattern;
	});
}

function normalizePayload(
	value: unknown,
	redactKeys: string[],
	depth = 0,
	seen = new WeakSet<object>(),
): { value: unknown; redacted: boolean } {
	if (value === undefined) return { value: undefined, redacted: false };
	if (value === null || typeof value === "number" || typeof value === "boolean") return { value, redacted: false };
	if (typeof value === "bigint") return { value: value.toString(), redacted: false };
	if (typeof value === "function") return { value: `[Function ${value.name || "anonymous"}]`, redacted: false };
	if (typeof value === "string") {
		if (SECRET_LIKE_VALUE.test(value)) return { value: "[REDACTED]", redacted: true };
		return { value, redacted: false };
	}
	if (typeof value !== "object") return { value: String(value), redacted: false };
	if (seen.has(value)) return { value: "[Circular]", redacted: false };
	seen.add(value);
	if (depth > 6) return { value: "[MaxDepth]", redacted: false };
	if (Array.isArray(value)) {
		let redacted = false;
		const items = value.slice(0, 200).map(item => {
			const normalized = normalizePayload(item, redactKeys, depth + 1, seen);
			redacted ||= normalized.redacted;
			return normalized.value;
		});
		if (value.length > 200) items.push(`[Truncated ${value.length - 200} items]`);
		return { value: items, redacted };
	}
	const entries = Object.entries(value as Record<string, unknown>);
	const out: Record<string, unknown> = {};
	let redacted = false;
	const redactSet = new Set(redactKeys.map(key => key.toLowerCase()));
	for (const [key, child] of entries.slice(0, 200)) {
		if (redactSet.has(key.toLowerCase())) {
			out[key] = "[REDACTED]";
			redacted = true;
			continue;
		}
		const normalized = normalizePayload(child, redactKeys, depth + 1, seen);
		redacted ||= normalized.redacted;
		out[key] = normalized.value;
	}
	if (entries.length > 200) out.__truncatedKeys = entries.length - 200;
	return { value: out, redacted };
}

function redactString(
	text: string,
	capture: Pick<NormalizedToolCaptureConfig, "redactPatterns">,
): { text: string; redacted: boolean } {
	let redacted = false;
	let output = text;
	for (const pattern of capture.redactPatterns) {
		try {
			const re = new RegExp(pattern, "gi");
			const next = output.replace(re, () => {
				redacted = true;
				return "[REDACTED]";
			});
			output = next;
		} catch {
			// Ignore malformed operator-supplied patterns instead of breaking routing.
		}
	}
	return { text: output, redacted };
}

function safeStringify(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function inferKind(value: unknown): ToolPayloadSnapshot["kind"] {
	if (value === undefined || value === null || value === "") return "empty";
	if (Array.isArray(value)) return "array";
	if (value instanceof Error) return "error";
	if (typeof value === "string") return "text";
	if (typeof value === "object") return "json";
	if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return "unknown";
	return "text";
}

function getTopLevelKeys(value: unknown): string[] | undefined {
	if (!isRecord(value)) return undefined;
	return Object.keys(value).slice(0, 64);
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (maxChars <= 0) return { text: "", truncated: text.length > 0 };
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

function hashString(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
	await mkdir(nodePath.dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}
