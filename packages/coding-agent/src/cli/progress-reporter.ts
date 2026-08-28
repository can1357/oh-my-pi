const BAR_WIDTH = 16;

/** Minimal output contract used by the interactive progress reporter. */
export interface ProgressOutput {
	isTTY?: boolean;
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
