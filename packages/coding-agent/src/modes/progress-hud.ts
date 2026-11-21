/**
 * Editor-anchored, right-aligned progress rows above the working line: judge
 * batches (`judge_batch`), automatic background work (downloads and
 * installs, skill optimization) and a background compaction beside a turn.
 * All render through {@link renderHudProgressRow} so they read as one HUD.
 */
import { type Component, type Loader, renderProgressBar, visibleWidth } from "@oh-my-pi/pi-tui";
import { col, elapsed, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { formatCost } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import type { DownloadActivity } from "../downloads/activity";
import type { JudgmentBatchProgress } from "../eval/judgment-batch-events";

const PROGRESS_BAR_WIDTH = 18;
const MIN_PROGRESS_BAR_WIDTH = 4;

/**
 * One right-aligned row: `label ━━━─── tail`. When narrow, drops the label,
 * then the bar, then falls back to `fallback` alone.
 */
function renderHudProgressRow(
	width: number,
	row: { label: string; tail: string; fallback: string; bar?: { value: number; max: number } },
): string {
	let tail = row.tail;
	let remaining = width - visibleWidth(tail);
	if (row.bar && remaining > 1) {
		const barWidth = Math.min(PROGRESS_BAR_WIDTH, remaining - 1);
		const bar = renderProgressBar(row.bar.value, barWidth, {
			min: 0,
			max: Math.max(1, row.bar.max),
			minWidth: barWidth,
			maxWidth: barWidth,
			style: {
				filled: "━",
				empty: "─",
				styleFilled: text => theme.fg("accent", text),
				styleEmpty: text => theme.fg("dim", text),
			},
		});
		tail = `${bar} ${tail}`;
		remaining = width - visibleWidth(tail);
	}
	if (remaining > 1) {
		const label = truncateToWidth(sanitizeStatusText(row.label), remaining - 1, "");
		if (label) tail = `${theme.fg("dim", label)} ${tail}`;
	}
	if (visibleWidth(tail) > width) tail = truncateToWidth(row.fallback, width, "");
	return `${" ".repeat(Math.max(0, width - visibleWidth(tail)))}${tail}`;
}

function rowWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
}

/**
 * Native HUD row, right-docked like the ANSI row: dim label, an optional
 * terminal-drawn bar (`null`: indeterminate), then the tail, spans or a node
 * the terminal clocks. The terminal drops and truncates.
 */
function describeHudRow(
	key: string,
	label: string,
	tail: readonly TspSpan[] | NativeNode,
	bar?: number | null,
): NativeNode {
	const children: NativeNode[] = [
		text([span(sanitizeStatusText(label), "dim")], { wrap: "none", truncate: "end", shrink: 1 }),
	];
	if (bar !== undefined) {
		const value = bar === null ? null : Math.min(1, Math.max(0, bar));
		children.push(node("progress", { value, max: { w: "18ch" } }));
	}
	children.push("k" in tail ? tail : text(tail, { wrap: "none" }));
	return node("row", { justify: "end", gap: "sm", align: "center", role: "omp.hud.progress" }, children, key);
}

/** A background compaction as {@link BackgroundCompactionHud} shows it. */
export interface BackgroundCompactionRun {
	/** Its working row, which the status row shows while nothing else fills it; stopped when the run ends. */
	readonly loader: Loader;
	/** The HUD row's label: `Compacting context in the background (Esc to cancel)`. */
	readonly label: string;
	/** Epoch ms it started: the HUD row's clock. */
	readonly startedAt: number;
	/** Whether its session is the one in view; out of view it shows nowhere. */
	readonly inView: () => boolean;
}

/** The compaction HUD with no run beside a turn. */
const EMPTY_COMPACTION_HUD: NativeNode = col([], { role: "omp.hud.compaction" });

/**
 * A background compaction (`/handoff`), which leaves the composer free and
 * so shares the dock with turns: while the status row is empty it shows its
 * working row there ({@link idleRow}); while a turn (or any other status)
 * holds the row, a HUD row with an indeterminate bar and its clock instead,
 * so neither replaces the other.
 */
export class BackgroundCompactionHud implements Component {
	readonly #statusBusy: () => boolean;
	#run: BackgroundCompactionRun | undefined;
	/** The HUD row while it stays shown, so the terminal's clock runs on uninterrupted. */
	#native: NativeNode | undefined;

	/** `statusBusy`: whether something other than the run holds the status row. */
	constructor(statusBusy: () => boolean) {
		this.#statusBusy = statusBusy;
	}

	start(run: BackgroundCompactionRun): void {
		this.#run?.loader.stop();
		this.#run = run;
		this.#native = undefined;
	}

	stop(): void {
		this.#run?.loader.stop();
		this.#run = undefined;
		this.#native = undefined;
	}

	/** The run's working row while its session is in view, for the status row to show when empty. */
	idleRow(): Loader | undefined {
		const run = this.#run;
		return run?.inView() ? run.loader : undefined;
	}

