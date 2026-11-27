/**
 * `async-notify` notices: the output lines a running background job or
 * supervised service was asked to report (`notify` on `bash`), delivered to the
 * session that started it through the same yield queue as its result.
 *
 * A job's tool opens a channel with `ToolSession.openAsyncNotify` and sends
 * each {@link NotifyBatch} through it; a service's matches arrive from the
 * launch broker and are queued with `ToolSession.queueServiceNotify`. Either
 * way the session holds one {@link AsyncNotifyEntry} per batch, and
 * {@link buildAsyncNotifyBatchMessage} folds whatever queued between two
 * injections into one message.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import { ASYNC_NOTIFY_MESSAGE_TYPE, type AsyncNotifyDetails, type AsyncNotifyReport } from "./transcript/messages";
import { NOTIFY_MAX_LINES, type NotifyBatch } from "../async/notify";
import asyncNotifyTemplate from "../prompts/tools/async-notify.md" with { type: "text" };
import { commandIdentity } from "./async-job-delivery";
import { escapeHarnessTags } from "./harness-tags";
import type { CustomMessage } from "./messages";

/** What a notice reports on: a background job, or a supervised service. */
export interface AsyncNotifySource {
	/** The job's id or the service's name, as `proc://` takes it. */
	id: string;
	type: AsyncNotifyReport["type"];
	/** A job's command line; a service is named by its `id`. */
	command?: string;
	/** Source of its `notify` regex. */
	pattern: string;
	/** Whether it still runs, asked when a notice is built. */
	running(): boolean;
}

/** One batch of a source's matching lines awaiting injection into the session that owns it. */
export interface AsyncNotifyEntry extends AsyncNotifySource, NotifyBatch {
	/**
	 * Session id owning a service: the entry is dropped once another session
	 * holds the transcript. Absent for a job, whose channel ends with the
	 * transcript it started in.
	 */
	owner?: string;
}

/**
 * Build the one notice for every batch queued since the last injection. A
 * source's batches merge into one block holding its first
 * {@link NOTIFY_MAX_LINES} lines.
 */
export function buildAsyncNotifyBatchMessage(entries: AsyncNotifyEntry[]): CustomMessage<AsyncNotifyDetails> | null {
	if (entries.length === 0) return null;
	const merged = new Map<string, { command: string | undefined; report: AsyncNotifyReport }>();
	for (const entry of entries) {
		// A job id and a service name live in separate namespaces.
		const key = `${entry.type}:${entry.id}`;
		const known = merged.get(key);
		if (!known) {
			merged.set(key, {
				command: entry.command,
				report: {
					id: entry.id,
					type: entry.type,
					pattern: entry.pattern,
					lines: [...entry.lines],
					omitted: entry.omitted,
					running: entry.running(),
					stopped: entry.stopped,
				},
			});
			continue;
		}
		known.report.lines.push(...entry.lines);
		known.report.omitted += entry.omitted;
		known.report.stopped ||= entry.stopped;
	}
	const blocks = [...merged.values()];
	for (const { report } of blocks) {
		const overflow = report.lines.length - NOTIFY_MAX_LINES;
		if (overflow <= 0) continue;
		report.lines.length = NOTIFY_MAX_LINES;
		report.omitted += overflow;
	}
	// The command, its regex and its output are text the source controls: none of
	// it may close the `<system-notice>` it renders into or open a forged harness block.
	const text = prompt.render(asyncNotifyTemplate, {
		reports: blocks.map(({ command, report }) => ({
			...report,
			service: report.type === "service",
			command: command === undefined ? undefined : escapeHarnessTags(commandIdentity(command)),
			pattern: escapeHarnessTags(report.pattern),
			lines: report.lines.map(line => escapeHarnessTags(line)),
		})),
	});
	return {
		role: "custom",
		customType: ASYNC_NOTIFY_MESSAGE_TYPE,
		content: text,
		display: true,
		attribution: "agent",
		details: { reports: blocks.map(({ report }) => report) },
		timestamp: Date.now(),
	};
}
