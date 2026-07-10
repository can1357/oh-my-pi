/**
 * Privacy-aware coding-trajectory capture for {@link OperationalStore}.
 *
 * Persists structural model/tool/context/patch/verification/outcome signals only.
 * Never writes raw prompts, file contents, tool argument values, secrets, patch
 * bodies, diffs, or full command strings.
 */
import type { AgentMessage, AgentRunSummary } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { OperationalStore } from "./store";
import type { JsonObject, JsonValue, TrajectoryEventKind } from "./types";

const CONTEXT_TOOLS = new Set(["read", "search", "lsp", "ast_grep", "find"]);
const PATCH_TOOLS = new Set(["edit", "write", "ast_edit", "apply_patch"]);
const VERIFICATION_TOOLS = new Set(["bash", "eval"]);

const MAX_SUMMARY_CHARS = 280;
const MAX_PATHS = 32;
const MAX_ARGUMENT_KEYS = 64;
const MAX_STRING_META = 240;

const SECRET_KEY_RE =
	/(api[_-]?key|apikey|authorization|auth|cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|bearer)/i;
const SECRET_VALUE_RE =
	/(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/i;

const TEST_COMMAND_RE =
	/\b(?:bun\s+test|npm\s+(?:test|run\s+test(?:s)?)|pnpm\s+(?:test|run\s+test(?:s)?)|yarn\s+test|npx\s+(?:vitest|jest|playwright)|vitest|jest|pytest|cargo\s+test|go\s+test|mocha|node\s+--test|playwright\s+test)\b/i;
const TEST_CODE_RE = /\b(?:describe|it|test|expect|assert(?:\.(?:equal|ok|strictEqual))?)\s*\(/;

export type TrajectoryClock = () => number;

export type HumanCorrectionCategory = "rating" | "preference" | "bug" | "instruction" | "other" | (string & {});

export interface RecordModelDecisionInput {
	readonly decision?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly role?: string;
	readonly reasonCodes?: readonly string[];
	readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface RecordContextRetrievalInput {
	readonly toolName: string;
	readonly toolCallId?: string;
	readonly status?: "ok" | "error";
	readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface RecordPatchInput {
	readonly toolName: string;
	readonly toolCallId?: string;
	readonly status?: "ok" | "error";
	readonly paths?: readonly string[];
	readonly filesTouched?: number;
	readonly totalReplacements?: number;
	readonly op?: string;
}

export interface RecordVerificationInput {
	readonly toolName: string;
	readonly toolCallId?: string;
	readonly kind: "test" | "check";
	readonly passed: boolean;
	readonly exitCode?: number;
	readonly durationMs?: number;
}

export interface RecordHumanCorrectionInput {
	readonly category: HumanCorrectionCategory;
	readonly rating?: number;
	readonly summary?: string;
	readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface RecordSkillCandidateInput {
	readonly skillName?: string;
	readonly skillId?: string;
	readonly score?: number;
	readonly selected?: boolean;
	readonly reasonCodes?: readonly string[];
}

export interface RecordOutcomeInput {
	readonly status?: "ok" | "error" | "aborted" | "unknown";
	readonly stopReasons?: readonly string[];
	readonly errorTypes?: readonly string[];
	readonly telemetry?: Readonly<Record<string, JsonValue>>;
}

export interface OperationalTrajectoryRecorderOptions {
	readonly store: OperationalStore;
	readonly sessionId?: string | null;
	readonly jobId?: string | null;
	readonly now?: TrajectoryClock;
	readonly onError?: (error: unknown) => void;
}

interface PendingToolCall {
	readonly toolName: string;
	readonly startedAt: number;
	readonly argumentKeys: readonly string[];
	readonly verificationKind?: "test" | "check";
}

export interface TrajectoryAttachment {
	unsubscribe: () => void;
	dispose: () => void;
}

type UnknownRecord = { readonly [key: string]: unknown };

/**
 * Records privacy-safe coding trajectory events into an {@link OperationalStore}.
 */
export class OperationalTrajectoryRecorder {
	readonly #store: OperationalStore;
	readonly #sessionId: string | null;
	readonly #jobId: string | null;
	readonly #now: TrajectoryClock;
	readonly #onError: ((error: unknown) => void) | undefined;
	readonly #pending = new Map<string, PendingToolCall>();
	#unsubscribe: (() => void) | undefined;
	#disposed = false;

	constructor(options: OperationalTrajectoryRecorderOptions) {
		this.#store = options.store;
		this.#sessionId = options.sessionId ?? null;
		this.#jobId = options.jobId ?? null;
		this.#now = options.now ?? Date.now;
		this.#onError = options.onError;
	}

	recordModelDecision(input: RecordModelDecisionInput): void {
		const payload: JsonObject = {};
		assignString(payload, "decision", input.decision);
		assignString(payload, "provider", input.provider);
		assignString(payload, "model", input.model);
		assignString(payload, "role", input.role);
		assignStringList(payload, "reasonCodes", input.reasonCodes);
		const metadata = sanitizeMetadata(input.metadata);
		if (metadata) payload.metadata = metadata;
		this.#append("model_decision", payload);
	}

	recordContextRetrieval(input: RecordContextRetrievalInput): void {
		const payload: JsonObject = { toolName: input.toolName };
		assignString(payload, "toolCallId", input.toolCallId);
		assignString(payload, "status", input.status);
		const metadata = sanitizeMetadata(input.metadata);
		if (metadata) Object.assign(payload, metadata);
		this.#append("context_retrieval", payload);
	}

	recordPatch(input: RecordPatchInput): void {
		const payload: JsonObject = { toolName: input.toolName };
		assignString(payload, "toolCallId", input.toolCallId);
		assignString(payload, "status", input.status);
		assignString(payload, "op", input.op);
		assignNumber(payload, "filesTouched", input.filesTouched);
		assignNumber(payload, "totalReplacements", input.totalReplacements);
		assignPathList(payload, "paths", input.paths);
		this.#append("patch", payload);
	}

	recordVerification(input: RecordVerificationInput): void {
		const payload: JsonObject = {
			toolName: input.toolName,
			kind: input.kind,
			passed: input.passed,
		};
		assignString(payload, "toolCallId", input.toolCallId);
		assignNumber(payload, "exitCode", input.exitCode);
		assignNumber(payload, "durationMs", input.durationMs);
		this.#append("verification", payload);
	}

	recordHumanCorrection(input: RecordHumanCorrectionInput): void {
		if (SECRET_KEY_RE.test(input.category) || SECRET_VALUE_RE.test(input.category)) {
			throw new Error("human correction category looks secret-like");
		}
		if (input.summary !== undefined && SECRET_VALUE_RE.test(input.summary)) {
			throw new Error("human correction summary looks secret-like");
		}
		const metadata = sanitizeMetadata(input.metadata, { rejectSecrets: true });
		if (input.metadata && metadata === undefined) {
			throw new Error("human correction metadata contains secret-like keys or values");
		}

		const payload: JsonObject = { category: boundString(input.category, MAX_SUMMARY_CHARS) };
		if (input.rating !== undefined && Number.isFinite(input.rating)) {
			payload.rating = input.rating;
		}
		if (input.summary !== undefined) {
			payload.summary = boundString(input.summary, MAX_SUMMARY_CHARS);
		}
		if (metadata) payload.metadata = metadata;
		this.#append("human_correction", payload);
	}

	recordSkillCandidate(input: RecordSkillCandidateInput): void {
		const payload: JsonObject = {};
		assignString(payload, "skillName", input.skillName);
		assignString(payload, "skillId", input.skillId);
		assignNumber(payload, "score", input.score);
		if (input.selected !== undefined) payload.selected = input.selected;
		assignStringList(payload, "reasonCodes", input.reasonCodes);
		this.#append("skill_candidate", payload);
	}

	recordOutcome(input: RecordOutcomeInput): void {
		const payload: JsonObject = {};
		assignString(payload, "status", input.status);
		assignStringList(payload, "stopReasons", input.stopReasons);
		assignStringList(payload, "errorTypes", input.errorTypes);
		const telemetry = sanitizeMetadata(input.telemetry);
		if (telemetry) payload.telemetry = telemetry;
		this.#append("outcome", payload);
	}

	/**
	 * Subscribe to session events. Failures inside the listener are isolated and
	 * reported via `onError` so AgentSession continues uninterrupted.
	 */
	attach(session: Pick<AgentSession, "subscribe">): TrajectoryAttachment {
		this.dispose();
		this.#disposed = false;
		const unsubscribe = session.subscribe(event => {
			try {
				this.#onSessionEvent(event);
			} catch (error) {
				this.#reportError(error);
			}
		});
		this.#unsubscribe = unsubscribe;
		return {
			unsubscribe: () => this.#detachSubscription(),
			dispose: () => this.dispose(),
		};
	}

	dispose(): void {
		this.#detachSubscription();
		this.#pending.clear();
		this.#disposed = true;
	}

	#detachSubscription(): void {
		const unsubscribe = this.#unsubscribe;
		this.#unsubscribe = undefined;
		unsubscribe?.();
	}

	#onSessionEvent(event: AgentSessionEvent): void {
		if (this.#disposed) return;
		switch (event.type) {
			case "tool_execution_start":
				this.#onToolStart(event);
				return;
			case "tool_execution_end":
				this.#onToolEnd(event);
				return;
			case "agent_end":
				this.#onAgentEnd(event);
				return;
			default:
				return;
		}
	}

	#onToolStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): void {
		const argumentKeys = collectArgumentKeys(event.args);
		const verificationKind = inferVerificationKind(event.toolName, event.args);
		this.#pending.set(event.toolCallId, {
			toolName: event.toolName,
			startedAt: this.#now(),
			argumentKeys,
			verificationKind,
		});

		const payload: JsonObject = {
			phase: "start",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			argumentKeys,
		};
		this.#append("tool_decision", payload);
	}

	#onToolEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		const pending = this.#pending.get(event.toolCallId);
		this.#pending.delete(event.toolCallId);
		const durationMs = pending ? Math.max(0, this.#now() - pending.startedAt) : undefined;
		const isError = event.isError === true;
		const status = isError ? "error" : "ok";

		const endPayload: JsonObject = {
			phase: "end",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			status,
		};
		assignNumber(endPayload, "durationMs", durationMs);
		this.#append("tool_decision", endPayload);

		const details = extractResultDetails(event.result);
		if (CONTEXT_TOOLS.has(event.toolName)) {
			this.recordContextRetrieval({
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				status,
				metadata: summarizeContextDetails(event.toolName, details),
			});
		}

		if (PATCH_TOOLS.has(event.toolName)) {
			this.recordPatch({
				...summarizePatchDetails(event.toolName, details, status),
				toolCallId: event.toolCallId,
			});
		}

		const verificationKind = pending?.verificationKind;
		if (verificationKind && VERIFICATION_TOOLS.has(event.toolName)) {
			const exitCode = details ? readFiniteNumber(details.exitCode) : undefined;
			const passed = !isError && (exitCode === undefined || exitCode === 0);
			this.recordVerification({
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				kind: verificationKind,
				passed,
				exitCode,
				durationMs,
			});
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		const stopReasons: string[] = [];
		const errorTypes: string[] = [];
		let status: RecordOutcomeInput["status"] = "unknown";

		for (const message of event.messages) {
			const stop = readAssistantStop(message);
			if (!stop) continue;
			stopReasons.push(stop.stopReason);
			if (stop.hasErrorMessage) errorTypes.push("errorMessage");
			if (stop.stopReason === "error") status = "error";
			else if (stop.stopReason === "aborted" && status !== "error") status = "aborted";
			else if (status === "unknown") status = "ok";
		}

		if (status === "unknown" && stopReasons.length === 0) {
			status = "ok";
		}

		this.recordOutcome({
			status,
			stopReasons: uniqueStrings(stopReasons),
			errorTypes: uniqueStrings(errorTypes),
			telemetry: summarizeTelemetry(event.telemetry),
		});
	}

	#append(kind: TrajectoryEventKind, payload: JsonObject): void {
		try {
			this.#store.appendEvent({
				kind,
				payload,
				sessionId: this.#sessionId,
				jobId: this.#jobId,
			});
		} catch (error) {
			this.#reportError(error);
		}
	}

	#reportError(error: unknown): void {
		try {
			this.#onError?.(error);
		} catch {
			// Never let onError itself break the session listener.
		}
	}
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectArgumentKeys(args: unknown): string[] {
	if (!isRecord(args)) return [];
	return Object.keys(args)
		.filter(key => !SECRET_KEY_RE.test(key))
		.slice(0, MAX_ARGUMENT_KEYS)
		.sort();
}

