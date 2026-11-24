/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Background activity the session reports into the transcript, each a status
 * block hidden with tool activity, plus the IRC coordination cards:
 *
 * - `AsyncResult` (`async-result`): one `✔ Background job completed [type] id
 *   (duration)` row per finished job, its artifact-error and minimizer rows
 *   beneath. A registered extension renderer owns the card (#14131); the
 *   built-in rows stand in while it declines or when it throws.
 * - `LaunchCompletion` (`launch-completion`): one `Supervised process
 *   completed|failed name (exit N) (duration)` row per exited service.
 * - `AsyncNotify` (`async-notify`): one `Background job output` /
 *   `Supervised process output` row per reporting source with its first
 *   matching lines under it (natively the notice's body).
 * - `IrcMessageBlock` (`irc:*` custom messages) and `ParentIrcMessage` (a
 *   consumed parent steer): IRC cards; only the former hides with tool activity.
 *
 * Terminal looks: `omp.status-block` (`src/ui/styles/messages/notice.ts`),
 * `omp.activity` (`panel.ts`), the `omp.custom` frame (`frame.ts`) and the
 * `omp.irc.*` cards (`src/ui/styles/tools/irc.ts`).
 */
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncate } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatCount, formatDuration } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { PersistedSnapshot } from "../../../daemon/daemon-types";
import type { AsyncNotifyDetails } from "../../../session/transcript/messages";
import { formatArtifactErrorNotice, type OutputMeta } from "../../../tools/output-meta-format";
import { PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "../../../utils/render-utils";
import { type IrcMessage, IrcMessageCard } from "../../tools/irc";
import { formatMinimized } from "../../tools/run";
import { type FramedMessage, type FrameRenderer, MessageFrame } from "./frame";
import { StatusBlock, type StatusRow } from "./notices";
import { ToolActivity } from "./panel";

/** A native row's trailing facts: each after a dim ` · `, absent ones skipped. */
export function statusFacts(values: readonly (string | undefined)[]): TspSpan[] {
	return values.flatMap(value =>
		value
			? [
					{ t: " · ", s: "dim" },
					{ t: value, s: "dim" },
				]
			: [],
	);
}

/** Status rows hidden with tool activity. */
function ActivityRows(props: { rows: readonly StatusRow[]; visible: Reactive<boolean> }): JSXNode {
	return (
		<ToolActivity visible={props.visible}>
			<StatusBlock rows={props.rows} />
		</ToolActivity>
	);
}

// ─── async-result ─────────────────────────────────────────────────────────────

/** One finished job of an `async-result` message. */
export interface AsyncResultJob {
	readonly jobId?: string;
	readonly type?: string;
	readonly label?: string;
	readonly durationMs?: number;
	readonly meta?: Pick<OutputMeta, "artifactError" | "minimized">;
}

/** `details` of an `async-result` message: a batch (`jobs`) or, as older sessions wrote it, one job inline. */
export interface AsyncResultDetails extends Omit<AsyncResultJob, "meta"> {
	readonly jobs?: readonly AsyncResultJob[];
	/** The delivery's own capture failure. */
	readonly meta?: Pick<OutputMeta, "artifactError">;
}

/** Rows of an `async-result` message; `indent` pads them (default 1). */
export function asyncResultRows(details: AsyncResultDetails | undefined, indent?: number): StatusRow[] {
	const jobs: readonly AsyncResultJob[] = details?.jobs?.length
		? details.jobs
		: [
				{
					jobId: details?.jobId,
					type: details?.type,
					label: details?.label,
					durationMs: details?.durationMs,
				},
			];
	const success = currentTheme().symbols.symbol("status.success");
	const rows: StatusRow[] = [];
	const note = (text: string, tone: "warning" | "info"): StatusRow => ({
		parts: [{ text, color: tone === "warning" ? "warning" : "dim" }],
		indent,
		native: {
			tone,
			message: [tone === "warning" ? { t: text } : { t: text, s: "dim" }],
		},
	});
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
		const type = job.type ?? "job";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		rows.push({
			parts: [
				{ text: `${success} Background job completed`, color: "success" },
				{ text: `[${type}]`, color: "dim" },
				{ text: jobId, color: "accent" },
				duration ? { text: `(${duration})`, color: "dim" } : undefined,
			],
			indent,
			native: {
				tone: "success",
				message: [{ t: "Background job completed" }, ...statusFacts([type, jobId, duration])],
			},
		});
		if (job.meta?.artifactError) rows.push(note(formatArtifactErrorNotice(job.meta.artifactError), "warning"));
		if (job.meta?.minimized) rows.push(note(`Minimized: ${formatMinimized(job.meta.minimized)}`, "info"));
	}
	if (details?.meta?.artifactError) rows.push(note(formatArtifactErrorNotice(details.meta.artifactError), "warning"));
	return rows;
}

