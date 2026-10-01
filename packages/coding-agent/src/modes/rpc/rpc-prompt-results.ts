/**
 * Prompt completion reporting for RPC mode.
 *
 * Every accepted `prompt`/`abort_and_prompt` that is not answered synchronously
 * with `data.agentInvoked: false` gets exactly one `prompt_result` frame, emitted
 * once all work the prompt caused has settled: immediately for local-only slash
 * commands and failures, or after the terminal `agent_end` of the run the prompt
 * started or joined. Hosts correlate on the command `id` instead of inferring
 * ownership of an `agent_end` that carries no prompt identity.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { stripRawHttpRequestDiagnostics } from "@oh-my-pi/pi-ai/utils/http-inspector";
import type { AgentSessionEvent } from "../../session/agent-session";
import { isRpcSessionSettled, type RpcSettleSession } from "./rpc-session-settle";
import type { RpcPromptError, RpcPromptResultFrame, RpcPromptStatus } from "./rpc-types";

/** A prompt accepted by RPC mode whose `prompt_result` is still owed; see {@link RpcPromptResults.begin}. */
export interface RpcPromptTicket {
	readonly id: string | undefined;
}

interface RunOutcome {
	status: RpcPromptStatus;
	error?: RpcPromptError;
}

interface OpenPrompt {
	/** `agent_start` count at acceptance; a later start begins a run this prompt may own. */
	startsAtBegin: number;
	/** Outcome of the first run started after acceptance, once the agent yielded it. */
	ownOutcome?: RunOutcome;
	/** Settled while another run was live: reported at the next yield that leaves nothing queued. */
	waiting: boolean;
}

/**
 * Correlates accepted prompts with the run that carries their work and emits
 * their `prompt_result`. Fed every session event through {@link observe}.
 *
 * A prompt reports when the agent **yields** its work (`agent_end` with
 * `yielded`), not when the session is done: background jobs may still wake the
 * session later (see {@link RpcSessionSettleWatcher}), which `sessionSettled`
 * on the frame reports.
 *
 * A prompt dispatched as a fresh turn owns the first run that starts after it
 * was accepted, so a late `agent_end` from an earlier run never settles it. A
 * prompt queued into a live run (steer/follow-up) resolves while that run
 * streams and reports at the first yield after its message left the queue.
 */
export class RpcPromptResults {
	#agentStarts = 0;
	#open = new Map<RpcPromptTicket, OpenPrompt>();
	readonly #session: RpcSettleSession;
	readonly #output: (frame: RpcPromptResultFrame) => void;

	/** @param session read for queue state and, at report time, the `sessionSettled` predicate. */
	constructor(session: RpcSettleSession, output: (frame: RpcPromptResultFrame) => void) {
		this.#session = session;
		this.#output = output;
	}

	/** Open a ticket before the prompt starts any work. Close it with exactly one report or {@link discard}. */
	begin(id: string | undefined): RpcPromptTicket {
		const ticket: RpcPromptTicket = { id };
		this.#open.set(ticket, { startsAtBegin: this.#agentStarts, waiting: false });
		return ticket;
	}

	/** Drop a ticket whose command was rejected before it was accepted (no `prompt_result` is owed). */
	discard(ticket: RpcPromptTicket): void {
		this.#open.delete(ticket);
	}

	/**
	 * The prompt's work reached the agent (dispatched or queued). Reports now if
	 * its own run already settled, otherwise at the next terminal `agent_end`.
	 */
	settle(ticket: RpcPromptTicket): void {
		const open = this.#open.get(ticket);
		if (!open) return;
		if (open.ownOutcome) {
			this.#report(ticket, true, open.ownOutcome);
		} else if (this.#session.isStreaming || this.#agentStarts > open.startsAtBegin) {
			// Queued into a live run, or its own run paused for agent-owned follow-up work (e.g. a retry).
			open.waiting = true;
		} else {
			// Idle with no run since acceptance: an abort won the race before dispatch.
			this.#report(ticket, true, { status: "aborted" });
		}
	}

	/** The prompt was handled locally without an agent turn. */
	completeLocal(ticket: RpcPromptTicket): void {
		this.#report(ticket, false, { status: "completed" });
	}

	/** The prompt failed before reaching the agent. */
	fail(ticket: RpcPromptTicket, message: string): void {
		this.#report(ticket, false, { status: "error", error: { message, retryable: false } });
	}