	/** The run while it shows here: in view, beside a busy status row. */
	#beside(): BackgroundCompactionRun | undefined {
		const run = this.#run;
		return run?.inView() && this.#statusBusy() ? run : undefined;
	}

	describe(): NativeNode {
		const run = this.#beside();
		if (!run) {
			this.#native = undefined;
			return EMPTY_COMPACTION_HUD;
		}
		this.#native ??= col([describeHudRow("run", run.label, elapsed(Date.now() - run.startedAt), null)], {
			role: "omp.hud.compaction",
		});
		return this.#native;
	}

	render(width: number): readonly string[] {
		const run = this.#beside();
		const available = rowWidth(width);
		if (!run || available === 0) return [];
		const took = theme.fg("text", formatDuration(Date.now() - run.startedAt));
		return [renderHudProgressRow(available, { label: run.label, tail: took, fallback: took })];
	}

	dispose(): void {
		this.stop();
	}
}

/** Progress rows for concurrent judge batches. */
export class JudgmentBatchProgressHud implements Component {
	readonly #batches = new Map<string, JudgmentBatchProgress>();
	#native: NativeNode | undefined;

	update(progress: JudgmentBatchProgress): void {
		this.#batches.set(progress.id, progress);
		this.#native = undefined;
	}

	delete(id: string): void {
		this.#batches.delete(id);
		this.#native = undefined;
	}

	clear(): void {
		this.#batches.clear();
		this.#native = undefined;
	}

	describe(): NativeNode {
		this.#native ??= col(
			Array.from(this.#batches.values(), progress => {
				const tail: TspSpan[] = [span(`${progress.done}/${progress.total}`, "strong")];
				// Zero cost means unpriced, not free — omit rather than show $0.
				if (progress.cost > 0) tail.push(span(` · ${formatCost(progress.cost)}`, "dim"));
				if (progress.failed > 0) tail.push(span(` · ${progress.failed} failed`, "warning"));
				return describeHudRow(progress.id, progress.intent, tail, progress.done / Math.max(1, progress.total));
			}),
			{ role: "omp.hud.judge" },
		);
		return this.#native;
	}

	render(width: number): readonly string[] {
		const available = rowWidth(width);
		if (available === 0) return [];
		const rows: string[] = [];
		for (const progress of this.#batches.values()) rows.push(this.#renderRow(progress, available));
		return rows;
	}

	#renderRow(progress: JudgmentBatchProgress, width: number): string {
		const countText = `${progress.done}/${progress.total}`;
		// Zero cost means unpriced (local/native without catalog pricing), not free — omit rather than show $0.
		const costText = progress.cost > 0 ? ` · ${formatCost(progress.cost)}` : "";
		const failedText = progress.failed > 0 ? ` · ${progress.failed} failed` : "";
		const compactFailedText = progress.failed > 0 ? ` +${progress.failed}!` : "";
		let failure = failedText;
		if (
			failure &&
			visibleWidth(countText) + visibleWidth(costText) + visibleWidth(failure) + MIN_PROGRESS_BAR_WIDTH + 1 >
				width &&
			visibleWidth(countText) + visibleWidth(costText) + visibleWidth(compactFailedText) <= width
		) {
			failure = compactFailedText;
		}

		const styledCount = theme.bold(theme.fg("text", countText));
		const styledCost = costText ? theme.fg("dim", costText) : "";
		const styledFailure = failure ? theme.fg("warning", failure) : "";
		return renderHudProgressRow(width, {
			label: progress.intent,
			tail: `${styledCount}${styledCost}${styledFailure}`,
			fallback: theme.bold(theme.fg("text", countText)),
			bar: { value: progress.done, max: progress.total },
		});
	}
}

/** Downloads finishing faster than this never appear (warm caches, tiny files). */
const DOWNLOAD_REVEAL_MS = 150;
/** A finished download's `ready` row lingers this long. */
const DOWNLOAD_DONE_RETAIN_MS = 1_500;
/** A failed download's row lingers this long so the reason can be read. */
const DOWNLOAD_FAILED_RETAIN_MS = 10_000;

/** What a running activity of unknown total shows: the amount so far, else its current step. */
function formatStep(activity: DownloadActivity): string {
	const { loaded, unit } = activity;
	if (loaded) return unit === "steps" ? `${loaded}` : formatBytes(loaded);
	return activity.detail ?? (unit === "steps" ? "working…" : "downloading…");
}

/** Progress of an activity whose total is known: `129MB / 258MB`, or `3/12` steps. */
function formatProgress(activity: DownloadActivity, received: number, total: number): string {
	if (activity.unit === "steps") return `${received}/${total}`;
	return `${formatBytes(received)} / ${formatBytes(total)}`;
}

interface DownloadRow {
	activity: DownloadActivity;
	startedAt: number;
	timer?: NodeJS.Timeout;
}

/**
 * Progress rows for automatic background work (see `downloads/activity`): a
 * byte or step bar when the total is known, the current step otherwise, then a brief
 * `ready` or a lingering failure reason. Owns its reveal/retain timers.
 */
