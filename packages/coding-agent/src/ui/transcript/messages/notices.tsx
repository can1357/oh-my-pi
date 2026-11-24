/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Transcript notices: one-line status rows, status blocks, toasts and the
 * boxed notices (rules injected, todo reminders).
 *
 * - `Notice` / `NoticeLine`: a toned row (icon + message, an optional body
 *   under it). A text terminal writes `Warning: …` / `Error: …` in the tone's
 *   color, or draws the notice's own terminal rows.
 * - `StatusBlock`: rows of colored parts in the terminal; natively each row
 *   is a notice row and body rows join the row before them.
 * - `StatusNotice`: a status toast natively, a styled line in the terminal.
 * - `MessageNotice`: a severity-toned card (or an inline section) natively,
 *   an inverse box in the terminal; `TtsrNotice` and `TodoReminder` build on it.
 *
 * Terminal looks: `src/ui/styles/messages/notice.ts`.
 */
import { type JSXNode, nativeRendering, type Reactive, read } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspChecklistItem, TspPreview, TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import type { BackgroundTanDispatchDetails } from "../../../session/transcript/messages";
import type { NotificationRule } from "../../../session/transcript/ttsr-notification";
import { EXPAND_KEY } from "../../styles/messages/fill";
import { cardExpansion } from "../expansion";
import { ansiSpans } from "./spans";

export type NoticeTone = "info" | "success" | "warning" | "error";

/** The word a warning or error leads with in a text terminal (natively the icon's name for screen readers). */
const TONE_LABEL: Partial<Record<NoticeTone, string>> = {
	warning: "Warning",
	error: "Error",
};

/** A toned notice row. */
export interface NoticeProps {
	readonly tone: NoticeTone;
	/** Plain text or spans. */
	readonly message: Reactive<TspText>;
	/** Icon name (the tone's icon by default). */
	readonly icon?: string;
	readonly nodeKey?: string;
	/** Native rows under the message. */
	readonly body?: JSXNode;
	/** What a text terminal draws instead (painted in place of the row). */
	readonly terminal?: JSXNode;
	/** Terminal-only look facts (a line notice's styled text). */
	readonly term?: Readonly<Record<string, unknown>>;
	readonly hidden?: Reactive<boolean | undefined>;
}

function messageProps(message: TspText): {
	text?: string;
	spans?: readonly TspSpan[];
} {
	return typeof message === "string" ? { text: message } : { spans: message };
}

/** A notice row: the tone's icon, then the message (and its body). */
export function Notice(props: NoticeProps): JSXNode {
	const { tone } = props;
	const message = (): TspText => read(props.message);
	const body = Array.isArray(props.body) && props.body.length === 0 ? undefined : props.body;
	const terminal = props.terminal;
	return (
		<row
			key={props.nodeKey}
			role={`omp.notice.${tone}`}
			tone={tone}
			gap="sm"
			align="start"
			hidden={props.hidden}
			term={{
				...props.term,
				...(terminal !== undefined ? { alt: terminal } : {}),
			}}
		>
			<icon name={props.icon ?? tone} tone={tone === "info" ? undefined : tone} aria={TONE_LABEL[tone]} />
			{body !== undefined ? (
				<col grow={1} shrink={1}>
					<text
						text={() => messageProps(message()).text}
						spans={() => messageProps(message()).spans}
						wrap="word"
					/>
					{body}
				</col>
			) : (
				<text
					grow={1}
					shrink={1}
					text={() => messageProps(message()).text}
					spans={() => messageProps(message()).spans}
					wrap="word"
				/>
			)}
		</row>
	);
}

/** A warning or error line: `Warning: …` in the tone's color (the message may carry SGR attributes). */
export function NoticeLine(props: { tone: "warning" | "error"; message: string }): JSXNode {
	return (
		<Notice
			tone={props.tone}
			message={ansiSpans(props.message)}
			term={{ line: { label: TONE_LABEL[props.tone], message: props.message } }}
		/>
	);
}

/** One status row: colored parts joined by spaces (absent parts skipped), and its native notice row. */
export interface StatusRow {
	readonly parts: readonly ({ readonly text: string; readonly color?: string } | undefined)[];
	/** Cells before the row (and its wrapped continuations); default 1. */
	readonly indent?: number;
	readonly native: {
		readonly tone: NoticeTone;
		readonly icon?: string;
		readonly message: readonly TspSpan[];
		/** A body row: joins the notice row before it natively. */
		readonly body?: boolean;
	};
}

