/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The tray (`tray` slot, native only): on a host whose `hello` advertises
 * `tray`, a row of live cards over the composer — one per subagent and
 * background job, and a done card standing for finished agents without a
 * card of their own — in place of the HUD pills. Tern owns selection, order,
 * paging and motion; omp owns the words and which card is looked at closer
 * (the peek).
 *
 * The cards are flat faces ({@link TrayItem}) the controller builds from the
 * agent registry, the observer sessions and the job manager. An agent that
 * runs but only waits on its own agents or jobs carries `waiting` on its card
 * (`isWaitingOnOwnWork` in `task/task-details`); its dot holds still, and Tern
 * colors it apart from agents at work.
 *
 * Events: `tray.peek=<ref>` opens (or, empty, closes) the closer look —
 * handled here; `tray.open`, `tray.stop`, `tray.dismiss` and `jobs.open` go
 * to {@link TrayModel.onAction}. A text terminal draws nothing.
 */
import { For, type JSXNode, signal, untrack } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspTrayMain, TspTrayStatus } from "@oh-my-pi/pi-wire";
import type { JobWidgetView } from "../../tools/details/job-widget";
import { previewLine, shortenEmbeddedPaths, TRUNCATE_LENGTHS } from "../../utils/render-utils";
import { replaceTabs } from "../../utils/text-width";
import "../styles/dock";
import { JobWidget } from "../tools/jobs/widget";
import { kbdKeys } from "../keys/format";
import { glanceSpans, MiniSpark, primarySpark } from "./pills";

/** Fields every card face has. */
interface TrayFace {
	/** `agent:<id>`, `job:<id>` or `done`: the card's identity, hashed into its node key. */
	readonly key: string;
	readonly ref: string;
	readonly name: string;
	readonly status: TspTrayStatus;
	readonly aria: string;
	/** Whether the closer look adds anything to the face. */
	readonly look: boolean;
}

/**
 * An agent card's second line: the call it runs or last made (`Edit tray.tsx`) with what that
 * call changed (`+42 −12`) or that it failed, else plain text (`Queued`, its outcome).
 */
export interface TrayDoing {
	/** The call's tool as a verb (`Edit`); empty when the line is plain text. */
	readonly tool: string;
	/** What the call acts on (file names, a pattern, a command), else the plain text. */
	readonly text: string;
	/** Lines the finished call added and removed (an edit's diff); 0 for none. */
	readonly added: number;
	readonly removed: number;
	/** The finished call failed. */
	readonly callFailed: boolean;
}

/** A subagent's card. */
export interface TrayAgentItem extends TrayFace, TrayDoing {
	readonly item: "agent";
	/** Epoch ms of its latest tool call start, or of the moment it settled. */
	readonly acted: number;
	/** Running, but only waiting on its own agents or jobs (`isWaitingOnOwnWork` of its progress). */
	readonly waiting: boolean;
	readonly unread: number;
	/** Its agent type, when it says more than the name (closer look and aria only). */
	readonly type: string;
	readonly model: string;
	/** Tool calls so far; undefined before its first progress frame. */
	readonly tools: number | undefined;
	/** `22%` (context fill), else `12K tok`; empty when neither is known. */
	readonly stats: string;
	/** Epoch ms its run clock counts from. */
	readonly start: number;
	/** Its run's length once settled. */
	readonly duration: number | undefined;
	readonly openable: boolean;
}

/** A background job's card. */
export interface TrayJobItem extends TrayFace {
	readonly item: "job";
	readonly start: number;
	readonly duration: number | undefined;
	readonly view: JobWidgetView | undefined;
	/** Its last output lines, newline-joined. */
	readonly output: string;
	/** Its command, when it says more than the name. */
	readonly command: string;
}

/** One finished agent in the done card's closer look. */
export interface TrayDoneEntry {
	readonly id: string;
	readonly name: string;
	readonly status: "done" | "failed" | "stopped";
	/** `opus-4.5 · high · 4m 12s · 38 tools · $0.12`; empty when nothing is known. */
	readonly meta: string;
	/** Its last output or result line; empty when none. */
	readonly line: string;
	readonly openable: boolean;
}