/** An `async-result` message (its `details`: {@link AsyncResultDetails}). */
export interface AsyncResultProps {
	readonly message: FramedMessage & { readonly details?: unknown };
	/** The transcript-wide expansion; the renderer is asked again when it changes. */
	readonly expanded: Reactive<boolean>;
	/** Tool activity shown; hides the built-in rows (not a renderer's output). */
	readonly visible: Reactive<boolean>;
	/** The extension renderer registered for `async-result`: it owns the card. */
	readonly renderer?: FrameRenderer;
	readonly onToggle?: (expanded: boolean) => void;
}

/**
 * Finished background jobs. Without a renderer: the rows. With one: an
 * `omp.custom` frame around its output, or around the rows while it returns
 * nothing or throws (the frame sets them one cell in, so they drop their own pad).
 */
export function AsyncResult(props: AsyncResultProps): JSXNode {
	const details = props.message.details as AsyncResultDetails | undefined;
	const custom = props.renderer;
	if (!custom) return <ActivityRows rows={asyncResultRows(details)} visible={props.visible} />;
	const rows = asyncResultRows(details, 0);
	const fallback = (): JSXNode => <ActivityRows rows={rows} visible={props.visible} />;
	const renderer: FrameRenderer = expanded => {
		try {
			return custom(expanded) ?? fallback();
		} catch {
			return fallback();
		}
	};
	return (
		<MessageFrame
			message={props.message}
			role="omp.custom"
			renderer={renderer}
			expanded={props.expanded}
			onToggle={props.onToggle}
		/>
	);
}

// ─── launch-completion ────────────────────────────────────────────────────────

/** `details` of a `launch-completion` message. */
export interface LaunchCompletionDetails {
	readonly daemons?: readonly PersistedSnapshot[];
}

/** Rows of a `launch-completion` message: one per exited service, else the message text. */
export function launchCompletionRows(details: LaunchCompletionDetails | undefined, content: unknown): StatusRow[] {
	const symbols = currentTheme().symbols;
	const rows: StatusRow[] = [];
	const daemons = details?.daemons ?? [];
	if (daemons.length === 0 && typeof content === "string") {
		rows.push({
			parts: [
				{
					text: `${symbols.symbol("status.success")} ${content}`,
					color: "dim",
				},
			],
			native: { tone: "success", message: [{ t: content }] },
		});
	}
	for (const daemon of daemons) {
		const name = "key" in daemon ? daemon.key : daemon.name;
		const { exitCode, startedAt, exitedAt } = daemon;
		const failed = daemon.state === "failed" || (exitCode !== undefined && exitCode !== 0);
		const label = failed ? "Supervised process failed" : "Supervised process completed";
		const exit = exitCode !== undefined ? `exit ${exitCode}` : undefined;
		const duration =
			exitedAt !== undefined && startedAt !== undefined ? formatDuration(exitedAt - startedAt) : undefined;
		rows.push({
			parts: [
				failed
					? {
							text: `${symbols.symbol("status.error")} ${label}`,
							color: "error",
						}
					: {
							text: `${symbols.symbol("status.success")} ${label}`,
							color: "success",
						},
				{ text: name, color: "accent" },
				exit ? { text: `(${exit})`, color: "dim" } : undefined,
				duration ? { text: `(${duration})`, color: "dim" } : undefined,
			],
			native: {
				tone: failed ? "error" : "success",
				message: [{ t: label }, { t: " " }, { t: name, s: "mono" }, ...statusFacts([exit, duration])],
			},
		});
	}
	return rows;
}

/** Supervised processes that exited (a `launch-completion` message). */
export function LaunchCompletion(props: {
	details?: LaunchCompletionDetails;
	/** The message's content: the row when no service is listed. */
	content: unknown;
	visible: Reactive<boolean>;
}): JSXNode {
	return <ActivityRows rows={launchCompletionRows(props.details, props.content)} visible={props.visible} />;
}

// ─── async-notify ─────────────────────────────────────────────────────────────

