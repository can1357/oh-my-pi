/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The HUD pills row (`pills` slot, native only), right-aligned above the
 * activity line: one running-work counter (`omp.hud.pill`) with an agents
 * segment and a background-jobs segment, each present only while it has
 * something to count. The agents segment stays as a muted icon while the
 * session still holds agents the hub can inspect, so the click into the hub
 * outlives the last running subagent. While jobs draw widgets the jobs
 * segment adds the freshest widget's figure and mini spark, and a hover card
 * of their tiles. On a host that draws the tray the row is hidden: the tray
 * shows running work.
 *
 * A click sends `agents.open` (the agent hub) or `jobs.open` (the jobs
 * sheet). A text terminal draws nothing here (the status line counts agents
 * and jobs; the subagents HUD lists agents).
 */
import { computed, createRoot, type JSXNode, resolveChildren, signal, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspPropNode, TspSpan } from "@oh-my-pi/pi-wire";
import {
	type JobWidgetEntry,
	type JobWidgetSparkBlock,
	type JobWidgetView,
	latestJobWidget,
} from "../../tools/details/job-widget";
import "../styles/dock";
import { type JobTile, JobTiles, jobWidgetGlance, plainLine, toneColor } from "../tools/jobs/widget";
import { formatTooltipDoubleTap } from "../keys/hints";

/** What the counter shows; the controller feeds it from the agent registry and the job manager. */
export class HudPillsModel {
	/** `display.pinnedAgents` is not `off`. */
	readonly showAgents = signal(true);
	readonly agentsRunning = signal(0);
	/** Agents the hub can inspect (finished, parked, killed included). */
	readonly agentsInSession = signal(0);
	/** Background jobs running no agent. */
	readonly jobsRunning = signal(0);
	/** Their live widgets. */
	readonly jobWidgets = signal<readonly JobWidgetEntry[]>([]);
	/** The host draws the tray (its `hello` advertises `tray`). */
	readonly trayHost = signal(false);
	onOpenAgents: (() => void) | undefined;
	onOpenJobs: (() => void) | undefined;
}

/** Values the mini spark keeps from the primary spark. */
const MINI_SPARK_POINTS = 16;
/** Tiles the hover card shows before it counts the rest. */
const HOVERCARD_JOBS = 4;

/** `1 job running`, `2 agents running`. */
function running(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"} running`;
}

/** The first spark block, cut to its newest values. */
export function primarySpark(view: JobWidgetView): JobWidgetSparkBlock | undefined {
	const spark = view.blocks.find((block): block is JobWidgetSparkBlock => block.kind === "spark");
	if (!spark || spark.values.length === 0) return undefined;
	if (spark.values.length <= MINI_SPARK_POINTS) return spark;
	const from = spark.values.length - MINI_SPARK_POINTS;
	return {
		...spark,
		values: spark.values.slice(from),
		...(spark.tips ? { tips: spark.tips.slice(from) } : {}),
	};
}

/** The widget as one tooltip line: `loadtest — decode 186 tok/s ▲ 15%`. */
export function jobWidgetSummary(view: JobWidgetView): string {
	const glance = jobWidgetGlance(view);
	const title = plainLine(view.title);
	if (!glance) return title;
	const figure = [glance.label, glance.text, glance.trend && plainLine(glance.trend.text)].filter(Boolean).join(" ");
	return title ? `${title} — ${figure}` : figure;
}

/** A node tree as a prop node (a `hovercard`): kinds, wire props and keys; terminal-only `term` dropped. */
export function propNodeOf(node: UiNode): TspPropNode {
	return untrack(() => {
		const { term: _term, ...props } = node.props() as Record<string, unknown>;
		const wire: Record<string, unknown> = {};
		let any = false;
		for (const name in props) {
			const value = props[name];
			if (value === undefined || typeof value === "function") continue;
			wire[name] = value;
			any = true;
		}
		const children = node.children().map(propNodeOf);
		const key = node.key();
		const out: Record<string, unknown> = {
			k: node.kind === "canvas" ? "rows" : node.kind,
		};
		if (any) out.p = wire;
		if (children.length > 0) out.c = children;
		if (key !== undefined) out.key = key;
		// Built from a node tree's own kinds and props, which are the wire vocabulary.
		const propNode = out as unknown as TspPropNode;
		return propNode;
	});
}

/** The jobs' hover card: up to four live tiles, then `+N more jobs · /jobs`. */
function jobsHovercard(entries: readonly JobWidgetEntry[]): TspPropNode | undefined {
	if (entries.length === 0) return undefined;
	const tiles = entries.slice(0, HOVERCARD_JOBS).map((entry): JobTile => ({
		id: entry.id,
		type: entry.type,
		status: "running",
		label: entry.id,
		live: true,
		widget: entry.view,
	}));
	const rest = entries.length - tiles.length;
	return createRoot(dispose => {
		const card = (
			<col role="omp.jobs.hovercard" gap="md">
				<JobTiles tiles={tiles} />
				{rest > 0 && (
					<text
						spans={[
							{
								t: `+${rest} more ${rest === 1 ? "job" : "jobs"} · /jobs`,
								s: "dim",
							},
						]}
						role="omp.jobs.hovercard.more"
						wrap="none"
					/>
				)}
			</col>
		);
		const [root] = resolveChildren(card)();
		const described = root ? propNodeOf(root) : undefined;
		dispose();
		return described;
	});
}

