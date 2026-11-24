/**
 * Lifecycle control for async background jobs (bash scripts,
 * subagents) owned by the calling agent: wait/cancel/snapshot plus the
 * running-agents roster for activity with no job entry.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

import {
	type AsyncJob,
	type AsyncJobDetails,
	type AsyncJobManagerApi,
	type AsyncJobType,
	agentProgress,
	type EvictedJob,
} from "./job-manager";

import { renderStructuredJson, structuredStatusLabel, taskAgentHandles } from "../session/async-job-delivery";
import { AGENT_KILL_LABEL, type InterruptReason } from "../session/messages";
import type { StructuredSubagentOutput } from "../task/task-details";
import { parseConfiguredThinkingLevel } from "../thinking/levels";

import type { ToolSession } from "../tools";

import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { AgentActivitySnapshot, CancelOutcome, CoordinationDetails, JobSnapshot } from "../tools/details/wait";

import { isWaitingPollDetails } from "../tools/details/wait";

/**
 * Resolve a list of job ids to job records visible to the calling agent.
 * Drops missing ids and ids owned by other agents, preventing cross-agent inspection.
 * An unowned caller (`ownerId` undefined) sees only unowned jobs.
 */
export function visibleJobs(manager: AsyncJobManagerApi, ids: string[], ownerId: string | undefined): AsyncJob[] {
	const out: AsyncJob[] = [];
	for (const id of ids) {
		const job = manager.getJob(id);
		if (!job) continue;
		if (job.ownerId !== ownerId) continue;
		out.push(job);
	}
	return out;
}

/**
 * Settled jobs owned by `ownerId` whose completion was accepted but has not
 * reached the owner yet: delivery queued or awaiting yield-queue injection,
 * dead-lettered, or skipped while a `wait` watched it. Consumed, acknowledged,
 * and currently watched results are excluded.
 */
export function undeliveredJobs(manager: AsyncJobManagerApi, ownerId: string | undefined): AsyncJob[] {
	return manager
		.getAllJobs({ ownerId })
		.filter(
			job =>
				(job.status === "completed" || job.status === "failed") &&
				!manager.isJobResultConsumed(job.id) &&
				!manager.isDeliverySuppressed(job.id),
		);
}

/**
 * Running subagents from the registry that are not covered by one of the
 * caller's running jobs. Agents woken via peer messaging (idle wake / park
 * revival) and spawns owned by another agent run with no AsyncJobManager
 * entry, yet the UI's agent badge counts them — a snapshot must account for
 * that activity instead of implying the system is quiet. Existence is
 * already public via the peer roster, so listing ids here leaks nothing new;
 * job *control* stays owner-scoped.
 *
 * Reporting deliberately uses the claimed `status`, not the session-corroborated
 * `registry.isRunning` used by the wait-sustaining gates: a ref that claims
 * `running` with no live turn is exactly the stale entry an operator must see
 * here to cancel it (#8634). Hiding it would match the badge count to nothing
 * and remove the only discovery path for the id.
 */
export function runningAgentsOutsideJobs(session: ToolSession): AgentActivitySnapshot[] {
	const registry = session.agentRegistry;
	if (!registry) return [];
	const selfId = session.getAgentId?.() ?? undefined;
	// Cover = the caller's RUNNING jobs only. A settled job still sitting in
	// delivery retention must not hide its agent if that agent was re-woken
	// (e.g. via a peer message) and is running again without a job.
	const covered = new Set<string>();
	const manager = session.asyncJobManager;
	if (manager) {
		for (const job of manager.getRunningJobs({ ownerId: selfId })) {
			covered.add(job.id);
			if (job.agentId) covered.add(job.agentId);
		}
	}
	const now = Date.now();
	// Accepted runs that never terminalized: reported as actionable state
	// instead of a generic stale-registration hint (#11079).
	const staleAccepted = new Set(registry.staleAcceptedRuns().map(ref => ref.id));
	const out: AgentActivitySnapshot[] = [];
	for (const ref of registry.list()) {
		if (ref.kind !== "sub" || ref.status !== "running") continue;
		if (ref.id === selfId || covered.has(ref.id)) continue;
		const acceptedAt = staleAccepted.has(ref.id) ? ref.lifecycle?.acceptedAt : undefined;
		out.push({
			id: ref.id,
			...(ref.parentId ? { parentId: ref.parentId } : {}),
			...(ref.activity ? { activity: ref.activity } : {}),
			ageMs: Math.max(0, now - ref.createdAt),
			live: registry.isRunning(ref),
			...(acceptedAt !== undefined ? { acceptedAt } : {}),
		});
	}
	return out;
}

