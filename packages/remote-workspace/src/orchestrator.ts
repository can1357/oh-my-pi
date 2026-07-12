/**
 * RemoteWorkspaceOrchestrator — Phase 1 thin vertical slice.
 *
 * Lifecycle:
 *   submit → authorize → provision → clone → install → run_agent
 *     → validate → checkpoint → clean → succeed/fail
 *
 * The orchestrator owns all state transitions. It calls the backend for
 * resource operations and persists every mutation to the job store before
 * proceeding. Cleanup always runs — even on failure — to avoid orphan
 * resources on the MSI.
 */

import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type {
	CleanupResult,
	ExecutionBackend,
	RuntimeHandle,
	WorkspaceArtifacts,
	WorkspaceLaunchSpec,
} from "./backend/types";
import { JobStore } from "./db/job-store";
import { allResourcesCleaned, markResourceCleaned, registerResource, transition } from "./job/state-machine";
import {
	type CleanupProof,
	createJob,
	type JobLimits,
	type JobSource,
	type JobTask,
	type RemoteJobV1,
	type TerminalJobState,
} from "./job/types";

export interface OrchestratorOptions {
	readonly dbPath: string;
	readonly backend: ExecutionBackend;
	readonly defaultImage?: string;
	/** Enables remote cloning only through a backend-enforced restricted network. */
	readonly networkEgress?: "none" | "restricted";
}

export interface SubmitJobInput {
	readonly source: JobSource;
	readonly task: JobTask;
	readonly limits?: Partial<JobLimits>;
}

export interface JobRunSummary {
	readonly jobId: string;
	readonly state: RemoteJobV1["state"];
	readonly outcomeState?: Exclude<TerminalJobState, "cleanup_failed">;
	readonly exitCode?: number;
	readonly agentExitCode?: number;
	readonly validationExitCode?: number;
	readonly patch?: string;
	readonly logs: string;
	readonly durationMs: number;
	readonly cleanupProof?: CleanupProof;
}

const DEFAULT_LIMITS: JobLimits = Object.freeze({
	timeoutMs: 10 * 60 * 1000,
});

type JobOutcomeState = Exclude<TerminalJobState, "cleanup_failed">;

interface ActiveRun {
	readonly controller: AbortController;
	readonly job: RemoteJobV1;
	runtime?: RuntimeHandle;
	terminationRequested: boolean;
	finalization?: Promise<void>;
}

class JobRunFailure extends Error {
	readonly outcomeState: JobOutcomeState;
	readonly artifacts?: WorkspaceArtifacts;

	constructor(outcomeState: JobOutcomeState, message: string, artifacts?: WorkspaceArtifacts) {
		super(message);
		this.name = "JobRunFailure";
		this.outcomeState = outcomeState;
		this.artifacts = artifacts;
	}
}

export class RemoteWorkspaceOrchestrator {
	readonly #store: JobStore;
	readonly #backend: ExecutionBackend;
	readonly #defaultImage: string;
	readonly #networkEgress: "none" | "restricted";
	readonly #activeRuns = new Map<string, ActiveRun>();
	readonly #cleanupPromises = new Map<string, Promise<void>>();

	constructor(opts: OrchestratorOptions) {
		this.#store = new JobStore({ path: opts.dbPath });
		this.#backend = opts.backend;
		this.#defaultImage = opts.defaultImage ?? "oh-my-pi/pi:dev";
		this.#networkEgress = opts.networkEgress ?? "none";
	}

	/** Submit a new job — returns immediately with the job id. */
	submit(input: SubmitJobInput): RemoteJobV1 {
		const limits: JobLimits = { ...DEFAULT_LIMITS, ...input.limits };
		const job = createJob({
			source: input.source,
			task: input.task,
			limits,
			backendId: this.#backend.id,
		});
		this.#store.upsert(job);
		logger.info("orchestrator: job submitted", { jobId: job.id });
		return job;
	}

	/** Run a job to completion synchronously. Returns a durable summary. */
	async run(jobId: string): Promise<JobRunSummary> {
		const job = this.#store.get(jobId);
		if (!job) throw new Error(`Job ${jobId} not found`);
		const startMs = Date.now();
		if (job.state !== "queued") return this.#summary(job, startMs, "Job was not queued for execution");

		const activeRun: ActiveRun = { controller: new AbortController(), job, terminationRequested: false };
		this.#activeRuns.set(job.id, activeRun);
		let runtime: RuntimeHandle | undefined;
		try {
			await this.#authorize(job);
			if (this.#cancellationRequested(job) || activeRun.controller.signal.aborted) {
				return this.#summary(this.#store.get(job.id) ?? job, startMs, "Job cancelled by user");
			}
			runtime = await this.#provision(job);
			activeRun.runtime = runtime;
			return await this.#execute(job, runtime, activeRun.controller, startMs);
		} catch (error) {
			const failure = this.#asJobRunFailure(job, error);
			return this.#finish(job, failure.outcomeState, failure.message, startMs, runtime, failure.artifacts);
		} finally {
			this.#activeRuns.delete(job.id);
		}
	}

