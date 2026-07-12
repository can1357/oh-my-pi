/**
 * Capture-to-agent workflow contracts.
 *
 * A capture task starts on a desktop capture surface (overlay, tray, browser),
 * is normalized by the capture gateway, executes inside an existing oh-my-pk
 * agent session, and is mirrored into a collaboration surface (Telegram first;
 * the adapter interface keeps other surfaces pluggable).
 */
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";

import type { Annotation, CaptureMode, CaptureRegion } from "../types";
import { isCaptureMode } from "../types";

/** Where the captured context originated. */
export type CaptureSourceType = "screen-region" | "active-window" | "full-screen" | "selected-text" | "browser";

const CAPTURE_SOURCE_TYPES: readonly CaptureSourceType[] = [
	"screen-region",
	"active-window",
	"full-screen",
	"selected-text",
	"browser",
];

export function isCaptureSourceType(value: unknown): value is CaptureSourceType {
	return typeof value === "string" && (CAPTURE_SOURCE_TYPES as readonly string[]).includes(value);
}

export type CaptureScreenshotMimeType = "image/png" | "image/jpeg";

/** Screenshot payload: inline base64 data, or a reference to a stored asset. */
export interface CaptureScreenshotInput {
	mimeType: CaptureScreenshotMimeType;
	/** Base64-encoded image bytes. Exactly one of data / storageRef must be set. */
	data?: string;
	/** Asset id previously stored by the gateway. */
	storageRef?: string;
	width?: number;
	height?: number;
}

/** Normalized capture task submitted by a capture client. */
export interface CaptureTaskRequest {
	/** Client-generated idempotency key. Resubmitting the same id returns the same run. */
	requestId: string;
	source: {
		type: CaptureSourceType;
		application?: string;
		windowTitle?: string;
		url?: string;
		capturedAt: string;
	};
	instruction: string;
	selectedText?: string;
	screenshot?: CaptureScreenshotInput;
	/**
	 * Ask the gateway to capture the screenshot server-side with the existing
	 * desktop CaptureService (for clients on the same machine, e.g. the overlay).
	 * Ignored when an explicit screenshot is provided.
	 */
	capture?: {
		mode: CaptureMode;
		region?: CaptureRegion;
		includeClipboard?: boolean;
	};
	annotations?: Annotation[];
	routing: {
		/** Resume this existing oh-my-pk session instead of creating a new one. */
		sessionId?: string;
		runnerId?: string;
		workspaceId?: string;
		agentRole?: string;
		modelPreference?: string;
	};
	collaboration?: {
		telegramChatId?: string;
		telegramTopicId?: string;
		/** Skip mirroring this task to collaboration surfaces entirely. */
		disabled?: boolean;
	};
	submittedBy?: string;
	metadata?: Record<string, unknown>;
}

export type CaptureRunStatus =
	| "queued"
	| "starting"
	| "running"
	| "waiting_for_user"
	| "completed"
	| "failed"
	| "cancelled";

const CAPTURE_RUN_STATUSES: readonly CaptureRunStatus[] = [
	"queued",
	"starting",
	"running",
	"waiting_for_user",
	"completed",
	"failed",
	"cancelled",
];

export function isCaptureRunStatus(value: unknown): value is CaptureRunStatus {
	return typeof value === "string" && (CAPTURE_RUN_STATUSES as readonly string[]).includes(value);
}

