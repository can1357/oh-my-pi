import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { buildJobResult, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import type { AgentRegistry } from "../registry/agent-registry";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";

import { cfgLaunchEnabled } from "./settings";

const waitSchema = type({});
const WAIT_MAX_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 500;

interface WaitMessaging {
	registry: AgentRegistry;
	senderId: string;
}

function takeQueuedMessage(messaging: WaitMessaging | undefined): IrcMessage | undefined {
	if (!messaging) return undefined;
	return drainPendingInbox(messaging.registry, messaging.senderId) ?? IrcBus.global().take(messaging.senderId);
}

/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

/**
 * Blocks on background jobs and services the calling agent started. Work it
 * did not start never sustains a wait: a peer owes no message — a parent
 * blocked awaiting this very agent stays running — so waiting on peers can
 * park both sides for good. A message arriving mid-wait still ends it.
 */
export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next result of a background job or service you started";
	readonly description = prompt.render(waitDescription);
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? undefined;
		const messaging = registry && senderId ? { registry, senderId } : undefined;
		const manager = this.session.asyncJobManager;

		throwIfAborted(signal);
		const pending = takeQueuedMessage(messaging);
		if (pending && messaging) return messageResult(messaging.senderId, pending);
		const deadline = Date.now() + WAIT_MAX_MS;
		let serviceError: string | undefined;
		const refreshAbort = new AbortController();
		const abortRefresh = () => refreshAbort.abort(signal?.reason);
		signal?.addEventListener("abort", abortRefresh, { once: true });
		// Discovery races local delivery; completion subscriptions remain valid if discovery fails.
		let refresh = cfgLaunchEnabled.get(this.session.settings)
			? listServicesTolerant(this.session, refreshAbort.signal).then(
					result => {
						if (refreshAbort.signal.aborted) return;
						serviceError = result.error;
					},
					error => {
						if (refreshAbort.signal.aborted) return;
						serviceError = error instanceof Error ? error.message : String(error);
					},
				)
			: undefined;
		try {
			for (;;) {
				const queued = takeQueuedMessage(messaging);
				if (queued && messaging) return messageResult(messaging.senderId, queued);
				const jobs = manager?.getRunningJobs({ ownerId: senderId }) ?? [];
				// Preserve accepted completions until their native consumed-delivery boundary.
				const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
				if (manager && undelivered.length > 0)
					return buildJobResult(this.session, manager, "wait", [...undelivered, ...jobs], []);
				const serviceRunning = hasLiveOwnedService(this.session);
				if (jobs.length === 0 && !serviceRunning && !refresh) {
					throwIfAborted(signal);
					if (serviceError !== undefined)
						throw new ToolError(
							`Service state unavailable: ${serviceError}. Last-known service state is not current.`,
						);
					throw new ToolError(
						"Nothing to wait for: no background job or service you started is running. Other agents' results and messages arrive on their own.",
					);
				}
				const refreshing = refresh;
				const result = await this.#blockUntilWake({
					jobs,
					manager,
					messaging,
					// Matching completion notifications are authoritative even during discovery.
					serviceRunning,
					refresh: refreshing?.then(() => {
						refresh = undefined;
					}),
					serviceError,
					deadline,
					signal,
					onUpdate,
				});
				if (result) return result;
			}
		} finally {
			signal?.removeEventListener("abort", abortRefresh);
			refreshAbort.abort();
		}
	}

	/** Block until an owned job settles, an owned service finishes, a message arrives, the cap elapses, or the call aborts. */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManager | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		refresh: Promise<void> | undefined;
		serviceError: string | undefined;
		deadline: number;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
	}): Promise<AgentToolResult<CoordinationDetails> | undefined> {
		const { jobs, manager, messaging, serviceRunning, refresh, serviceError, deadline, signal, onUpdate } = args;
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		let serviceCompleted = false;
		const serviceLeg = serviceRunning
			? waitForOwnedServiceCompletion(this.session, serviceAbort.signal).then(() => {
					if (!serviceAbort.signal.aborted) serviceCompleted = true;
				})
			: undefined;
		const busAbort = new AbortController();
		// Only `busAbort` can reject this leg, and it fires once the wait has settled.
		const busLeg = messaging
			? IrcBus.global()
					.wait(messaging.senderId, {}, 0, busAbort.signal)
					.catch(() => null)
			: undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, Math.max(0, deadline - Date.now()));
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const emitProgress = () =>
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			});
		const progressTimer = onUpdate && jobs.length > 0 ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		let wake: "job" | "message" | "service" | "refresh" | "timeout" | "abort";
		try {
			if (jobs.length > 0) emitProgress();
			wake = await Promise.race([
				...jobs.map(job => job.promise.then(() => "job" as const)),
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(refresh ? [refresh.then(() => "refresh" as const)] : []),
				timeout.then(() => "timeout" as const),
				abort.promise.then(() => "abort" as const),
			]);
		} catch (error) {
			manager?.unwatchJobs(watchedIds);
			throw error;
		} finally {
			clearTimeout(timer);
			clearInterval(progressTimer);
			busAbort.abort();
			serviceAbort.abort();
			signal?.removeEventListener("abort", onAbort);
		}
		// Unwatch only after the result is built: a job recovered below is
		// consumed first, while one left unreported (message or interrupt won
		// the race) is re-enqueued for its ordinary async delivery.
		try {
			// A dequeued message wins a photo-finish with a job: the job remains
			// deliverable, whereas a lost message cannot be recovered from the bus.
			const message = await busLeg;
			if (message && messaging) return messageResult(messaging.senderId, message);
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
					return {
						content: [{ type: "text", text: "Wait interrupted by message." }],
						details: { op: "wait", jobs: [], interrupted: true },
						useless: true,
					};
				}
				throwIfAborted(signal);
			}
			// A terminal list can settle the watched service in the same turn as
			// discovery. Keep that exit even when refresh wins the promise race.
			if (wake === "refresh") {
				if (!serviceCompleted) return undefined;
				wake = "service";
			}
			if (manager && jobs.length > 0) return buildJobResult(this.session, manager, "wait", jobs, []);
			if (wake === "timeout" && serviceError !== undefined)
				throw new ToolError(`Service state unavailable: ${serviceError}. Last-known service state is not current.`);
			return {
				content: [
					{
						type: "text",
						text:
							wake === "service"
								? "A service finished. Read proc:// for its status and output."
								: "Wait limit reached; background work may still be running. Read proc:// for status.",
					},
				],
				details: { op: "wait", jobs: [] },
			};
		} finally {
			manager?.unwatchJobs(watchedIds);
		}
	}
}
