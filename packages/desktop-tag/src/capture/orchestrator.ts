/**
 * Capture orchestrator: the gateway between capture clients, the durable
 * store, the runner adapter, and collaboration surfaces.
 *
 * Responsibilities:
 * - Validate and idempotently accept capture task requests.
 * - Store screenshots and create/resume oh-my-pk sessions via the runner adapter.
 * - Persist the request ↔ run ↔ session ↔ Telegram-thread mapping.
 * - Stream summarized progress to subscribers and collaboration adapters.
 * - Accept follow-up turns (from Telegram or the API) into the same session.
 */
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import * as logger from "@pk-nerdsaver-ai/pi-utils/logger";

import { type CapabilityRegistry, createDefaultRegistry, routeContext } from "../router";
import type { CaptureMode, CaptureRegion, ContextPacket } from "../types";
import { buildCaptureUserTurn, buildFollowUpTurn } from "./prompt";
import { ReplayChannel } from "./queue";
import { sanitizeForCollaboration } from "./redact";
import type { CaptureStore } from "./store";
import {
	type CaptureRun,
	type CaptureRunEvent,
	type CaptureRunnerAdapter,
	type CaptureRunStatus,
	type CaptureScreenshotMimeType,
	type CaptureTaskRequest,
	type CollaborationAdapter,
	isPersistedRunEvent,
	isTerminalRunStatus,
	type ParseResult,
	parseCaptureTaskRequest,
	type RunnerRunHandle,
	shortSessionLabel,
} from "./types";

/** Desktop capture surface (CaptureService from ../context satisfies this). */
export interface CaptureServiceLike {
	capture(options: {
		mode: CaptureMode;
		userRequest: string;
		includeClipboard?: boolean;
		region?: CaptureRegion;
	}): Promise<ContextPacket>;
}

export interface CaptureOrchestratorOptions {
	store: CaptureStore;
	runner: CaptureRunnerAdapter;
	registry?: CapabilityRegistry;
	/** Enables server-side screenshots for same-machine clients (the overlay). */
	captureService?: CaptureServiceLike;
	maxScreenshotBytes?: number;
	defaultRunnerId?: string;
	defaultAgentRole?: string;
	now?: () => string;
}

export interface FollowUpInput {
	text: string;
	images?: ImageContent[];
	source: "telegram" | "api";
	participant?: string;
	/** Idempotency key (e.g. `telegram:<updateId>`); duplicate keys are ignored. */
	idempotencyKey?: string;
}

export interface FollowUpResult {
	accepted: boolean;
	reason?: string;
	run?: CaptureRun;
}

export interface CaptureMetrics {
	requestsReceived: number;
	requestsDeduplicated: number;
	runsStarted: number;
	runsCompleted: number;
	runsFailed: number;
	runsCancelled: number;
	followUpsAccepted: number;
	followUpsRejected: number;
	collaborationDeliveryFailures: number;
}

interface LiveRunEvent {
	seq: number;
	event: CaptureRunEvent;
}

interface PendingTurn {
	message: string;
	images?: ImageContent[];
	description: string;
}

interface RunState {
	channel: ReplayChannel<LiveRunEvent>;
	activeRunnerRunId?: string;
	/** Set when cancellation arrives while startup is still awaiting async steps. */
	cancelRequested: boolean;
	resultText: string;
	queue: PendingTurn[];
}

const MAX_RESULT_CHARS = 16_000;
const MAX_QUEUED_TURNS = 16;

const TOOL_SUMMARIES: ReadonlyArray<[RegExp, string]> = [
	[/^(bash|shell|terminal|exec)/i, "Running a command"],
	[/^(read|grep|find|ls|glob|search|list|tree)/i, "Inspecting repository files"],
	[/^(edit|write|apply|patch|multi_edit)/i, "Editing files"],
	[/test/i, "Running tests"],
	[/^(browser|ix_bridge|playwright|web)/i, "Checking browser state"],
	[/^(fetch|http|curl|download)/i, "Fetching a URL"],
	[/linear/i, "Working in Linear"],
	[/^(git|commit|push)/i, "Working with git"],
];

