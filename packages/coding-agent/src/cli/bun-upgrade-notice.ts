/** Bun version below which interactive startup recommends upgrading (older runtimes still work, but are slower). */
const RECOMMENDED_BUN_VERSION = "1.4.0";

/** Upgrade notice for a supported but older Bun runtime; undefined when `bunVersion` is current. */
export function bunUpgradeNotice(bunVersion: string): string | undefined {
	if (Bun.semver.order(bunVersion, RECOMMENDED_BUN_VERSION) >= 0) return undefined;
	return `omp is running on Bun v${bunVersion}. Bun ${RECOMMENDED_BUN_VERSION} or newer uses noticeably less memory and CPU. Run \`bun upgrade\`, or update Bun through the package manager you installed it with.`;
}
