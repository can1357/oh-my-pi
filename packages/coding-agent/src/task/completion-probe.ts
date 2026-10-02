/**
 * Periodic completion self-estimates for running subagents.
 *
 * Every `task.completionProbeMs` the subagent is asked, through the same
 * ephemeral side turn `/btw` uses ({@link AgentSession.runEphemeralTurn}), to
 * estimate how complete its task is. The side turn reuses the live session's
 * system prompt, tools and history, so it reads the main conversation's prompt
 * cache and never touches the transcript. The parsed percentage feeds
 * `AgentProgress.completionPercent`, which wait/task views render.
 *
 * Each probe also receives the run's previous estimate and the tool calls the
 * agent is still streaming: a long `write` is invisible in history until it
 * finishes, so without it the estimate stalls near 0% for minutes.
 */
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { formatDuration, logger, prompt } from "@oh-my-pi/pi-utils";
import completionProbePrompt from "../prompts/system/subagent-completion-probe.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";

/** Inputs for {@link startCompletionProbe}. */
export interface CompletionProbeOptions {
	/** Probe period; values ≤ 0 disable probing. */
	intervalMs: number;
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
 * Probe the run's session every {@link CompletionProbeOptions.intervalMs} until
 * `signal` aborts. Ticks are skipped while the session is idle or a previous
 * probe is still in flight; failures are logged and the next tick retries.
 */
export function startCompletionProbe(options: CompletionProbeOptions): void {
	const { intervalMs, signal } = options;
	if (intervalMs <= 0 || signal.aborted) return;
	let inFlight = false;
	let previous: { percent: number; at: number } | undefined;
	const probe = async (): Promise<void> => {
		const session = options.session();
		if (inFlight || !session?.isStreaming || signal.aborted) return;
		inFlight = true;
		try {
			const { replyText, assistantMessage } = await session.runEphemeralTurn({
				promptText: prompt.render(completionProbePrompt, {
					inflight: inflightToolCalls(session),
					previous: previous && { percent: previous.percent, ago: formatDuration(Date.now() - previous.at) },
				}),
				signal,
			});
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
		} finally {
			inFlight = false;
		}
	};
	const timer = setInterval(() => void probe(), intervalMs);
	timer.unref?.();
	signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
