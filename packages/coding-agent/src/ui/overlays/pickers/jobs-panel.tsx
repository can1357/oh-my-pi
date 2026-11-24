/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The jobs pill's sheet: the background jobs of the viewed agent and its
 * subagents as a tree (a task job heads the jobs its subagent started) beside
 * the selected job's detail, and a Close action.
 *
 * The detail leads with a status line (pill, live elapsed, type · id, Cancel
 * job while it runs and the sheet may cancel), then what the job is for (a
 * task's intent and caption) or the command it runs, its facts, its live
 * widget, and its output: the run's own output, or — for a traced command —
 * the output of a step the user picked in the command's step view or a pipe
 * or file it writes, chosen from the source menu.
 *
 * The sheet reads the session through {@link JobsPanelSource} whenever
 * `refresh` changes (the host ticks it while the sheet is open). A selected
 * job the session evicts stays listed until the selection moves.
 *
 * The terminal draws the list and the selected job's facts as plain rows
 * (look `omp.jobs.sheet`, `src/ui/styles/pickers/jobs.ts`).
 */
import { type Accessor, computed, type JSXNode, type KeyEvent, signal, untrack } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { ShellVisualization } from "@oh-my-pi/pi-natives";
import type {
	ShellTrace,
	ShellVizLayer,
	ShellVizPreferences,
	ShellVizPresentation,
	TspKvProps,
	TspMenuProps,
	TspSpan,
	TspTone,
} from "@oh-my-pi/pi-wire";
import type { JobWidgetView } from "../../../tools/details/job-widget";
import type { ShellStream } from "../../../tools/shell-steps";
import { defaultShellVizPreferences, readShellPresentation } from "../../../tools/shell-viz";
import { buildJobTree, type JobTreeAgent } from "../../../modes/view-model/overlays/job-tree";
import "../../styles/pickers/jobs";
import type { JobsSheetTerm, JobsTermDetail, JobsTermRow } from "../../styles/pickers/jobs";
import { JobWidget } from "../../tools/jobs/widget";
import { stableKey } from "./format";
import type { SheetAttributes } from "../sheet";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { ActionButton, QuietButton } from "../panels/common";

/** One async job as the session snapshots it. */
export interface JobsPanelJob {
	readonly id: string;
	readonly type: string;
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly label: string;
	/** What the job is for, in the model's words. */
	readonly intent?: string;
	/** One line on what a command does and when it ends. */
	readonly caption?: string;
	readonly startTime: number;
	readonly endTime?: number;
	/** Registry id of the agent that owns the job. */
	readonly ownerId?: string;
	/** Registry id of the subagent a task job runs. */
	readonly agentId?: string;
}

/** Running and recently settled jobs of an agent and its subagents. */
export interface JobsPanelSnapshot {
	readonly running: readonly JobsPanelJob[];
	readonly recent: readonly JobsPanelJob[];
	/** The agent the sheet is for: its jobs sit at the top level. */
	readonly rootId?: string;
	/** Subagents owning listed jobs, with the ancestors linking them to the root. */
	readonly agents?: readonly JobTreeAgent[];
}

/** What the sheet shows about the selected job beyond its row. */
export interface JobsPanelDetail {
	readonly command?: string;
	readonly cwd?: string;
	readonly pids: readonly number[];
	readonly exitCode?: number;
	/** Output tail while running; the final text once settled. */
	readonly output?: string;
	/** Milliseconds since the UNIX epoch the command last wrote `output`. */
	readonly outputModified?: number;
	/** Artifact holding the full output when `output` is cut. */
	readonly artifactId?: string;
	readonly widget?: JobWidgetView;
	/** The command's shell trace: the command is drawn as its steps, the running one marked. */
	readonly trace?: ShellTrace;
	/** Where the command writes besides its own output (pipes, redirected files), oldest first. */
	readonly streams?: readonly ShellStream[];
}

/** The session behind the sheet. */
export interface JobsPanelSource {
	load(): JobsPanelSnapshot;
	/** The job's detail; undefined once the job is gone. */
	inspect(id: string): JobsPanelDetail | undefined;
	/** Cancel a running job; omitted by a read-only sheet. */
	cancel?(id: string): void;
	close(): void;
}

export interface JobsPanelProps {
	readonly source: JobsPanelSource;
	/** The job selected at open (when listed). */
	readonly selected?: string;
	/** Read the session again whenever this changes. */
	readonly refresh?: Accessor<unknown>;
	/** Wall clock (ms); default `Date.now`. */
	readonly now?: () => number;
}

const STATUS_LABEL: Record<JobsPanelJob["status"], string> = {
	running: "Running",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

const STATUS_TONE: Record<JobsPanelJob["status"], TspTone> = {
	running: "pending",
	completed: "success",
	failed: "error",
	cancelled: "muted",
};

const STATUS_GLYPH: Record<JobsPanelJob["status"], TspSpan> = {
	running: { t: "●", fx: "pulse" },
	completed: { t: "✓" },
	failed: { t: "✕" },
	cancelled: { t: "⊘" },
};

const TYPE_ICON: Record<string, string> = { bash: "bash", task: "agent" };

/** Lines of the command shown before Expand. */
const COMMAND_PREVIEW_LINES = 6;
/** The run's own output among the output sources. */
const OWN_OUTPUT = "out";
/** A source written within this window reads as flowing. */
const FLOW_WINDOW_MS = 1_500;
const SOURCE_ACT = "source:";
/** Key of the job list; its events arrive at this keypath. */
const LIST_KEY = "jobs";
const STEP_ACT = "select:";

/** How long the job ran (running: so far). */
function jobAge(job: JobsPanelJob, now: number): number {
	return Math.max(0, (job.status === "running" ? now : (job.endTime ?? now)) - job.startTime);
}

function jobTitle(job: JobsPanelJob): string {
	return job.intent ?? job.label;
}

/** One output source: the run's own output, or a stream it writes. */
interface OutputSource {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly text: string | undefined;
	readonly open: boolean;
	readonly modified?: number;
	/** Execution node that writes it (a stream's producer). */
	readonly node?: string;
}

/** What the output pane shows: the source the user pinned, else the run's own output. */
interface ShownOutput {
	readonly source: OutputSource;
	readonly sources: readonly OutputSource[];
	readonly pinned: boolean;
	/** Execution nodes the command highlights as writing the shown source. */
	readonly focus: readonly string[];
}

function outputSources(detail: JobsPanelDetail | undefined, running: boolean): OutputSource[] {
	const own: OutputSource = {
		id: OWN_OUTPUT,
		label: "Output",
		text: detail?.output ?? "",
		open: running,
		modified: detail?.outputModified,
	};
	const streams = (detail?.streams ?? []).map((stream): OutputSource => ({
		id: stream.id,
		label: stream.kind === "file" ? stream.consumer : `${stream.producer} | ${stream.consumer}`,
		detail: stream.kind === "file" ? `written by ${stream.producer}` : "pipe",
		text: stream.tail(),
		open: stream.open,
		modified: stream.modified || undefined,
		node: stream.node,
	}));
	return [own, ...streams];
}

/** Pin of the output pane: a source picked from the menu, or a step of the command. */
type OutputPin = { readonly source: string } | { readonly step: string };

function shownOutput(sources: readonly OutputSource[], pin: OutputPin | undefined): ShownOutput {
	const own = sources[0]!;
	if (pin && "source" in pin) {
		const source = sources.find(entry => entry.id === pin.source);
		if (source) return { source, sources, pinned: true, focus: source.node ? [source.node] : [] };
	}
	if (pin && "step" in pin) {
		const stream = sources.find(entry => entry.node === pin.step);
		return {
			source: stream ?? own,
			sources,
			pinned: true,
			focus: [pin.step],
		};
	}
	return { source: own, sources, pinned: false, focus: [] };
}

/** The flattened tree, with the held selection kept where it was. */
interface JobsView {
	readonly rows: readonly { job: JobsPanelJob; depth: number }[];
	readonly running: number;
	readonly recent: number;
}

/** Tern's sheet: a large centered one titled Background jobs. */
export const JOBS_SHEET: SheetAttributes = {
	role: "omp.overlay.jobs",
	size: "lg",
	anchor: "center",
	head: "Background jobs",
};

/** The jobs sheet. */
export function JobsPanel(props: JobsPanelProps): JSXNode {
	const { source } = props;
	const now = props.now ?? Date.now;
	const selectedId = signal<string | undefined>(props.selected);
	/** The selected job as last listed: kept while the session no longer lists it. */
	let held: JobsPanelJob | undefined;
	const pin = signal<OutputPin | undefined>(undefined);
	const preferences = signal<ShellVizPreferences>(defaultShellVizPreferences());

	const snapshot = computed(() => {
		props.refresh?.();
		return { jobs: source.load(), now: now() };
	});

	const view = computed((): JobsView => {
		const { jobs } = snapshot();
		const selected = selectedId();
		let running = [...jobs.running];
		let recent = [...jobs.recent];
		const listed = [...running, ...recent].find(job => job.id === selected);
		if (listed) held = listed;
		else if (held && held.id === selected) {
			if (held.status === "running") running = [...running, held];
			else recent = [...recent, held];
		}
		const tree = buildJobTree([...running, ...recent], jobs.agents ?? [], jobs.rootId);
		const rows: { job: JobsPanelJob; depth: number }[] = [];
		for (const row of tree) if (row.kind === "job") rows.push({ job: row.job, depth: row.depth });
		return { rows, running: running.length, recent: recent.length };
	});

	// Open on the requested job when listed, else the first.
	untrack(() => {
		const rows = view().rows;
		if (!rows.some(row => row.job.id === selectedId())) selectedId.set(rows[0]?.job.id);
	});

	const selectedJob = computed(() => {
		const id = selectedId();
		return view().rows.find(row => row.job.id === id)?.job;
	});

	const detail = computed(() => {
		snapshot();
		const job = selectedJob();
		return job ? source.inspect(job.id) : undefined;
	});

	const select = (id: string | undefined): void => {
		if (id === undefined || id === selectedId()) return;
		if (!view().rows.some(row => row.job.id === id)) return;
		held = undefined;
		pin.set(undefined);
		selectedId.set(id);
	};

	const move = (delta: number): void => {
		const rows = view().rows;
		const at = rows.findIndex(row => row.job.id === selectedId());
		const next = rows[Math.max(0, Math.min(rows.length - 1, at + delta))];
		select(next?.job.id);
	};

	const cancel = (): void => {
		const job = selectedJob();
		if (job?.status === "running" && source.cancel) source.cancel(job.id);
	};

	const onAction = (act: string, event: { readonly key: string; readonly value?: unknown }): void => {
		// The step view's controls arrive as `shell-viz` actions carrying the control's action.
		if (act === "shell-viz" && typeof event.value === "string") act = event.value;
		if (act === "close") source.close();
		else if (act === "cancel") cancel();
		else if (act === "follow") pin.set(undefined);
		else if (act.startsWith(SOURCE_ACT)) {
			const id = act.slice(SOURCE_ACT.length);
			pin.set(id === OWN_OUTPUT ? undefined : { source: id });
		} else if (act.startsWith(STEP_ACT)) pin.set({ step: act.slice(STEP_ACT.length) });
		else preferences.set(changePreferences(preferences(), act));
	};

	const onKey = (key: KeyEvent): boolean => {
		if (matchesSelectCancel(key)) {
			source.close();
			return true;
		}
		switch (selectKeyId(key)) {
			case "up":
				move(-1);
				return true;
			case "down":
				move(1);
				return true;
			case "x":
				cancel();
				return true;
		}
		return false;
	};

	const term = computed((): JobsSheetTerm => {
		const { now: at } = snapshot();
		const { rows, running } = view();
		const selected = selectedJob();
		const termRows = rows.map(({ job, depth }): JobsTermRow => ({
			status: job.status,
			type: job.type,
			age: formatDuration(jobAge(job, at)),
			label: job.agentId !== undefined && job.intent ? `${job.agentId}: ${job.intent}` : jobTitle(job),
			depth,
		}));
		return {
			role: "omp.jobs.sheet",
			running,
			rows: termRows,
			selected: rows.findIndex(row => row.job === selected),
			detail: selected ? termDetail(selected, detail(), shown()) : undefined,
		};
	});

	const shown = computed((): ShownOutput | undefined => {
		const job = selectedJob();
		if (!job) return undefined;
		return shownOutput(outputSources(detail(), job.status === "running"), pin());
	});

	return (
		<col
			term={term}
			onKey={onKey}
			onAction={onAction}
			onSelect={(item, event) => {
				if (event.key.endsWith(LIST_KEY)) select(item);
			}}
			onActivate={(item, event) => {
				if (event.key.endsWith(LIST_KEY)) select(item);
			}}
		>
			{() =>
				view().rows.length === 0 ? (
					<col key="empty" role="omp.jobs.empty" align="center">
						<icon name="jobs" />
						<text role="omp.jobs.empty.title" text="No background jobs" />
						<text
							role="omp.jobs.empty.note"
							text="Commands and subagent tasks started in the background show up here while they run."
							wrap="word"
						/>
					</col>
				) : (
					<row key="split" role="omp.jobs.split">
						<col key="master" role="omp.jobs.master">
							<list
								key={LIST_KEY}
								selected={() => selectedId()}
								max={{ lines: 12 }}
								actions={{ click: "select", dblclick: "activate" }}
							>
								{() =>
									view().rows.map(({ job, depth }) => <JobItem job={job} depth={depth} now={snapshot().now} />)
								}
							</list>
						</col>
						{() => {
							const job = selectedJob();
							const output = shown();
							if (!job || !output) return null;
							return (
								<JobDetail
									job={job}
									detail={detail()}
									now={snapshot().now}
									cancellable={source.cancel !== undefined}
									shown={output}
									preferences={preferences()}
								/>
							);
						}}
					</row>
				)
			}
			<row key="actions" role="omp.actions" gap="sm" align="center">
				{() =>
					view().rows.length > 0 && (
						<text
							key="summary"
							role="omp.jobs.summary"
							text={`${view().running} running · ${view().recent} recent`}
							wrap="none"
						/>
					)
				}
				<spacer grow={1} />
				<ActionButton id="close" label="Close" title="Close  esc" keys={["escape"]} />
			</row>
		</col>
	);
}

function JobItem(props: { job: JobsPanelJob; depth: number; now: number }): JSXNode {
	const { job, depth } = props;
	const age = formatDuration(jobAge(job, props.now));
	const title = jobTitle(job);
	const state = job.status === "completed" ? "done" : job.status;
	const label: TspSpan[] = [];
	if (depth > 0) label.push({ t: `${"   ".repeat(depth - 1)}└─ `, s: "mono dim" });
	if (job.agentId !== undefined) label.push({ t: `${job.agentId} `, s: "strong" }, { t: title });
	else label.push({ t: title, s: "mono" });
	const tooltip = [
		title,
		job.caption,
		job.intent !== undefined && job.intent !== job.label ? job.label : undefined,
		`${STATUS_LABEL[job.status]} · ${job.type} · ${job.id}`,
	].filter(line => line !== undefined);
	return (
		<item
			key={job.id}
			icon={TYPE_ICON[job.type] ?? "jobs"}
			label={label}
			value={[{ t: age, s: "mono" }]}
			tone={STATUS_TONE[job.status]}
			aria={`${title}, ${state}, ${age}`}
			title={tooltip.join("\n")}
		/>
	);
}

/** Facts of the selected job as a `kv` row. */
function jobFacts(job: JobsPanelJob, detail: JobsPanelDetail | undefined): TspKvProps["items"] {
	const items: TspKvProps["items"][number][] = [];
	if (job.agentId !== undefined) items.push({ k: "Agent", v: [{ t: job.agentId, s: "mono" }] });
	if (detail?.cwd) items.push({ k: "Directory", v: [{ t: detail.cwd, s: "path" }] });
	if (detail && detail.pids.length > 0) items.push({ k: "PIDs", v: [{ t: detail.pids.join(", "), s: "num" }] });
	if (detail?.exitCode !== undefined)
		items.push({
			k: "Exit code",
			v: [{ t: String(detail.exitCode), s: detail.exitCode === 0 ? "success" : "error" }],
		});
	if (detail?.artifactId) items.push({ k: "Full output", v: [{ t: `local://${detail.artifactId}.log`, s: "mono" }] });
	return items;
}

/** A trace snapshot's restored visualization, once read (null: the engine rejected it). */
const kVisualization = Symbol("jobs.visualization");

interface VisualizedTrace extends ShellTrace {
	[kVisualization]?: ShellVisualization | null;
}

/** The command as its shell steps (a traced run); undefined without a trace or when the engine rejects it. */
function stepPresentation(
	trace: ShellTrace | undefined,
	preferences: ShellVizPreferences,
): ShellVizPresentation | undefined {
	if (!trace) return undefined;
	const held = trace as VisualizedTrace;
	let visualization = held[kVisualization];
	if (visualization === undefined) {
		try {
			visualization = new ShellVisualization(JSON.stringify(trace));
		} catch {
			visualization = null;
		}
		held[kVisualization] = visualization;
	}
	return visualization ? readShellPresentation(visualization, preferences, trace) : undefined;
}

const SHELL_LAYERS: readonly ShellVizLayer[] = ["color", "inline", "idioms", "effects", "unwrap"];

/** `preferences` after a step view control (`view:raw`, `layer:color`, `split`); unchanged for anything else. */
function changePreferences(preferences: ShellVizPreferences, act: string): ShellVizPreferences {
	if (act === "view:raw" || act === "view:pseudo") return { ...preferences, view: act.slice(5) as "raw" | "pseudo" };
	if (act === "split") return { ...preferences, split: !preferences.split };
	const layer = SHELL_LAYERS.find(name => act === `layer:${name}`);
	if (layer) return { ...preferences, layers: { ...preferences.layers, [layer]: !preferences.layers[layer] } };
	return preferences;
}

function JobDetail(props: {
	job: JobsPanelJob;
	detail: JobsPanelDetail | undefined;
	now: number;
	cancellable: boolean;
	shown: ShownOutput;
	preferences: ShellVizPreferences;
}): JSXNode {
	const { job, detail, shown } = props;
	const running = job.status === "running";
	const age = Math.round(jobAge(job, props.now));
	const command = detail?.command ?? (job.type === "task" ? undefined : job.label);
	const facts = jobFacts(job, detail);
	const presentation = stepPresentation(detail?.trace, props.preferences);
	return (
		<col key={stableKey(job.id)} role="omp.jobs.detail">
			<row role="omp.jobs.status" gap="sm" align="center">
				<text
					role="omp.jobs.state"
					spans={[STATUS_GLYPH[job.status], { t: ` ${STATUS_LABEL[job.status]}` }]}
					tone={STATUS_TONE[job.status]}
					wrap="none"
				/>
				<elapsed
					role="omp.jobs.age"
					age={age}
					format="short"
					title={running ? "Running for" : "Ran for"}
					stopped={running ? undefined : age}
				/>
				<text role="omp.jobs.id" spans={[{ t: `${job.type} · ${job.id}`, s: "mono" }]} wrap="none" truncate="end" />
				<spacer grow={1} />
				{running && props.cancellable && (
					<ActionButton id="cancel" label="Cancel job" title="Cancel job  x" tone="error" keys={["x"]} />
				)}
			</row>
			{job.type === "task" && (
				<col key="about" role="omp.jobs.about" gap="xs">
					<text role="omp.jobs.title" text={jobTitle(job)} title={jobTitle(job)} wrap="word" />
					{job.caption && (
						<text
							role="omp.jobs.caption"
							spans={[{ t: job.caption, s: "muted" }]}
							title={job.caption}
							wrap="word"
						/>
					)}
				</col>
			)}
			{presentation ? (
				<shell
					key="command"
					role="omp.jobs.command"
					presentation={presentation}
					lang="bash"
					preview={{ lines: COMMAND_PREVIEW_LINES }}
					steps
					focus={shown.focus}
				/>
			) : (
				command !== undefined && (
					<code
						role="omp.jobs.command"
						text={command}
						lang="bash"
						wrap
						preview={{ lines: COMMAND_PREVIEW_LINES }}
					/>
				)
			)}
			{facts.length > 0 && <kv role="omp.jobs.facts" layout="inline" items={facts} />}
			{detail?.widget && (
				<col key="widget" role="omp.jobs.widget">
					<JobWidget view={detail.widget} />
				</col>
			)}
			<JobOutput shown={shown} running={running} now={props.now} />
		</col>
	);
}

function JobOutput(props: { shown: ShownOutput; running: boolean; now: number }): JSXNode {
	const { shown, running } = props;
	const { source } = shown;
	const flowing = source.modified !== undefined && props.now - source.modified < FLOW_WINDOW_MS;
	const menu: TspMenuProps | undefined =
		shown.sources.length > 1
			? {
					text: source.label,
					trigger: "quiet",
					align: "start",
					items: shown.sources.map(entry => ({
						id: `${SOURCE_ACT}${entry.id}`,
						label: entry.label,
						...(entry.detail ? { detail: entry.detail } : {}),
						radio: "source",
						checked: entry.id === source.id,
					})),
				}
			: undefined;
	const note =
		source.text === undefined
			? "Binary data"
			: source.text === ""
				? source.open
					? "No output yet"
					: "No output"
				: undefined;
	return (
		<col key="out" role="omp.jobs.out" gap="sm">
			<row key="source" role="omp.jobs.source" gap="sm" align="center">
				{menu ? (
					<menu key="sources" title="Output source" {...menu} />
				) : (
					<text role="omp.jobs.label" text={source.label} />
				)}
				{source.detail && shown.pinned && (
					<text
						key="stream"
						role="omp.jobs.stream"
						spans={[{ t: source.detail, s: "mono" }]}
						wrap="none"
						truncate="end"
					/>
				)}
				<spacer grow={1} />
				{shown.pinned ? (
					<QuietButton label="Follow live" act="follow" title="Show what the command writes now">
						<row
							key="follow"
							role="omp.btn"
							gap="xs"
							align="center"
							title="Show what the command writes now"
							actions={{ click: "follow" }}
						>
							<text text="Follow live" />
						</row>
					</QuietButton>
				) : (
					running && (
						<text
							key="follow"
							role="omp.jobs.follow"
							text="Following"
							title="Shows what the command writes now; click a step of the command to show its output"
							wrap="none"
							tone={flowing ? "pending" : undefined}
						/>
					)
				)}
			</row>
			{note !== undefined ? (
				<text key="empty" role="omp.jobs.nooutput" text={note} />
			) : (
				<ansi
					key={`text-${stableKey(source.id)}`}
					role="omp.jobs.output"
					text={source.text ?? ""}
					follow={source.open}
					max={{ h: "16lines" }}
				/>
			)}
		</col>
	);
}

/** The selected job's terminal facts. */
function termDetail(
	job: JobsPanelJob,
	detail: JobsPanelDetail | undefined,
	shown: ShownOutput | undefined,
): JobsTermDetail {
	const facts: string[] = [];
	if (detail?.cwd) facts.push(`cwd ${detail.cwd}`);
	if (detail && detail.pids.length > 0) facts.push(`pid ${detail.pids.join(", ")}`);
	if (detail?.exitCode !== undefined) facts.push(`exit ${detail.exitCode}`);
	if (detail?.artifactId) facts.push(`local://${detail.artifactId}.log`);
	const command = detail?.command ?? (job.type === "task" ? undefined : job.label);
	return {
		caption: job.type === "task" ? job.caption : undefined,
		command,
		facts: facts.join(" · "),
		widget: detail?.widget,
		output: shown?.source.text,
	};
}