/** The card standing for finished agents without a card of their own. */
export interface TrayDoneItem extends TrayFace {
	readonly item: "done";
	readonly count: number;
	/** Up to three names, then `+N`. */
	readonly names: string;
	/** The newest finished agents, most recently active first. */
	readonly entries: readonly TrayDoneEntry[];
}

export type TrayItem = TrayAgentItem | TrayJobItem | TrayDoneItem;

/** One operation in an agent's closer look. */
export interface TrayEvent {
	readonly tool: string;
	readonly text: string;
	readonly state: "ok" | "err" | "run";
	/** A running call's age, once it outlasts five seconds. */
	readonly age: number | undefined;
}

/** What an agent's closer look adds to its card. */
export interface TrayAgentDetail {
	readonly task: string;
	/** Oldest first, ending with the call the agent is inside. */
	readonly tail: readonly TrayEvent[];
}

/** What the tray shows; the controller feeds it. */
export class TrayModel {
	readonly items = signal<readonly TrayItem[]>([]);
	/** Only finished work: the host keeps a quiet tray out of sight until asked. */
	readonly quiet = signal(true);
	/** What the main agent is doing (sent while the tray has cards). */
	readonly main = signal<TspTrayMain | undefined>(undefined);
	/** Bumped to move keyboard focus into the tray. */
	readonly focus = signal(0);
	/** The card looked at closer, and (an agent's) detail. */
	readonly peek = signal<string | undefined>(undefined);
	readonly peekDetail = signal<TrayAgentDetail | undefined>(undefined);
	/** `tray.open`, `tray.stop`, `tray.dismiss` (with the card's ref) and `jobs.open`. */
	onAction: ((act: string, ref: string) => void) | undefined;

	/** Look closer at card `ref` (one whose look adds something), or close the look. */
	peekAt(ref: string | undefined): void {
		const item = ref ? this.items.peek().find(candidate => candidate.ref === ref) : undefined;
		if (ref && !item?.look) return;
		this.peek.set(item?.ref);
	}

	/** Move keyboard focus into the tray; false when it has no cards. */
	focusTray(): boolean {
		if (this.items.peek().length === 0) return false;
		this.focus.set(this.focus.peek() + 1);
		return true;
	}
}

/** Output lines a job card shows; its closer look with and without a widget. */
const OUT_LINES = 2;
const PEEK_OUT_LINES = 3;
const PEEK_OUT_LINES_BARE = 4;

function isLive(status: TspTrayStatus): boolean {
	return status === "queued" || status === "running";
}

function toneOf(status: TspTrayStatus): "accent" | "success" | "error" | "muted" {
	return status === "running" ? "accent" : status === "done" ? "success" : status === "failed" ? "error" : "muted";
}

/** The card's node key: a stable hash of its identity. */
export function trayKey(identity: string): string {
	return Bun.hash(identity).toString(36);
}

/** A card's status dot: it pulses while the item works, and holds still while an agent only waits. */
function Dot(props: { readonly status: TspTrayStatus; readonly waiting?: boolean }): JSXNode {
	const status = props.status;
	return (
		<text
			key="dot"
			role="omp.tray.dot"
			spans={[
				{
					t: "●",
					s: toneOf(status),
					...(status === "running" && !props.waiting ? { fx: "pulse" as const } : {}),
				},
			]}
			wrap="none"
		/>
	);
}

function Clock(props: {
	readonly start: number;
	readonly duration: number | undefined;
	readonly now: number;
}): JSXNode {
	const age = Math.max(0, Math.round(props.duration ?? props.now - props.start));
	return props.duration === undefined ? (
		<elapsed key="time" role="omp.tray.time" age={age} format="short" />
	) : (
		<elapsed key="time" role="omp.tray.time" age={age} stopped={age} format="short" />
	);
}

function cardProps(item: TrayItem) {
	return {
		role: "omp.tray.card",
		item: item.item,
		propRef: item.ref,
		status: item.status,
		tone: toneOf(item.status),
		...(item.item === "agent" ? { acted: item.acted } : {}),
		...(item.item === "agent" && item.waiting ? { waiting: true } : {}),
		...(item.look ? {} : { look: false }),
		aria: item.aria,
	} as const;
}

/** The call's verb and subject, else the plain text. */
function callSpans(doing: TrayDoing): TspSpan[] {
	if (!doing.tool) return [{ t: doing.text }];
	const verb: TspSpan = { t: doing.tool, s: "strong" };
	return doing.text ? [verb, { t: ` ${doing.text}` }] : [verb];
}

