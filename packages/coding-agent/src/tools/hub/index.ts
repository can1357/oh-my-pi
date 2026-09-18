/**
 * Hub tool — the single agent-coordination surface: peer messaging over the
 * IrcBus, lifecycle control for async background jobs, and supervision of
 * project-scoped long-running processes (launch).
 *
 * Op families:
 * - messaging: `send` (with `to`), `inbox`, `list`, `wait` (with `from`);
 * - jobs: `wait` (bare or with `ids`), `cancel`, `jobs`;
 * - processes: `start`, `ps`, `logs`, `stop`, `restart`, `describe`, plus
 *   `send`/`wait` when they carry a process `name`.
 *
 * The unified `wait` blocks until the FIRST of: a matching peer message, a
 * watched job settling, the wait window elapsing, or a steering interrupt.
 * Job results always deliver themselves when they finish — `wait` exists for
 * when the agent has nothing else to do.
 */

import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";

import { MAX_TIMER_DELAY_MS, prompt } from "@oh-my-pi/pi-utils";
import { POLL_WAIT_LADDER_MS } from "../../async/job-manager";

import { IrcBus } from "../../irc/bus";

import hubDescription from "../../prompts/tools/hub.md" with { type: "text" };
import type { AgentRegistry } from "../../registry/agent-registry";
import type { ToolSession } from "..";

import {
	buildJobResult,
	executeCancel,
	executeJobsSnapshot,
	noMatchingJobsResult,
	nothingToWaitForResult,
	snapshotJobs,
	visibleJobs,
} from "./jobs";

import { executeLaunch } from "./launch";
import { type LaunchParams } from "@oh-my-pi/pi-tui/tools/hub";
import {
	drainPendingInbox,
	executeInbox,
	executeList,
	executeMessageWait,
	executeSend,
	messageResult,
} from "./messaging";

import { DEFAULT_HUB_LIST_LIMIT, type HubDetails, MAX_HUB_LIST_LIMIT } from "@oh-my-pi/pi-tui/tools/hub";
import { hubErrorResult } from "./types";

export type { LaunchParams, LaunchToolDetails } from "@oh-my-pi/pi-tui/tools/hub";
export { isIrcEnabled } from "./messaging";
export * from "./types";

const hubSchema = type({
	op: type(
		"'send' | 'wait' | 'inbox' | 'list' | 'jobs' | 'cancel' | 'start' | 'ps' | 'logs' | 'stop' | 'restart' | 'describe'",
	).describe("hub operation"),
	"to?": type("string").describe('send: recipient agent id or "all"'),
	"message?": type("string").describe("send: message body"),
	"replyTo?": type("string").describe("send: message id being answered"),
	"await?": type("boolean").describe('send: wait for the recipient\'s reply (invalid with to:"all")'),
	"from?": type("string").describe("wait: only accept a message from this agent id"),
	"ids?": type("string[]").describe("wait: job ids to watch (omit = all running jobs); cancel: job ids to kill"),
	"peek?": type("boolean").describe("inbox: list messages without consuming them"),
	"status?": type("'running' | 'idle' | 'parked'").describe("list: filter by status; omit for running+idle"),
	"limit?": type("number > 0").describe(
		`list: max peer rows; default ${DEFAULT_HUB_LIST_LIMIT}, max ${MAX_HUB_LIST_LIMIT}`,
	),
	"name?": type("string <= 48").describe("process ops: stable project-scoped launch name"),
	"application?": type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeout?": type("number > 0").describe("seconds to wait; default 30"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last omp client exiting; default false"),
	"detached?": type("boolean").describe(
		"start: survive every omp and broker exit; implies persist and disables PTY input",
	),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs: output cursor returned by an earlier call"),
	"for?": type("'ready' | 'exit'").describe("wait with name: lifecycle condition; default exit"),
	"pattern?": type("string > 0").describe("wait with name: output regex; takes precedence over for"),
	"text?": type("string > 0").describe("send with name: stdin text"),
	"enter?": type("boolean").describe("send with name: append Enter after text; default true"),
	"keys?": type("string[]").describe("send with name: terminal keys after text"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe(
		"send with name: process-tree signal",
	),
	"timeout?": type("number > 0").describe("logs/stop/wait with name: max seconds; default 30 (stop: 5)"),
});