/**
 * Suffix flagging a claimed-running agent with no turn in flight; empty for a
 * live one. Shared by `jobs`, empty-wait results, and the `proc://` roster so
 * every surface tells a finished-but-unterminalized run (#11079) from real work.
 */
export function agentStaleNote(agent: AgentActivitySnapshot): string {
	if (agent.live) return "";
	// An accepted final result with no turn in flight is the #11079 leak:
	// the run is over but the ref never terminalized, so say so actionably
	// instead of the generic stale-registration hint.
	return agent.acceptedAt !== undefined
		? ` — final result accepted ${formatDuration(Math.max(0, Date.now() - agent.acceptedAt))} ago but still running; clear it with \`write proc://${agent.id}/kill\``
		: " — no turn in flight (stale registration?)";
}

/** Model-facing lines for the running-agents section shared by `jobs` and empty-wait results. */
function describeAgents(agents: AgentActivitySnapshot[]): string[] {
	const lines = [`## Running Agents (${agents.length}) — not job-backed\n`];
	for (const agent of agents) {
		const parent = agent.parentId ? ` (spawned by \`${agent.parentId}\`)` : "";
		const activity = agent.activity ? ` — ${agent.activity}` : "";
		lines.push(`- \`${agent.id}\`${parent} — up ${formatDuration(agent.ageMs)}${activity}${agentStaleNote(agent)}`);
	}
	lines.push(
		"",
		"These agents have no job entry; message them via `write agent://<id>`, transcripts at `history://<id>`.",
	);
	if (agents.some(agent => !agent.live)) {
		lines.push(
			"An agent with no turn in flight cannot answer a message and never satisfies `wait`; clear it with `write proc://<id>/kill`.",
		);
	}
	return lines;
}

interface TrackedJobLike {
	id: string;
	type: AsyncJobType;
	status: string;
	label: string;
	/** See {@link AsyncJob.intent}. */
	intent?: string;
	startTime: number;
	endTime?: number;
	latestDetails?: AsyncJobDetails;
	resultText?: string;
	errorText?: string;
	structured?: StructuredSubagentOutput;
	/** See {@link AsyncJob.agentOutputPublished}. */
	agentOutputPublished?: boolean;
}

