/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Progress HUDs (`progress` slot), right above the working row: judgment
 * batches, downloads, and a background compaction while a turn holds the
 * status row. Each is one right-aligned row: the dim label, an 18-cell bar
 * when the work has a size, then the tail (`12/40 · $0.031 · 2 failed`,
 * `1.2 MB / 9.8 MB`, `ready`, the compaction's run time).
 *
 * - Natively: per kind an `omp.hud.judge` / `omp.hud.downloads` /
 *   `omp.hud.compaction` column of `omp.hud.progress` rows (`justify: end`):
 *   the label, a `progress` capped at 18ch, the tail.
 * - In a text terminal (`src/ui/styles/dock/progress.ts`) the same row,
 *   right-aligned; a tail that cannot fit falls back to its short form.
 *
 * A download shows once it has run 150 ms (quick fetches never flash) and
 * stays 1.5 s once done, 10 s once failed.
 */
import { type Accessor, For, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatBytes } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { DownloadActivity } from "../../downloads/activity";
import type { JudgmentBatchProgress } from "../../eval/judgment-batch-events";
import { sanitizeDisplaySingleLine } from "../../extensibility/inventory/display-text";
import { formatCost } from "../overlays/pickers/agent-hub-model";
import "../styles/dock";
import type { ProgressTerm } from "../styles/dock/progress";
import { keyLabel } from "../keys/hints";
import type { BackgroundCompactionModel, BackgroundRun } from "./status";

const DOWNLOAD_REVEAL_MS = 150;
const DOWNLOAD_DONE_RETAIN_MS = 1500;
const DOWNLOAD_FAILED_RETAIN_MS = 10_000;

/** One-line status text: control characters dropped, runs of spaces collapsed. */
export function statusText(text: string): string {
	return sanitizeDisplaySingleLine(text).replace(/ +/g, " ").trim();
}

interface DownloadRow {
	readonly activity: DownloadActivity;
	readonly startedAt: number;
	/** Past the reveal delay (or settled). */
	readonly shown: boolean;
}

/** Downloads in flight and recently settled. */
export class DownloadsModel {
	readonly rows = signal<readonly DownloadRow[]>([]);
	readonly #timers = new Map<number, NodeJS.Timeout>();

	/** Record an activity report (the `onDownloadActivity` stream). */
	update(activity: DownloadActivity, now = Date.now()): void {
		const rows = this.rows.peek();
		const existing = rows.find(row => row.activity.id === activity.id);
		const startedAt = existing?.startedAt ?? now;
		const shown = existing?.shown === true || now - startedAt >= DOWNLOAD_REVEAL_MS;
		if (!existing && activity.state === "running")
			this.#arm(activity.id, DOWNLOAD_REVEAL_MS, () => this.#reveal(activity.id));
		if (activity.state !== "running") {
			if (activity.state === "done" && !shown) {
				this.#drop(activity.id);
				return;
			}
			this.#arm(activity.id, activity.state === "failed" ? DOWNLOAD_FAILED_RETAIN_MS : DOWNLOAD_DONE_RETAIN_MS, () =>
				this.#drop(activity.id),
			);
		}
		const row: DownloadRow = {
			activity,
			startedAt,
			shown: shown || activity.state !== "running",
		};
		this.rows.set(existing ? rows.map(entry => (entry === existing ? row : entry)) : [...rows, row]);
	}

	dispose(): void {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
		this.rows.set([]);
	}

	#arm(id: number, delay: number, run: () => void): void {
		clearTimeout(this.#timers.get(id));
		const timer = setTimeout(() => {
			this.#timers.delete(id);
			run();
		}, delay);
		timer.unref?.();
		this.#timers.set(id, timer);
	}

	#reveal(id: number): void {
		this.rows.set(this.rows.peek().map(row => (row.activity.id === id ? { ...row, shown: true } : row)));
	}

	#drop(id: number): void {
		clearTimeout(this.#timers.get(id));
		this.#timers.delete(id);
		this.rows.set(this.rows.peek().filter(row => row.activity.id !== id));
	}
}

/** Judgment batches by id, in arrival order. */
export class JudgmentsModel {
	readonly batches = signal<readonly JudgmentBatchProgress[]>([]);

	update(progress: JudgmentBatchProgress): void {
		const list = this.batches.peek();
		const index = list.findIndex(batch => batch.id === progress.id);
		this.batches.set(index < 0 ? [...list, progress] : list.map((batch, at) => (at === index ? progress : batch)));
	}

	delete(id: string): void {
		this.batches.set(this.batches.peek().filter(batch => batch.id !== id));
	}

	clear(): void {
		this.batches.set([]);
	}
}

/** What the progress slot shows. */
export class ProgressHudModel {
	readonly judgments = new JudgmentsModel();
	readonly downloads = new DownloadsModel();
	readonly background: BackgroundCompactionModel;
	/** A turn holds the status row: a background compaction shows here instead. */
	readonly statusBusy: Accessor<boolean>;

	constructor(background: BackgroundCompactionModel, statusBusy: Accessor<boolean>) {
		this.background = background;
		this.statusBusy = statusBusy;
	}
}

