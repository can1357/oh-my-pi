import { $which } from "@oh-my-pi/pi-utils";

/** Portable command that rejects credential prompts without assuming an FHS layout. */
export const REJECT_PROMPT_COMMAND = $which("false") ?? "false";

export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
	// Disable pagers so commands don't block on interactive views.
	PAGER: "cat",
	GIT_PAGER: "cat",
	MANPAGER: "cat",
	SYSTEMD_PAGER: "cat",
	BAT_PAGER: "cat",
	DELTA_PAGER: "cat",
	GH_PAGER: "cat",
	GLAB_PAGER: "cat",
	PSQL_PAGER: "cat",
	MYSQL_PAGER: "cat",
	AWS_PAGER: "",
	HOMEBREW_PAGER: "cat",
	LESS: "FRX",
	// Disable terminal features that can block the process.
	TERM: "dumb",
	NO_COLOR: "1",
	PYTHONUNBUFFERED: "1",
	// Disable editor and terminal credential prompts.
	GIT_EDITOR: "true",
	VISUAL: "true",
	EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	// A config-file `sequence.editor` outranks GIT_EDITOR and would block `git rebase -i`.
	GIT_SEQUENCE_EDITOR: "true",
	// Git Credential Manager GUI/browser auth dialogs ignore GIT_TERMINAL_PROMPT.
	GCM_INTERACTIVE: "never",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
	CI: "true",
	AGENT: "1",
	// Package manager defaults for unattended execution.
	npm_config_yes: "true",
	npm_config_update_notifier: "false",
	npm_config_fund: "false",
	npm_config_audit: "false",
	npm_config_progress: "false",
	PNPM_DISABLE_SELF_UPDATE_CHECK: "true",
	PNPM_UPDATE_NOTIFIER: "false",
	YARN_ENABLE_TELEMETRY: "0",
	YARN_ENABLE_PROGRESS_BARS: "0",
	// Cross-language/tooling non-interactive defaults.
	CARGO_TERM_PROGRESS_WHEN: "never",
	DEBIAN_FRONTEND: "noninteractive",
	PIP_NO_INPUT: "1",
	PIP_DISABLE_PIP_VERSION_CHECK: "1",
	TF_INPUT: "0",
	TF_IN_AUTOMATION: "1",
	GH_PROMPT_DISABLED: "1",
	COMPOSER_NO_INTERACTION: "1",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
};

/**
 * Locale pinned for agent commands: byte-order collation, `C` numbers, dates,
 * and English messages like `C`, but UTF-8 text, which `C` would split into bytes.
 */
const AGENT_LOCALE = "C.UTF-8";

/** Python stdio defaults for Windows, where the console code page is not UTF-8. */
const WINDOWS_PYTHON_UTF8_ENV: Readonly<Record<string, string>> = {
	PYTHONIOENCODING: "utf-8",
	PYTHONUTF8: "1",
};

function hasEnvValue(
	env: Record<string, string | undefined> | undefined,
	key: string,
	platform: NodeJS.Platform,
): boolean {
	if (!env) return false;
	if (platform !== "win32") return env[key] !== undefined;

	for (const [existingKey, value] of Object.entries(env)) {
		if (value !== undefined && existingKey.toLowerCase() === key.toLowerCase()) {
			return true;
		}
	}
	return false;
}

function hasEnvGroupValue(
	env: Record<string, string | undefined> | undefined,
	group: Readonly<Record<string, string>>,
	platform: NodeJS.Platform,
): boolean {
	for (const key in group) {
		if (hasEnvValue(env, key, platform)) return true;
	}
	return false;
}

function hasLocaleEnvValue(env: Record<string, string | undefined> | undefined, platform: NodeJS.Platform): boolean {
	if (!env) return false;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
		if (normalizedKey === "LANG" || normalizedKey.startsWith("LC_")) return true;
	}
	return false;
}

/** Copy of the base env with `CI` removed, for the `PI_BASH_NO_CI` opt-out. */
function withoutCI(env: Readonly<Record<string, string>>): Record<string, string> {
	const { CI: _ci, ...rest } = env;
	return rest;
}

/** Options for {@link buildNonInteractiveEnv}. */
export interface NonInteractiveEnvOptions {
	/** Env the child inherits from the launcher. */
	baseEnv?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	/** Keep the inherited locale instead of pinning {@link AGENT_LOCALE}: user-typed `!` commands. */
	inheritLocale?: boolean;
}

/** Builds the per-command environment for non-interactive child processes. */
export function buildNonInteractiveEnv(
	overrides?: Record<string, string>,
	{ baseEnv = Bun.env, platform = process.platform, inheritLocale = false }: NonInteractiveEnvOptions = {},
): Record<string, string> {
	// `PI_BASH_NO_CI` (and its legacy alias) opts out of the automatic `CI=true`
	// injection. Mirrors the session-env gate in `procmgr.ts` so the opt-out
	// reaches the per-command env, which otherwise overrides the session value.
	const env: Record<string, string> =
		baseEnv.PI_BASH_NO_CI || baseEnv.CLAUDE_BASH_NO_CI ? withoutCI(NON_INTERACTIVE_ENV) : { ...NON_INTERACTIVE_ENV };

	// Agent commands pin the locale whatever the launcher inherited, so sort
	// order, number formats, and messages do not vary by machine; a locale in
	// the command's own env opts out. Inherited-locale commands still get UTF-8
	// on Windows when nothing names a locale.
	const pinLocale = !inheritLocale || (platform === "win32" && !hasLocaleEnvValue(baseEnv, platform));
	if (pinLocale && !hasLocaleEnvValue(overrides, platform)) {
		env.LANG = AGENT_LOCALE;
		env.LC_ALL = AGENT_LOCALE;
	}

	if (
		platform === "win32" &&
		!hasEnvGroupValue(baseEnv, WINDOWS_PYTHON_UTF8_ENV, platform) &&
		!hasEnvGroupValue(overrides, WINDOWS_PYTHON_UTF8_ENV, platform)
	) {
		Object.assign(env, WINDOWS_PYTHON_UTF8_ENV);
	}
	return overrides ? { ...env, ...overrides } : env;
}