export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
	const now = Date.now();
	return jobs.map(j => {
		const current = session.asyncJobManager?.getJob(j.id);
		const latest = current ?? j;
		const resultConsumed = session.asyncJobManager?.isJobResultConsumed(latest.id) === true;
		let resolvedModel: string | undefined;
		const exitCode = typeof latest.latestDetails?.exitCode === "number" ? latest.latestDetails.exitCode : undefined;
		let resolvedModelIdentity: string | undefined;
		let resolvedThinkingLevel: JobSnapshot["resolvedThinkingLevel"];
		let advisor = false;
		let completionPercent: number | undefined;
		let stage: string | undefined;
		let requests: number | undefined;
		let cost: number | undefined;
		let contextTokens: number | undefined;
		let contextWindow: number | undefined;
		if (latest.type === "task") {
			// A collided job id is suffixed (`Foo-2`) while its agent id stays `Foo`.
			const progressRecord = agentProgress(latest.latestDetails, current?.agentId ?? latest.id);
			if (progressRecord) {
				const modelValue = progressRecord?.resolvedModel;
				if (typeof modelValue === "string") {
					const trimmed = modelValue.trim();
					if (trimmed) resolvedModel = trimmed;
				}
				const identityValue = progressRecord?.resolvedModelIdentity;
				if (typeof identityValue === "string") {
					const trimmed = identityValue.trim();
					if (trimmed) resolvedModelIdentity = trimmed;
				}
				const thinkingValue = progressRecord?.resolvedThinkingLevel;
				if (typeof thinkingValue === "string") {
					resolvedThinkingLevel = parseConfiguredThinkingLevel(thinkingValue);
				}
				advisor = progressRecord?.advisor === true;
				const completionValue = progressRecord?.completionPercent;
				if (typeof completionValue === "number" && Number.isFinite(completionValue)) {
					completionPercent = completionValue;
				}
				const stageValue = progressRecord?.stage;
				if (typeof stageValue === "string") {
					const trimmed = stageValue.trim();
					if (trimmed) stage = trimmed;
				}
				requests = finiteNumber(progressRecord?.requests);
				cost = finiteNumber(progressRecord?.cost);
				contextTokens = finiteNumber(progressRecord?.contextTokens);
				contextWindow = finiteNumber(progressRecord?.contextWindow);
			}
		}
		const running = latest.status === "running";
		const widget = current ? session.asyncJobManager?.widgets?.view(current) : undefined;
		return {
			id: latest.id,
			type: latest.type,
			status: latest.status as JobSnapshot["status"],
			label: latest.label,
			...(latest.intent ? { intent: latest.intent } : {}),
			durationMs: Math.max(0, (latest.endTime ?? now) - latest.startTime),
			...(latest.endTime !== undefined ? { settledAtMs: latest.endTime } : {}),
			...(exitCode !== undefined ? { exitCode } : {}),
			...(resolvedModel ? { resolvedModel } : {}),
			...(resolvedModelIdentity ? { resolvedModelIdentity } : {}),
			...(resolvedThinkingLevel !== undefined ? { resolvedThinkingLevel } : {}),
			...(advisor ? { advisor: true } : {}),
			...(completionPercent !== undefined && running ? { completionPercent } : {}),
			...(stage ? { stage } : {}),
			...(requests !== undefined && running ? { requests } : {}),
			...(cost !== undefined && running ? { cost } : {}),
			...(contextTokens !== undefined && running ? { contextTokens } : {}),
			...(contextWindow !== undefined && running ? { contextWindow } : {}),
			...(widget ? { widget } : {}),
			...(!resultConsumed && latest.resultText ? { resultText: latest.resultText } : {}),
			...(!resultConsumed && latest.errorText ? { errorText: latest.errorText } : {}),
			...(!resultConsumed && latest.latestDetails?.meta ? { meta: latest.latestDetails.meta } : {}),
			...(!resultConsumed && latest.structured ? { structured: latest.structured } : {}),
			...(latest.type === "task" ? { agentUrlId: current?.agentId ?? latest.id } : {}),
			...(latest.agentOutputPublished !== undefined ? { agentOutputPublished: latest.agentOutputPublished } : {}),
		};
	});
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Progress suffix for a running task row, e.g.
 * ` — 5h7m · 90 req · $18.40 · ctx 160K/1M · stage: implementing`, from the
 * fields {@link snapshotJobs} copies out of the task's latest progress record.
 * Returns `""` for any other row and for a running task without progress
 * fields, so those rows keep their plain shape; duration alone never makes a
 * suffix. Pass `duration: false` where the row already shows the run time.
 */
export function runningTaskProgressSuffix(job: JobSnapshot, options: { duration: boolean }): string {
	if (job.type !== "task" || job.status !== "running") return "";
	const parts: string[] = [];
	if (job.requests !== undefined && job.requests > 0) parts.push(`${job.requests} req`);
	if (job.cost !== undefined && job.cost > 0) parts.push(job.cost < 0.005 ? "<$0.01" : `$${job.cost.toFixed(2)}`);
	if (job.contextTokens !== undefined && job.contextTokens > 0) {
		parts.push(
			job.contextWindow !== undefined && job.contextWindow > 0
				? `ctx ${formatNumber(job.contextTokens)}/${formatNumber(job.contextWindow)}`
				: `ctx ${formatNumber(job.contextTokens)}`,
		);
	}
	if (job.completionPercent !== undefined) parts.push(`~${job.completionPercent}%`);
	if (job.stage) parts.push(`stage: ${job.stage.replace(/\s+/g, " ")}`);
	if (parts.length === 0) return "";
	if (options.duration) parts.unshift(formatDuration(job.durationMs));
	return ` — ${parts.join(" · ")}`;
}

