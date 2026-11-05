/**
 * Read-only views of the async jobs one agent owns, computed from the
 * process-root `AsyncJobManager`. Shared by `AgentSession` (its own jobs) and
 * the main thread's mirror of a worker-homed session, which scopes the same
 * root manager to the child's agent id.
 */
import type { AsyncJob, AsyncJobManagerApi } from "../async";
import type { JobWidgetRegistry } from "../job-widgets/types";
import { AgentRegistry } from "../registry/agent-registry";
import type { JobWidgetEntry } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AsyncJobInspection, AsyncJobSnapshot, AsyncJobSnapshotItem, AsyncJobTree } from "./agent-session-types";

/** The public summary of `job` (see {@link AsyncJobSnapshotItem}); its caption shows only while widgets are on. */
function jobSnapshotItem(job: AsyncJob, widgets: JobWidgetRegistry | undefined): AsyncJobSnapshotItem {
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		label: job.label,
		intent: job.intent,
		caption: widgets?.caption(job),
		command: job.process?.command,
		startTime: job.startTime,
		endTime: job.endTime,
		agentId: job.agentId,
		ownerId: job.ownerId,
	};
}

/** Running and recent jobs `agentId` owns (every job when it is undefined), with their delivery state. */
export function asyncJobSnapshot(
	manager: AsyncJobManagerApi,
	agentId: string | undefined,
	options?: { recentLimit?: number },
): AsyncJobSnapshot {
	const ownerFilter = agentId ? { ownerId: agentId } : undefined;
	const running = manager.getRunningJobs(ownerFilter).map(job => jobSnapshotItem(job, manager.widgets));
	const recent = manager
		.getRecentJobs(options?.recentLimit ?? 5, ownerFilter)
		.map(job => jobSnapshotItem(job, manager.widgets));
	const delivery = manager.getDeliveryState(ownerFilter);
	return { running, recent, delivery };
}

/**
 * Live widgets of the running jobs `agentId` owns (the owner scope of
 * {@link asyncJobSnapshot}), in job order. Reading a widget marks it shown,
 * which is what lets its spec be written.
 */
export function runningJobWidgets(manager: AsyncJobManagerApi, agentId: string | undefined): JobWidgetEntry[] {
	const widgets = manager.widgets;
	if (!widgets) return [];
	const entries: JobWidgetEntry[] = [];
	for (const job of manager.getRunningJobs(agentId ? { ownerId: agentId } : undefined)) {
		const view = widgets.view(job);
		if (view) entries.push({ id: job.id, type: job.type, view });
	}
	return entries;
}

/** Each agent's parent: the registry's link, else the owner of the task job that runs it. */
function jobTreeParents(manager: AsyncJobManagerApi): Map<string, string> {
	const parents = new Map<string, string>();
	for (const job of [...manager.getRunningJobs(), ...manager.getRecentJobs(Number.POSITIVE_INFINITY)]) {
		if (job.agentId !== undefined && job.ownerId !== undefined) parents.set(job.agentId, job.ownerId);
	}
	for (const ref of AgentRegistry.global().list()) {
		if (ref.parentId !== undefined) parents.set(ref.id, ref.parentId);
	}
	return parents;
}

/** Whether `job`'s owner is `rootId` or descends from it; every job when `rootId` is undefined. */
function inJobTree(job: AsyncJob, rootId: string | undefined, parents: ReadonlyMap<string, string>): boolean {
	if (!rootId) return true;
	const seen = new Set<string>();
	for (let id = job.ownerId; id !== undefined && !seen.has(id); id = parents.get(id)) {
		if (id === rootId) return true;
		seen.add(id);
	}
	return false;
}

/**
 * Async jobs of `rootId` and every subagent below it: the running ones and
 * the `recentLimit` (default 10) newest settled ones across the tree, with the subagents
 * that own them and the ancestors linking those to the root. Lineage comes
 * from the agent registry, falling back to the task job that runs a subagent
 * once its registry entry is gone.
 */
export function asyncJobTree(
	manager: AsyncJobManagerApi,
	rootId: string | undefined,
	options?: { recentLimit?: number },
): AsyncJobTree {
	const parents = jobTreeParents(manager);
	const running = manager.getRunningJobs().filter(job => inJobTree(job, rootId, parents));
	const recent = manager
		.getRecentJobs(Number.POSITIVE_INFINITY)
		.filter(job => inJobTree(job, rootId, parents))
		.slice(0, options?.recentLimit ?? 10);
	const agents = new Map<string, { id: string; parentId?: string }>();
	for (const job of [...running, ...recent]) {
		for (let id = job.ownerId; id !== undefined && id !== rootId && !agents.has(id); id = parents.get(id)) {
			agents.set(id, { id, parentId: parents.get(id) });
		}
	}
	return {
		running: running.map(job => jobSnapshotItem(job, manager.widgets)),
		recent: recent.map(job => jobSnapshotItem(job, manager.widgets)),
		rootId,
		agents: [...agents.values()],
	};
}

/** Ask for the captions of the running commands in `rootId`'s job tree (see {@link asyncJobTree}). */
export function requestJobTreeCaptions(manager: AsyncJobManagerApi, rootId: string | undefined): void {
	const widgets = manager.widgets;
	if (!widgets) return;
	const parents = jobTreeParents(manager);
	for (const job of manager.getRunningJobs()) {
		if (inJobTree(job, rootId, parents)) widgets.requestCaption(job);
	}
}

/**
 * One async job in `rootId`'s tree (see {@link asyncJobTree}): its command,
 * live pids, exit status and output. Undefined when the job is unknown, owned
 * outside the tree, or evicted.
 */
export function inspectAsyncJob(
	manager: AsyncJobManagerApi,
	rootId: string | undefined,
	id: string,
): AsyncJobInspection | undefined {
	const job = manager.getJob(id);
	if (!job || job.foreground || !inJobTree(job, rootId, jobTreeParents(manager))) return undefined;
	const details = job.latestDetails;
	const reported = typeof details?.exitCode === "number" ? details.exitCode : undefined;
	// Bash reports only non-zero exits; a completed command exited 0.
	const exitCode = reported ?? (job.type === "bash" && job.status === "completed" ? 0 : undefined);
	const output = job.status === "running" ? job.progressText : (job.resultText ?? job.errorText ?? job.progressText);
	return {
		command: job.process?.command,
		cwd: job.process?.cwd,
		pids: job.status === "running" ? (job.process?.pids() ?? []) : [],
		exitCode,
		output,
		artifactId: details?.meta?.truncation?.artifactId,
		widget: manager.widgets?.view(job),
	};
}

/** A listed job by id, under the owner scope of {@link asyncJobSnapshot}. */
export function ownedAsyncJob(
	manager: AsyncJobManagerApi,
	agentId: string | undefined,
	id: string,
): AsyncJob | undefined {
	const job = manager.getJob(id);
	if (!job || job.foreground) return undefined;
	return !agentId || job.ownerId === agentId ? job : undefined;
}

/** Cancel a running job `agentId` owns; false when there is none by that id. */
export function cancelOwnedAsyncJob(manager: AsyncJobManagerApi, agentId: string | undefined, id: string): boolean {
	const job = ownedAsyncJob(manager, agentId, id);
	return job !== undefined && manager.cancel(id, { ownerId: job.ownerId });
}