/** A block of status rows (background job lines, dispatch breadcrumbs). */
export function StatusBlock(props: { rows: readonly StatusRow[] }): JSXNode {
	const groups: { head: StatusRow; body: StatusRow[] }[] = [];
	for (const row of props.rows) {
		const last = groups.at(-1);
		if (row.native.body && last) last.body.push(row);
		else groups.push({ head: row, body: [] });
	}
	return (
		<col role="omp.status-block" term={{ rows: props.rows }}>
			{groups.map(group => (
				<Notice
					tone={group.head.native.tone}
					icon={group.head.native.icon}
					message={group.head.native.message}
					body={
						group.body.length > 0
							? group.body.map(row => <text spans={row.native.message} wrap="word" />)
							: undefined
					}
				/>
			))}
		</col>
	);
}

/** How long a status toast stays (ms). */
const STATUS_TOAST_TTL = 2400;

/** A transient status line: a toast natively (unless `toast` is false), a styled line in the transcript. */
export function StatusNotice(props: {
	/** The message (may carry SGR styling). */
	message: string;
	/** Theme color the terminal draws the line in. */
	color?: string;
	/** An action the toast offers (Undo). */
	action?: { act: string; label: string };
	/** Show it as a toast natively (default true). */
	toast?: boolean;
	onAction?: (act: string) => void;
}): JSXNode {
	const term = { message: props.message, color: props.color };
	const text = stripEscapes(props.message);
	// Kept out of native toasts, the line still shows in the terminal transcript.
	if (props.toast === false) return <col role="omp.toast.status" hidden={nativeRendering} term={term} />;
	return props.action ? (
		<toast
			role="omp.toast.status"
			text={text}
			action={props.action.act}
			label={props.action.label}
			term={term}
			onAction={act => props.onAction?.(act)}
		/>
	) : (
		<toast role="omp.toast.status" text={text} ttl={STATUS_TOAST_TTL} term={term} />
	);
}

/** The idle recap: where the session stands, written while the user was away. */
export function Recap(props: { recap: string }): JSXNode {
	return (
		<row gap="sm" align="start" role="omp.recap" title="Recap while you were away" term={{ recap: props.recap }}>
			<icon key="icon" name="history" />
			<text text={props.recap} wrap="word" />
		</row>
	);
}

/** Tool calls stripped from the resolved branch (tool activity: hidden with it). */
export function StrippedToolCalls(props: { count: number; visible: Reactive<boolean> }): JSXNode {
	const label = `${props.count} tool call${props.count === 1 ? "" : "s"} elided — no result on this branch`;
	return (
		<text
			role="omp.tool.elided"
			spans={[{ t: label, s: "dim em" }]}
			wrap="word"
			hidden={() => (read(props.visible) ? undefined : true)}
		/>
	);
}

/** Characters of a dispatched job's work shown in its breadcrumb. */
const TAN_WORK_PREVIEW = 56;

function previewWork(work: string): string {
	const line = work.replaceAll("\t", "   ").trim().replace(/\s+/g, " ");
	return line.length <= TAN_WORK_PREVIEW ? line : `${line.slice(0, TAN_WORK_PREVIEW - 1)}…`;
}

/** A `/tan` background dispatch breadcrumb: one compact line (the full notice is for the model). */
export function TangentDispatch(props: { details?: Partial<BackgroundTanDispatchDetails> }): JSXNode {
	const jobId = props.details?.jobId ?? "unknown";
	const work = props.details?.work ? previewWork(props.details.work) : undefined;
	const message: TspSpan[] = [{ t: "Tangent dispatched" }, { t: " · ", s: "dim" }, { t: `task ${jobId}`, s: "dim" }];
	if (work) message.push({ t: " · ", s: "dim" }, { t: work, s: "dim" });
	return (
		<StatusBlock
			rows={[
				{
					parts: [
						{
							text: `${currentTheme().symbols.icon("output")} Tangent dispatched`,
							color: "muted",
						},
						{ text: "[task]", color: "dim" },
						{ text: jobId, color: "accent" },
						work ? { text: `— ${work}`, color: "dim" } : undefined,
					],
					native: { tone: "info", icon: "output", message },
				},
			]}
		/>
	);
}

/** What a boxed notice draws in a text terminal. */
export interface NoticeBox {
	/** Header (may carry SGR attributes; colors conflict with the inverse fill). */
	readonly header: string;
	/** Symbol key of the glyph before the header (`status.warning`). */
	readonly icon?: string;
	/** Body texts under a blank row. */
	readonly body?: readonly string[];
}