/** A capture run is terminal once completed, failed, or cancelled. */
export function isTerminalRunStatus(status: CaptureRunStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/** Durable record connecting a capture request, agent session, runner, and Telegram thread. */
export interface CaptureRun {
	id: string;
	requestId: string;
	instruction: string;
	sourceType: CaptureSourceType;
	sessionId?: string;
	/** Absolute path to the persisted session JSONL; the resume key that survives restarts. */
	sessionFile?: string;
	runnerId?: string;
	workspaceId?: string;
	agentRole?: string;
	status: CaptureRunStatus;
	error?: string;
	resultSummary?: string;
	submittedBy?: string;
	screenshotAssetId?: string;
	telegramChatId?: string;
	telegramTopicId?: string;
	telegramRootMessageId?: string;
	createdAt: string;
	updatedAt: string;
}

/** Stored screenshot metadata; binary bytes live on disk, not in the database. */
export interface CaptureAsset {
	id: string;
	runId?: string;
	mimeType: CaptureScreenshotMimeType;
	byteSize: number;
	width?: number;
	height?: number;
	filePath: string;
	createdAt: string;
}

/** Summarized run progress suitable for persistence and collaboration surfaces. */
export type CaptureRunEvent =
	| { type: "run.status"; runId: string; status: CaptureRunStatus; detail?: string }
	| {
			type: "run.tool";
			runId: string;
			toolName: string;
			phase: "started" | "completed";
			isError?: boolean;
			summary: string;
	  }
	| { type: "run.message.delta"; runId: string; text: string }
	| { type: "run.result"; runId: string; text: string }
	| { type: "run.follow_up"; runId: string; source: "telegram" | "api"; participant?: string; text: string }
	| { type: "run.error"; runId: string; error: string };

/** Whether an event should be written to the durable event log (deltas stay live-only). */
export function isPersistedRunEvent(event: CaptureRunEvent): boolean {
	return event.type !== "run.message.delta";
}

/** A normalized inbound message from a collaboration surface. */
export interface CollaborationTurn {
	runId: string;
	text: string;
	images?: ImageContent[];
	participant?: string;
	source: "telegram" | "api";
}

export interface CollaborationMessageRef {
	channelId: string;
	messageId: string;
	topicId?: string;
}

/**
 * A collaboration surface (Telegram, later Slack/Discord/Teams/web chat).
 * Adapters receive summarized run events only — never raw tool payloads,
 * environment variables, or hidden model reasoning.
 */
export interface CollaborationAdapter {
	readonly id: string;
	publishTask(
		run: CaptureRun,
		screenshot?: { bytes: Uint8Array; mimeType: string },
	): Promise<CollaborationMessageRef | undefined>;
	publishEvent(run: CaptureRun, event: CaptureRunEvent): Promise<void>;
	publishResult(run: CaptureRun, result: { status: CaptureRunStatus; text: string }): Promise<void>;
	parseInboundMessage(input: unknown): Promise<CollaborationTurn | null>;
}

/** Events emitted by a runner execution, projected from the agent session gateway. */
export type RunnerEvent =
	| { type: "agent_start" }
	| { type: "text_delta"; text: string }
	| { type: "tool_start"; toolCallId: string; toolName: string }
	| { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
	| {
			type: "agent_end";
			hasError: boolean;
			error?: string;
			/** Final session identity — the session file may only exist after the first assistant turn. */
			session?: RunnerSessionRef;
	  }
	| { type: "fatal"; error: string };

export interface RunnerSessionRef {
	sessionId: string;
	sessionFile?: string;
}

/** A single dispatched turn executing inside a runner space. */
export interface RunnerRunHandle {
	runnerRunId: string;
	session: RunnerSessionRef;
	events: AsyncIterable<RunnerEvent>;
}

export interface CreateCaptureSessionInput {
	/** Fully rendered first user turn. */
	message: string;
	images?: ImageContent[];
	cwd?: string;
	runnerId?: string;
	agentRole?: string;
	modelPreference?: string;
	displayName?: string;
}

export interface CaptureTurnInput {
	message: string;
	images?: ImageContent[];
}

export type RunnerRunStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";

/**
 * Adapter around the existing oh-my-pk session/runner infrastructure.
 * Implementations must persist sessions so `resumeSession` works after a
 * process restart, and must never hardcode a single machine or repository.
 */
export interface CaptureRunnerAdapter {
	createSession(input: CreateCaptureSessionInput): Promise<RunnerRunHandle>;
	resumeSession(session: RunnerSessionRef, input: CaptureTurnInput): Promise<RunnerRunHandle>;
	cancelRun(runnerRunId: string): Promise<void>;
	getRunStatus(runnerRunId: string): RunnerRunStatus;
	listRunners(): Promise<RunnerInfo[]>;
}

/** A runner/execution space that can host capture tasks. */
export interface RunnerInfo {
	id: string;
	name: string;
	location: "local" | "remote" | "cloud";
	available: boolean;
	description?: string;
}

const MAX_INSTRUCTION_CHARS = 20_000;
const MAX_SELECTED_TEXT_CHARS = 100_000;
const MAX_ANNOTATIONS = 100;
const MAX_ID_CHARS = 128;
const MAX_METADATA_CHARS = 16_384;

export interface CaptureRequestLimits {
	/** Maximum decoded screenshot size in bytes. */
	maxScreenshotBytes: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function optionalBoundedString(value: unknown, name: string, max: number): ParseResult<string | undefined> {
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "string") return { ok: false, error: `${name} must be a string` };
	if (value.length > max) return { ok: false, error: `${name} is too long (max ${max} chars)` };
	return { ok: true, value };
}

function isAnnotation(value: unknown): value is Annotation {
	if (!isRecord(value)) return false;
	const bounds = value.bounds;
	return (
		typeof value.id === "string" &&
		(value.type === "rectangle" || value.type === "point" || value.type === "arrow" || value.type === "blur") &&
		Array.isArray(bounds) &&
		bounds.length === 4 &&
		bounds.every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate)) &&
		isOptionalString(value.label)
	);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Reject asset refs that are not plain generated ids (defends against path traversal). */
export function isValidAssetId(value: string): boolean {
	return ASSET_ID_PATTERN.test(value);
}

function parseScreenshot(
	value: unknown,
	limits: CaptureRequestLimits,
): ParseResult<CaptureScreenshotInput | undefined> {
	if (value === undefined) return { ok: true, value: undefined };
	if (!isRecord(value)) return { ok: false, error: "screenshot must be an object" };
	if (value.mimeType !== "image/png" && value.mimeType !== "image/jpeg") {
		return { ok: false, error: "screenshot.mimeType must be image/png or image/jpeg" };
	}
	const hasData = typeof value.data === "string" && value.data.length > 0;
	const hasRef = typeof value.storageRef === "string" && value.storageRef.length > 0;
	if (hasData === hasRef) {
		return { ok: false, error: "screenshot must set exactly one of data or storageRef" };
	}
	if (hasData) {
		const data = value.data as string;
		// Base64 expands bytes by 4/3; bound the encoded length before decoding.
		const maxEncoded = Math.ceil((limits.maxScreenshotBytes * 4) / 3) + 4;
		if (data.length > maxEncoded) {
			return { ok: false, error: `screenshot.data exceeds the upload limit (${limits.maxScreenshotBytes} bytes)` };
		}
		if (!BASE64_PATTERN.test(data)) return { ok: false, error: "screenshot.data must be base64" };
	}
	if (hasRef && !isValidAssetId(value.storageRef as string)) {
		return { ok: false, error: "screenshot.storageRef is not a valid asset id" };
	}
	for (const key of ["width", "height"] as const) {
		if (
			value[key] !== undefined &&
			(typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0)
		) {
			return { ok: false, error: `screenshot.${key} must be a positive finite number` };
		}
	}
	return {
		ok: true,
		value: {
			mimeType: value.mimeType,
			...(hasData ? { data: value.data as string } : {}),
			...(hasRef ? { storageRef: value.storageRef as string } : {}),
			...(typeof value.width === "number" ? { width: value.width } : {}),
			...(typeof value.height === "number" ? { height: value.height } : {}),
		},
	};
}

function parseServerCapture(value: unknown): ParseResult<CaptureTaskRequest["capture"] | undefined> {
	if (value === undefined) return { ok: true, value: undefined };
	if (!isRecord(value)) return { ok: false, error: "capture must be an object" };
	if (!isCaptureMode(value.mode)) {
		return { ok: false, error: "capture.mode must be one of screen, window, region, browser" };
	}
	if (value.includeClipboard !== undefined && typeof value.includeClipboard !== "boolean") {
		return { ok: false, error: "capture.includeClipboard must be a boolean" };
	}
	let region: CaptureRegion | undefined;
	if (value.region !== undefined) {
		if (!isRecord(value.region)) return { ok: false, error: "capture.region must be an object" };
		const { x, y, width, height } = value.region as Record<string, unknown>;
		if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
			return { ok: false, error: "capture.region x and y must be finite numbers" };
		}
		if (
			typeof width !== "number" ||
			!Number.isFinite(width) ||
			width <= 0 ||
			typeof height !== "number" ||
			!Number.isFinite(height) ||
			height <= 0
		) {
			return { ok: false, error: "capture.region width and height must be positive finite numbers" };
		}
		region = { x, y, width, height };
	}
	if (value.mode === "region" && region === undefined) {
		return { ok: false, error: "capture.region is required for region capture" };
	}
	return {
		ok: true,
		value: {
			mode: value.mode,
			...(region !== undefined ? { region } : {}),
			...(value.includeClipboard !== undefined ? { includeClipboard: value.includeClipboard } : {}),
		},
	};
}

