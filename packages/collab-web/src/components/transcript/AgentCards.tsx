/**
 * Subagent traffic as first-class chat rows: spawned-task cards with live
 * per-agent status, background job completions, and inter-agent messages.
 */
import type { AgentProgress, CustomMessageEntry } from "@oh-my-pi/pi-wire";
import { ChevronRight, CornerDownRight, SquareArrowOutUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useState } from "react";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { detailsRecord, isRecord, num, str } from "../../tool-render/util";
import type { ActivityItem } from "./activity";
import { useAgentLive } from "./agent-live";
import { type AsyncJobResult, type IrcTraffic, parseAsyncResult } from "./agent-notices";
import { Markdown } from "./Markdown";
import { JobOutput } from "./JobOutput";

type AgentState = "pending" | "running" | "done" | "failed" | "aborted";

const STATE_LABEL: Record<AgentState, string> = {
	pending: "queued",
	running: "running",
	done: "done",
	failed: "failed",
	aborted: "aborted",
};

interface SpawnView {
	id: string;
	description?: string;
	state: AgentState;
	activity?: string;
	stats: string[];
}

function stateFromProgress(status: string | null): AgentState | undefined {
	switch (status) {
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "aborted":
			return "aborted";
		default:
			return undefined;
	}
}

/** One task tool call → one row per spawned agent, merging final results, live bus progress, and the roster. */
function useSpawnViews(item: ActivityItem): SpawnView[] {
	const live = useAgentLive();
	const args = isRecord(item.args) ? item.args : {};
	const partial =
		isRecord(item.partialResult) && isRecord(item.partialResult.details) ? item.partialResult.details : null;
	const details = detailsRecord(item.result) ?? partial;
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	const snapshots = details && Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];

	const specs: { id: string | null; description: string | null }[] = Array.isArray(args.tasks)
		? args.tasks.filter(isRecord).map(task => ({ id: str(task.id), description: str(task.description) }))
		: [{ id: str(args.id), description: str(args.description) }];
	// Ids the host assigned (results/progress) fill in tasks the model left unnamed.
	const hostIds = [...results, ...snapshots].map(entry => str(entry.id)).filter(id => id !== null);

	return specs.map((spec, index) => {
		const id = spec.id ?? hostIds[index] ?? `#${index + 1}`;
		const result = results.find(entry => str(entry.id) === id);
		const snapshot = snapshots.find(entry => str(entry.id) === id);
		const progress: AgentProgress | undefined = live.progress.get(id)?.progress;
		const lifecycle = live.lifecycle.get(id)?.status;
		const roster = live.agents.find(agent => agent.id === id)?.status;

		let state: AgentState;
		if (result) {
			state = result.aborted === true ? "aborted" : num(result.exitCode) === 0 ? "done" : "failed";
		} else if (lifecycle === "completed") state = "done";
		else if (lifecycle === "failed" || lifecycle === "aborted") state = lifecycle;
		else {
			state =
				stateFromProgress(progress?.status ?? null) ??
				(roster === "running" ? "running" : roster === "aborted" ? "aborted" : roster ? "done" : undefined) ??
				stateFromProgress(str(snapshot?.status)) ??
				(item.running ? "running" : "pending");
		}

		const stats: string[] = [];
		const tokens = num(result?.tokens) ?? progress?.tokens ?? num(snapshot?.tokens);
		if (tokens) stats.push(`${fmtTokens(tokens)} tok`);
		const cost = num(result?.cost) ?? progress?.cost;
		if (cost) stats.push(fmtCost(cost));
		const durationMs = num(result?.durationMs) ?? progress?.durationMs ?? num(snapshot?.durationMs);
		if (durationMs) stats.push(fmtDuration(durationMs));

		const activity =
			state === "running"
				? (progress?.lastIntent ?? progress?.currentTool ?? str(snapshot?.lastIntent) ?? undefined)
				: undefined;
		return {
			id,
			description: spec.description ?? progress?.description ?? str(snapshot?.description) ?? undefined,
			state,
			activity,
			stats,
		};
	});
}

function StateNode({ state }: { state: AgentState }): ReactNode {
	return state === "running" ? (
		<span className="tr-agent-spin" aria-label="running" />
	) : (
		<span className={`tr-agent-dot tr-agent-dot--${state}`} aria-hidden="true" />
	);
}