	getJob(id: string): RemoteJobV1 | undefined {
		return this.#store.get(id);
	}

	listJobs(): RemoteJobV1[] {
		return this.#store.all();
	}

	/** Cancel an active job and wait for its resources to be released or proven unreleased. */
	async cancel(jobId: string): Promise<boolean> {
		const activeRun = this.#activeRuns.get(jobId);
		const job = activeRun?.job ?? this.#store.get(jobId);
		if (!job || job.state === "cleaning") return false;
		const transitionResult = transition(job, "cancelled", "user", "user requested cancellation");
		if (!transitionResult.ok) return false;
		job.outcomeState = "cancelled";
		if (!this.#store.upsert(job)) return false;

		if (activeRun) {
			activeRun.terminationRequested = true;
			activeRun.controller.abort(new Error("Job cancelled by user"));
		}
		const runtime = activeRun?.runtime ?? this.#rebuildHandle(job);
		const hasRuntimeResources =
			activeRun?.runtime !== undefined || job.workerId !== undefined || job.resources.length > 0;
		if (!hasRuntimeResources) return true;

		const finalization = this.#terminateAndCleanup(job, "cancelled", runtime);
		if (activeRun) activeRun.finalization = finalization;
		await finalization;
		return true;
	}

	close(): void {
		this.#store.close();
	}

	// ── Private steps ──────────────────────────────────────────────────────────

	async #authorize(job: RemoteJobV1): Promise<void> {
		this.#step(job, "authorizing", "authorization check");
		this.#step(job, "planning", "authorization passed — generating plan");
		this.#step(job, "plan_auditing", "auditing plan");
	}

	async #provision(job: RemoteJobV1): Promise<RuntimeHandle> {
		this.#step(job, "provisioning", "launching worker");
		const spec: WorkspaceLaunchSpec = {
			jobId: job.id,
			image: this.#defaultImage,
			repoUrl: job.source.repoUrl,
			ref: job.source.ref,
			taskPrompt: job.task.prompt,
			validationCommands: job.task.validationCommands,
			timeoutMs: job.limits.timeoutMs,
			labels: { "ompk.job_id": job.id },
			networkEgress: this.#networkEgress,
		};

