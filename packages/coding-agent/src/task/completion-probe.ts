/**
 * Periodic completion self-estimates for running subagents.
 *
 * On the {@link PROBE_DELAYS_MS} backoff schedule the subagent is asked, through
 * the same ephemeral side turn `/btw` uses ({@link AgentSession.runEphemeralTurn}),
 * to estimate how complete its task is. The side turn reuses the live session's
 * system prompt, tools and history, so it reads the main conversation's prompt
 * cache and never touches the transcript. The parsed percentage feeds
 * `AgentProgress.completionPercent`, which wait/task views render.
 *
 * Each probe also receives the run's previous estimate and the tool calls the
 * agent is still streaming: a long `write` is invisible in history until it
 * finishes, so without it the estimate stalls near 0% for minutes.
 */
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { formatDuration, isInteractiveHost, logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import completionProbePrompt from "../prompts/system/subagent-completion-probe.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { cfgTaskCompletionProbe } from "./settings";

/**
 * Wait before each successive probe: early estimates come quickly, long runs back
 * off to one side request an hour. The last entry repeats.
 */
const PROBE_DELAYS_MS = [2, 5, 10, 30, 60].map(minutes => minutes * 60_000);

/**
 * Whether a subagent spawned by a session at `parentDepth` gets completion probes.
 * Only the interactive TUI shows the estimate, so print/RPC/ACP/SDK hosts never pay
 * for it, and only the main agent's direct subagents (`parentDepth` 0) are probed.
 * Callers: the task executor and eval workpool, when building a run monitor.
 */
export function isCompletionProbeEnabled(settings: Settings, parentDepth: number): boolean {
	return parentDepth === 0 && isInteractiveHost() && cfgTaskCompletionProbe.get(settings);
}

/** Inputs for {@link startCompletionProbe}. */
export interface CompletionProbeOptions {
	/** The run's current session; probing skips ticks while it is absent or idle. */
	session: () => AgentSession | null;
	/** Stops the timer and cancels an in-flight probe. */
	signal: AbortSignal;
	/** Receives each parsed estimate with the side request's cost in USD. */
	onEstimate: (percent: number, cost: number) => void;
}

/**
 * Extract a 0–100 percentage from a probe reply (`"40%"`, `"~65 %"`, `"Roughly 70%."`).
 * Returns `undefined` when the reply carries no percentage.
 */
export function parseCompletionPercent(reply: string): number | undefined {
	const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(reply);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return undefined;
	return Math.min(100, Math.max(0, Math.round(value)));
}

/** A tool call the agent is still generating when the probe fires. */
interface InflightToolCall {
	name: string;
	path?: string;
	chars: number;
}

/** Tool calls in the session's in-flight assistant message, which the ephemeral snapshot drops. */
function inflightToolCalls(session: AgentSession): InflightToolCall[] {
	const message = session.agent.state.streamMessage;
	if (message?.role !== "assistant") return [];
	const calls: InflightToolCall[] = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const path = block.arguments?.path;
		calls.push({
			name: block.name,
			path: typeof path === "string" ? path : undefined,
			chars: (getStreamingPartialJson(block) ?? JSON.stringify(block.arguments ?? {})).length,
		});
	}
	return calls;
}

/**
 * Probe the run's session on the {@link PROBE_DELAYS_MS} schedule until `signal`
 * aborts. Each delay counts from the end of the previous probe, so probes never
 * overlap. A tick that finds the session idle is skipped; failures are logged.
 * Both still advance the schedule.
 */
export function startCompletionProbe(options: CompletionProbeOptions): void {
	const { signal } = options;
	if (signal.aborted) return;
	let step = 0;
	let timer: NodeJS.Timeout | undefined;
	let previous: { percent: number; at: number } | undefined;
	const probe = async (): Promise<void> => {
		const session = options.session();
		if (!session?.isStreaming || signal.aborted) return;
		try {
			const usageOwner = {
				sessionId: session.sessionManager.getSessionId(),
				parentId: session.sessionManager.getLeafId(),
			};
			const { replyText, assistantMessage } = await session.runEphemeralTurn({
				promptText: prompt.render(completionProbePrompt, {
					inflight: inflightToolCalls(session),
					previous: previous && { percent: previous.percent, ago: formatDuration(Date.now() - previous.at) },
				}),
				signal,
			});
			if (assistantMessage.usage) {
				session.sessionManager.appendModelUsage(
					{
						purpose: "task-completion-probe",
						api: assistantMessage.api,
						provider: assistantMessage.provider,
						model: assistantMessage.model,
						usage: assistantMessage.usage,
						stopReason: assistantMessage.stopReason,
					},
					usageOwner,
				);
			}
			const percent = parseCompletionPercent(replyText);
			if (signal.aborted) return;
			if (percent === undefined) {
				logger.debug("Subagent completion probe reply had no percentage", { reply: replyText.slice(0, 200) });
				return;
			}
			previous = { percent, at: Date.now() };
			options.onEstimate(percent, assistantMessage.usage?.cost?.total ?? 0);
		} catch (error) {
			if (!signal.aborted) {
				logger.debug("Subagent completion probe failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	};
	const schedule = (): void => {
		const delay = PROBE_DELAYS_MS[Math.min(step++, PROBE_DELAYS_MS.length - 1)];
		timer = setTimeout(async () => {
			await probe();
			if (!signal.aborted) schedule();
		}, delay);
		timer.unref?.();
	};
	schedule();
	signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}