type HubParams = typeof hubSchema.infer;

interface MessagingDeps {
	registry: AgentRegistry;
	senderId: string;
	settings: ToolSession["settings"];
	/** Caller session file: direct sends refresh this root's persisted roster before resolving the target. */
	sessionFileHint?: string | null;
}

const PROGRESS_INTERVAL_MS = 500;

/** Mutating process ops require exec approval; messaging, jobs, and inspection are read-only. */
function hubApproval(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "exec";
	const op = params.op;
	switch (op) {
		case "wait":
		case "inbox":
		case "list":
		case "jobs":
		case "cancel":
		case "ps":
		case "logs":
		case "describe":
			return "read";
		case "send": {
			// Peer DMs are read-tier; writing to a process stdin is exec-tier.
			const name = "name" in params ? params.name : undefined;
			const to = "to" in params ? params.to : undefined;
			return typeof name === "string" && name.length > 0 && !to ? "exec" : "read";
		}
		default:
			// start / stop / restart and anything unrecognized.
			return "exec";
	}
}

export class HubTool implements AgentTool<typeof hubSchema, HubDetails> {
	readonly name = "hub";
	readonly approval = hubApproval;
	readonly label = "Hub";
	readonly summary = "Message peer agents, control background jobs, and supervise long-running processes";
	readonly description: string;
	readonly parameters = hubSchema;
	readonly strict = true;
	readonly interruptible = (params: Partial<HubParams>): boolean => {
		if (params.op === "wait") return true;
		return params.op === "logs" && params.follow === true;
	};
	readonly loadMode = "essential";