/** `+42 −12`, or `failed`: what the finished call changed, or that it failed; empty for neither. */
function outcomeSpans(doing: TrayDoing): TspSpan[] {
	if (doing.callFailed) return [{ t: "failed", s: "error" }];
	const spans: TspSpan[] = [];
	if (doing.added > 0) spans.push({ t: `+${doing.added}`, s: "success mono" });
	if (doing.removed > 0) {
		if (spans.length > 0) spans.push({ t: " " });
		spans.push({ t: `−${doing.removed}`, s: "error mono" });
	}
	return spans;
}

/** An agent card's second line in words (`Edit tray.tsx +42 −12`), for its aria. */
export function trayDoingText(doing: TrayDoing): string {
	return [callSpans(doing), outcomeSpans(doing)]
		.map(spans => spans.map(span => span.t).join(""))
		.filter(Boolean)
		.join(" ");
}

/** An agent card's second line: the call (it gives way first), then what it changed at the right. */
function DoingRow(props: { readonly item: TrayAgentItem }): JSXNode {
	const item = props.item;
	const outcome = outcomeSpans(item);
	return (
		<row
			key="doing"
			role="omp.tray.doing"
			gap="sm"
			align="center"
			tone={item.status === "failed" ? "error" : undefined}
		>
			<text key="call" role="omp.tray.call" spans={callSpans(item)} wrap="none" truncate="end" grow={1} shrink={1} />
			{outcome.length > 0 && <text key="outcome" role="omp.tray.outcome" spans={outcome} wrap="none" shrink={0} />}
		</row>
	);
}

function AgentCard(props: { readonly item: TrayAgentItem; readonly now: number }): JSXNode {
	const item = props.item;
	return (
		<col key={trayKey(item.key)} {...cardProps(item)}>
			<row key="head" role="omp.tray.head" gap="xs" align="center">
				<Dot status={item.status} waiting={item.waiting} />
				<text key="name" role="omp.tray.name" text={item.name} wrap="none" truncate="end" grow={1} />
				{item.unread > 0 && <badge key="unread" role="omp.tray.unread" text={String(item.unread)} tone="warning" />}
				<Clock start={item.start} duration={item.duration} now={props.now} />
				{item.tools !== undefined && (
					<row key="tools" role="omp.tray.tools" align="center">
						<text key="count" spans={[{ t: "/", s: "dim" }, { t: String(item.tools) }]} wrap="none" />
						<icon key="icon" name="gear" tone="muted" />
					</row>
				)}
			</row>
			<DoingRow item={item} />
			<row key="meta" role="omp.tray.meta" gap="sm" align="center">
				{item.model !== "" && (
					<text
						key="model"
						role="omp.tray.model"
						text={item.model}
						wrap="none"
						truncate="end"
						grow={1}
						shrink={1}
					/>
				)}
				{item.stats !== "" && <text key="stats" role="omp.tray.stats" text={item.stats} wrap="none" />}
			</row>
		</col>
	);
}

/** A job widget's stage as one card line. */
function stageLine(stage: string): string {
	return previewLine(shortenEmbeddedPaths(replaceTabs(sanitizeText(stage))), TRUNCATE_LENGTHS.CONTENT);
}

function JobGlance(props: { readonly view: JobWidgetView }): JSXNode {
	const view = props.view;
	const glance = glanceSpans(view);
	const spark = primarySpark(view);
	const stage = view.stage ? stageLine(view.stage) : "";
	return (
		<row key="glance" role="omp.tray.glance" gap="xs" align="center">
			{glance && <text key="glance" role="omp.hud.glance" spans={glance} wrap="none" />}
			{spark && <MiniSpark spark={spark} />}
			{stage !== "" && <text key="stage" role="omp.tray.stage" text={stage} wrap="none" truncate="end" />}
		</row>
	);
}

function hasGlance(view: JobWidgetView): boolean {
	return (
		glanceSpans(view) !== undefined ||
		primarySpark(view) !== undefined ||
		Boolean(view.stage && stageLine(view.stage))
	);
}