/** Map a tool name to a human-friendly progress label; never leaks arguments. */
export function summarizeToolUse(toolName: string): string {
	for (const [pattern, summary] of TOOL_SUMMARIES) {
		if (pattern.test(toolName)) return summary;
	}
	return `Using tool: ${toolName.slice(0, 48)}`;
}

export class CaptureOrchestrator {
	readonly #store: CaptureStore;
	readonly #runner: CaptureRunnerAdapter;
	readonly #registry: CapabilityRegistry;
	readonly #adapters: CollaborationAdapter[] = [];
	readonly #runs = new Map<string, RunState>();
	#captureService: CaptureServiceLike | undefined;
	readonly #maxScreenshotBytes: number;
	readonly #defaultRunnerId: string | undefined;
	readonly #defaultAgentRole: string;
	readonly #now: () => string;
	readonly metrics: CaptureMetrics = {
		requestsReceived: 0,
		requestsDeduplicated: 0,
		runsStarted: 0,
		runsCompleted: 0,
		runsFailed: 0,
		runsCancelled: 0,
		followUpsAccepted: 0,
		followUpsRejected: 0,
		collaborationDeliveryFailures: 0,
	};

	constructor(options: CaptureOrchestratorOptions) {
		this.#store = options.store;
		this.#runner = options.runner;
		this.#registry = options.registry ?? createDefaultRegistry();
		this.#captureService = options.captureService;
		this.#maxScreenshotBytes = options.maxScreenshotBytes ?? 20 * 1024 * 1024;
		this.#defaultRunnerId = options.defaultRunnerId;
		this.#defaultAgentRole = options.defaultAgentRole ?? "task";
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	registerCollaborationAdapter(adapter: CollaborationAdapter): void {
		this.#adapters.push(adapter);
	}

	get store(): CaptureStore {
		return this.#store;
	}

	get runner(): CaptureRunnerAdapter {
		return this.#runner;
	}

	/**
	 * Validate and accept a capture task. Idempotent on requestId: a replay
	 * returns the existing run without re-executing.
	 */
	async submitTask(rawRequest: unknown): Promise<ParseResult<CaptureRun>> {
		this.metrics.requestsReceived += 1;
		const parsed = parseCaptureTaskRequest(rawRequest, { maxScreenshotBytes: this.#maxScreenshotBytes });
		if (!parsed.ok) return parsed;
		const request = parsed.value;

		const runnerId = request.routing.runnerId ?? this.#defaultRunnerId ?? this.#routeRunner(request);
		const now = this.#now();
		const runTemplate: CaptureRun = {
			id: crypto.randomUUID(),
			requestId: request.requestId,
			instruction: request.instruction,
			sourceType: request.source.type,
			status: "queued",
			createdAt: now,
			updatedAt: now,
			...(runnerId !== undefined ? { runnerId } : {}),
			...(request.routing.workspaceId !== undefined ? { workspaceId: request.routing.workspaceId } : {}),
			agentRole: request.routing.agentRole ?? this.#defaultAgentRole,
			...(request.routing.sessionId !== undefined ? { sessionId: request.routing.sessionId } : {}),
			...(request.submittedBy !== undefined ? { submittedBy: request.submittedBy } : {}),
			...(request.collaboration?.telegramChatId !== undefined
				? { telegramChatId: request.collaboration.telegramChatId }
				: {}),
			...(request.collaboration?.telegramTopicId !== undefined
				? { telegramTopicId: request.collaboration.telegramTopicId }
				: {}),
		};

		const { run, created } = this.#store.createRun(request.requestId, rawRequest, runTemplate);
		if (!created) {
			this.metrics.requestsDeduplicated += 1;
			return { ok: true, value: run };
		}

		this.#store.audit("task.created", {
			runId: run.id,
			actor: request.submittedBy,
			detail: `source=${request.source.type} runner=${run.runnerId ?? "auto"}`,
		});

		// Fire-and-forget: submission returns immediately; progress streams via events.
		void this.#startRun(run, request).catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			logger.error("Capture run failed to start", { runId: run.id, error: message });
			this.metrics.runsFailed += 1;
			this.#transition(run.id, "failed", { error: message });
			// Close the live stream so SSE subscribers don't wait forever.
			this.#runs.get(run.id)?.channel.close();
			this.#runs.delete(run.id);
		});

