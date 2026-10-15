import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";

const BAR_WIDTH = 16;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 250;

/** Minimal output contract used by the interactive progress reporters. */
export interface ProgressOutput {
	isTTY?: boolean;
	columns?: number;
	write(text: string): boolean;
}

/** Renders completed units of work on one transient terminal line. */
export interface ProgressReporter {
	readonly interactive: boolean;
	start(total: number): void;
	complete(): void;
	finish(): void;
}

/**
 * Create a TTY-only completion bar labelled `label`, e.g. `Repairing [████░░░░] 4/8`.
 *
 * Non-interactive output disables rendering entirely, so callers can print plain
 * per-item lines instead by checking {@link ProgressReporter.interactive}.
 */
export function createProgressReporter(label: string, output: ProgressOutput = process.stdout): ProgressReporter {
	const interactive = output.isTTY === true;
	let total = 0;
	let completed = 0;
	let rendered = false;

	const render = (): void => {
		if (!interactive || total === 0) return;
		const ratio = Math.min(completed / total, 1);
		const filled = Math.round(ratio * BAR_WIDTH);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
		output.write(`\r${label} [${bar}] ${completed}/${total}\x1b[K`);
		rendered = true;
	};

	return {
		interactive,
		start(nextTotal) {
			total = Math.max(nextTotal, 0);
			completed = 0;
			render();
		},
		complete() {
			completed = Math.min(completed + 1, total);
			render();
		},
		finish() {
			if (!rendered) return;
			output.write("\n");
			rendered = false;
		},
	};
}

/** Renders a byte transfer on one transient terminal line. */
export interface DownloadProgressReporter {
	update(received: number): void;
	finish(): void;
}

/**
 * Create a TTY-only transfer line, e.g. `  42.1MB / 180.3MB (23%), 1.2MB/s, 1m50s left`,
 * redrawn at most every 250ms and cut to the terminal width so it never wraps.
 * Non-interactive output prints nothing.
 */
export function createDownloadProgressReporter(
	total: number,
	output: ProgressOutput = process.stdout,
): DownloadProgressReporter {
	if (output.isTTY !== true) return { update() {}, finish() {} };
	const startedAt = Date.now();
	let renderedAt = 0;
	return {
		update(received) {
			const now = Date.now();
			if (received < total && now - renderedAt < DOWNLOAD_PROGRESS_INTERVAL_MS) return;
			renderedAt = now;
			const bytesPerSecond = (received * 1000) / Math.max(now - startedAt, 1);
			const percent = Math.floor((received / total) * 100);
			const left = received < total ? `, ${formatDuration(((total - received) / bytesPerSecond) * 1000)} left` : "";
			const line = `  ${formatBytes(received)} / ${formatBytes(total)} (${percent}%), ${formatBytes(bytesPerSecond)}/s${left}`;
			// One column short of the width: a line ending in the last column wraps on some terminals.
			const width = (output.columns || 80) - 1;
			output.write(`\r${chalk.dim(truncateToWidth(line, width))}\x1b[K`);
		},
		finish() {
			if (renderedAt) output.write("\n");
		},
	};
}
