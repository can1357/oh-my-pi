/** Environment and invocation gates for onboarding scene selection. */
export interface SetupSceneSelectionOptions {
	resuming?: boolean;
	isTTY?: boolean;
	skipEnv?: string;
	setupWizardEnabled?: boolean;
	force?: boolean;
}

function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Whether this launch may show onboarding at all: a TTY and, unless forced,
 * not resuming, not skipped by `OMP_SKIP_SETUP` or `startup.setupWizard`.
 */
export function setupWizardAllowed(options: SetupSceneSelectionOptions = {}): boolean {
	const isTTY = options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
	if (!isTTY) return false;
	if (options.force) return true;
	return (
		!options.resuming &&
		!setupSkipEnvEnabled(options.skipEnv ?? Bun.env.OMP_SKIP_SETUP) &&
		options.setupWizardEnabled !== false
	);
}

/** Control completion persistence and the post-setup welcome animation. */
export interface RunSetupWizardOptions {
	markComplete?: boolean;
	playWelcomeIntro?: boolean;
}