		return { ok: true, value: this.#store.getRun(run.id) ?? run };
	}

	getRun(runId: string): CaptureRun | undefined {
		return this.#store.getRun(runId);
	}

	listRuns(limit = 50): CaptureRun[] {
		return this.#store.listRuns(limit);
	}

	async listRunners() {
		return this.#runner.listRunners();
	}

	/** Replay persisted events, then follow live events until the run is terminal. */
	subscribeEvents(runId: string, signal?: AbortSignal): AsyncIterable<CaptureRunEvent> {
		const store = this.#store;
		const state = this.#runs.get(runId);
		const isTerminal = () => {
			const run = store.getRun(runId);
			return run === undefined || isTerminalRunStatus(run.status);
		};
		return {
			async *[Symbol.asyncIterator](): AsyncIterator<CaptureRunEvent> {
				let lastSeq = 0;
				for (const stored of store.listEvents(runId)) {
					lastSeq = stored.seq;
					yield stored.event;
					if (signal?.aborted) return;
				}
				if (!state || isTerminal()) return;
				for await (const live of state.channel.subscribe(signal)) {
					if (live.seq === 0 || live.seq > lastSeq) {
						if (live.seq > 0) lastSeq = live.seq;
						yield live.event;
					}
				}
			},
		};
	}