export class DownloadActivityHud implements Component {
	readonly #rows = new Map<number, DownloadRow>();
	readonly #requestRender: () => void;
	/** Last description and the revealed-row signature it was built for. */
	#native: { node: NativeNode; revision: number; shown: string } | undefined;
	#revision = 0;

	constructor(requestRender: () => void) {
		this.#requestRender = requestRender;
	}

	update(activity: DownloadActivity): void {
		const now = Date.now();
		this.#revision++;
		let row = this.#rows.get(activity.id);
		if (!row) {
			row = { activity, startedAt: now };
			this.#rows.set(activity.id, row);
			row.timer = setTimeout(() => this.#requestRender(), DOWNLOAD_REVEAL_MS);
			row.timer.unref?.();
		}
		row.activity = activity;
		if (activity.state !== "running") {
			clearTimeout(row.timer);
			const shown = now - row.startedAt >= DOWNLOAD_REVEAL_MS;
			if (activity.state === "done" && !shown) {
				this.#rows.delete(activity.id);
				return;
			}
			const id = activity.id;
			row.timer = setTimeout(
				() => {
					this.#rows.delete(id);
					this.#revision++;
					this.#requestRender();
				},
				activity.state === "failed" ? DOWNLOAD_FAILED_RETAIN_MS : DOWNLOAD_DONE_RETAIN_MS,
			);
			row.timer.unref?.();
		}
		this.#requestRender();
	}

	dispose(): void {
		for (const row of this.#rows.values()) clearTimeout(row.timer);
		this.#rows.clear();
		this.#revision++;
	}

	describe(): NativeNode {
		const now = Date.now();
		const shown = [...this.#rows.values()].filter(
			row => row.activity.state !== "running" || now - row.startedAt >= DOWNLOAD_REVEAL_MS,
		);
		const signature = shown.map(row => row.activity.id).join(",");
		if (this.#native?.revision === this.#revision && this.#native.shown === signature) return this.#native.node;
		const nodeOut = col(
			shown.map(row => this.#describeRow(row.activity)),
			{ role: "omp.hud.downloads" },
		);
		this.#native = { node: nodeOut, revision: this.#revision, shown: signature };
		return nodeOut;
	}

	#describeRow(activity: DownloadActivity): NativeNode {
		const key = `${activity.id}`;
		if (activity.state === "failed") {
			const reason = `failed: ${sanitizeStatusText(activity.error ?? "unknown error")}`;
			return describeHudRow(key, activity.label, [span(reason, "warning")]);
		}
		if (activity.state === "done") return describeHudRow(key, activity.label, [span("ready", "success")]);
		const { loaded, total } = activity;
		if (total !== undefined && total > 0) {
			const received = loaded ?? 0;
			const label = activity.detail ? `${activity.label} · ${activity.detail}` : activity.label;
			return describeHudRow(
				key,
				label,
				[span(formatProgress(activity, received, total), "strong")],
				received / total,
			);
		}
		const step = formatStep(activity);
		return describeHudRow(key, activity.label, [span(step)]);
	}

	render(width: number): readonly string[] {
		const available = rowWidth(width);
		if (available === 0) return [];
		const now = Date.now();
		const rows: string[] = [];
		for (const row of this.#rows.values()) {
			if (row.activity.state === "running" && now - row.startedAt < DOWNLOAD_REVEAL_MS) continue;
			rows.push(this.#renderRow(row.activity, available));
		}
		return rows;
	}

	#renderRow(activity: DownloadActivity, width: number): string {
		if (activity.state === "failed") {
			const reason = `failed: ${sanitizeStatusText(activity.error ?? "unknown error")}`;
			return renderHudProgressRow(width, {
				label: activity.label,
				tail: theme.fg("warning", truncateToWidth(reason, Math.max(8, Math.floor(width * 0.6)))),
				fallback: theme.fg("warning", reason),
			});
		}
		if (activity.state === "done") {
			return renderHudProgressRow(width, {
				label: activity.label,
				tail: theme.fg("success", "ready"),
				fallback: theme.fg("success", `${activity.label} ready`),
			});
		}
		const { loaded, total } = activity;
		if (total !== undefined && total > 0) {
			const received = loaded ?? 0;
			const percent = `${Math.floor((received / total) * 100)}%`;
			return renderHudProgressRow(width, {
				label: activity.detail ? `${activity.label} · ${activity.detail}` : activity.label,
				tail: theme.bold(theme.fg("text", formatProgress(activity, received, total))),
				fallback: theme.bold(theme.fg("text", percent)),
				bar: { value: received, max: total },
			});
		}
		// Total unknown: the amount so far, or the current step (`installing`, `extracting`).
		const step = formatStep(activity);
		return renderHudProgressRow(width, {
			label: activity.label,
			tail: theme.fg("text", step),
			fallback: theme.fg("text", `${activity.label} ${step}`),
		});
	}
}
