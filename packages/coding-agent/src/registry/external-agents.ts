/**
 * External agents: agents an extension runs outside this process (a remote
 * host, a job queue), shown and driven like subagents.
 *
 * Each one is an `external` registry ref owned by the registering session's
 * agent and backed by an `extension` job of that agent, so `wait`, `cancel`,
 * `proc://` and result delivery treat it like a background subagent. Its
 * lifecycle and progress go out as `task:subagent:*` frames, which the
 * subagent HUD and RPC subagent channels read.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, type AsyncJobManagerApi, formatAsyncJobLabel } from "../async/job-manager";
import { sanitizeDisplayLine } from "../extensibility/inventory/display-text";
import { generateTaskName } from "../task/name-generator";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../task/session-observer-registry";
import type { AgentRegistryApi, AgentStatus, ExternalAgentExecution, ExternalTranscriptPage } from "./agent-registry";

/** An agent an extension runs elsewhere, as `ctx.agents.registerExternal` takes it. */
export interface ExternalAgentSpec {
	/** What it works on; the roster, the subagent HUD and the job list show it. */
	label: string;
	/** Where it runs, and the model and reasoning level it started on, when known. */
	execution: ExternalAgentExecution & { model?: string; thinking?: string };
	/** Its transcript as session JSONL lines from byte `fromByte`; see {@link ExternalTranscriptPage}. */
	readTranscript(fromByte: number, signal?: AbortSignal): Promise<ExternalTranscriptPage>;
	/** Deliver a message: `steer` while it runs, `follow_up` once idle. Without it, it takes no messages. */
	steer?(text: string, mode: "steer" | "follow_up"): Promise<void>;
	/** Stop it for good; called once, when the agent or the user cancels it here. */
	cancel?(): Promise<void>;
}

/** What `ctx.agents.registerExternal` returns. */
export interface ExternalAgentHandle {
	/** Registry id that `agent://`, `wait`, `cancel` and the roster use. */
	readonly id: string;
	/** Report its state, current activity, and observed model or reasoning level. Ignored once it settled. */
	update(patch: { status?: "running" | "idle"; progress?: string; model?: string; thinking?: string }): void;
	/** Settle it and deliver `text` to the owning agent. Only the first call counts, and none after a cancel. */
	complete(result: { status: "done" | "failed" | "cancelled"; text: string }): void;
}

/** Where {@link registerExternalAgent} registers. */
export interface ExternalAgentHost {
	registry: AgentRegistryApi;
	jobs: AsyncJobManagerApi;
	/** Agent that owns it: waits on it, receives its result, and may cancel it. */
	ownerId: string;
	/** Publish a `task:subagent:*` frame on the session's buses. */
	emitFrame(channel: string, payload: unknown): void;
}

function displayLine(text: string): string {
	return formatAsyncJobLabel(sanitizeDisplayLine(text));
}

function modelSelector(model: string | undefined, thinking: string | undefined): string | undefined {
	return model && thinking ? `${model}:${thinking}` : model;
}