/** Ids of `ownerId`'s jobs that have already settled — a call's entry state. */
export function settledJobIds(manager: AsyncJobManagerApi, ownerId: string | undefined): Set<string> {
	return new Set(
		manager
			.getAllJobs({ ownerId })
			.filter(job => job.status !== "running")
			.map(job => job.id),
	);
}

/** Inputs that let a snapshot describe how a settled result reached its owner. */
export interface JobResultOptions {
	/**
	 * Ids already settled when this call started, captured before its first
	 * await. A settled job outside this set finished while the call was in
	 * flight, so the call itself handed the result over. Membership is the
	 * evidence — comparing timestamps would call a job settled in the same
	 * millisecond as the call "delivered by it" (#16052 review).
	 *
	 * Absent for `jobs`, which never waits and therefore only ever reports
	 * results it did not deliver.
	 */
	settledAtEntry?: ReadonlySet<string>;
	/**
	 * Epoch ms when this call started. Used only to state how long before the
	 * call a genuinely late result had settled.
	 */
	startedAtMs?: number;
}

/**
 * Model-facing delivery line for one settled job. Three very different
 * situations used to read as the same "not auto-delivered" failure:
 *
 * - the job finished while this call was already running: the call is what
 *   handed the result over — the completion push was never lost, the call
 *   simply won the race;
 * - it had already finished and its push was still queued when this snapshot
 *   consumed it: the snapshot superseded that push, so the follow-up cannot
 *   arrive — promising one would make the model expect a duplicate;
 * - it had already finished and nothing is on the way: a genuinely late
 *   result, reported with how long before the call it settled.
 *
 * A queued push this snapshot consumed is always reported as superseded:
 * `consumeJobResults` re-checks `isDeliveryPending` per id before it
 * acknowledges the queue, so every pending push the snapshot reads lands in
 * the superseded set — a "push still on the way" line could never be reached.
 *
 * `watchedByWait` is the fallback evidence for a snapshot that did not capture
 * its entry state (a direct `buildJobResult` call): a suppressed delivery means
 * a `wait` was watching the job when it settled, so that wait handed the result
 * over. It keeps the wording #17040 gave it. Entry-state membership decides
 * whenever it is available, because a job suppressed by an earlier, interrupted
 * wait is settled at this call's entry and was not delivered by it.
 */
function describeDelivery(
	job: JobSnapshot,
	op: "wait" | "cancel" | "jobs",
	options: JobResultOptions,
	alreadyConsumed: boolean,
	deliverySuperseded: boolean,
	watchedByWait: boolean,
): string {
	if (alreadyConsumed) return "Delivery: already delivered or recovered.";
	if (options.settledAtEntry === undefined) {
		if (watchedByWait) return "Delivery: delivered directly to wait.";
	} else if (!options.settledAtEntry.has(job.id)) {
		const surface = op === "wait" ? "this wait" : "this call";
		const when = op === "wait" ? "it finished while you were waiting" : "it finished as the call ran";
		return `Delivery: delivered by ${surface} — ${when}.`;
	}
	const settledAt = job.settledAtMs;
	const startedAt = options.startedAtMs;
	const age =
		settledAt !== undefined && startedAt !== undefined && startedAt > settledAt
			? formatDuration(startedAt - settledAt)
			: undefined;
	if (deliverySuperseded) {
		const before = age === undefined ? "" : ` (it finished ${age} before this call)`;
		return `Delivery: handed over by this snapshot${before} — this snapshot superseded its queued completion push.`;
	}
	return `Delivery: not auto-delivered; recovered by this snapshot${
		age === undefined ? "" : ` — it had already finished ${age} before this call`
	}.`;
}