/** Rows of an `async-notify` message: a head per source, its first lines beneath (natively the head's body). */
export function asyncNotifyRows(details: AsyncNotifyDetails | undefined): StatusRow[] {
	const info = currentTheme().symbols.symbol("status.info");
	const rows: StatusRow[] = [];
	const detail = (text: string, tone: "info" | "warning"): StatusRow => ({
		parts: [{ text, color: tone === "warning" ? "warning" : "dim" }],
		indent: 3,
		native: {
			tone,
			message: [tone === "info" ? { t: text, s: "mono" } : { t: text }],
		},
	});
	for (const report of details?.reports ?? []) {
		const label = report.type === "service" ? "Supervised process output" : "Background job output";
		const total = report.lines.length + report.omitted;
		const tally = formatCount("line", total);
		rows.push({
			parts: [
				{ text: `${info} ${label}`, color: "accent" },
				{ text: report.id, color: "accent" },
				{ text: `(${tally})`, color: "dim" },
			],
			native: {
				tone: "info",
				message: [{ t: label }, ...statusFacts([report.id, tally])],
			},
		});
		const shown = report.lines.slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED);
		for (const line of shown) {
			const output = replaceTabs(line);
			rows.push({
				// Process output: the terminal cuts an overlong line; natively the notice wraps it in full.
				parts: [{ text: truncate(output, TRUNCATE_LENGTHS.LINE), color: "dim" }],
				indent: 3,
				native: {
					tone: "info",
					body: true,
					message: [{ t: output, s: "mono" }],
				},
			});
		}
		if (total > shown.length) rows.push(detail(`… ${total - shown.length} more`, "info"));
		if (report.stopped) rows.push(detail("Matched too often: notify is off for it", "warning"));
	}
	return rows;
}

/** Output running background jobs or services were asked to report (an `async-notify` message). */
export function AsyncNotify(props: { details?: AsyncNotifyDetails; visible: Reactive<boolean> }): JSXNode {
	return <ActivityRows rows={asyncNotifyRows(props.details)} visible={props.visible} />;
}

// ─── IRC ──────────────────────────────────────────────────────────────────────

const IRC_KINDS: Readonly<Record<string, IrcMessage["kind"]>> = {
	"irc:incoming": "incoming",
	"irc:autoreply": "autoreply",
	"irc:relay": "relay",
	"irc:workpool": "workpool",
};

/** `details` of an `irc:*` custom message. */
export interface IrcMessageDetails {
	readonly from?: string;
	readonly to?: string;
	/** The body of an `irc:incoming` message. */
	readonly message?: string;
	/** The body of the other kinds. */
	readonly body?: string;
	readonly replyTo?: string;
	readonly pool?: string;
	readonly mode?: string;
}

/** Whether a custom message type is an IRC card. */
export function isIrcMessageType(customType: string): boolean {
	return customType in IRC_KINDS;
}

/** The card of an `irc:*` custom message; undefined for other types. */
export function ircMessage(
	customType: string,
	details: IrcMessageDetails | undefined,
	timestamp: number,
): IrcMessage | undefined {
	const kind = IRC_KINDS[customType];
	if (!kind) return undefined;
	return {
		kind,
		from: details?.from,
		to: details?.to,
		body: kind === "incoming" ? details?.message : details?.body,
		replyTo: details?.replyTo,
		timestamp,
		pool: details?.pool,
		mode: details?.mode,
	};
}

/** An IRC coordination message (`irc:incoming` / `irc:autoreply` / `irc:relay` / `irc:workpool`), hidden with tool activity. */
export function IrcMessageBlock(props: {
	message: {
		readonly customType: string;
		readonly details?: unknown;
		readonly timestamp: number;
	};
	expanded: Reactive<boolean>;
	visible: Reactive<boolean>;
}): JSXNode {
	const { customType, details, timestamp } = props.message;
	const card = ircMessage(customType, details as IrcMessageDetails | undefined, timestamp) ?? {
		kind: "relay",
		timestamp,
	};
	return (
		<ToolActivity visible={props.visible}>
			<IrcMessageCard message={card} expanded={() => read(props.expanded)} />
		</ToolActivity>
	);
}

/** A parent's steer the session consumed (a user message's `parentIrc`): an incoming IRC card, shown with tool activity off too. */
export function ParentIrcMessage(props: {
	parentIrc: { readonly from: string; readonly body: string };
	timestamp: number;
	expanded: Reactive<boolean>;
}): JSXNode {
	const card: IrcMessage = {
		kind: "incoming",
		from: props.parentIrc.from,
		body: props.parentIrc.body,
		timestamp: props.timestamp,
	};
	return <IrcMessageCard message={card} expanded={() => read(props.expanded)} />;
}
