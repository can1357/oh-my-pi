/**
 * Process RSS helpers for eval kernels.
 *
 * `ps -o rss=` reports kilobytes on macOS and Linux. Windows has no equivalent
 * we can rely on without extra tools, so RSS is treated as unknown there and
 * the cap does not fire.
 */

/** Default retained-Python RSS ceiling. 0 disables the cap. */
export const DEFAULT_PYTHON_MAX_RSS_MB = 1024;

/** Parse `ps -o rss=` stdout into kilobytes. */
export function parsePsRssKb(output: string): number | undefined {
	const match = /(\d+)/.exec(output);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return undefined;
	return value;
}

/** Coerce a settings value into a whole-megabyte cap. Non-positive disables. */
export function normalizeMaxRssMb(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_PYTHON_MAX_RSS_MB;
	if (value <= 0) return 0;
	return Math.floor(value);
}

/** True when sampled RSS is strictly above the configured megabyte cap. */
export function kernelRssExceedsLimit(rssKb: number | undefined, maxRssMb: number): boolean {
	if (maxRssMb <= 0 || rssKb === undefined) return false;
	return rssKb > maxRssMb * 1024;
}

/** Host-visible note appended after a cell whose kernel was recycled for RSS. */
export function formatKernelRssRecycleAnnotation(rssMb: number, maxRssMb: number): string {
	return `eval kernel RSS ${rssMb}MB exceeded python.maxRssMb=${maxRssMb}; the kernel was recycled and the next cell starts fresh.`;
}

type RssAnnotatedOutput = {
	output: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
};

/** Append the recycle note and keep line/byte summaries describing the returned text. */
export function appendRssRecycleAnnotation<T extends RssAnnotatedOutput>(result: T, note: string): T {
	const prefix = result.output.length === 0 || result.output.endsWith("\n") ? result.output : `${result.output}\n`;
	const output = `${prefix}${note}\n`;
	const addedBytes = Buffer.byteLength(output, "utf8") - Buffer.byteLength(result.output, "utf8");
	return {
		...result,
		output,
		totalLines: result.totalLines + 1,
		totalBytes: result.totalBytes + addedBytes,
		outputLines: result.outputLines + 1,
		outputBytes: result.outputBytes + addedBytes,
	};
}

/**
 * Read a process's RSS in kilobytes, or undefined when it cannot be sampled.
 * Spawn, read, and exit failures are best-effort: a missing `ps` must not turn
 * a successful Python cell into a tool failure. Windows has no `ps -o rss=`.
 */
export async function readProcessRssKb(pid: number): Promise<number | undefined> {
	if (process.platform === "win32") return undefined;
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	try {
		const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const text = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return undefined;
		return parsePsRssKb(text);
	} catch {
		return undefined;
	}
}
