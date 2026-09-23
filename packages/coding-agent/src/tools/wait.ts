import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import type { ToolSession } from ".";
import { buildJobResult, nothingToWaitForResult, snapshotJobs } from "../async/job-control";
import { hasLiveOwnedService, listServices, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";

const waitSchema = type({});
const WAIT_MAX_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 500;

export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next background result or peer message";
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

		if (messaging) {
			const pending =
				drainPendingInbox(messaging.registry, messaging.senderId) ?? IrcBus.global().take(messaging.senderId);
			if (pending) return messageResult(messaging.senderId, pending);
		}
		if (this.session.settings.get("launch.enabled")) await listServices(this.session, signal);
		const jobs = manager?.getRunningJobs(senderId ? { ownerId: senderId } : undefined) ?? [];
		if (messaging) {
			const queued =
				drainPendingInbox(messaging.registry, messaging.senderId) ?? IrcBus.global().take(messaging.senderId);
			if (queued) return messageResult(messaging.senderId, queued);
		}

		const runningPeer =
			messaging?.registry.listVisibleTo(messaging.senderId).some(ref => messaging.registry.isRunning(ref)) ?? false;
		const serviceRunning = hasLiveOwnedService(this.session);
		if (jobs.length === 0 && !runningPeer && !serviceRunning) {
			return nothingToWaitForResult(this.session);
		}

		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const busAbort = messaging ? new AbortController() : undefined;
		const busCancelled = new Error("wait settled");
		const busLeg: Promise<{ message: IrcMessage | null; error: Error | null }> | undefined =
			messaging && busAbort
				? IrcBus.global()
						.wait(
							messaging.senderId,
							{},
							0,
							busAbort.signal,
							jobs.length === 0 && !serviceRunning ? { liveness: messaging } : undefined,
						)
						.then(
							message => ({ message, error: null }),
							error => ({
								message: null,
								error:
									error === busCancelled ? null : error instanceof Error ? error : new Error(String(error)),
							}),
						)
				: undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, WAIT_MAX_MS);
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
		if (jobs.length > 0) emitProgress();
		let wokeFromService = false;
		try {
			const wake = await Promise.race([
				...jobs.map(job => job.promise.then(() => "job" as const)),
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				timeout.then(() => "timeout" as const),
				abort.promise.then(() => "abort" as const),
			]);
			wokeFromService = wake === "service";
		} finally {
			manager?.unwatchJobs(watchedIds);
			clearTimeout(timer);
			clearInterval(progressTimer);
			busAbort?.abort(busCancelled);
			serviceAbort.abort();
			signal?.removeEventListener("abort", onAbort);
		}
		// A dequeued message wins a photo-finish with a job: the job remains
		// deliverable, whereas a lost message cannot be recovered from the bus.
		if (busLeg && messaging) {
			const { message, error } = await busLeg;
			if (message) return messageResult(messaging.senderId, message);
			if (error && !signal?.aborted) {
				if (
					jobs.length === 0 &&
					!serviceRunning &&
					!messaging.registry.listVisibleTo(messaging.senderId).some(ref => messaging.registry.isRunning(ref))
				) {
					return nothingToWaitForResult(this.session);
				}
				throw error;
			}
		}
		// Steering skips the tool result; leave any concurrent job completion
		// available for its ordinary async delivery instead of consuming it.
		throwIfAborted(signal);
		if (manager && jobs.length > 0) return buildJobResult(this.session, manager, "wait", jobs, []);
		return {
			content: [
				{
					type: "text",
					text: wokeFromService
						? "A service finished. Read proc:// for its status and output."
						: "Wait limit reached; background work may still be running. Read proc:// for status.",
				},
			],
			details: { op: "wait", jobs: [] },
		};
	}
}