function JobOut(props: { readonly item: TrayJobItem; readonly lines: number }): JSXNode {
	const parts = props.item.output ? props.item.output.split("\n") : [];
	return (
		<text
			key="out"
			role="omp.tray.out"
			text={parts.slice(-props.lines).join("\n")}
			wrap="none"
			tone={props.item.status === "failed" ? "error" : undefined}
		/>
	);
}

function JobCard(props: { readonly item: TrayJobItem; readonly now: number }): JSXNode {
	const item = props.item;
	return (
		<col key={trayKey(item.key)} {...cardProps(item)}>
			<row key="head" role="omp.tray.head" gap="xs" align="center">
				<Dot status={item.status} />
				<text key="name" role="omp.tray.name" text={item.name} wrap="none" truncate="end" grow={1} />
				<text key="id" role="omp.tray.id" text={item.ref} wrap="none" />
				<Clock start={item.start} duration={item.duration} now={props.now} />
			</row>
			{item.view && hasGlance(item.view) ? <JobGlance view={item.view} /> : <JobOut item={item} lines={OUT_LINES} />}
		</col>
	);
}

function DoneCard(props: { readonly item: TrayDoneItem }): JSXNode {
	const item = props.item;
	return (
		<col key={trayKey(item.key)} {...cardProps(item)}>
			<row key="head" role="omp.tray.head" gap="xs" align="center">
				<Dot status="done" />
				<text key="name" role="omp.tray.name" text={item.name} wrap="none" truncate="end" grow={1} />
			</row>
			<text key="doing" role="omp.tray.doing" spans={[{ t: item.names }]} wrap="none" truncate="end" />
		</col>
	);
}

function Button(props: {
	readonly nodeKey: string;
	readonly text: string;
	readonly act: string;
	readonly icon?: string;
	readonly label?: string;
	readonly keys?: readonly string[];
	readonly tone?: "error";
}): JSXNode {
	return (
		<button
			key={props.nodeKey}
			text={props.text}
			size="sm"
			actions={{ click: props.act }}
			icon={props.icon}
			aria={props.label}
			title={props.label}
			keys={props.keys}
			tone={props.tone}
		/>
	);
}

/** The closer look's actions: Open, Stop/Cancel while live or Dismiss once settled, then close. */
function peekButtons(item: TrayItem): JSXNode[] {
	const close = <Button nodeKey="close" text="" act="tray.peek=" icon="x" label="Close" />;
	if (item.item === "done") return [close];
	const buttons: JSXNode[] = [];
	if (item.item === "job" || item.openable)
		buttons.push(<Button nodeKey="open" text="Open" act={`tray.open=${item.ref}`} keys={kbdKeys("enter")} />);
	if (isLive(item.status)) {
		buttons.push(
			<Button
				nodeKey="stop"
				text={item.item === "agent" ? "Stop" : "Cancel"}
				act={`tray.stop=${item.ref}`}
				tone="error"
			/>,
		);
	} else {
		buttons.push(<Button nodeKey="dismiss" text="Dismiss" act={`tray.dismiss=${item.ref}`} />);
	}
	buttons.push(close);
	return buttons;
}

function peekMeta(item: TrayItem): string {
	if (item.item === "agent") {
		const tools = item.tools === undefined ? "" : `${item.tools} ${item.tools === 1 ? "tool" : "tools"}`;
		return [item.type, item.model, tools, item.stats].filter(Boolean).join(" · ");
	}
	return item.item === "job" ? item.command : "";
}

function DoneEntry(props: { readonly entry: TrayDoneEntry }): JSXNode {
	const entry = props.entry;
	const aria = [entry.name, entry.status, entry.meta, entry.line].filter(Boolean).join(", ");
	return (
		<row
			key={trayKey(entry.id)}
			role="omp.tray.done.item"
			propRef={entry.id}
			status={entry.status}
			gap="xs"
			align="center"
			aria={aria}
			actions={entry.openable ? { click: `tray.open=${entry.id}` } : undefined}
		>
			<Dot status={entry.status} />
			<text key="name" role="omp.tray.name" text={entry.name} wrap="none" truncate="end" shrink={1} />
			{entry.meta !== "" && (
				<text key="meta" role="omp.tray.meta" spans={[{ t: entry.meta, s: "dim" }]} wrap="none" />
			)}
			{entry.line !== "" && (
				<text key="line" role="omp.tray.line" text={entry.line} wrap="none" truncate="end" grow={1} shrink={1} />
			)}
		</row>
	);
}