/** Native presentation of a boxed notice. */
export interface NoticeNative {
	readonly head: TspText;
	readonly body?: JSXNode;
	/** Body clamp while collapsed; makes the card collapsible. */
	readonly preview?: TspPreview;
	/** An inline notice (an icon and one line, the body a disclosure under it) instead of a toned card. */
	readonly inline?: { readonly icon: string };
}

/** A boxed transcript notice (tool activity: hidden with it). */
export interface MessageNoticeProps {
	/** `omp.notice.<name>`. */
	readonly role: string;
	/** Theme color of the box (default `warning`). */
	readonly severity?: string;
	/** Background key filling the box instead of the inverse severity color. */
	readonly background?: string;
	/** A blank row above the box (default true). */
	readonly leadingSpace?: boolean;
	readonly expanded: Reactive<boolean>;
	/** Tool activity shown (default true). */
	readonly visible?: Reactive<boolean>;
	readonly onToggle?: (expanded: boolean) => void;
	/** The terminal box for the expansion state. */
	readonly box: (expanded: boolean) => NoticeBox;
	readonly native: Reactive<NoticeNative>;
}

const SEVERITY_TONE: Readonly<Record<string, TspTone>> = {
	error: "error",
	warning: "warning",
	success: "success",
	accent: "accent",
	dim: "muted",
	muted: "muted",
};

/** The box facts the terminal look reads. */
function boxTerm(props: MessageNoticeProps, expanded: () => boolean): () => Record<string, unknown> {
	return () => ({
		box: props.box(expanded()),
		severity: props.severity ?? "warning",
		background: props.background,
		leadingSpace: props.leadingSpace !== false,
	});
}

/** A boxed notice. */
export function MessageNotice(props: MessageNoticeProps): JSXNode {
	const native = (): NoticeNative => read(props.native);
	const hidden = (): true | undefined => (props.visible === undefined || read(props.visible) ? undefined : true);
	const tone = SEVERITY_TONE[props.severity ?? "warning"] ?? "warning";
	const { expanded, toggle } = cardExpansion(props.expanded, props.onToggle);
	const term = boxTerm(props, expanded);
	const view = untrackedNative(props);
	if (view.inline) {
		const icon = view.inline.icon;
		const hasBody = (): boolean => {
			const body = native().body;
			return Array.isArray(body) ? body.length > 0 : body !== undefined && body !== null && body !== false;
		};
		return (
			<section
				role={props.role}
				tone={tone}
				collapsible={hasBody}
				collapsed={() => (hasBody() ? !expanded() : undefined)}
				hidden={hidden}
				term={term}
				onToggle={toggle}
			>
				<row key="head" gap="sm">
					<icon name={icon} />
					<text spans={() => headSpans(native().head)} truncate="end" />
				</row>
				{() => native().body}
			</section>
		);
	}
	const collapsible = view.preview !== undefined;
	return (
		<card
			role={props.role}
			tone={tone}
			head={() => native().head}
			collapsible={collapsible}
			collapsed={() => (collapsible ? !expanded() : undefined)}
			preview={() => native().preview}
			hidden={hidden}
			term={term}
			onToggle={toggle}
		>
			{() => native().body}
		</card>
	);
}

function untrackedNative(props: MessageNoticeProps): NoticeNative {
	const native = props.native;
	return typeof native === "function" ? native() : native;
}

function headSpans(head: TspText): readonly TspSpan[] {
	return typeof head === "string" ? [{ t: head }] : head;
}

/** Rules a collapsed multi-rule notice lists before eliding the rest. */
const MAX_COLLAPSED_RULES = 4;

function ruleDescription(rule: NotificationRule): string | undefined {
	return (rule.description || rule.content)?.trim() || undefined;
}