/** Validate an untrusted capture task request. Rejects unknown shapes instead of casting. */
export function parseCaptureTaskRequest(input: unknown, limits: CaptureRequestLimits): ParseResult<CaptureTaskRequest> {
	if (!isRecord(input)) return { ok: false, error: "request must be an object" };

	if (typeof input.requestId !== "string" || input.requestId.trim().length === 0) {
		return { ok: false, error: "requestId must be a non-empty string" };
	}
	if (input.requestId.length > MAX_ID_CHARS) return { ok: false, error: "requestId is too long" };

	if (!isRecord(input.source)) return { ok: false, error: "source must be an object" };
	if (!isCaptureSourceType(input.source.type)) {
		return { ok: false, error: `source.type must be one of: ${CAPTURE_SOURCE_TYPES.join(", ")}` };
	}
	if (typeof input.source.capturedAt !== "string" || Number.isNaN(Date.parse(input.source.capturedAt))) {
		return { ok: false, error: "source.capturedAt must be an ISO timestamp" };
	}
	const application = optionalBoundedString(input.source.application, "source.application", 512);
	if (!application.ok) return application;
	const windowTitle = optionalBoundedString(input.source.windowTitle, "source.windowTitle", 1_024);
	if (!windowTitle.ok) return windowTitle;
	const url = optionalBoundedString(input.source.url, "source.url", 4_096);
	if (!url.ok) return url;

	if (typeof input.instruction !== "string" || input.instruction.trim().length === 0) {
		return { ok: false, error: "instruction must be a non-empty string" };
	}
	if (input.instruction.length > MAX_INSTRUCTION_CHARS) {
		return { ok: false, error: `instruction is too long (max ${MAX_INSTRUCTION_CHARS} chars)` };
	}

	const selectedText = optionalBoundedString(input.selectedText, "selectedText", MAX_SELECTED_TEXT_CHARS);
	if (!selectedText.ok) return selectedText;

	const screenshot = parseScreenshot(input.screenshot, limits);
	if (!screenshot.ok) return screenshot;

	const capture = parseServerCapture(input.capture);
	if (!capture.ok) return capture;

	if (input.annotations !== undefined) {
		if (!Array.isArray(input.annotations) || input.annotations.length > MAX_ANNOTATIONS) {
			return { ok: false, error: `annotations must be an array of at most ${MAX_ANNOTATIONS} items` };
		}
		if (!input.annotations.every(isAnnotation)) return { ok: false, error: "annotations contain an invalid entry" };
	}

	const routingInput = input.routing;
	if (routingInput !== undefined && !isRecord(routingInput)) return { ok: false, error: "routing must be an object" };
	const routing: CaptureTaskRequest["routing"] = {};
	for (const key of ["sessionId", "runnerId", "workspaceId", "agentRole", "modelPreference"] as const) {
		const parsed = optionalBoundedString(routingInput?.[key], `routing.${key}`, key === "workspaceId" ? 1_024 : 256);
		if (!parsed.ok) return parsed;
		if (parsed.value !== undefined) routing[key] = parsed.value;
	}

	let collaboration: CaptureTaskRequest["collaboration"];
	if (input.collaboration !== undefined) {
		if (!isRecord(input.collaboration)) return { ok: false, error: "collaboration must be an object" };
		collaboration = {};
		for (const key of ["telegramChatId", "telegramTopicId"] as const) {
			const parsed = optionalBoundedString(input.collaboration[key], `collaboration.${key}`, 64);
			if (!parsed.ok) return parsed;
			if (parsed.value !== undefined) collaboration[key] = parsed.value;
		}
		if (input.collaboration.disabled !== undefined) {
			if (typeof input.collaboration.disabled !== "boolean") {
				return { ok: false, error: "collaboration.disabled must be a boolean" };
			}
			collaboration.disabled = input.collaboration.disabled;
		}
	}

	const submittedBy = optionalBoundedString(input.submittedBy, "submittedBy", 256);
	if (!submittedBy.ok) return submittedBy;

	let metadata: Record<string, unknown> | undefined;
	if (input.metadata !== undefined) {
		if (!isRecord(input.metadata)) return { ok: false, error: "metadata must be an object" };
		// JSON.stringify throws on circular references; keep the ParseResult contract.
		let serialized: string;
		try {
			serialized = JSON.stringify(input.metadata);
		} catch {
			return { ok: false, error: "metadata must be JSON-serializable" };
		}
		if (serialized.length > MAX_METADATA_CHARS) {
			return { ok: false, error: "metadata is too large" };
		}
		metadata = input.metadata;
	}

	return {
		ok: true,
		value: {
			requestId: input.requestId,
			source: {
				type: input.source.type,
				capturedAt: input.source.capturedAt,
				...(application.value !== undefined ? { application: application.value } : {}),
				...(windowTitle.value !== undefined ? { windowTitle: windowTitle.value } : {}),
				...(url.value !== undefined ? { url: url.value } : {}),
			},
			instruction: input.instruction,
			...(selectedText.value !== undefined ? { selectedText: selectedText.value } : {}),
			...(screenshot.value !== undefined ? { screenshot: screenshot.value } : {}),
			...(capture.value !== undefined ? { capture: capture.value } : {}),
			...(Array.isArray(input.annotations) ? { annotations: input.annotations as Annotation[] } : {}),
			routing,
			...(collaboration !== undefined ? { collaboration } : {}),
			...(submittedBy.value !== undefined ? { submittedBy: submittedBy.value } : {}),
			...(metadata !== undefined ? { metadata } : {}),
		},
	};
}

/** Human-readable shortened session identifier for collaboration surfaces. */
export function shortSessionLabel(run: Pick<CaptureRun, "id" | "sessionId">): string {
	const source = run.sessionId ?? run.id;
	return `capture-${source.replace(/-/g, "").slice(0, 6)}`;
}
