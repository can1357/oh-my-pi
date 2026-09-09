/** Inputs used to decide whether the optional startup splash may run for this process. */
export interface StartupSplashDecisionOptions {
	readonly configured: boolean;
	readonly isInteractive: boolean;
	readonly resuming: boolean;
	readonly quiet: boolean;
	readonly timing: boolean;
	readonly stdinIsTTY: boolean | undefined;
	readonly stdoutIsTTY: boolean | undefined;
}

/** Returns true only for explicitly enabled, normal interactive TTY startup. */
export function shouldShowStartupSplash(options: StartupSplashDecisionOptions): boolean {
	if (!options.configured) return false;
	if (!options.isInteractive) return false;
	if (options.resuming || options.quiet) return false;
	if (options.timing) return false;
	return options.stdinIsTTY === true && options.stdoutIsTTY === true;
}