/** Register `spec` as an external agent of `host.ownerId`; throws when the running-job limit is reached. */
export function registerExternalAgent(host: ExternalAgentHost, spec: ExternalAgentSpec): ExternalAgentHandle {
	const { registry, jobs, ownerId, emitFrame } = host;
	const label = displayLine(spec.label);
	const execution: ExternalAgentExecution = {
		backend: displayLine(spec.execution.backend),
		jobId: displayLine(spec.execution.jobId),
		...(spec.execution.machine ? { machine: displayLine(spec.execution.machine) } : {}),
	};
	const agent = execution.machine ? `${execution.backend}@${execution.machine}` : execution.backend;
	let model = spec.execution.model ? displayLine(spec.execution.model) : undefined;
	let thinking = spec.execution.thinking ? displayLine(spec.execution.thinking) : undefined;
	let progress: string | undefined;
	let id = generateTaskName();
	while (registry.get(id)) id = generateTaskName();
	const startedAt = Date.now();
	const outcome = Promise.withResolvers<string>();
	const steer = spec.steer?.bind(spec);
	// Set once it settled: a finished agent takes no more messages.
	let settled = false;

	const ref = registry.register({
		id,
		displayName: label,
		kind: "external",
		parentId: ownerId,
		session: null,
		status: "running",
		execution,
		history: { resolvedModel: modelSelector(model, thinking) },
		// Async, so an extension's synchronous throw reaches callers as a rejection.
		external: {
			readTranscript: async (fromByte, signal) => spec.readTranscript(fromByte, signal),
			steer:
				steer &&
				(async text => {
					if (settled) throw new Error(`External agent ${id} has finished; register a new one to continue.`);
					await steer(text, registry.get(id)?.status === "running" ? "steer" : "follow_up");
				}),
		},
	});

	const lifecycle = (status: SubagentLifecyclePayload["status"]): void => {
		const payload: SubagentLifecyclePayload = {
			id,
			agent,
			agentSource: "user",
			description: label,
			status,
			index: 0,
			detached: true,
		};
		emitFrame(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
	};
	const report = (): void => {
		const resolvedModel = modelSelector(model, thinking);
		const payload: SubagentProgressPayload = {
			index: 0,
			agent,
			agentSource: "user",
			task: label,
			detached: true,
			progress: {
				index: 0,
				id,
				agent,
				agentSource: "user",
				status: "running",
				task: label,
				description: label,
				...(progress ? { lastIntent: progress } : {}),
				...(resolvedModel ? { resolvedModel } : {}),
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: Date.now() - startedAt,
			},
		};
		emitFrame(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
	};

	const settle = (status: AgentStatus, frame?: SubagentLifecyclePayload["status"]): boolean => {
		if (settled) return false;
		settled = true;
		unsubscribe();
		registry.setStatus(id, status, ref);
		if (frame) lifecycle(frame);
		return true;
	};

	let jobId: string;
	let reportJobProgress: ((text: string) => Promise<void>) | undefined;
	try {
		jobId = jobs.register(
			"extension",
			label,
			({ signal, reportProgress }) => {
				reportJobProgress = reportProgress;
				const onAbort = (): void => {
					// Session shutdown leaves the remote work running and only detaches it here.
					const shutdown = signal.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON;
					if (settle(shutdown ? "parked" : "aborted", shutdown ? undefined : "aborted") && !shutdown) {
						void (async () => {
							try {
								await spec.cancel?.();
							} catch (error) {
								logger.warn("External agent cancel failed", { id, error: String(error) });
							}
						})();
					}
					outcome.reject(signal.reason);
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				return outcome.promise;
			},
			{ id, ownerId, agentId: id },
		);
	} catch (error) {
		registry.unregister(id, ref);
		throw error;
	}
	// A kill that reaches only the registry (the Agent Hub, a lifecycle release) cancels the backing job.
	const unsubscribe = registry.onChange(event => {
		if (event.ref.id !== id || event.ref.generation !== ref.generation) return;
		if (event.type === "removed" || (event.type === "status_changed" && event.ref.status === "aborted")) {
			jobs.cancel(jobId, { ownerId });
		}
	});
	lifecycle("started");
	report();

	return {
		id,
		update(patch) {
			if (settled) return;
			if (patch.model !== undefined) model = displayLine(patch.model);
			if (patch.thinking !== undefined) thinking = displayLine(patch.thinking);
			if (patch.model !== undefined || patch.thinking !== undefined) {
				registry.setHistory(id, { resolvedModel: modelSelector(model, thinking) });
			}
			if (patch.status) registry.setStatus(id, patch.status, ref);
			if (patch.progress !== undefined) {
				progress = displayLine(patch.progress);
				registry.setActivity(id, progress, ref);
				void reportJobProgress?.(progress);
			}
			report();
		},
		complete(result) {
			if (result.status === "done") {
				if (settle("idle", "completed")) outcome.resolve(result.text);
			} else if (settle("aborted", result.status === "failed" ? "failed" : "aborted")) {
				outcome.reject(new Error(result.text));
			}
		},
	};
}