export function buildJobResult(
	session: ToolSession,
	manager: AsyncJobManagerApi,
	op: "wait" | "cancel",
	jobs: TrackedJobLike[],
	cancelOutcomes: CancelOutcome[],
	agents: AgentActivitySnapshot[] = [],
	options: JobResultOptions = {},
): AgentToolResult<CoordinationDetails> {
	// Deduplicate by id (cancelled jobs may also appear in the watched set).
	const seen = new Set<string>();
	const uniqueJobs = jobs.filter(j => {
		if (seen.has(j.id)) return false;
		seen.add(j.id);
		return true;
	});
	const jobResults = snapshotJobs(session, uniqueJobs);
	const alreadyConsumed = new Set(jobResults.filter(job => manager.isJobResultConsumed(job.id)).map(job => job.id));
	const watchedByWait = new Set(
		op === "wait"
			? jobResults
					.filter(job => !alreadyConsumed.has(job.id) && manager.isDeliverySuppressed(job.id))
					.map(job => job.id)
			: [],
	);

	manager.consumeJobResults(jobResults.filter(j => j.status !== "running").map(j => j.id));

	// Read AFTER `consumeJobResults`: that call is what supersedes a queued push,
	// so reading before it would always miss the jobs this snapshot handed over
	// and the line would promise a follow-up that cannot arrive (#16135 review).
	const deliverySuperseded = new Set(
		jobResults.filter(job => manager.isDeliverySuperseded(job.id)).map(job => job.id),
	);

	const completed = jobResults.filter(j => j.status !== "running");
	const running = jobResults.filter(j => j.status === "running");

	const lines: string[] = [];

	if (cancelOutcomes.length > 0) {
		lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
		for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
		lines.push("");
	}

	if (completed.length > 0) {
		lines.push(`## Completed (${completed.length})\n`);
		for (const j of completed) {
			lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
			if (j.intent) lines.push(`Intent: ${j.intent}`);
			lines.push(`Label: ${j.label}`);
			const handles = taskAgentHandles(j.id, j, j.agentUrlId);
			if (handles) {
				lines.push(
					handles === "agent"
						? `Agent: agent://${j.agentUrlId}, history://${j.agentUrlId}`
						: `Agent: history://${j.agentUrlId}`,
				);
			}
			if (j.status !== "cancelled") {
				lines.push(
					describeDelivery(
						j,
						op,
						options,
						alreadyConsumed.has(j.id),
						deliverySuperseded.has(j.id),
						watchedByWait.has(j.id),
					),
				);
			}
			if (j.resultText) {
				lines.push("```", j.resultText, "```");
			}
			if (j.errorText) {
				lines.push(`Error: ${j.errorText}`);
			}
			if (j.structured) {
				const hasData = Object.hasOwn(j.structured, "data");
				let header = `Structured output: ${structuredStatusLabel(j.structured.status)}`;
				if (j.structured.error) header += `: ${j.structured.error}`;
				// Valid results never inline the JSON here — it duplicates the
				// `<output>` block above (or breaks mid-JSON once truncated at
				// 4k), which contradicts async-result.md's contract of pointing
				// to `agent://<id>` instead (PR #10625 review).
				if (hasData)
					header += `; full payload at agent://${j.agentUrlId}, fields via agent://${j.agentUrlId}/<field>`;
				lines.push(header);
				if (j.structured.status !== "valid") {
					const block = renderStructuredJson(j.structured);
					if (block) lines.push("```json", block, "```");
				}
			}
			lines.push("");
		}
	}

	if (running.length > 0) {
		lines.push(`## Still Running (${running.length})\n`);
		for (const j of running) {
			const intent = j.intent ? `${j.intent} — ` : "";
			lines.push(
				`- \`${j.id}\` [${j.type}] — ${intent}${j.label}${runningTaskProgressSuffix(j, { duration: true })}`,
			);
		}
	}

	if (agents.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...describeAgents(agents));
	}

	// A tool result must never be empty text — the model cannot tell "no
	// jobs" from a malfunction (reported exactly that way in QA).
	if (lines.length === 0) {
		lines.push("No background jobs.");
	}

	const details: CoordinationDetails = {
		op,
		// The report is complete even when an individual job's raw capture failed.
		meta: { source: { type: "report", value: "background jobs snapshot" } },
		jobs: jobResults,
		...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
		...(agents.length ? { agents } : {}),
	};
	return {
		content: [{ type: "text", text: lines.join("\n").trimEnd() }],
		details,
		// A wait where everything is still running carries no new information
		// once a later wait exists — same predicate the TUI uses to displace
		// stale waiting frames.
		...(isWaitingPollDetails(details) ? { useless: true } : {}),
	};
}