function inferVerificationKind(toolName: string, args: unknown): "test" | "check" | undefined {
	if (!VERIFICATION_TOOLS.has(toolName)) return undefined;
	if (toolName === "bash") {
		const command = readString(isRecord(args) ? args.command : undefined);
		if (!command) return undefined;
		return TEST_COMMAND_RE.test(command) ? "test" : undefined;
	}
	if (toolName === "eval") {
		const source = collectEvalSource(args);
		if (!source) return undefined;
		if (TEST_CODE_RE.test(source) || TEST_COMMAND_RE.test(source)) return "test";
		return "check";
	}
	return undefined;
}

function collectEvalSource(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	const chunks: string[] = [];
	const code = readString(args.code);
	if (code) chunks.push(code);
	const source = readString(args.source);
	if (source) chunks.push(source);
	const cells = args.cells;
	if (Array.isArray(cells)) {
		for (const cell of cells) {
			if (typeof cell === "string") {
				chunks.push(cell);
				continue;
			}
			if (!isRecord(cell)) continue;
			const cellSource = readString(cell.source) ?? readString(cell.code) ?? readString(cell.content);
			if (cellSource) chunks.push(cellSource);
		}
	}
	if (chunks.length === 0) return undefined;
	// Inspect only; never persisted.
	return chunks.join("\n");
}