	/** Append a follow-up turn to the run's session, resuming it when idle. */
	async followUp(runId: string, input: FollowUpInput): Promise<FollowUpResult> {
		const run = this.#store.getRun(runId);
		if (!run) {
			this.metrics.followUpsRejected += 1;
			return { accepted: false, reason: "Unknown capture run." };
		}
		if (input.text.trim().length === 0) {
			this.metrics.followUpsRejected += 1;
			return { accepted: false, reason: "Follow-up text is empty." };
		}

		const state = this.#ensureState(runId);
		// Durably reserve the idempotency key so a duplicate is rejected even after the
		// turn settles or the process restarts (an in-memory set would forget both).
		if (input.idempotencyKey && !this.#store.claimFollowUpKey(runId, input.idempotencyKey)) {
			return { accepted: true, run, reason: "duplicate" };
		}
		// A rejection below must release the reservation so a retry is not
		// misreported as a duplicate of a turn that never ran.
		const releaseIdempotencyKey = () => {
			if (input.idempotencyKey) this.#store.releaseFollowUpKey(runId, input.idempotencyKey);
		};

		if (state.queue.length >= MAX_QUEUED_TURNS) {
			releaseIdempotencyKey();
			this.metrics.followUpsRejected += 1;
			return {
				accepted: false,
				reason: `Too many pending follow-ups (max ${MAX_QUEUED_TURNS}); wait for the current turn to finish.`,
				run,
			};
		}

		const message = buildFollowUpTurn({
			text: input.text,
			source: input.source,
			participant: input.participant,
			hasImages: (input.images?.length ?? 0) > 0,
		});

		this.#store.audit("task.follow_up", {
			runId,
			actor: input.participant,
			detail: `source=${input.source}`,
		});
		this.#publish(runId, {
			type: "run.follow_up",
			runId,
			source: input.source,
			participant: input.participant,
			text: sanitizeForCollaboration(input.text, 500),
		});

		const turn: PendingTurn = {
			message,
			...(input.images && input.images.length > 0 ? { images: input.images } : {}),
			description: "follow-up",
		};

		if (state.activeRunnerRunId !== undefined) {
			// A turn is already executing; queue and dispatch on settlement.
			state.queue.push(turn);
			this.metrics.followUpsAccepted += 1;
			return { accepted: true, run };
		}

		if (!run.sessionId && !run.sessionFile) {
			releaseIdempotencyKey();
			this.metrics.followUpsRejected += 1;
			return { accepted: false, reason: "This task has no persisted session to resume.", run };
		}

		try {
			await this.#dispatchResume(runId, turn);
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			releaseIdempotencyKey();
			this.metrics.followUpsRejected += 1;
			this.#transition(runId, "failed", { error: `Failed to resume session: ${messageText}` });
			return { accepted: false, reason: `Failed to resume session: ${messageText}`, run };
		}
		this.metrics.followUpsAccepted += 1;
		return { accepted: true, run: this.#store.getRun(runId) };
	}

	/** Cancel the active execution without deleting the session or the mapping. */
	async cancel(runId: string, actor?: string): Promise<FollowUpResult> {
		const run = this.#store.getRun(runId);
		if (!run) return { accepted: false, reason: "Unknown capture run." };
		if (isTerminalRunStatus(run.status)) {
			return { accepted: false, reason: `Run is already ${run.status}.`, run };
		}
		const state = this.#ensureState(runId);
		this.#store.audit("task.cancelled", { runId, actor });
		// Also cover runs whose startup is still awaiting async steps: #startRun
		// re-checks this flag before dispatching to the runner.
		state.cancelRequested = true;
		state.queue.length = 0;
		if (state.activeRunnerRunId) {
			await this.#runner.cancelRun(state.activeRunnerRunId);
		} else {
			this.#transition(runId, "cancelled");
		}
		return { accepted: true, run: this.#store.getRun(runId) };
	}

	/** Delete screenshot assets older than the retention window. */
	async runRetentionSweep(retentionDays: number): Promise<number> {
		const removed = await this.#store.cleanupExpiredAssets(retentionDays);
		if (removed > 0) logger.info("Capture asset retention sweep", { removed, retentionDays });
		return removed;
	}

	#routeRunner(request: CaptureTaskRequest): string | undefined {
		// Reuse the existing capability router by synthesizing a context packet.
		const packet: ContextPacket = {
			captureId: request.requestId,
			timestamp: request.source.capturedAt,
			userRequest: request.instruction,
			captureMode:
				request.source.type === "browser"
					? "browser"
					: request.source.type === "active-window"
						? "window"
						: request.source.type === "screen-region"
							? "region"
							: "screen",
			visual: { displayScale: 1, annotations: request.annotations ?? [] },
			foregroundApp: {
				...(request.source.application !== undefined ? { processName: request.source.application } : {}),
				...(request.source.windowTitle !== undefined ? { windowTitle: request.source.windowTitle } : {}),
			},
			browser: { ...(request.source.url !== undefined ? { url: request.source.url } : {}) },
			selection: { ...(request.selectedText !== undefined ? { text: request.selectedText } : {}) },
			availableCapabilities: [],
		};
		try {
			return routeContext(this.#registry, packet).executorId;
		} catch (error) {
			logger.debug("Capture routing fell back to default runner", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	async #startRun(run: CaptureRun, rawRequest: CaptureTaskRequest): Promise<void> {
		const state = this.#ensureState(run.id);
		this.#transition(run.id, "starting", { detail: run.runnerId ? `runner ${run.runnerId}` : undefined });

		let request = rawRequest;
		if (request.capture && !request.screenshot && this.#captureService) {
			try {
				request = await this.#applyServerCapture(request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.#transition(run.id, "failed", { error: `Screen capture failed: ${message}` });
				return;
			}
		}

		const screenshot = await this.#resolveScreenshot(run.id, request);
		if (request.screenshot && !screenshot) {
			this.#transition(run.id, "failed", { error: "Screenshot could not be stored or resolved." });
			return;
		}
		if (screenshot) {
			this.#store.updateRun(run.id, { screenshotAssetId: screenshot.assetId });
		}

		if (!request.collaboration?.disabled) {
			await this.#publishTask(run.id, screenshot);
		}

		const message = buildCaptureUserTurn({
			request,
			hasScreenshot: screenshot !== undefined,
			runnerId: run.runnerId,
			workspacePath: run.workspaceId,
			collaborationSource: "desktop-capture",
			participant: run.submittedBy,
		});
		const images = screenshot ? [screenshot.image] : undefined;

		// Cancellation may have arrived while capture/collaboration steps were
		// awaited; do not dispatch a cancelled run to the runner.
		if (state.cancelRequested) {
			state.channel.close();
			this.#runs.delete(run.id);
			return;
		}

		let handle: RunnerRunHandle;
		if (request.routing.sessionId) {
			// Resume an explicitly selected existing session; prefer a mapping that
			// already knows the persisted session file.
			const existing = this.#store
				.listRuns(500)
				.find(
					candidate => candidate.sessionId === request.routing.sessionId && candidate.sessionFile !== undefined,
				);
			handle = await this.#runner.resumeSession(
				{ sessionId: request.routing.sessionId, sessionFile: existing?.sessionFile },
				{ message, ...(images ? { images } : {}) },
			);
		} else {
			handle = await this.#runner.createSession({
				message,
				...(images ? { images } : {}),
				...(run.workspaceId !== undefined ? { cwd: run.workspaceId } : {}),
				...(run.runnerId !== undefined ? { runnerId: run.runnerId } : {}),
				...(run.agentRole !== undefined ? { agentRole: run.agentRole } : {}),
				...(request.routing.modelPreference !== undefined
					? { modelPreference: request.routing.modelPreference }
					: {}),
				displayName: `Capture: ${request.instruction.slice(0, 64)}`,
			});
		}

		this.metrics.runsStarted += 1;
		this.#store.updateRun(run.id, {
			sessionId: handle.session.sessionId,
			...(handle.session.sessionFile !== undefined ? { sessionFile: handle.session.sessionFile } : {}),
		});
		this.#consume(run.id, handle);
		// Cancellation that raced session creation lands here; abort the fresh run.
		if (state.cancelRequested) {
			await this.#runner.cancelRun(handle.runnerRunId);
		}
	}

	/** Perform a same-machine screenshot with the existing CaptureService and fold it into the request. */
	async #applyServerCapture(request: CaptureTaskRequest): Promise<CaptureTaskRequest> {
		const capture = request.capture;
		const service = this.#captureService;
		if (!capture || !service) return request;
		const packet = await service.capture({
			mode: capture.mode,
			userRequest: request.instruction,
			includeClipboard: capture.includeClipboard ?? true,
			...(capture.region !== undefined ? { region: capture.region } : {}),
		});
		let screenshot = request.screenshot;
		if (packet.visual.screenshotPath) {
			const bytes = await Bun.file(packet.visual.screenshotPath).bytes();
			if (bytes.byteLength > 0 && bytes.byteLength <= this.#maxScreenshotBytes) {
				screenshot = { mimeType: "image/png", data: bytes.toBase64() };
			}
		}
		const selectedText = request.selectedText ?? packet.selection.text ?? packet.selection.clipboardText;
		return {
			...request,
			...(screenshot !== undefined ? { screenshot } : {}),
			...(selectedText !== undefined ? { selectedText } : {}),
			source: {
				...request.source,
				...(request.source.application === undefined && packet.foregroundApp.processName !== undefined
					? { application: packet.foregroundApp.processName }
					: {}),
				...(request.source.windowTitle === undefined && packet.foregroundApp.windowTitle !== undefined
					? { windowTitle: packet.foregroundApp.windowTitle }
					: {}),
				...(request.source.url === undefined && packet.browser.url !== undefined
					? { url: packet.browser.url }
					: {}),
			},
			annotations: [...(request.annotations ?? []), ...packet.visual.annotations],
		};
	}

	async #dispatchResume(runId: string, turn: PendingTurn): Promise<void> {
		const run = this.#store.getRun(runId);
		if (!run || (!run.sessionId && !run.sessionFile)) {
			throw new Error("The mapped session no longer exists.");
		}
		const handle = await this.#runner.resumeSession(
			{ sessionId: run.sessionId ?? "", sessionFile: run.sessionFile },
			{ message: turn.message, ...(turn.images ? { images: turn.images } : {}) },
		);
		this.#store.updateRun(runId, {
			sessionId: handle.session.sessionId,
			...(handle.session.sessionFile !== undefined ? { sessionFile: handle.session.sessionFile } : {}),
		});
		// A resumed run leaves its terminal state so /status and cancel behave.
		this.#transition(runId, "starting");
		this.#consume(runId, handle);
	}

	/** Pump runner events for one dispatched turn into persistence + subscribers. */
	#consume(runId: string, handle: RunnerRunHandle): void {
		const state = this.#ensureState(runId);
		state.activeRunnerRunId = handle.runnerRunId;
		state.resultText = "";

		const pump = async (): Promise<void> => {
			for await (const event of handle.events) {
				switch (event.type) {
					case "agent_start":
						this.#transition(runId, "running");
						break;
					case "text_delta":
						state.resultText = (state.resultText + event.text).slice(-MAX_RESULT_CHARS);
						state.channel.push({ seq: 0, event: { type: "run.message.delta", runId, text: event.text } });
						break;
					case "tool_start":
						this.#publish(runId, {
							type: "run.tool",
							runId,
							toolName: event.toolName,
							phase: "started",
							summary: summarizeToolUse(event.toolName),
						});
						break;
					case "tool_end":
						if (event.isError) {
							this.#publish(runId, {
								type: "run.tool",
								runId,
								toolName: event.toolName,
								phase: "completed",
								isError: true,
								summary: `${summarizeToolUse(event.toolName)} (failed)`,
							});
						}
						break;
					case "agent_end": {
						if (event.session) {
							this.#store.updateRun(runId, {
								sessionId: event.session.sessionId,
								...(event.session.sessionFile !== undefined ? { sessionFile: event.session.sessionFile } : {}),
							});
						}
						const cancelled = this.#runner.getRunStatus(handle.runnerRunId) === "cancelled";
						const status: CaptureRunStatus = cancelled ? "cancelled" : event.hasError ? "failed" : "completed";
						await this.#finishTurn(runId, status, event.error);
						// The turn is settled; ignore any further events from this handle
						// (a fatal is followed by agent_end) so #finishTurn runs once.
						return;
					}
					case "fatal":
						await this.#finishTurn(runId, "failed", event.error);
						return;
				}
			}
		};

		void pump().catch(async error => {
			const message = error instanceof Error ? error.message : String(error);
			logger.error("Capture event pump failed", { runId, error: message });
			await this.#finishTurn(runId, "failed", message);
		});
	}

	async #finishTurn(runId: string, status: CaptureRunStatus, error?: string): Promise<void> {
		const state = this.#ensureState(runId);
		state.activeRunnerRunId = undefined;

		const resultText = state.resultText.trim();
		state.resultText = "";
		if (status === "completed") this.metrics.runsCompleted += 1;
		if (status === "failed") this.metrics.runsFailed += 1;
		if (status === "cancelled") this.metrics.runsCancelled += 1;

		if (status === "cancelled") state.queue.length = 0;
		const next = state.queue.shift();

		// Publish the turn result before any terminal transition so live
		// subscribers observe it on a still-open channel.
		const run = this.#store.getRun(runId);
		if (run) {
			const text =
				resultText.length > 0
					? sanitizeForCollaboration(resultText)
					: error
						? sanitizeForCollaboration(`Task ${status}: ${error}`)
						: `Task ${status}.`;
			if (resultText.length > 0) this.#publish(runId, { type: "run.result", runId, text });
			await this.#deliver(adapter => adapter.publishResult(run, { status, text }));
		}

		if (next) {
			// More turns are queued: stay in the conversation instead of terminalizing.
			if (resultText.length > 0) this.#store.updateRun(runId, { resultSummary: resultText });
			try {
				await this.#dispatchResume(runId, next);
				return;
			} catch (resumeError) {
				const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
				this.#transition(runId, "failed", { error: `Failed to resume session: ${message}` });
				state.channel.close();
				this.#runs.delete(runId);
				return;
			}
		}

		this.#transition(runId, status, {
			error,
			resultSummary: resultText.length > 0 ? resultText : undefined,
		});
		state.channel.close();
		this.#runs.delete(runId);
	}

	async #resolveScreenshot(
		runId: string,
		request: CaptureTaskRequest,
	): Promise<
		{ assetId: string; image: ImageContent; bytes: Uint8Array; mimeType: CaptureScreenshotMimeType } | undefined
	> {
		const screenshot = request.screenshot;
		if (!screenshot) return undefined;
		try {
			if (screenshot.data) {
				const bytes = Uint8Array.fromBase64(screenshot.data);
				if (bytes.byteLength === 0 || bytes.byteLength > this.#maxScreenshotBytes) return undefined;
				const asset = await this.#store.saveAsset(bytes, screenshot.mimeType, {
					runId,
					...(screenshot.width !== undefined ? { width: screenshot.width } : {}),
					...(screenshot.height !== undefined ? { height: screenshot.height } : {}),
				});
				return {
					assetId: asset.id,
					bytes,
					mimeType: screenshot.mimeType,
					image: { type: "image", data: screenshot.data, mimeType: screenshot.mimeType, detail: "high" },
				};
			}
			if (screenshot.storageRef) {
				const stored = await this.#store.readAssetBytes(screenshot.storageRef);
				if (!stored) return undefined;
				return {
					assetId: stored.asset.id,
					bytes: stored.bytes,
					mimeType: stored.asset.mimeType,
					image: {
						type: "image",
						data: stored.bytes.toBase64(),
						mimeType: stored.asset.mimeType,
						detail: "high",
					},
				};
			}
		} catch (error) {
			logger.error("Failed to resolve capture screenshot", {
				runId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return undefined;
	}

	async #publishTask(
		runId: string,
		screenshot?: { bytes: Uint8Array; mimeType: CaptureScreenshotMimeType },
	): Promise<void> {
		const run = this.#store.getRun(runId);
		if (!run || run.telegramRootMessageId) return;
		await this.#deliver(async adapter => {
			const ref = await adapter.publishTask(run, screenshot);
			if (ref) {
				this.#store.updateRun(runId, {
					telegramChatId: ref.channelId,
					telegramRootMessageId: ref.messageId,
					...(ref.topicId !== undefined ? { telegramTopicId: ref.topicId } : {}),
				});
				this.#store.recordCollabMessage(adapter.id, ref.channelId, ref.messageId, runId, "root", ref.topicId);
			}
		});
	}

	#ensureState(runId: string): RunState {
		let state = this.#runs.get(runId);
		if (!state) {
			state = {
				channel: new ReplayChannel<LiveRunEvent>(),
				cancelRequested: false,
				resultText: "",
				queue: [],
			};
			this.#runs.set(runId, state);
		}
		return state;
	}

	#transition(
		runId: string,
		status: CaptureRunStatus,
		options: { error?: string; resultSummary?: string; detail?: string } = {},
	): void {
		const current = this.#store.getRun(runId);
		if (!current) return;
		// A run leaving the failed state (e.g. a resumed run moving to starting) must
		// not keep its stale error; clear it unless this transition sets a new one.
		const clearsError = options.error === undefined && status !== "failed" && current.error !== undefined;
		this.#store.updateRun(runId, {
			status,
			...(options.error !== undefined ? { error: options.error } : clearsError ? { error: null } : {}),
			...(options.resultSummary !== undefined ? { resultSummary: options.resultSummary } : {}),
		});
		this.#publish(runId, {
			type: "run.status",
			runId,
			status,
			...(options.detail !== undefined || options.error !== undefined
				? { detail: options.detail ?? options.error }
				: {}),
		});
		logger.info("Capture run status", { runId, status, sessionLabel: shortSessionLabel(current) });
	}

	/** Persist (when applicable), stream to subscribers, and mirror to adapters. */
	#publish(runId: string, event: CaptureRunEvent): void {
		const state = this.#ensureState(runId);
		let seq = 0;
		if (isPersistedRunEvent(event)) {
			seq = this.#store.appendEvent(runId, event);
		}
		state.channel.push({ seq, event });

		const run = this.#store.getRun(runId);
		if (run && event.type !== "run.result") {
			void this.#deliver(adapter => adapter.publishEvent(run, event));
		}
	}

	async #deliver(action: (adapter: CollaborationAdapter) => Promise<unknown>): Promise<void> {
		for (const adapter of this.#adapters) {
			try {
				await action(adapter);
			} catch (error) {
				this.metrics.collaborationDeliveryFailures += 1;
				logger.error("Collaboration adapter delivery failed", {
					adapter: adapter.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}