/** `cancel`: kill the named jobs; returns immediately with outcomes + snapshots. */
export async function executeCancel(
	session: ToolSession,
	manager: AsyncJobManagerApi,
	ownerId: string | undefined,
	ids: string[],
	options: { startedAtMs?: number; settledAtEntry?: ReadonlySet<string> } = {},
): Promise<AgentToolResult<CoordinationDetails>> {
	// Same rule as `wait`: a job that settled after this call began is one this
	// call is handing over, not a lost completion push (#16052). The caller may
	// pass its own start time — `write proc://<id>/kill` awaits a broker lookup
	// first, so stamping here would miss a job that settled during that await.
	const callStartedAt = options.startedAtMs ?? Date.now();
	const settledAtEntry = options.settledAtEntry ?? settledJobIds(manager, ownerId);
	const cancelOutcomes: CancelOutcome[] = [];
	for (const id of ids) {
		const existing = manager.getJob(id);
		if (!existing || existing.ownerId !== ownerId) {
			// No job by this id (or it belongs to another agent): a budget-aborted
			// keep-alive subagent lives on as a jobless registration long after its
			// job row is reaped, so let cancel reach the agent registration too.
			cancelOutcomes.push(await cancelAgentRegistration(session, ownerId, id, AGENT_KILL_LABEL));
			continue;
		}
		if (existing.status !== "running") {
			// The job row settled but may still be inside the retention window.
			// The agent registration behind it (job id == agent id for task
			// spawns) can outlive the row as an idle/parked zombie — try the
			// registration kill before reporting the row as already done.
			const regOutcome = await cancelAgentRegistration(session, ownerId, id, AGENT_KILL_LABEL);
			cancelOutcomes.push(
				regOutcome.status === "cancelled"
					? regOutcome
					: {
							id,
							status: "already_completed",
							message: `Background job ${id} is already ${existing.status}.`,
						},
			);
			continue;
		}
		// Cancelling a task job alone only aborts its current turn: the agent stays
		// live and idle, and the next message queued for it starts it again. Kill
		// the agent too, as an explicit kill, before its run observes the abort.
		const runAgent = agentRunOf(existing);
		const agentKill = runAgent
			? await cancelAgentRegistration(session, ownerId, runAgent, AGENT_KILL_LABEL)
			: undefined;
		const cancelled = manager.cancel(id, { ownerId });
		cancelOutcomes.push(
			cancelled
				? {
						id,
						status: "cancelled",
						message:
							agentKill?.status === "cancelled"
								? `Cancelled background job ${id}. ${agentKill.message}`
								: `Cancelled background job ${id}.`,
					}
				: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
		);
	}
	return buildJobResult(session, manager, "cancel", visibleJobs(manager, ids, ownerId), cancelOutcomes, [], {
		startedAtMs: callStartedAt,
		settledAtEntry,
	});
}

/**
 * What became of an evicted job, in one line: when it settled, whether its
 * result reached the owner, and why its row is gone.
 */
