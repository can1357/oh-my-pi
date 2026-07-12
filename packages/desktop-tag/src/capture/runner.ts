/**
 * Runner adapter: executes capture turns inside the existing oh-my-pk
 * AgentSession infrastructure through the transport-neutral
 * AgentSessionGateway. Sessions persist as JSONL files via SessionManager, so
 * a run can be resumed after any process restart from its session file alone.
 */
import { type CreateAgentSessionOptions, createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent";
import { AgentSessionGateway } from "@pk-nerdsaver-ai/pi-coding-agent/gateway/agent-session-gateway";
import type { GatewayCommand, GatewayEventListener } from "@pk-nerdsaver-ai/pi-coding-agent/gateway/types";
import { resolveResumableSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-listing";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { resolveUnrestrictedToolProfile } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { getProjectDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import * as logger from "@pk-nerdsaver-ai/pi-utils/logger";

import { type CapabilityRegistry, createDefaultRegistry } from "../router";
import { ReplayChannel } from "./queue";
import type {
	CaptureRunnerAdapter,
	CaptureTurnInput,
	CreateCaptureSessionInput,
	RunnerEvent,
	RunnerInfo,
	RunnerRunHandle,
	RunnerRunStatus,
	RunnerSessionRef,
} from "./types";

/** Minimal session surface the adapter needs; AgentSession satisfies it structurally. */
export interface RunnerSessionHost {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	sessionManager: { flush(): Promise<void>; getCwd(): string };
	dispose(): Promise<void>;
}

export interface RunnerGateway {
	dispatch(command: GatewayCommand): Promise<void>;
	subscribe(listener: GatewayEventListener): () => void;
	dispose(): void;
}

export interface RunnerRuntime {
	session: RunnerSessionHost;
	gateway: RunnerGateway;
}

export type CreateRuntimeFactory = (input: CreateCaptureSessionInput) => Promise<RunnerRuntime>;
export type ResumeRuntimeFactory = (session: RunnerSessionRef) => Promise<RunnerRuntime>;

export interface PiRunnerAdapterOptions {
	createRuntime?: CreateRuntimeFactory;
	resumeRuntime?: ResumeRuntimeFactory;
	registry?: CapabilityRegistry;
	autoApprove?: boolean;
	appendSystemPrompt?: string;
}

const CAPTURE_SYSTEM_PROMPT = [
	"You are handling a capture-to-agent task: the user captured desktop context and delegated work to you.",
	"Progress summaries from this session are mirrored to the user's team chat, so keep assistant messages concise and readable.",
	"Never include credentials, API keys, or environment variable values in assistant messages.",
].join("\n");

interface ActiveRun {
	readonly runnerRunId: string;
	readonly channel: ReplayChannel<RunnerEvent>;
	readonly runtime: RunnerRuntime;
	status: RunnerRunStatus;
	assistantError?: string;
	settled: boolean;
	cancelling: boolean;
	unsubscribe?: () => void;
}

export class PiRunnerAdapter implements CaptureRunnerAdapter {
	readonly #runs = new Map<string, ActiveRun>();
	readonly #createRuntime: CreateRuntimeFactory;
	readonly #resumeRuntime: ResumeRuntimeFactory;
	readonly #registry: CapabilityRegistry;

	constructor(options: PiRunnerAdapterOptions = {}) {
		const autoApprove = options.autoApprove ?? true;
		const appendSystemPrompt = options.appendSystemPrompt ?? CAPTURE_SYSTEM_PROMPT;
		this.#createRuntime =
			options.createRuntime ?? (input => defaultCreateRuntime(input, autoApprove, appendSystemPrompt));
		this.#resumeRuntime =
			options.resumeRuntime ?? (ref => defaultResumeRuntime(ref, autoApprove, appendSystemPrompt));
		this.#registry = options.registry ?? createDefaultRegistry();
	}

	async createSession(input: CreateCaptureSessionInput): Promise<RunnerRunHandle> {
		const runtime = await this.#createRuntime(input);
		return this.#dispatchTurn(runtime, { message: input.message, images: input.images });
	}

	async resumeSession(session: RunnerSessionRef, input: CaptureTurnInput): Promise<RunnerRunHandle> {
		const runtime = await this.#resumeRuntime(session);
		if (session.sessionId && runtime.session.sessionId !== session.sessionId) {
			logger.warn("Resumed capture session id differs from mapping", {
				expected: session.sessionId,
				actual: runtime.session.sessionId,
			});
		}
		return this.#dispatchTurn(runtime, input);
	}

	#dispatchTurn(runtime: RunnerRuntime, input: CaptureTurnInput): RunnerRunHandle {
		this.#trimSettledRuns();
		const runnerRunId = crypto.randomUUID();
		const channel = new ReplayChannel<RunnerEvent>();
		const run: ActiveRun = {
			runnerRunId,
			channel,
			runtime,
			status: "running",
			settled: false,
			cancelling: false,
		};
		this.#runs.set(runnerRunId, run);

		run.unsubscribe = runtime.gateway.subscribe(event => {
			if (run.settled) return;
			switch (event.type) {
				case "ready":
					return;
				case "session_event": {
					const sessionEvent = event.event;
					switch (sessionEvent.type) {
						case "agent_start":
							channel.push({ type: "agent_start" });
							return;
						case "assistant_text_delta":
							channel.push({ type: "text_delta", text: sessionEvent.text });
							return;
						case "tool_start":
							channel.push({
								type: "tool_start",
								toolCallId: sessionEvent.toolCallId,
								toolName: sessionEvent.toolName,
							});
							return;
						case "tool_end":
							channel.push({
								type: "tool_end",
								toolCallId: sessionEvent.toolCallId,
								toolName: sessionEvent.toolName,
								isError: sessionEvent.isError,
							});
							return;
						case "assistant_end":
							run.assistantError = sessionEvent.hasError ? "Assistant turn ended with an error." : undefined;
							return;
						case "agent_end":
							void this.#settle(run, run.cancelling ? "cancelled" : run.assistantError ? "failed" : "completed");
							return;
						default:
							return;
					}
				}
				case "response":
					if (!event.success) void this.#fail(run, event.error);
					return;
				case "protocol_error":
					void this.#fail(run, event.error);
					return;
				default:
					return;
			}
		});

		void runtime.gateway
			.dispatch({
				id: crypto.randomUUID(),
				type: "prompt",
				identity: { channelId: "capture", sessionKey: runnerRunId },
				message: input.message,
				...(input.images && input.images.length > 0 ? { images: input.images } : {}),
			})
			.catch(error => this.#fail(run, error instanceof Error ? error.message : String(error)));

		return {
			runnerRunId,
			session: { sessionId: runtime.session.sessionId, sessionFile: runtime.session.sessionFile },
			events: channel.subscribe(),
		};
	}

	async cancelRun(runnerRunId: string): Promise<void> {
		const run = this.#runs.get(runnerRunId);
		if (!run || run.settled) return;
		run.cancelling = true;
		try {
			await run.runtime.gateway.dispatch({
				id: crypto.randomUUID(),
				type: "abort",
				identity: { channelId: "capture", sessionKey: runnerRunId },
			});
		} catch (error) {
			logger.debug("Capture run abort dispatch failed", {
				runnerRunId,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			await this.#settle(run, "cancelled");
		}
	}

	getRunStatus(runnerRunId: string): RunnerRunStatus {
		return this.#runs.get(runnerRunId)?.status ?? "unknown";
	}

	async listRunners(): Promise<RunnerInfo[]> {
		return this.#registry.listExecutors().map(executor => ({
			id: executor.id,
			name: executor.name,
			location: executor.location,
			available: executor.available,
		}));
	}

	async #fail(run: ActiveRun, error: string): Promise<void> {
		if (run.settled) return;
		run.channel.push({ type: "fatal", error });
		await this.#settle(run, "failed", error);
	}

	async #settle(
		run: ActiveRun,
		status: Exclude<RunnerRunStatus, "running" | "unknown">,
		error?: string,
	): Promise<void> {
		if (run.settled) return;
		run.settled = true;
		run.status = status;
		run.unsubscribe?.();

		let persistError: string | undefined;
		try {
			await run.runtime.session.sessionManager.flush();
		} catch (flushError) {
			persistError = flushError instanceof Error ? flushError.message : String(flushError);
			logger.error("Failed to flush capture session", { runnerRunId: run.runnerRunId, error: persistError });
		}

		const finalError = error ?? run.assistantError ?? persistError;
		run.channel.push({
			type: "agent_end",
			hasError: status === "failed" || persistError !== undefined,
			...(finalError !== undefined ? { error: finalError } : {}),
			session: {
				sessionId: run.runtime.session.sessionId,
				...(run.runtime.session.sessionFile !== undefined ? { sessionFile: run.runtime.session.sessionFile } : {}),
			},
		});
		run.channel.close();
		try {
			run.runtime.gateway.dispose();
		} catch (disposeError) {
			logger.error("Failed to dispose capture gateway", {
				runnerRunId: run.runnerRunId,
				error: disposeError instanceof Error ? disposeError.message : String(disposeError),
			});
		}
		try {
			await run.runtime.session.dispose();
		} catch (disposeError) {
			logger.error("Failed to dispose capture session", {
				runnerRunId: run.runnerRunId,
				error: disposeError instanceof Error ? disposeError.message : String(disposeError),
			});
		}
		// Keep terminal runs addressable for late status queries; #trimSettledRuns bounds the map.
	}

	/** Bound memory: drop the oldest settled runs once the registry grows large. */
	#trimSettledRuns(maxEntries = 256): void {
		if (this.#runs.size < maxEntries) return;
		for (const [id, run] of this.#runs) {
			if (this.#runs.size < maxEntries) return;
			if (run.settled) this.#runs.delete(id);
		}
	}
}

