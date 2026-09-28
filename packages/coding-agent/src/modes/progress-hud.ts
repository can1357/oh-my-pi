/**
 * Editor-anchored, right-aligned progress rows above the working line: judge
 * batches (`judge_batch`) and automatic downloads/installs (model weights,
 * tool binaries, browsers, side runtimes). Both render through
 * {@link renderHudProgressRow} so they read as one HUD.
 */
import { type Component, renderProgressBar, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { formatCost } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { formatBytes } from "@oh-my-pi/pi-utils";
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

/** Progress rows for concurrent judge batches. */
export class JudgmentBatchProgressHud implements Component {
	readonly #batches = new Map<string, JudgmentBatchProgress>();

	update(progress: JudgmentBatchProgress): void {
		this.#batches.set(progress.id, progress);
	}

	delete(id: string): void {
		this.#batches.delete(id);
	}

	clear(): void {
		this.#batches.clear();
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

interface DownloadRow {
	activity: DownloadActivity;
	startedAt: number;
	timer?: NodeJS.Timeout;
}

/**
 * Progress rows for automatic downloads and installs (see `downloads/activity`):
 * a byte bar when the size is known, the current step otherwise, then a brief
 * `ready` or a lingering failure reason. Owns its reveal/retain timers.
 */
export class DownloadActivityHud implements Component {
	readonly #rows = new Map<number, DownloadRow>();
	readonly #requestRender: () => void;

	constructor(requestRender: () => void) {
		this.#requestRender = requestRender;
	}

	update(activity: DownloadActivity): void {
		const now = Date.now();
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
				tail: theme.bold(theme.fg("text", `${formatBytes(received)} / ${formatBytes(total)}`)),
				fallback: theme.bold(theme.fg("text", percent)),
				bar: { value: received, max: total },
			});
		}
		// Size unknown: bytes so far, or the current step (`installing`, `extracting`).
		const step = loaded ? formatBytes(loaded) : (activity.detail ?? "downloading…");
		return renderHudProgressRow(width, {
			label: activity.label,
			tail: theme.fg("text", step),
			fallback: theme.fg("text", `${activity.label} ${step}`),
		});
	}
}
