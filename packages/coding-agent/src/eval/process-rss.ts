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

/** Read a process's RSS in kilobytes, or undefined when it cannot be sampled. */
export async function readProcessRssKb(pid: number): Promise<number | undefined> {
	if (process.platform === "win32") return undefined;
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const text = await new Response(proc.stdout).text();
	const code = await proc.exited;
	if (code !== 0) return undefined;
	return parsePsRssKb(text);
}
