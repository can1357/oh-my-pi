/**
 * Periodic completion self-estimates for running subagents.
 *
 * On the {@link PROBE_DELAYS_MS} backoff schedule the subagent is asked, through
 * the same ephemeral side turn `/btw` uses ({@link AgentSession.runEphemeralTurn}),
 * to estimate how complete its task is. The side turn reuses the live session's
 * system prompt, tools and history, so it reads the main conversation's prompt
 * cache and never touches the transcript. The reply is one JSON line
 * `{"pct": 40, "stage": "…", "watch": "…"}` (see {@link parseCompletionEstimate}):
 * the percentage feeds `AgentProgress.completionPercent`, the stage
 * `AgentProgress.stage` (the running row's label) and the watch hint
 * `AgentProgress.watch` (what the job widget author should chart).
 *
 * Each probe also receives the run's previous estimate and the tool calls the
 * agent is still streaming: a long `write` is invisible in history until it
 * finishes, so without it the estimate stalls near 0% for minutes.
 */
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import {
	formatDuration,
	isInteractiveHost,
	isRecord,
	jsonContainerEnd,
	logger,
	prompt,
	sanitizeText,
} from "@oh-my-pi/pi-utils";
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
	onEstimate: (estimate: CompletionEstimate, cost: number) => void;
}

/** One parsed probe reply. */
export interface CompletionEstimate {
	/** Whole-number completion, 0–100. */
	percent: number;
	/** The agent's current step in its own words; ≤ {@link MAX_STAGE_CHARS} chars, one line. */
	stage?: string;
	/** Which output or metric shows the agent's progress and what target; ≤ {@link MAX_WATCH_CHARS} chars, one line. */
	watch?: string;
}

/** Longest stage line kept from a probe reply. */
export const MAX_STAGE_CHARS = 80;
/** Longest watch hint kept from a probe reply. */
export const MAX_WATCH_CHARS = 200;

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value)));
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
	return clampPercent(value);
}

/** A free-text reply field as one sanitized line of at most `max` chars; `undefined` when empty or not a string. */
function replyLine(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = sanitizeText(value).replace(/\s+/g, " ").trim();
	if (line.length === 0) return undefined;
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** `pct` as a number (`40`, `40.5`) or a numeric string (`"40"`, `"40%"`). */
function replyPercent(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? clampPercent(value) : undefined;
	if (typeof value !== "string") return undefined;
	const match = /^\s*(\d{1,3}(?:\.\d+)?)\s*%?\s*$/.exec(value);
	return match ? clampPercent(Number(match[1])) : undefined;
}

/**
 * Balanced `{…}` spans of `text`, outermost first in reading order. String
 * literals are skipped so braces inside a stage line do not split the object.
 */
function jsonObjectSpans(text: string): string[] {
	const spans: string[] = [];
	for (let start = text.indexOf("{"); start !== -1;) {
		const end = jsonContainerEnd(text, start);
		if (end === -1) break;
		spans.push(text.slice(start, end));
		start = text.indexOf("{", end);
	}
	return spans;
}

/**
 * Parse a probe reply: the JSON line `{"pct": 40, "stage": "…", "watch": "…"}`,
 * also when wrapped in a code fence or surrounded by prose. `pct` is clamped to
 * 0–100; `stage` and `watch` are flattened to one line and capped at
 * {@link MAX_STAGE_CHARS} / {@link MAX_WATCH_CHARS}. A reply without a usable
 * JSON `pct` falls back to a plain percentage (`40%`, see
 * {@link parseCompletionPercent}), keeping any stage/watch the JSON carried.
 * Returns `undefined` when no percentage can be read.
 */
export function parseCompletionEstimate(reply: string): CompletionEstimate | undefined {
	let stage: string | undefined;
	let watch: string | undefined;
	for (const span of jsonObjectSpans(reply)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(span);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		stage ??= replyLine(parsed.stage, MAX_STAGE_CHARS);
		watch ??= replyLine(parsed.watch, MAX_WATCH_CHARS);
		const percent = replyPercent(parsed.pct ?? parsed.percent);
		if (percent !== undefined) {
			return {
				percent,
				...(stage !== undefined ? { stage } : {}),
				...(watch !== undefined ? { watch } : {}),
			};
		}
	}
	const percent = parseCompletionPercent(reply);
	if (percent === undefined) return undefined;
	return { percent, ...(stage !== undefined ? { stage } : {}), ...(watch !== undefined ? { watch } : {}) };
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
	let previous: { percent: number; stage?: string; at: number } | undefined;
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
					previous: previous && {
						percent: previous.percent,
						stage: previous.stage,
						ago: formatDuration(Date.now() - previous.at),
					},
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
			const estimate = parseCompletionEstimate(replyText);
			if (signal.aborted) return;
			if (estimate === undefined) {
				logger.debug("Subagent completion probe reply had no percentage", { reply: replyText.slice(0, 200) });
				return;
			}
			previous = { percent: estimate.percent, stage: estimate.stage, at: Date.now() };
			options.onEstimate(estimate, assistantMessage.usage?.cost?.total ?? 0);
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
