/** Platform-specific options for the launch broker and its non-PTY children. */
export interface DaemonSpawnOptions {
	detached: boolean;
	windowsHide?: boolean;
}

/** Keep launch processes headless without discarding an inheritable Windows console. */
export function resolveDaemonSpawnOptions(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole: boolean;
}): DaemonSpawnOptions {
	if (opts.platform !== "win32") return { detached: true };
	return {
		detached: false,
		windowsHide: !opts.hostHasInheritableConsole,
	};
}
