/** Platform-specific options for detached daemon service children. */
export interface DaemonSpawnOptions {
	detached: boolean;
	windowsHide?: boolean;
}

/**
 * Keep daemon service children alive across the host's death. On Windows,
 * `detached: false` leaves the child in libuv's kill-on-close job object, so a
 * daemon restart took every detached service with it; `windowsHide` keeps the
 * re-spawned service headless.
 */
export function resolveDaemonSpawnOptions(opts: { platform: NodeJS.Platform }): DaemonSpawnOptions {
	if (opts.platform !== "win32") return { detached: true };
	return { detached: true, windowsHide: true };
}