function extractResultDetails(result: unknown): UnknownRecord | undefined {
	if (!isRecord(result)) return undefined;
	if (isRecord(result.details)) return result.details;
	return result;
}

function summarizeContextDetails(
	toolName: string,
	details: UnknownRecord | undefined,
): Record<string, JsonValue> | undefined {
	if (!details) return { structural: true };
	const out: JsonObject = {};

	assignString(out, "kind", readString(details.kind));
	assignBoolean(out, "isDirectory", details.isDirectory);
	assignBoolean(out, "truncated", readTruncatedFlag(details));
	assignNumber(out, "matchCount", readFiniteNumber(details.matchCount));
	assignNumber(out, "fileCount", readFiniteNumber(details.fileCount) ?? readFiniteNumber(details.filesSearched));
	assignNumber(out, "filesSearched", readFiniteNumber(details.filesSearched));
	assignNumber(out, "resultLimitReached", readFiniteNumber(details.resultLimitReached));
	assignNumber(out, "fileLimitReached", readFiniteNumber(details.fileLimitReached));
	assignNumber(out, "perFileLimitReached", readFiniteNumber(details.perFileLimitReached));
	assignNumber(out, "conflictCount", readFiniteNumber(details.conflictCount));
	assignBoolean(out, "limitReached", details.limitReached);
	assignString(out, "contentType", readString(details.contentType));
	assignString(out, "action", readString(details.action));
	assignString(out, "serverName", readString(details.serverName));
	assignBoolean(out, "success", details.success);

	const summary = details.summary;
	if (isRecord(summary)) {
		const nested: JsonObject = {};
		assignNumber(nested, "lines", readFiniteNumber(summary.lines));
		assignNumber(nested, "elidedSpans", readFiniteNumber(summary.elidedSpans));
		assignNumber(nested, "elidedLines", readFiniteNumber(summary.elidedLines));
		if (Object.keys(nested).length > 0) out.summary = nested;
	}

	const meta = details.meta;
	if (isRecord(meta) && isRecord(meta.truncation)) {
		const truncation: JsonObject = {};
		assignBoolean(truncation, "truncated", meta.truncation.truncated);
		assignString(truncation, "direction", readString(meta.truncation.direction));
		assignNumber(truncation, "outputLines", readFiniteNumber(meta.truncation.outputLines));
		assignNumber(truncation, "totalLines", readFiniteNumber(meta.truncation.totalLines));
		if (Object.keys(truncation).length > 0) out.truncation = truncation;
	}

	const pathCandidates = [
		readString(details.resolvedPath),
		readString(details.scopePath),
		readString(details.searchPath),
		readString(details.path),
	].filter((value): value is string => value !== undefined);
	if (Array.isArray(details.files)) {
		for (const file of details.files) {
			if (typeof file === "string") pathCandidates.push(file);
		}
	}
	assignPathList(out, "paths", pathCandidates);

	if (toolName === "lsp" && isRecord(details.request)) {
		const requestKeys = Object.keys(details.request)
			.filter(key => !SECRET_KEY_RE.test(key))
			.slice(0, MAX_ARGUMENT_KEYS)
			.sort();
		if (requestKeys.length > 0) out.requestKeys = requestKeys;
	}

	return Object.keys(out).length > 0 ? out : { structural: true };
}

