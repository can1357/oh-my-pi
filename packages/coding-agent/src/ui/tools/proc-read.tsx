/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Reads of `proc://` (background jobs and services): `proc://` lists every
 * job, service and agent; `proc://<id>` shows one job (its row and log) or
 * one service (its state facts in the head and its log, followed while it
 * runs). Routed from `read` through {@link registerReadScheme}.
 *
 * Terminal look: `proc-read` (`src/ui/styles/tools/proc-read.ts`), fed by {@link ProcReadTerm}.
 */

import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { type TspSpan, type TspTone, toolIntentLabel } from "@oh-my-pi/pi-wire";
import { splitUrlScheme } from "../../internal-urls/url-scheme";
import { ErrorText } from "./agent-common";
import type { ToolPresenter, ToolResult, ToolView } from "./contract";
import { type ReadArgs, registerReadScheme } from "./read";

/** A background job as proc reads report it. */
export interface ProcJob {
	readonly id: string;
	readonly type: string;
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly label: string;
	readonly intent?: string;
	readonly durationMs: number;
	readonly resultText?: string;
	readonly errorText?: string;
}

/** A service snapshot (a daemon record or a keyed service). */
export interface ProcService {
	readonly name?: string;
	readonly key?: string;
	readonly state: string;
	readonly pid?: number;
	readonly pids?: readonly number[];
	readonly startedAt: number;
	readonly exitedAt?: number;
	readonly persist?: boolean;
	readonly detached?: boolean;
	readonly policy?: { readonly hold?: string };
}

/** A sub-agent as proc reads report it. */
export interface ProcAgent {
	readonly id: string;
	readonly live?: boolean;
	readonly ageMs: number;
}

/** `details.proc` of a proc read. */
export interface ProcReadDetails {
	readonly jobs?: readonly ProcJob[];
	readonly agents?: readonly ProcAgent[];
	readonly daemons?: readonly ProcService[];
	readonly job?: ProcJob;
	readonly daemon?: ProcService;
	readonly log?: string;
	readonly terminalRows?: readonly string[];
}

/** A service as it is shown: name, state, pid, run time and what keeps it alive. */
export interface ServiceView {
	readonly name: string;
	readonly state: string;
	readonly pid?: number;
	readonly startedAt: number;
	readonly exitedAt?: number;
	readonly hold?: string;
}

/** Terminal-only facts of a proc read (`term`). */
export type ProcReadTerm = {
	readonly look: "proc-read";
	readonly phase: "call" | "error" | "result";
	/** The URL's target (empty: the whole table). */
	readonly id: string;
	readonly error?: string;
	/** A job read: the job and its log. */
	readonly job?: ProcJob;
	readonly log?: string;
	/** A service read: its state and facts (head meta) and its output rows. */
	readonly service?: {
		readonly state: string;
		readonly facts: readonly string[];
	};
	readonly rows?: readonly string[];
	/** The table read. */
	readonly table?: {
		readonly jobs: readonly ProcJob[];
		readonly services: readonly {
			readonly name: string;
			readonly state: string;
			readonly facts: readonly string[];
		}[];
		readonly agents: readonly ProcAgent[];
	};
	/** The result's text (a target read without a structured snapshot). */
	readonly text?: string;
};

export function serviceView(service: ProcService): ServiceView {
	const base = {
		state: service.state,
		startedAt: service.startedAt,
		exitedAt: service.exitedAt,
	};
	if (service.key !== undefined)
		return {
			...base,
			name: service.key,
			pid: service.pids?.[0],
			hold: service.policy?.hold,
		};
	return {
		...base,
		name: service.name ?? "",
		pid: service.pid,
		hold: service.detached ? "detached" : service.persist ? "persist" : "leases",
	};
}

/** A service's facts after its state: pid, run time, what keeps it alive. */
export function serviceFacts(service: ServiceView, now: number): string[] {
	const facts: string[] = [];
	if (service.pid !== undefined) facts.push(`pid ${service.pid}`);
	facts.push(
		`${service.exitedAt === undefined ? "up" : "ran"} ${formatDuration(Math.max(0, (service.exitedAt ?? now) - service.startedAt))}`,
	);
	if (service.hold === "detached") facts.push("detached");
	else if (service.hold === "persist") facts.push("persistent");
	return facts;
}

/** A job's name: its intent, else its label. */
export function jobLabel(job: ProcJob): string {
	return job.intent ? toolIntentLabel(job.intent) : job.label;
}

/** Tabs expanded, carriage returns dropped. */
export function safeText(value: string): string {
	return replaceTabs(value).replace(/\r/g, "");
}

function stateTone(state: string): TspTone {
	return state === "failed" ? "error" : state === "ready" || state === "running" ? "success" : "warning";
}

function jobTone(status: ProcJob["status"]): TspTone {
	return status === "failed"
		? "error"
		: status === "cancelled"
			? "warning"
			: status === "running"
				? "info"
				: "success";
}