	/**
	 * Mark every open prompt aborted after a session transition. Transitions
	 * detach the agent before aborting it, so the interrupted run never
	 * publishes a terminal `agent_end` for them.
	 */
	abortOpen(): void {
		for (const [ticket, open] of this.#open) {
			if (open.waiting) this.#report(ticket, true, { status: "aborted" });
			else open.ownOutcome ??= { status: "aborted" };
		}
	}

	/** Track run boundaries; call after the event has been written so `prompt_result` follows its `agent_end`. */
	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.#agentStarts++;
			return;
		}
		if (event.type !== "agent_end" || this.#open.size === 0) return;
		// Older sessions omit `yielded`; only their terminal ends were yields.
		if (!(event.yielded ?? event.isTerminal !== false)) return;
		const outcome = runOutcome(event.messages);
		// A still-queued steer/follow-up has not been read by the agent yet.
		const queueDrained = this.#session.queuedMessageCount === 0;
		for (const [ticket, open] of this.#open) {
			if (open.waiting) {
				if (queueDrained) this.#report(ticket, true, outcome);
			} else if (!open.ownOutcome && this.#agentStarts > open.startsAtBegin) {
				open.ownOutcome = outcome;
			}
		}
	}

	#report(ticket: RpcPromptTicket, agentInvoked: boolean, outcome: RunOutcome): void {
		if (!this.#open.delete(ticket)) return;
		// A prompt command's response is written after the handler's remaining
		// microtasks; deferring to the next macrotask keeps every prompt_result
		// behind the response for the same id and lets queue drains land before
		// `sessionSettled` is read.
		setImmediate(() => {
			const frame: RpcPromptResultFrame = {
				type: "prompt_result",
				id: ticket.id,
				agentInvoked,
				status: outcome.status,
				sessionSettled: isRpcSessionSettled(this.#session),
			};
			if (outcome.error) frame.error = outcome.error;
			this.#output(frame);
		});
	}
}

/** Outcome of a run, read from its final assistant message. */
function runOutcome(messages: readonly AgentMessage[]): RunOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return { status: "error", error: promptError(message) };
		if (message.stopReason === "aborted") return { status: "aborted" };
		return { status: "completed" };
	}
	return { status: "completed" };
}

function promptError(message: AssistantMessage): RpcPromptError {
	const errorId = AIError.classifyMessage({
		api: message.api,
		provider: message.provider,
		model: message.model,
		errorId: message.errorId,
		errorMessage: message.errorMessage,
		errorClassificationMessage: message.errorClassificationMessage,
		errorStatus: message.errorStatus,
	});
	const error: RpcPromptError = {
		message: message.errorMessage ? stripRawHttpRequestDiagnostics(message.errorMessage) : "Provider request failed",
		provider: message.provider,
		model: message.model,
		retryable: AIError.is(errorId, AIError.Flag.Transient),
	};
	if (message.errorStatus !== undefined) error.httpStatus = message.errorStatus;
	return error;
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt's result must wait for the agent work.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

/**
 * Route a started prompt's resolution into its `prompt_result`: `false` without
 * extension-scheduled agent work completes locally, agent work settles through
 * the run, and a rejection is reported via `onError` and as a failed result.
 */
export function reportPromptResult(input: {
	ticket: RpcPromptTicket;
	prompt: Promise<boolean>;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (!agentInvoked) await input.waitForExtensionAgentMessageTasks?.();
			if (agentInvoked || input.hasExtensionAgentMessageTask?.()) input.results.settle(input.ticket);
			else input.results.completeLocal(input.ticket);
		})
		.catch(cause => {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			input.onError(error);
			input.results.fail(input.ticket, error.message);
		});
}

/**
 * Start a prompt under extension-message tracking and report its `prompt_result`.
 *
 * `startPrompt` receives an admission callback to forward as
 * `PromptOptions.onPromptAdmitted`. The returned promise resolves once the
 * prompt is admitted, or once it settles without ever being admitted; it never
 * rejects, since a failure is already routed to `onError` and the failed
 * `prompt_result`. Await it to acknowledge the command only after admission.
 */
export function watchAndReportPromptResult(input: {
	ticket: RpcPromptTicket;
	startPrompt: (onPromptAdmitted: () => void) => Promise<boolean>;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): Promise<void> {
	const admitted = Promise.withResolvers<void>();
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(() => input.startPrompt(admitted.resolve));
	reportPromptResult({
		ticket: input.ticket,
		prompt: trackedPrompt.prompt,
		results: input.results,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
	const settled = () => admitted.resolve();
	void trackedPrompt.prompt.then(settled, settled);
	return admitted.promise;
}
