import { errorMessage } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import { clearApprovalGrants } from "../tools/approval-cache";
import { clearSubmittedText } from "./helpers/draft";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { signal } from "@oh-my-pi/pi-tui";
import type { InteractiveModeContext } from "../modes/types";
import { formatCoarseDuration } from "../modes/view-model/chrome/format";
import type { PauseWorkStatus } from "../modes/view-model/overlays/pause-screen";
import { presentFullscreen } from "../ui/apps/fullscreen";
import { PAUSE_SHEET, PauseScreen } from "../ui/overlays/panels/pause-screen";

/** Advisors with review work they can still run (not parked, yielded, or quota-paused). */
function advisorUnsettledCount(session: AgentSessionHandle): number {
	return session
		.getAdvisorStatusOverview()
		.advisors.filter(advisor => advisor.backlog > 0 && !advisor.isPaused && !advisor.yielded).length;
}

/**
 * Outstanding work for the `/pause` screen. A subagent counts as a turn only
 * while its session streams and is not parked; its task job is deduplicated
 * against that same live set, so a pre-live or stale `running` ref still
 * counts through its job. Advisors of the root and every live subagent count.
 */
function pauseWorkStatus(root: AgentSession): PauseWorkStatus {
	const registry = AgentRegistry.global();
	const liveSubagents = registry.list().filter(ref => ref.kind === "sub" && registry.isRunning(ref));
	const liveSubagentIds = new Set(liveSubagents.map(ref => ref.id));
	let unsettledTurns = Number(root.isStreaming && !root.agent.isPaused) + advisorUnsettledCount(root);
	for (const ref of liveSubagents) {
		if (!ref.session) continue;
		if (!ref.session.agent.isPaused) unsettledTurns++;
		unsettledTurns += advisorUnsettledCount(ref.session);
	}
	const unfinishedJobs =
		root
			.getAsyncJobTree({ recentLimit: 0 })
			?.running.filter(job => job.type !== "task" || job.agentId === undefined || !liveSubagentIds.has(job.agentId))
			.length ?? 0;
	return { unsettledTurns, unfinishedJobs };
}

/** How often the pause screen re-reads outstanding work. */
const PAUSE_WORK_POLL_MS = 1_000;

/**
 * Engage the global pause gate and hold the fullscreen pause screen until the
 * user resumes. No-op when the gate is already engaged. Always releases the
 * gate on the way out (including teardown throws) — a leaked pause would
 * freeze every agent in the process with no UI left to release it.
 */
async function runPauseScreen(ctx: InteractiveModeContext): Promise<void> {
	if (!agentPauseGate.pause()) return;
	try {
		const startedAt = Date.now();
		const work = signal(pauseWorkStatus(ctx.session), {
			equals: (a, b) => a.unsettledTurns === b.unsettledTurns && a.unfinishedJobs === b.unfinishedJobs,
		});
		const timer = setInterval(() => work.set(pauseWorkStatus(ctx.session)), PAUSE_WORK_POLL_MS);
		const resumed = Promise.withResolvers<void>();
		await presentFullscreen(ctx.shell, () => ({
			view: () =>
				PauseScreen({
					sessionName: ctx.sessionName,
					since: () => startedAt,
					work,
					onResume: () => resumed.resolve(),
				}),
			sheet: PAUSE_SHEET,
			done: resumed.promise,
			dispose: () => clearInterval(timer),
		}));
	} finally {
		const heldMs = agentPauseGate.resume();
		if (heldMs !== undefined) {
			ctx.showStatus(`Resumed after ${formatCoarseDuration(heldMs)} — agents are running again.`);
		}
	}
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "autoprompt",
		icon: "sparkle",
		description: "Automatically submit predicted follow-ups within time, token, spend, and turn limits",
		allowArgs: true,
		subcommandOptional: true,
		subcommands: [
			{
				name: "start",
				description: "Start bounded automatic follow-ups",
				usage: "[--minutes N] [--tokens N] [--dollars N] [--turns N]",
			},
			{ name: "stop", description: "Stop automatic follow-ups" },
			{ name: "status", description: "Show auto-prompt limits and usage" },
		],
		handleTui: (command, runtime) => {
			const ctx = runtime.ctx;
			const tokens = command.args.trim().split(/\s+/).filter(Boolean);
			const verb = tokens.shift()?.toLowerCase() ?? "status";
			if (verb === "stop") {
				const stopped = ctx.eventController.composerPrediction.stopAutomatic();
				ctx.showStatus(stopped ? "Auto-prompt stopped." : "Auto-prompt is not running.");
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "status") {
				const status = ctx.eventController.composerPrediction.getAutomaticStatus();
				ctx.showStatus(
					status
						? `Auto-prompt active: ${status.turns}/${status.limits.turns} turns, ${Math.floor(status.elapsedMs / 60_000)}/${status.limits.minutes} min, ` +
							`${status.tokens}/${status.limits.tokens} tokens, $${status.dollars.toFixed(2)}/$${status.limits.dollars.toFixed(2)}.`
						: "Auto-prompt is not running.",
				);
				clearSubmittedText(runtime);
				return;
			}
			if (verb !== "start") {
				ctx.showError(
					"Usage: /autoprompt start [--minutes N] [--tokens N] [--dollars N] [--turns N] | stop | status",
				);
				clearSubmittedText(runtime);
				return;
			}
			const limits = { minutes: 480, tokens: 100_000, dollars: 5, turns: 20 };
			const maxima = { minutes: 1_440, tokens: 10_000_000, dollars: 1_000, turns: 1_000 };
			for (let i = 0; i < tokens.length; i++) {
				const match = /^(--minutes|--tokens|--dollars|--turns)(?:=(.+))?$/.exec(tokens[i]!);
				if (!match) {
					ctx.showError(`Unknown auto-prompt option: ${tokens[i]}`);
					clearSubmittedText(runtime);
					return;
				}
				const raw = match[2] ?? tokens[++i];
				const value = Number(raw);
				const key = match[1]!.slice(2) as keyof typeof limits;
				if (
					!raw ||
					!Number.isFinite(value) ||
					value <= 0 ||
					value > maxima[key] ||
					(key !== "dollars" && !Number.isInteger(value))
				) {
					ctx.showError(
						`${match[1]} needs a positive${key === "dollars" ? "" : " whole"} number no greater than ${maxima[key]}.`,
					);
					clearSubmittedText(runtime);
					return;
				}
				limits[key] = value;
			}
			clearSubmittedText(runtime);
			try {
				ctx.eventController.composerPrediction.startAutomatic(limits);
				ctx.showStatus(
					`Auto-prompt started: up to ${limits.turns} follow-ups, ${limits.minutes} min, ${limits.tokens} tokens, and estimated $${limits.dollars} spend. Limits are checked between turns, so an active turn may exceed them. Use /autoprompt stop to stop it.`,
				);
			} catch (error) {
				ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "force",
		icon: "hammer",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "Force: no active tools" : `Force: ${count} active tools`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				clearSubmittedText(runtime);
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				clearSubmittedText(runtime);
				return;
			}

			clearSubmittedText(runtime);

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "record",
		icon: "export",
		description: "Start or stop recording this screen to a replayable file (omp play)",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.toggleRecording();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "forget-approvals",
		icon: "trash",
		description: "Forget every file and folder approval Ask and remember has recorded",
		handle: async (_command, runtime) => {
			clearApprovalGrants(runtime.settings.getAgentDir());
			await runtime.output("Remembered approvals forgotten; the next read or write asks again.");
			return commandConsumed();
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		icon: "power",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];
