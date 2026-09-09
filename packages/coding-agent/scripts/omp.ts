/**
 * Bun `--preload` shim for the omp dev launcher (`scripts/omp`).
 *
 * The launcher starts Bun from an empty, bunfig-free directory so a foreign
 * project's `bunfig.toml` `preload` cannot run inside the omp CLI: Bun reads
 * `bunfig.toml` from the *current working directory* on startup and evaluates
 * its `preload` entries before the entrypoint, so a bun-shebang bin inherits
 * whatever `preload` the directory you launched from declares (and crashes if
 * that preload can't resolve). This shim is loaded before the entrypoint's
 * imports run, so it restores the user's real working directory in time for
 * import-time snapshots (e.g. `getProjectDir()` in `@oh-my-pi/pi-utils/dirs`).
 */
const launchCwd = process.env.OMP_LAUNCH_CWD;
if (launchCwd) {
	delete process.env.OMP_LAUNCH_CWD;
	try {
		process.chdir(launchCwd);
	} catch {}
}