function summarizePatchDetails(
	toolName: string,
	details: UnknownRecord | undefined,
	status: "ok" | "error",
): RecordPatchInput {
	const paths: string[] = [];
	const pushPath = (value: unknown): void => {
		if (typeof value === "string" && value.length > 0) paths.push(value);
	};

	if (details) {
		pushPath(details.path);
		pushPath(details.resolvedPath);
		pushPath(details.scopePath);
		pushPath(details.searchPath);
		pushPath(details.move);
		if (Array.isArray(details.files)) {
			for (const file of details.files) pushPath(file);
		}
		if (Array.isArray(details.perFileResults)) {
			for (const entry of details.perFileResults) {
				if (isRecord(entry)) pushPath(entry.path);
			}
		}
		if (Array.isArray(details.fileReplacements)) {
			for (const entry of details.fileReplacements) {
				if (isRecord(entry)) pushPath(entry.path);
			}
		}
	}

	return {
		toolName,
		status,
		paths: uniqueStrings(paths).slice(0, MAX_PATHS),
		filesTouched: details ? readFiniteNumber(details.filesTouched) : undefined,
		totalReplacements: details ? readFiniteNumber(details.totalReplacements) : undefined,
		op: details ? readString(details.op) : undefined,
	};
}

function summarizeTelemetry(telemetry: AgentRunSummary | undefined): Record<string, JsonValue> | undefined {
	if (!telemetry) return undefined;
	return {
		stepCount: telemetry.stepCount,
		chats: {
			total: telemetry.chats.total,
			totalLatencyMs: telemetry.chats.totalLatencyMs,
			byStopReason: { ...telemetry.chats.byStopReason },
		},
		tools: {
			total: telemetry.tools.total,
			ok: telemetry.tools.ok,
			error: telemetry.tools.error,
			skipped: telemetry.tools.skipped,
			blocked: telemetry.tools.blocked,
			timeout: telemetry.tools.timeout,
			aborted: telemetry.tools.aborted,
			totalLatencyMs: telemetry.tools.totalLatencyMs,
		},
		usage: {
			inputTokens: telemetry.usage.inputTokens,
			outputTokens: telemetry.usage.outputTokens,
			cachedInputTokens: telemetry.usage.cachedInputTokens,
			cacheWriteTokens: telemetry.usage.cacheWriteTokens,
			reasoningOutputTokens: telemetry.usage.reasoningOutputTokens,
			totalTokens: telemetry.usage.totalTokens,
		},
		cost: {
			estimatedUsd: telemetry.cost.estimatedUsd,
			unavailableReasons: [...telemetry.cost.unavailableReasons],
		},
		errors: {
			total: telemetry.errors.total,
			byType: { ...telemetry.errors.byType },
		},
	};
}