export function describeEvictedJob(record: EvictedJob, now: number = Date.now()): string {
	const settled = record.endTime === undefined ? "" : ` ${formatDuration(Math.max(0, now - record.endTime))} ago`;
	const result = record.delivered
		? "its result reached you then (a follow-up message or a wait result)"
		: record.reason === "cleared"
			? "its undelivered result was dropped"
			: "its result was never read";
	const gone =
		record.reason === "cleared"
			? "its row was cleared when your session was reset, replaced, or switched"
			: "its row has since expired";
	return `${record.id} [${record.type}] ${record.status}${settled} — ${record.label.replace(/\s+/g, " ")}; ${result}; ${gone}.`;
}

/**
 * The agent whose run `job` is: a spawned agent's job, or a later turn's job of
 * it, which takes the agent id with a `-N` collision suffix. Undefined for any
 * other job, including a workpool batch, which runs on a pool worker it does not own.
 */
export function agentRunOf(job: AsyncJob): string | undefined {
	const agentId = job.agentId;
	if (job.type !== "task" || !agentId) return undefined;
	if (job.id === agentId) return agentId;
	return job.id.startsWith(`${agentId}-`) && /^\d+$/.test(job.id.slice(agentId.length + 1)) ? agentId : undefined;
}

/** What killing an agent registration reaches: the registry it lives in and the lifecycle that releases it. */
export type AgentKillScope = Pick<ToolSession, "agentRegistry" | "agentLifecycle">;

/**
 * Stop agent `id` for good on its parent's behalf, as cancelling its task job
 * does (see {@link executeCancel}): kill its registration so no queued message
 * restarts it, then cancel the job that runs it, if one still runs.
 * `reason` goes to {@link cancelAgentRegistration}.
 */
export async function stopAgentRun(
	scope: AgentKillScope,
	manager: AsyncJobManagerApi | undefined,
	id: string,
	reason: InterruptReason,
): Promise<CancelOutcome> {
	const outcome = await cancelAgentRegistration(scope, scope.agentRegistry?.get(id)?.parentId, id, reason);
	let cancelledJob = false;
	for (const job of manager?.getRunningJobs() ?? []) {
		if (agentRunOf(job) === id && manager?.cancel(job.id, { ownerId: job.ownerId })) cancelledJob = true;
	}
	if (outcome.status === "cancelled" || !cancelledJob) return outcome;
	return { id, status: "cancelled", message: `Cancelled the job running agent ${id}.` };
}

/**
 * Kill an agent registration named by `id`: abort any in-flight turn, then
 * release it from the lifecycle as an explicit kill (dispose the session and
 * keep a terminal `aborted` row, so no queued message wakes it, while a message
 * sent to it later reopens its transcript). It is the kill path for a task
 * job's agent and for a keep-alive subagent that was budget-aborted, went
 * `idle`/`parked`, and outlived its job row. The caller supplies `reason` to
 * control its interrupt label. Scope limits this function to the caller's own
 * descendants and blocks cross-agent kills. An unowned caller reaches only
 * parentless subs. The function never touches Main, the caller, or advisor transcripts.
 */
export async function cancelAgentRegistration(
	session: AgentKillScope,
	ownerId: string | undefined,
	id: string,
	reason: InterruptReason,
): Promise<CancelOutcome> {
	const registry = session.agentRegistry;
	const ref = registry?.get(id);
	if (ref?.kind !== "sub") {
		return { id, status: "not_found", message: `Background job not found: ${id}` };
	}
	if (id === ownerId) {
		return { id, status: "not_found", message: `Cannot cancel yourself (${id}).` };
	}
	if (ref.parentId !== ownerId) {
		return { id, status: "not_found", message: `Agent ${id} was not spawned by you and cannot be cancelled.` };
	}
	const lifecycle = session.agentLifecycle?.();
	try {
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason });
		}
		if (lifecycle) {
			await lifecycle.release(id, undefined, { tombstone: true });
		} else {
			await ref.session?.dispose();
			registry?.unregister(id);
		}
	} catch (error) {
		return {
			id,
			status: "already_completed",
			message: `Agent ${id} could not be fully cancelled: ${error instanceof Error ? error.message : String(error)}.`,
		};
	}
	return {
		id,
		status: "cancelled",
		message: `Killed agent ${id}; its transcript stays at history://${id}.`,
	};
}