function JobItem(props: { readonly job: ProcJob }): JSXNode {
	const { job } = props;
	return (
		<item
			key={job.id}
			label={[{ s: "accent", t: job.type }, { t: " " }, { s: "toolOutput", t: safeText(job.id) }]}
			detail={[{ s: "muted", t: safeText(jobLabel(job)) }]}
			value={[{ s: "muted", t: formatDuration(job.durationMs) }]}
			tone={jobTone(job.status)}
		/>
	);
}

function head(id: string, ...facts: (string | undefined)[]): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: id ? "Proc" : "Proc jobs & services" }];
	if (id) spans.push({ t: " " }, { s: "accent", t: safeText(id) });
	for (const fact of facts) if (fact) spans.push({ t: " " }, { s: "muted", t: fact });
	return spans;
}

function targetOf(args: ReadArgs | undefined): string {
	return typeof args?.path === "string" ? (splitUrlScheme(args.path)?.rest ?? "") : "";
}

function firstText(result: ToolResult): string {
	for (const block of result.content) if (block.type === "text") return block.text ?? "";
	return "";
}

function resultView(result: ToolResult<{ proc?: ProcReadDetails }>, now: number, id: string): ToolView {
	const details = result.details?.proc;
	const daemon = details?.daemon ? serviceView(details.daemon) : undefined;
	const daemonText = daemon ? [daemon.state, ...serviceFacts(daemon, now)].join(" · ") : undefined;
	if (result.isError) {
		const message = firstText(result) || "Process read failed.";
		return {
			label: head(id, daemonText),
			tone: "error",
			body: <ErrorText message={message} />,
			term: {
				look: "proc-read",
				phase: "error",
				id,
				error: message,
			} satisfies ProcReadTerm,
		};
	}
	if (details?.job) {
		const log = details.log ?? details.job.errorText ?? details.job.resultText ?? "";
		const term: ProcReadTerm = {
			look: "proc-read",
			phase: "result",
			id,
			job: details.job,
			log,
		};
		return {
			label: head(id, daemonText),
			body: [
				<list>
					<JobItem job={details.job} />
				</list>,
				log.trim().length > 0 && <ansi text={log} role="omp.tool.proc.log" />,
			],
			term,
		};
	}
	if (daemon && details) {
		const output = details.terminalRows?.join("\n") ?? details.log ?? "";
		const term: ProcReadTerm = {
			look: "proc-read",
			phase: "result",
			id,
			service: { state: daemon.state, facts: serviceFacts(daemon, now) },
			rows: details.terminalRows ?? (details.log ?? "").split("\n").filter(Boolean),
		};
		return {
			label: head(id, daemonText),
			body: <ansi text={output} follow={daemon.exitedAt === undefined} role="omp.tool.proc.log" />,
			term,
		};
	}
	if (id && !details?.jobs && !details?.daemons && !details?.agents) {
		const text = firstText(result);
		return {
			label: head(id),
			term: {
				look: "proc-read",
				phase: "result",
				id,
				text,
			} satisfies ProcReadTerm,
			body: text.trim() ? (
				<text spans={[{ s: "toolOutput", t: text }]} wrap="word" role="omp.tool.proc.preview" />
			) : undefined,
		};
	}
	const jobs = details?.jobs ?? [];
	const services = (details?.daemons ?? []).map(serviceView);
	const agents = details?.agents ?? [];
	const counts = [`${jobs.length} jobs`, `${services.length} services`];
	if (agents.length) counts.push(`${agents.length} agents`);
	const term: ProcReadTerm = {
		look: "proc-read",
		phase: "result",
		id,
		table: {
			jobs,
			services: services.map(service => ({
				name: service.name,
				state: service.state,
				facts: serviceFacts(service, now),
			})),
			agents,
		},
	};
	return {
		label: head(id, counts.join(" · ")),
		body: (
			<list empty="No background jobs or services." role="omp.tool.proc.table">
				{jobs.map(job => (
					<JobItem job={job} />
				))}
				{services.map(service => (
					<item
						key={`service:${service.name}`}
						label={[{ s: "accent", t: "service" }, { t: " " }, { s: "toolOutput", t: safeText(service.name) }]}
						detail={[
							{
								s: "muted",
								t: [service.state, ...serviceFacts(service, now)].join(" · "),
							},
						]}
						tone={stateTone(service.state)}
					/>
				))}
				{agents.map(agent => (
					<item
						key={`agent:${agent.id}`}
						label={[
							{ s: agent.live ? "accent" : "warning", t: "agent" },
							{ t: " " },
							{ s: "toolOutput", t: safeText(agent.id) },
						]}
						value={[{ s: "muted", t: formatDuration(agent.ageMs) }]}
					/>
				))}
			</list>
		),
		term,
	};
}

export const procReadPresenter: ToolPresenter<ReadArgs, { proc?: ProcReadDetails }> = {
	call(args): ToolView {
		const id = targetOf(args);
		return {
			label: head(id),
			term: { look: "proc-read", phase: "call", id } satisfies ProcReadTerm,
		};
	},
	result(result, _state, args) {
		return resultView(result, Date.now(), targetOf(args));
	},
};

registerReadScheme("proc", {
	label: "Process",
	rootDetail: "jobs & services",
	detailsKey: "proc",
	presenter: procReadPresenter as ToolPresenter,
});