function readAssistantStop(message: AgentMessage): { stopReason: string; hasErrorMessage: boolean } | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	const stopReason = readString(message.stopReason);
	if (!stopReason) return undefined;
	return {
		stopReason,
		hasErrorMessage: typeof message.errorMessage === "string" && message.errorMessage.length > 0,
	};
}

function sanitizeMetadata(
	metadata: Readonly<Record<string, JsonValue>> | undefined,
	options: { rejectSecrets?: boolean } = {},
): JsonObject | undefined {
	if (!metadata) return undefined;
	const out: JsonObject = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (SECRET_KEY_RE.test(key)) {
			if (options.rejectSecrets) return undefined;
			continue;
		}
		const sanitized = sanitizeJsonValue(value, options.rejectSecrets === true);
		if (sanitized === undefined) {
			if (options.rejectSecrets) return undefined;
			continue;
		}
		out[key] = sanitized;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeJsonValue(value: JsonValue, rejectSecrets: boolean): JsonValue | undefined {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		if (SECRET_VALUE_RE.test(value)) return undefined;
		return boundString(value, MAX_STRING_META);
	}
	if (Array.isArray(value)) {
		const items: JsonValue[] = [];
		for (const item of value) {
			const sanitized = sanitizeJsonValue(item, rejectSecrets);
			if (sanitized === undefined) {
				if (rejectSecrets) return undefined;
				continue;
			}
			items.push(sanitized);
		}
		return items;
	}
	if (isRecord(value)) {
		const nested = sanitizeMetadata(value as Record<string, JsonValue>, { rejectSecrets });
		if (nested === undefined && rejectSecrets) return undefined;
		return nested ?? {};
	}
	return undefined;
}