/** The terminal box of a TTSR notice. */
function ttsrBox(rules: readonly NotificationRule[], expanded: boolean): NoticeBox {
	const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
	const italic = (text: string) => `\x1b[3m${text}\x1b[23m`;
	const rewind = currentTheme().symbols.icon("rewind");
	if (rules.length === 1) {
		const rule = rules[0]!;
		const header = `Injecting rule: ${bold(rule.name)}  ${rewind}`;
		const desc = ruleDescription(rule);
		if (!desc) return { icon: "status.warning", header };
		const lines = desc.split("\n");
		if (expanded || lines.length <= 2) return { icon: "status.warning", header, body: [italic(desc)] };
		return {
			icon: "status.warning",
			header,
			body: [italic(`${lines.slice(0, 2).join("\n")}…`), italic(` (${EXPAND_KEY} to expand)`)],
		};
	}
	const visible = expanded ? rules : rules.slice(0, MAX_COLLAPSED_RULES);
	const body: string[] = [];
	let elided = false;
	for (const rule of visible) {
		const desc = ruleDescription(rule);
		let line = bold(rule.name);
		if (desc) {
			const newline = expanded ? -1 : desc.indexOf("\n");
			if (newline !== -1) elided = true;
			line += `: ${italic(newline === -1 ? desc : `${desc.slice(0, newline).trimEnd()}…`)}`;
		}
		body.push(line);
	}
	const hidden = rules.length - visible.length;
	if (hidden > 0) body.push(italic(`… +${hidden} more (${EXPAND_KEY} to expand)`));
	else if (elided) body.push(italic(` (${EXPAND_KEY} to expand)`));
	return {
		icon: "status.warning",
		header: `Injecting ${rules.length} rules:  ${rewind}`,
		body,
	};
}

/** Rules a stream rewind injected (Time Traveling Stream Rules); later matches merge in. */
export function TtsrNotice(props: {
	rules: Reactive<readonly NotificationRule[]>;
	expanded: Reactive<boolean>;
	visible?: Reactive<boolean>;
	onToggle?: (expanded: boolean) => void;
}): JSXNode {
	const rules = (): readonly NotificationRule[] => read(props.rules);
	return (
		<col>
			<MessageNotice
				role="omp.notice.ttsr"
				expanded={props.expanded}
				visible={props.visible}
				onToggle={props.onToggle}
				box={expanded => ttsrBox(rules(), expanded)}
				native={() => {
					const list = rules();
					const single = list.length === 1 ? list[0] : undefined;
					const head: TspSpan[] = single
						? [
								{ t: "Rule applied: ", s: "warning" },
								{ t: single.name, s: "mono strong" },
							]
						: [
								{ t: `${list.length} rules applied: `, s: "warning" },
								{
									t: list.map(rule => rule.name).join(", "),
									s: "mono strong",
								},
							];
					const body = list.flatMap(rule => {
						const desc = ruleDescription(rule);
						if (single)
							return desc ? [<text propKey={rule.name} spans={[{ t: desc, s: "em" }]} wrap="word" />] : [];
						const spans: TspSpan[] = desc
							? [{ t: rule.name, s: "strong" }, { t: ": " }, { t: desc, s: "em" }]
							: [{ t: rule.name, s: "strong" }];
						return [<text propKey={rule.name} spans={spans} wrap="word" />];
					});
					return { head, body, inline: { icon: "shield-alert" } };
				}}
			/>
		</col>
	);
}

/** An open todo of a reminder. */
export interface ReminderTodo {
	readonly content: string;
	readonly status: string;
}

const CHECKLIST_STATUS: Readonly<Record<string, TspChecklistItem["status"]>> = {
	pending: "pending",
	in_progress: "active",
	completed: "done",
	abandoned: "dropped",
};

/** The agent stopped with open todos: a reminder checklist natively, a warning box in the terminal. */
export function TodoReminder(props: {
	todos: readonly ReminderTodo[];
	attempt: number;
	maxAttempts: number;
	visible?: Reactive<boolean>;
}): JSXNode {
	const count = props.todos.length;
	const note = `reminder ${props.attempt}/${props.maxAttempts}`;
	const header = `${count} incomplete ${count === 1 ? "todo" : "todos"} - ${note}`;
	const unchecked = currentTheme().symbols.symbol("checkbox.unchecked") || "☐";
	const list = props.todos.map(todo => `  ${unchecked} ${todo.content}`).join("\n");
	return (
		<checklist
			mode="reminder"
			phases={[
				{
					id: "p0",
					title: "",
					collapsed: false,
					items: props.todos.map((todo, index) => ({
						id: `p0.${index}`,
						text: todo.content,
						status: CHECKLIST_STATUS[todo.status] ?? "pending",
					})),
				},
			]}
			note={note}
			role="omp.notice.todo"
			hidden={() => (props.visible === undefined || read(props.visible) ? undefined : true)}
			term={{
				box: {
					icon: "status.warning",
					header,
					body: [`\x1b[3m${list}\x1b[23m`],
				},
				severity: "warning",
				leadingSpace: true,
			}}
		/>
	);
}