async function defaultCreateRuntime(
	input: CreateCaptureSessionInput,
	autoApprove: boolean,
	appendSystemPrompt: string,
): Promise<RunnerRuntime> {
	const options: CreateAgentSessionOptions = {
		cwd: input.cwd ?? getProjectDir(),
		toolProfile: resolveUnrestrictedToolProfile(),
		appendSystemPrompt,
		autoApprove,
		...(input.displayName !== undefined ? { agentDisplayName: input.displayName } : {}),
		...(input.modelPreference !== undefined ? { modelPattern: input.modelPreference } : {}),
	};
	const { session } = await createAgentSession(options);
	return { session, gateway: new AgentSessionGateway(session) };
}

async function defaultResumeRuntime(
	ref: RunnerSessionRef,
	autoApprove: boolean,
	appendSystemPrompt: string,
): Promise<RunnerRuntime> {
	let sessionFile = ref.sessionFile;
	if (!sessionFile) {
		const match = await resolveResumableSession(ref.sessionId, getProjectDir());
		sessionFile = match?.session.path;
	}
	if (!sessionFile) {
		throw new Error(`Session ${ref.sessionId} could not be resolved to a persisted session file`);
	}
	const sessionManager = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
	const { session } = await createAgentSession({
		sessionManager,
		cwd: sessionManager.getCwd(),
		toolProfile: resolveUnrestrictedToolProfile(),
		appendSystemPrompt,
		autoApprove,
	});
	return { session, gateway: new AgentSessionGateway(session) };
}