		const runtime = await this.#backend.launch(spec);
		if (this.#cancellationRequested(job)) {
			const cancelledJob = this.#store.get(job.id);
			if (cancelledJob) {
				this.#registerRuntimeResources(cancelledJob, runtime);
				await this.#terminateAndCleanup(cancelledJob, "cancelled", runtime);
			} else {
				try {
					await this.#backend.terminate(runtime);
				} finally {
					await this.#backend.cleanup(runtime);
				}
			}
			throw new JobRunFailure("cancelled", "Job cancelled by user");
		}
		this.#registerRuntimeResources(job, runtime);
		this.#store.upsert(job);
		this.#step(job, "cloning", "container started — cloning repo");
		this.#step(job, "installing", "repo cloned — installing deps");
		this.#step(job, "running_agent", "deps installed — running agent");
		return runtime;
	}

	async #execute(
		job: RemoteJobV1,
		runtime: RuntimeHandle,
		controller: AbortController,
		startMs: number,
	): Promise<JobRunSummary> {
		let clearTimeoutHandle: (() => void) | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			const timeoutHandle = setTimeout(() => {
				controller.abort(new Error(`Job timed out after ${job.limits.timeoutMs}ms`));
				reject(new JobRunFailure("timed_out", `Job timed out after ${job.limits.timeoutMs}ms`));
			}, job.limits.timeoutMs);
			clearTimeoutHandle = () => clearTimeout(timeoutHandle);
		});

		const artifactCollection = this.#backend.collectArtifacts(runtime, { signal: controller.signal });
		void artifactCollection.catch(() => undefined);
		const artifacts = await Promise.race([artifactCollection, timeout]).finally(() => clearTimeoutHandle?.());

		if (this.#cancellationRequested(job) || controller.signal.aborted) {
			throw new JobRunFailure("cancelled", "Job cancelled by user", artifacts);
		}

		this.#step(job, "validating", `container exited with code ${artifacts.exitCode}`);
		job.agentExitCode = artifacts.agentExitCode;
		job.validationExitCode = artifacts.validationExitCode;
		this.#store.upsert(job);

		if (artifacts.agentExitCode !== undefined && artifacts.agentExitCode !== 0) {
			throw new JobRunFailure("failed", `Agent exited with code ${artifacts.agentExitCode}`, artifacts);
		}
		if (artifacts.validationExitCode !== undefined && artifacts.validationExitCode !== 0) {
			throw new JobRunFailure("failed", `Validation exited with code ${artifacts.validationExitCode}`, artifacts);
		}
		if (artifacts.exitCode !== 0) {
			throw new JobRunFailure("failed", `Container exited with code ${artifacts.exitCode}`, artifacts);
		}

		this.#step(job, "checkpointing_result", "saving result");
		return this.#finish(job, "succeeded", "Job completed", startMs, runtime, artifacts);
	}

	async #finish(
		job: RemoteJobV1,
		outcomeState: JobOutcomeState,
		reason: string,
		startMs: number,
		runtime: RuntimeHandle | undefined,
		artifacts?: WorkspaceArtifacts,
	): Promise<JobRunSummary> {
		const persisted = this.#store.get(job.id);
		if (persisted && persisted.revision !== job.revision) {
			return this.#summary(persisted, startMs, reason, artifacts);
		}
		if (job.state !== "cleaning" && job.state !== outcomeState && job.state !== "cleanup_failed") {
			this.#step(job, outcomeState, reason);
		}
		job.outcomeState = outcomeState;
		if (outcomeState !== "succeeded") job.failureReason = reason;
		this.#store.upsert(job);
		const cleanupRuntime = runtime ?? this.#rebuildHandle(job);
		const activeRun = this.#activeRuns.get(job.id);
		if (activeRun?.finalization) {
			await activeRun.finalization;
			return this.#summary(job, startMs, reason, artifacts);
		}
		if (outcomeState !== "succeeded") {
			if (activeRun) activeRun.terminationRequested = true;
			await this.#terminateAndCleanup(job, outcomeState, cleanupRuntime);
		} else {
			await this.#cleanup(job, outcomeState, cleanupRuntime);
		}
		return this.#summary(job, startMs, reason, artifacts);
	}

	async #cleanup(
		job: RemoteJobV1,
		outcomeState: JobOutcomeState,
		runtime: RuntimeHandle,
		priorErrors: readonly string[] = [],
	): Promise<void> {
		const existing = this.#cleanupPromises.get(job.id);
		if (existing) return existing;
		const cleanup = this.#performCleanup(job, outcomeState, runtime, priorErrors);
		this.#cleanupPromises.set(job.id, cleanup);
		try {
			await cleanup;
		} finally {
			this.#cleanupPromises.delete(job.id);
		}
	}

	async #terminateAndCleanup(job: RemoteJobV1, outcomeState: JobOutcomeState, runtime: RuntimeHandle): Promise<void> {
		const cleanupErrors: string[] = [];
		try {
			await this.#backend.terminate(runtime);
		} catch (error) {
			cleanupErrors.push(`terminate failed: ${this.#errorMessage(error)}`);
		}
		await this.#cleanup(job, outcomeState, runtime, cleanupErrors);
	}

	async #performCleanup(
		job: RemoteJobV1,
		outcomeState: JobOutcomeState,
		runtime: RuntimeHandle,
		priorErrors: readonly string[],
	): Promise<void> {
		if (job.state !== "cleaning") {
			const transitionResult = transition(job, "cleaning", "orchestrator", "cleanup phase");
			if (!transitionResult.ok) return;
			this.#store.upsert(job);
		}

		let result: CleanupResult;
		const errors = [...priorErrors];
		try {
			result = await this.#backend.cleanup(runtime);
			errors.push(...result.errors);
		} catch (error) {
			errors.push(`cleanup failed: ${this.#errorMessage(error)}`);
			result = {
				containerGone: false,
				volumeGone: false,
				networkGone: false,
				workspaceDirGone: false,
				credentialRevoked: false,
				errors: [],
			};
		}

		this.#markVerifiedResourcesCleaned(job, result);
		job.cleanupProof = {
			verifiedAt: new Date().toISOString(),
			containerGone: result.containerGone,
			volumeGone: result.volumeGone,
			networkGone: result.networkGone,
			workspaceDirGone: result.workspaceDirGone,
			credentialRevoked: result.credentialRevoked,
			notes: errors.length > 0 ? errors.join("; ") : undefined,
		};

		const cleanupSucceeded =
			result.containerGone &&
			result.volumeGone &&
			result.networkGone &&
			result.workspaceDirGone &&
			result.credentialRevoked &&
			errors.length === 0 &&
			allResourcesCleaned(job);
		if (cleanupSucceeded) {
			this.#step(job, outcomeState, "all registered resources confirmed released");
		} else {
			this.#step(job, "cleanup_failed", "Cleanup could not be fully verified");
		}
		this.#store.upsert(job);
		logger.info("orchestrator: cleanup complete", { jobId: job.id, proof: job.cleanupProof });
	}

	#markVerifiedResourcesCleaned(job: RemoteJobV1, result: CleanupResult): void {
		for (const resource of job.resources) {
			const cleaned = (() => {
				switch (resource.kind) {
					case "container":
						return result.containerGone;
					case "volume":
						return result.volumeGone;
					case "network":
						return result.networkGone;
					case "tmpfs_secret":
						return result.workspaceDirGone;
					case "credential_lease":
						return result.credentialRevoked;
					case "process":
						return result.containerGone;
					case "port_proxy":
						return result.networkGone;
					case "branch":
						return false;
				}
			})();
			if (cleaned) markResourceCleaned(job, resource.id);
		}
	}

	#asJobRunFailure(job: RemoteJobV1, error: unknown): JobRunFailure {
		if (error instanceof JobRunFailure) return error;
		if (job.outcomeState === "cancelled" || job.state === "cancelled") {
			return new JobRunFailure("cancelled", this.#errorMessage(error));
		}
		return new JobRunFailure("failed", this.#errorMessage(error));
	}

	#summary(job: RemoteJobV1, startMs: number, reason: string, artifacts?: WorkspaceArtifacts): JobRunSummary {
		return {
			jobId: job.id,
			state: job.state,
			outcomeState: job.outcomeState,
			exitCode: artifacts?.exitCode,
			agentExitCode: artifacts?.agentExitCode,
			validationExitCode: artifacts?.validationExitCode,
			patch: artifacts?.patch,
			logs: artifacts?.logs ?? reason,
			durationMs: Date.now() - startMs,
			cleanupProof: job.cleanupProof,
		};
	}

	#step(job: RemoteJobV1, to: RemoteJobV1["state"], reason: string): void {
		const transitionResult = transition(job, to, "orchestrator", reason);
		if (!transitionResult.ok) {
			logger.warn("orchestrator: transition rejected", {
				jobId: job.id,
				code: transitionResult.code,
				message: transitionResult.message,
			});
		}
		this.#store.upsert(job);
	}

	#cancellationRequested(job: RemoteJobV1): boolean {
		if (job.outcomeState === "cancelled" || job.state === "cancelled") return true;
		const persisted = this.#store.get(job.id);
		return persisted?.outcomeState === "cancelled" || persisted?.state === "cancelled";
	}

	#runtimeMetadata(runtime: RuntimeHandle, key: string, fallback?: string): string {
		const value = runtime.metadata[key];
		if (typeof value === "string" && value.length > 0) return value;
		if (fallback !== undefined) return fallback;
		throw new Error(`Runtime ${runtime.jobId} is missing metadata ${key}`);
	}

	#registerRuntimeResources(job: RemoteJobV1, runtime: RuntimeHandle): void {
		job.workerId = runtime.workerId;
		const containerName = this.#runtimeMetadata(runtime, "containerName");
		const volumeName = this.#runtimeMetadata(runtime, "volumeName");
		const networkName = this.#runtimeMetadata(runtime, "networkName", "");
		const entrypointDirectory = this.#runtimeMetadata(runtime, "entrypointDirectory", "");
		if (!job.resources.some(resource => resource.kind === "container" && resource.id === containerName)) {
			registerResource(job, "container", containerName, `container for job ${job.id}`);
		}
		if (!job.resources.some(resource => resource.kind === "volume" && resource.id === volumeName)) {
			registerResource(job, "volume", volumeName, `volume for job ${job.id}`);
		}
		if (networkName && !job.resources.some(resource => resource.kind === "network" && resource.id === networkName)) {
			registerResource(job, "network", networkName, `network for job ${job.id}`);
		}
		if (
			entrypointDirectory &&
			!job.resources.some(resource => resource.kind === "tmpfs_secret" && resource.id === entrypointDirectory)
		) {
			registerResource(job, "tmpfs_secret", entrypointDirectory, `secure entrypoint for job ${job.id}`);
		}
	}

	#rebuildHandle(job: RemoteJobV1): RuntimeHandle {
		const containerName = job.resources.find(resource => resource.kind === "container")?.id ?? `ompk-job-${job.id}`;
		const volumeName = job.resources.find(resource => resource.kind === "volume")?.id ?? `ompk-vol-${job.id}`;
		const networkName = job.resources.find(resource => resource.kind === "network")?.id;
		const entrypointDirectory = job.resources.find(resource => resource.kind === "tmpfs_secret")?.id;
		return Object.freeze({
			backendId: this.#backend.id,
			jobId: job.id,
			workerId: job.workerId ?? "",
			startedAt: job.updatedAt,
			metadata: Object.freeze({
				containerName,
				volumeName,
				networkName,
				entrypointDirectory,
				image: this.#defaultImage,
			}),
		});
	}

	#errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