interface HudRowProps {
	readonly nodeKey: string;
	readonly label: string;
	/** The tail as spans, or (`since`) a run time counting from epoch ms. */
	readonly tail: readonly TspSpan[] | { readonly since: number };
	/** Bar fill 0–1, `null` indeterminate, undefined no bar. */
	readonly bar?: number | null;
	readonly term: ProgressTerm;
}

function HudRow(props: HudRowProps): JSXNode {
	const bar = props.bar;
	const tail = props.tail;
	return (
		<row key={props.nodeKey} justify="end" gap="sm" align="center" role="omp.hud.progress" term={props.term}>
			<text spans={[{ t: statusText(props.label), s: "dim" }]} wrap="none" truncate="end" shrink={1} />
			{bar !== undefined && (
				<progress value={bar === null ? null : Math.min(1, Math.max(0, bar))} max={{ w: "18ch" }} />
			)}
			{"since" in tail ? (
				<elapsed age={Math.max(0, Date.now() - tail.since)} format="short" />
			) : (
				<text spans={tail} wrap="none" />
			)}
		</row>
	);
}

function JudgmentRow(props: { readonly batch: JudgmentBatchProgress }): JSXNode {
	const batch = props.batch;
	const count = `${batch.done}/${batch.total}`;
	const cost = batch.cost > 0 ? ` · ${formatCost(batch.cost)}` : "";
	const tail: TspSpan[] = [{ t: count, s: "strong" }];
	if (cost) tail.push({ t: cost, s: "dim" });
	if (batch.failed > 0) tail.push({ t: ` · ${batch.failed} failed`, s: "warning" });
	return (
		<HudRow
			nodeKey={batch.id}
			label={batch.intent}
			tail={tail}
			bar={batch.done / Math.max(1, batch.total)}
			term={{
				label: batch.intent,
				judgment: { count, cost, failed: batch.failed },
				bar: { value: batch.done, max: batch.total },
			}}
		/>
	);
}

function downloadStep(activity: DownloadActivity): string {
	if (activity.loaded) return activity.unit === "steps" ? `${activity.loaded}` : formatBytes(activity.loaded);
	return activity.detail ?? (activity.unit === "steps" ? "working…" : "downloading…");
}

function DownloadRowNode(props: { readonly activity: DownloadActivity }): JSXNode {
	const activity = props.activity;
	const key = `${activity.id}`;
	if (activity.state === "failed") {
		const reason = `failed: ${statusText(activity.error ?? "unknown error")}`;
		return (
			<HudRow
				nodeKey={key}
				label={activity.label}
				tail={[{ t: reason, s: "warning" }]}
				term={{
					label: activity.label,
					tail: { text: reason, color: "warning", cap: 0.6 },
				}}
			/>
		);
	}
	if (activity.state === "done") {
		return (
			<HudRow
				nodeKey={key}
				label={activity.label}
				tail={[{ t: "ready", s: "success" }]}
				term={{
					label: activity.label,
					tail: { text: "ready", color: "success" },
					fallback: { text: `${activity.label} ready`, color: "success" },
				}}
			/>
		);
	}
	const { loaded, total } = activity;
	if (total !== undefined && total > 0) {
		const received = loaded ?? 0;
		const label = activity.detail ? `${activity.label} · ${activity.detail}` : activity.label;
		const amount =
			activity.unit === "steps" ? `${received}/${total}` : `${formatBytes(received)} / ${formatBytes(total)}`;
		return (
			<HudRow
				nodeKey={key}
				label={label}
				tail={[{ t: amount, s: "strong" }]}
				bar={received / total}
				term={{
					label,
					tail: { text: amount, color: "text", strong: true },
					fallback: {
						text: `${Math.floor((received / total) * 100)}%`,
						color: "text",
						strong: true,
					},
					bar: { value: received, max: total },
				}}
			/>
		);
	}
	const step = downloadStep(activity);
	return (
		<HudRow
			nodeKey={key}
			label={activity.label}
			tail={[{ t: step }]}
			term={{
				label: activity.label,
				tail: { text: step, color: "text" },
				fallback: { text: `${activity.label} ${step}`, color: "text" },
			}}
		/>
	);
}

/** See the module docs. */
export function ProgressHud(props: { readonly model: ProgressHudModel }): JSXNode {
	const model = props.model;
	const beside = (): BackgroundRun | undefined => (model.statusBusy() ? model.background.visible() : undefined);
	return (
		<col>
			<col role="omp.hud.judge">
				<For each={model.judgments.batches}>{batch => <JudgmentRow batch={batch} />}</For>
			</col>
			<col role="omp.hud.downloads">
				<For each={() => model.downloads.rows().filter(row => row.shown)}>
					{row => <DownloadRowNode activity={row.activity} />}
				</For>
			</col>
			<col role="omp.hud.compaction">
				{() => {
					const run = beside();
					if (!run) return undefined;
					const label =
						run.interruptKey === undefined
							? run.label
							: `${run.label} (${keyLabel(currentTheme(), run.interruptKey)} to cancel)`;
					return (
						<HudRow
							nodeKey="run"
							label={label}
							tail={{ since: run.startedAt }}
							bar={null}
							term={{ label, run: { startedAt: run.startedAt } }}
						/>
					);
				}}
			</col>
		</col>
	);
}