/** A widget's glance as spans: strong figure, toned trend (the label is the tooltip's: no room for it in a pill). */
export function glanceSpans(view: JobWidgetView): TspSpan[] | undefined {
	const glance = jobWidgetGlance(view);
	if (!glance) return undefined;
	const spans: TspSpan[] = [{ t: glance.text, s: "num strong" }];
	if (glance.trend)
		spans.push({
			t: ` ${plainLine(glance.trend.text)}`,
			s: toneColor(glance.trend.tone),
		});
	return spans;
}

/** A widget's primary spark as the HUD's mini chart (keyed `spark`). */
export function MiniSpark(props: { readonly spark: JobWidgetSparkBlock }): JSXNode {
	const spark = props.spark;
	return (
		<chart
			key="spark"
			role="omp.hud.spark"
			kind="spark"
			size="sm"
			series={spark.values.map(value => ({ value }))}
			min={spark.min}
			max={spark.max}
			token={toneColor(spark.tone ?? "accent")}
			summary={`${plainLine(spark.label)} ${plainLine(spark.last)}`}
		/>
	);
}

function AgentsSegment(props: { readonly running: number; readonly inSession: number }): JSXNode {
	const shortcut = formatTooltipDoubleTap("left");
	if (props.running === 0) {
		const label = `No agents running · ${props.inSession} in this session`;
		return (
			<row
				key="agents"
				role="omp.hud.seg"
				gap="xs"
				align="center"
				title={`${label}  ${shortcut}`}
				aria={label}
				actions={{ click: "agents.open" }}
			>
				<icon key="icon" name="users" tone="muted" />
			</row>
		);
	}
	const label = running(props.running, "agent");
	return (
		<row
			key="agents"
			role="omp.hud.seg"
			gap="xs"
			align="center"
			title={`${label}  ${shortcut}`}
			aria={label}
			actions={{ click: "agents.open" }}
		>
			<icon key="icon" name="users" tone="accent" />
			<text key="count" spans={[{ t: String(props.running), s: "num" }]} wrap="none" />
		</row>
	);
}

function JobsSegment(props: { readonly running: number; readonly entries: readonly JobWidgetEntry[] }): JSXNode {
	const label = running(props.running, "job");
	const entries = props.entries;
	const latest = latestJobWidget(entries)?.view;
	const glance = latest && glanceSpans(latest);
	const spark = latest && primarySpark(latest);
	const title =
		entries.length > 0
			? [`${label}  /jobs`, ...entries.map(entry => `${entry.id}  ${jobWidgetSummary(entry.view)}`)].join("\n")
			: `${label}  /jobs`;
	const hovercard = jobsHovercard(entries);
	return (
		<row
			key="jobs"
			role="omp.hud.seg"
			gap="xs"
			align="center"
			title={title}
			aria={label}
			actions={{ click: "jobs.open" }}
			hovercard={hovercard}
		>
			<icon key="icon" name="job" tone="warning" />
			<text key="count" spans={[{ t: String(props.running), s: "num" }]} wrap="none" />
			{glance && <text key="glance" role="omp.hud.glance" spans={glance} wrap="none" />}
			{spark && <MiniSpark spark={spark} />}
		</row>
	);
}

/** See the module docs. */
export function HudPills(props: { readonly model: HudPillsModel }): JSXNode {
	const model = props.model;
	const agents = computed(() => {
		if (!model.showAgents()) return undefined;
		const run = model.agentsRunning();
		const inSession = model.agentsInSession();
		return run > 0 || inSession > 0 ? { running: run, inSession } : undefined;
	});
	const jobs = computed(() =>
		model.jobsRunning() > 0 ? { running: model.jobsRunning(), entries: model.jobWidgets() } : undefined,
	);
	const onAction = (act: string): void => {
		if (act === "agents.open") model.onOpenAgents?.();
		else if (act === "jobs.open") model.onOpenJobs?.();
	};
	return () => {
		if (model.trayHost()) return <row role="omp.hud" justify="end" hidden={true} />;
		const a = agents();
		const j = jobs();
		const empty = !a && !j;
		return (
			<row role="omp.hud" justify="end" hidden={empty || undefined} onAction={onAction}>
				{!empty && (
					<row key="running" role="omp.hud.pill" align="center">
						{a && <AgentsSegment running={a.running} inSession={a.inSession} />}
						{j && <JobsSegment running={j.running} entries={j.entries} />}
					</row>
				)}
			</row>
		);
	};
}