/** A `task` tool call: the spawned subagents, always visible, each row opening its transcript. */
export function SubagentCard({ item, host }: { item: ActivityItem; host?: ToolRenderHost }): ReactNode {
	const spawns = useSpawnViews(item);
	const running = spawns.filter(spawn => spawn.state === "running" || spawn.state === "pending").length;
	const done = spawns.filter(spawn => spawn.state === "done").length;
	const failed = spawns.filter(spawn => spawn.state === "failed" || spawn.state === "aborted").length;
	const counts = [running > 0 && `${running} running`, done > 0 && `${done} done`, failed > 0 && `${failed} failed`]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className="tr-subagents">
			<div className="tr-subagents-head">
				<span className="tr-subagents-title">
					{spawns.length === 1 ? "Subagent" : `${spawns.length} subagents`}
				</span>
				{counts && <span className="tr-subagents-counts">{counts}</span>}
			</div>
			<ul className="tr-subagents-list">
				{spawns.map(spawn => {
					const openable = host?.hasAgent?.(spawn.id) === true;
					const body = (
						<>
							<StateNode state={spawn.state} />
							<span className="tr-subagent-main">
								<span className="tr-subagent-line">
									<span className="tr-subagent-id">{spawn.id}</span>
									{spawn.description && <span className="tr-subagent-desc">{spawn.description}</span>}
								</span>
								{spawn.activity && <span className="tr-subagent-activity">{spawn.activity}</span>}
							</span>
							<span className="tr-subagent-meta">
								<span className={`tr-subagent-state tr-subagent-state--${spawn.state}`}>
									{STATE_LABEL[spawn.state]}
								</span>
								{spawn.stats.length > 0 && <span>{spawn.stats.join(" · ")}</span>}
							</span>
						</>
					);
					return (
						<li key={spawn.id}>
							{openable ? (
								<button
									type="button"
									className="tr-subagent"
									onClick={() => host?.openAgent?.(spawn.id)}
									title={`open ${spawn.id}'s transcript`}
								>
									{body}
								</button>
							) : (
								<div className="tr-subagent">{body}</div>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

const OUTCOME_VERB: Record<AsyncJobResult["outcome"], string> = {
	completed: "finished",
	failed: "failed",
	aborted: "was aborted",
};

function JobRow({ job, host }: { job: AsyncJobResult; host?: ToolRenderHost }): ReactNode {
	const [open, setOpen] = useState(false);
	const openable = host?.hasAgent?.(job.id) === true;
	const expandable = job.output.trim() !== "" || job.data !== undefined || job.error || job.abortReason;
	const tone = job.outcome === "completed" ? "done" : job.outcome;
	return (
		<div className={open ? "tr-job tr-job--open" : "tr-job"}>
			<div className="tr-job-line">
				<button
					type="button"
					className="tr-job-head"
					aria-expanded={open}
					disabled={!expandable}
					onClick={() => setOpen(v => !v)}
				>
					<ChevronRight size={13} className={`tr-chev${open ? " tr-chev--open" : ""}`} aria-hidden="true" />
					<span className={`tr-agent-dot tr-agent-dot--${tone}`} aria-hidden="true" />
					<span className="tr-job-id">{job.id}</span>
					<span className="tr-job-verb">{OUTCOME_VERB[job.outcome]}</span>
					{(job.agent ?? job.type) && <span className="tr-chip">{job.agent ?? job.type}</span>}
					{job.type === "bash" && job.label && <span className="tr-job-label">{job.label}</span>}
					{job.durationMs !== undefined && <span className="tr-job-time">{fmtDuration(job.durationMs)}</span>}
				</button>
				{openable && (
					<button
						type="button"
						className="tr-job-open"
						onClick={() => host?.openAgent?.(job.id)}
						title={`open ${job.id}'s transcript`}
						aria-label={`open ${job.id}'s transcript`}
					>
						<SquareArrowOutUpRight size={13} />
					</button>
				)}
			</div>
			{open && (
				<div className="tr-job-body">
					{job.abortReason && <p className="tr-job-note tr-job-note--err">{job.abortReason}</p>}
					{job.error && job.error !== job.abortReason && (
						<p className="tr-job-note tr-job-note--err">{job.error}</p>
					)}
					<JobOutput job={job} />
				</div>
			)}
		</div>
	);
}

/** `async-result`: background jobs (subagents, bash) reporting back — one compact line each. */
export const AsyncResultNotice = memo(function AsyncResultNotice({
	entry,
	host,
}: {
	entry: CustomMessageEntry;
	host?: ToolRenderHost;
}): ReactNode {
	const jobs = parseAsyncResult(entry);
	return (
		<div className="tr-row tr-row--custom">
			<div className="tr-body tr-jobs">
				{jobs.map((job, i) => (
					<JobRow key={`${job.id}:${i}`} job={job} host={host} />
				))}
			</div>
		</div>
	);
});

/** IRC notices and parent steering deliveries share this attributed chat presentation. */
export const IrcNotice = memo(function IrcNotice({
	traffic,
	recipient,
}: {
	traffic: IrcTraffic;
	recipient: string;
}): ReactNode {
	const { from, to, body, images } = traffic;
	return (
		<div className="tr-row tr-row--custom">
			<div className="tr-body">
				<div className="tr-irc">
					<div className="tr-irc-head">
						<CornerDownRight size={12} aria-hidden="true" />
						<span className="tr-irc-from">{from}</span>
						<span className="tr-irc-arrow">→</span>
						<span className="tr-irc-to">{to ?? recipient}</span>
					</div>
					<div className="tr-irc-body">
						<Markdown text={body} />
						{images?.map((image, index) => (
							<img
								key={index}
								className="tr-msg-img"
								src={`data:${image.mimeType};base64,${image.data}`}
								alt="attachment"
							/>
						))}
					</div>
				</div>
			</div>
		</div>
	);
});