function readTruncatedFlag(details: UnknownRecord): boolean | undefined {
	if (typeof details.truncated === "boolean") return details.truncated;
	if (isRecord(details.truncation) && typeof details.truncation.truncated === "boolean") {
		return details.truncation.truncated;
	}
	return undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assignString(target: JsonObject, key: string, value: string | undefined): void {
	if (value === undefined) return;
	target[key] = boundString(value, MAX_STRING_META);
}

function assignNumber(target: JsonObject, key: string, value: number | undefined): void {
	if (value === undefined || !Number.isFinite(value)) return;
	target[key] = value;
}

function assignBoolean(target: JsonObject, key: string, value: unknown): void {
	if (typeof value === "boolean") target[key] = value;
}

function assignStringList(target: JsonObject, key: string, values: readonly string[] | undefined): void {
	if (!values || values.length === 0) return;
	target[key] = uniqueStrings(values.map(value => boundString(value, MAX_STRING_META)));
}

function assignPathList(target: JsonObject, key: string, values: readonly string[] | undefined): void {
	if (!values || values.length === 0) return;
	const paths = uniqueStrings(
		values.map(value => {
			const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
			return boundString(segments.slice(-2).join("/"), MAX_STRING_META);
		}),
	).slice(0, MAX_PATHS);
	if (paths.length > 0) target[key] = paths;
}

function boundString(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter(value => value.length > 0))];
}