	readonly examples: readonly ToolExample<typeof hubSchema.infer>[] = [
		{
			caption: "List peers",
			call: { op: "list" },
		},
		{
			caption: "Inspect parked peer history",
			call: { op: "list", status: "parked" },
		},
		{
			caption: "Fire-and-forget DM — same send wakes idle/parked peers",
			call: {
				op: "send",
				to: "AuthLoader",
				message: "Still touching src/server/auth.ts? I need to add a 401 path.",
			},
		},
		{
			caption: "Round-trip when you cannot proceed without the answer",
			call: {
				op: "send",
				to: "Main",
				message: "JWT or session cookies for the auth flow?",
				await: true,
			},
		},
		{
			caption: "Completely blocked: wait for the first finished job or incoming message",
			call: { op: "wait" },
		},
		{
			caption: "Block until a specific peer answers",
			call: { op: "wait", from: "AuthLoader" },
		},
		{
			caption: "Kill a hung background job",
			call: { op: "cancel", ids: ["bash_a1b2c3"] },
		},
		{
			caption: "Snapshot every background job without waiting",
			call: { op: "jobs" },
		},
		{
			caption: "Start a dev server and wait for its log banner and port",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeout: 30 },
			},
		},
		{
			caption: "Follow process output after a cursor",
			call: { op: "logs", name: "web", follow: true, cursor: 1842, timeout: 30 },
		},
		{
			caption: "Drive a REPL/debugger over stdin",
			call: { op: "send", name: "debugger", text: "breakpoint set --name main" },
		},
		{
			caption: "Interrupt a process",
			call: { op: "send", name: "debugger", keys: ["CTRL_C"] },
		},
		{
			caption: "Block until a process is ready",
			call: { op: "wait", name: "web", for: "ready", timeout: 30 },
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(hubDescription);
	}

	/** Messaging deps when this session can address peers; null otherwise. */
	#messaging(): MessagingDeps | null {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry || !senderId) return null;
		return {
			registry,
			senderId,
			settings: this.session.settings,
			sessionFileHint: this.session.getSessionFile?.() ?? null,
		};
	}

	async execute(
		_toolCallId: string,
		params: HubParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<HubDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<HubDetails>> {
		switch (params.op) {
			case "list": {
				const messaging = this.#messaging();
				if (!messaging) return hubErrorResult("Peer messaging is unavailable in this session.", { op: "list" });
				return executeList(
					messaging.registry,
					messaging.senderId,
					{
						status: params.status,
						limit: params.limit,
					},
					this.session.getSessionFile(),
				);
			}
			case "send": {
				const toPeer = params.to?.trim();
				const toProcess = params.name?.trim();
				if (toPeer && toProcess) {
					return hubErrorResult('`to` (peer) and `name` (process) are mutually exclusive for op="send".', {
						op: "send",
					});
				}
				if (toProcess) return this.#launch(params, "send", signal);
				const messaging = this.#messaging();
				if (!messaging) return hubErrorResult("Peer messaging is unavailable in this session.", { op: "send" });
				return executeSend(messaging, params, signal);
			}
			case "inbox": {
				const messaging = this.#messaging();
				if (!messaging) return hubErrorResult("Peer messaging is unavailable in this session.", { op: "inbox" });
				return executeInbox(messaging.registry, messaging.senderId, params.peek);
			}
			case "wait":
				if (params.name?.trim()) return this.#launch(params, "wait", signal);
				return this.#executeWait(params, signal, onUpdate);
			case "cancel": {
				const manager = this.session.asyncJobManager;
				if (!manager) return this.#asyncDisabled("cancel");
				if (!params.ids?.length) {
					return hubErrorResult('`ids` is required for op="cancel".', { op: "cancel", jobs: [] });
				}
				return await executeCancel(this.session, manager, this.#ownerId(), params.ids);
			}
			case "jobs": {
				const manager = this.session.asyncJobManager;
				if (!manager) return this.#asyncDisabled("jobs");
				return executeJobsSnapshot(this.session, manager, this.#ownerId());
			}
			case "start":
			case "ps":
			case "logs":
			case "stop":
			case "restart":
			case "describe":
				return this.#launch(params, params.op === "ps" ? "list" : params.op, signal);
			default:
				return hubErrorResult("Unknown hub op.", { op: params.op });
		}
	}

	/** Job visibility scope: everything the calling agent owns (tests/SDK without an agent id see all). */
	#ownerId(): string | undefined {
		return this.session.getAgentId?.() ?? undefined;
	}

	#asyncDisabled(op: "cancel" | "jobs"): AgentToolResult<HubDetails> {
		return {
			content: [{ type: "text", text: "Async execution is disabled; no background jobs are available." }],
			details: { op, jobs: [] },
		};
	}

	/** Route a process-supervision op to the launch broker, honoring `launch.enabled`. */
	async #launch(
		params: HubParams,
		op: LaunchParams["op"],
		signal?: AbortSignal,
	): Promise<AgentToolResult<HubDetails>> {
		if (!this.session.settings.get("launch.enabled")) {
			return hubErrorResult("Process supervision is disabled (launch.enabled=false).", { op: params.op });
		}
		const { op: _hubOp, ...rest } = params;
		return executeLaunch(this.session, { ...rest, op }, signal);
	}

	/**
	 * Unified wait: race the caller's running jobs against incoming peer
	 * messages. Returns on the FIRST settled job, the first matching message,
	 * window expiry, or abort — never "when everything finishes"; the model
	 * re-issues to keep waiting. With no job legs it degrades to a pure
	 * message wait; with no messaging it is exactly the old job poll.
	 */
	async #executeWait(
		params: HubParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<HubDetails>,
	): Promise<AgentToolResult<HubDetails>> {
		const messaging = this.#messaging();
		const manager = this.session.asyncJobManager;
		const ownerId = this.#ownerId();
		const from = params.from?.trim() || undefined;
		const backoffMs = this.session.settings.get("async.waitBackoffMs") ?? POLL_WAIT_LADDER_MS;
		if (
			!Array.isArray(backoffMs) ||
			backoffMs.length === 0 ||
			backoffMs.some(ms => !Number.isInteger(ms) || ms < 1 || ms > MAX_TIMER_DELAY_MS)
		) {
			return hubErrorResult(
				`async.waitBackoffMs must be a nonempty list of integer milliseconds from 1 to ${MAX_TIMER_DELAY_MS}.`,
				{ op: "wait" },
			);
		}

		// A message already buffered on the session satisfies the wait first.
		if (messaging) {
			const pending = drainPendingInbox(messaging.registry, messaging.senderId, from);
			if (pending) return messageResult(messaging.senderId, pending);
		}

		// Resolve which jobs to watch:
		// - explicit `ids` → exactly those (owner-scoped; missing ids corrected);
		// - omitted → every running job the caller owns.
		const ids = params.ids;
		const jobsToWatch = manager
			? ids?.length
				? visibleJobs(manager, ids, ownerId)
				: manager.getRunningJobs(ownerId ? { ownerId } : undefined)
			: [];
		if (manager && ids?.length && jobsToWatch.length === 0) {
			return noMatchingJobsResult(this.session, ids);
		}
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (manager && jobsToWatch.length > 0 && runningJobs.length === 0) {
			// Every explicitly watched job already settled — immediate snapshot.
			return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
		}

		// Wait window: the adaptive ladder starts at the floor and climbs as the
		// agent waits in a tight loop, then resets once it steps away (see
		// AsyncJobManager.nextPollWaitMs). Job and message waits share one
		// per-owner ladder; only paths that actually block advance and record it.
		const nextWindowMs = (): number => manager?.nextPollWaitMs(ownerId, Date.now(), backoffMs) ?? backoffMs[0];

		if (!manager || runningJobs.length === 0) {
			// No job legs: pure message wait — or nothing to block on at all.
			if (!messaging) return nothingToWaitForResult(this.session);
			// The bus mailbox is a separate store from the session-pending buffer
			// drained above, and only `executeMessageWait` below ever reads it. A
			// peer that sends and then stops running leaves its message queued
			// there, so without this take the liveness gate would answer "nothing
			// to wait for" while `hub inbox` hands back the very message being
			// waited on. Single atomic take: the rest of the backlog stays queued.
			const queued = IrcBus.global().take(messaging.senderId, from);
			if (queued) return messageResult(messaging.senderId, queued);
			if (!from) {
				// A bare wait can only be satisfied by a running peer eventually
				// sending something; with none, return the snapshot immediately
				// instead of blocking a full message-timeout window.
				const hasRunningPeer = messaging.registry
					.listVisibleTo(messaging.senderId)
					.some(ref => messaging.registry.isRunning(ref));
				if (!hasRunningPeer) return nothingToWaitForResult(this.session);
			}
			try {
				return await executeMessageWait(messaging, { from, timeoutMs: nextWindowMs() }, signal);
			} finally {
				manager?.recordPollWaitEnd(ownerId);
			}
		}

		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);

		// Message leg: park a bus waiter with no timeout of its own — the race
		// window governs. Cancelled via sentinel so late losers do not reject.
		const busAbort = messaging ? new AbortController() : undefined;
		const busCancelled = new Error("hub wait settled");
		let removeBusAbortListener: (() => void) | undefined;
		const busLeg =
			messaging && busAbort
				? IrcBus.global()
						.wait(messaging.senderId, { from }, 0, busAbort.signal)
						.then(
							message => ({ message, error: null as Error | null }),
							error => ({
								message: null,
								error:
									error === busCancelled ? null : error instanceof Error ? error : new Error(String(error)),
							}),
						)
				: undefined;
		if (busLeg) racePromises.push(busLeg);
		if (busAbort && signal) {
			if (signal.aborted) {
				busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
			} else {
				const onAbort = (): void => {
					busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeBusAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
		}

		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = setTimeout(() => timeoutResolve(), nextWindowMs());
		racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const emitProgress = () => {
			if (!onUpdate) return;
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobsToWatch) },
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			clearTimeout(timeoutHandle);
			clearInterval(progressTimer);
			busAbort?.abort(busCancelled);
			removeBusAbortListener?.();
			// Reset the idle-gap clock: escalate if the agent waits again soon,
			// drop back to the floor once it goes quiet for a while.
			manager.recordPollWaitEnd(ownerId);
		}

		// A message consumed by the bus waiter must never be dropped — it wins
		// even a photo-finish race (job results re-deliver themselves; a
		// dequeued message would otherwise be lost).
		if (busLeg && messaging) {
			const settled = await busLeg;
			if (settled.message) return messageResult(messaging.senderId, settled.message);
		}

		return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
	}
}