function Peek(props: {
	readonly item: TrayItem;
	readonly detail: TrayAgentDetail | undefined;
	readonly now: number;
}): JSXNode {
	const { item, detail } = props;
	const meta = peekMeta(item);
	let body: JSXNode;
	if (item.item === "agent") {
		body = [
			detail?.task && <text key="task" role="omp.tray.peek.task" text={detail.task} wrap="none" truncate="end" />,
			detail && detail.tail.length > 0 && (
				<col key="tail" role="omp.tray.tail">
					{detail.tail.map((event, index) => (
						<row key={String(index)} role="omp.tray.ev" state={event.state} gap="xs" align="center">
							<text key="tool" role="omp.tray.ev.tool" text={event.tool} wrap="none" />
							<text key="text" role="omp.tray.ev.text" text={event.text} wrap="none" truncate="end" grow={1} />
							{event.age !== undefined && (
								<elapsed key="time" role="omp.tray.time" age={Math.round(event.age)} format="short" />
							)}
						</row>
					))}
				</col>
			),
		];
	} else if (item.item === "job") {
		body = [
			item.view && <JobWidget view={item.view} nodeKey="widget" />,
			item.output && <JobOut item={item} lines={item.view ? PEEK_OUT_LINES : PEEK_OUT_LINES_BARE} />,
		];
	} else {
		const earlier = item.count - item.entries.length;
		body = (
			<col key="done" role="omp.tray.done">
				{item.entries.map(entry => (
					<DoneEntry entry={entry} />
				))}
				{earlier > 0 && <text key="more" role="omp.tray.done.more" text={`+${earlier} earlier`} wrap="none" />}
			</col>
		);
	}
	return (
		<col key="peek" role="omp.tray.peek" propRef={item.ref}>
			<row key="head" role="omp.tray.peek.head" gap="xs" align="center">
				<Dot status={item.status} />
				<text key="name" role="omp.tray.name" text={item.name} wrap="none" truncate="end" shrink={1} />
				{meta !== "" && (
					<text key="meta" role="omp.tray.peek.meta" text={meta} wrap="none" truncate="end" grow={1} shrink={1} />
				)}
				{item.item !== "done" && <Clock start={item.start} duration={item.duration} now={props.now} />}
				{peekButtons(item)}
			</row>
			{body}
		</col>
	);
}

/** See the module docs. */
export function Tray(props: { readonly model: TrayModel; readonly now?: () => number }): JSXNode {
	const model = props.model;
	const clock = props.now ?? Date.now;
	const onAction = (act: string, value: string | undefined): void => {
		// Tern sends `act` and `value`; a terminal synthesizing the event sends `act=value`.
		const split = value === undefined ? act.indexOf("=") : -1;
		const name = split < 0 ? act : act.slice(0, split);
		const ref = split < 0 ? (value ?? "") : act.slice(split + 1);
		// The app's feed handles a peek when bound (it fills the look's detail); else the model alone.
		if (name === "tray.peek" && !model.onAction) model.peekAt(ref || undefined);
		else model.onAction?.(name, ref);
	};
	const peeked = (): TrayItem | undefined => {
		const ref = model.peek();
		return ref === undefined ? undefined : model.items().find(item => item.ref === ref);
	};
	const cards = (
		<For each={model.items}>
			{item => {
				const now = untrack(clock);
				return item.item === "agent" ? (
					<AgentCard item={item} now={now} />
				) : item.item === "job" ? (
					<JobCard item={item} now={now} />
				) : (
					<DoneCard item={item} />
				);
			}}
		</For>
	);
	return (
		<col
			role="omp.tray"
			hidden={() => (model.items().length === 0 && peeked() === undefined) || undefined}
			quiet={() => (model.items().length > 0 && model.quiet()) || undefined}
			main={() => (model.items().length > 0 ? model.main() : undefined)}
			focus={() => (model.focus() > 0 ? model.focus() : undefined)}
			peek={() => peeked()?.ref}
			onAction={(act, event) => onAction(act, event.value)}
		>
			{cards}
			{() => {
				const item = peeked();
				return item && <Peek item={item} detail={model.peekDetail()} now={untrack(clock)} />;
			}}
		</col>
	);
}
