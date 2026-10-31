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
	// Git Credential Manager GUI/browser auth dialogs ignore GIT_TERMINAL_PROMPT and block until answered.
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

const WINDOWS_UTF8_ENV_DEFAULT_GROUPS: ReadonlyArray<ReadonlyArray<readonly [key: string, value: string]>> = [
	[
		["PYTHONIOENCODING", "utf-8"],
		["PYTHONUTF8", "1"],
	],
	[
		["LANG", "C.UTF-8"],
		["LC_ALL", "C.UTF-8"],
	],
];

/** Returns the `[key, value]` entry for `key`, matched case-insensitively on Windows. */
function getEnvEntry(
	env: Record<string, string | undefined> | undefined,
	key: string,
	platform: NodeJS.Platform,
): [key: string, value: string] | undefined {
	if (!env) return undefined;
	if (platform !== "win32") {
		const value = env[key];
		return value === undefined ? undefined : [key, value];
	}

	for (const [existingKey, value] of Object.entries(env)) {
		if (value !== undefined && existingKey.toLowerCase() === key.toLowerCase()) {
			return [existingKey, value];
		}
	}
	return undefined;
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

function hasEnvGroupValue(
	env: Record<string, string | undefined> | undefined,
	group: ReadonlyArray<readonly [key: string, value: string]>,
	platform: NodeJS.Platform,
): boolean {
	if (group.some(([key]) => key === "LC_ALL") && hasLocaleEnvValue(env, platform)) return true;
	for (const [key] of group) {
		if (getEnvEntry(env, key, platform) !== undefined) return true;
	}
	return false;
}

/** Copy of the base env with `CI` removed, for the `PI_BASH_NO_CI` opt-out. */
function withoutCI(env: Readonly<Record<string, string>>): Record<string, string> {
	const { CI: _ci, ...rest } = env;
	return rest;
}

/**
 * Env-provided git config (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`)
 * setting `sequence.editor=true`, appended after the entries of `env` overlaid on `baseEnv`.
 *
 * A configured `sequence.editor` outranks GIT_EDITOR, so `git rebase -i` would
 * block on the user's editor. Env config outranks config files but not
 * `git -c sequence.editor=...` or an inline GIT_SEQUENCE_EDITOR, so scripted
 * todo-list edits keep working; exporting GIT_SEQUENCE_EDITOR would silently
 * replace them with plain picks.
 *
 * Belongs at the level of the environment a shell starts from (the persistent
 * shell's session env, a fresh PTY shell's spawn env), never in a per-command
 * overlay: a shell's own `export GIT_CONFIG_*` must keep replacing it.
 *
 * Returns nothing when the existing count is malformed (the user's env is left
 * untouched) or an existing entry already sets `sequence.editor`.
 */
export function buildSequenceEditorConfigEnv(
	env: Record<string, string> | undefined,
	baseEnv: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> | undefined {
	const countEntry =
		getEnvEntry(env, "GIT_CONFIG_COUNT", platform) ?? getEnvEntry(baseEnv, "GIT_CONFIG_COUNT", platform);
	const count = countEntry ? Number(countEntry[1]) : 0;
	if (countEntry && (!/^\d+$/.test(countEntry[1]) || !Number.isSafeInteger(count))) return undefined;
	// Scan present keys rather than looping to `count`, which the user controls.
	// `env` shadows `baseEnv` entries at the same index.
	const keyPattern = platform === "win32" ? /^GIT_CONFIG_KEY_(\d+)$/i : /^GIT_CONFIG_KEY_(\d+)$/;
	const configKeys = new Map<number, string>();
	for (const source of [baseEnv, env ?? {}]) {
		for (const [key, value] of Object.entries(source)) {
			const index = keyPattern.exec(key)?.[1];
			if (index !== undefined && value !== undefined) configKeys.set(Number(index), value);
		}
	}
	for (const [index, key] of configKeys) {
		if (index < count && key.toLowerCase() === "sequence.editor") return undefined;
	}
	return {
		[countEntry?.[0] ?? "GIT_CONFIG_COUNT"]: String(count + 1),
		[`GIT_CONFIG_KEY_${count}`]: "sequence.editor",
		[`GIT_CONFIG_VALUE_${count}`]: "true",
	};
}

/** Builds the per-command environment for non-interactive child processes. */
export function buildNonInteractiveEnv(
	overrides?: Record<string, string>,
	baseEnv: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	// `PI_BASH_NO_CI` (and its legacy alias) opts out of the automatic `CI=true`
	// injection. Mirrors the session-env gate in `procmgr.ts` so the opt-out
	// reaches the per-command env, which otherwise overrides the session value.
	const base =
		baseEnv.PI_BASH_NO_CI || baseEnv.CLAUDE_BASH_NO_CI ? withoutCI(NON_INTERACTIVE_ENV) : NON_INTERACTIVE_ENV;
	if (platform !== "win32") {
		return overrides ? { ...base, ...overrides } : base;
	}

	const env: Record<string, string> = { ...base };
	for (const group of WINDOWS_UTF8_ENV_DEFAULT_GROUPS) {
		if (hasEnvGroupValue(baseEnv, group, platform) || hasEnvGroupValue(overrides, group, platform)) {
			continue;
		}
		for (const [key, value] of group) {
			env[key] = value;
		}
	}
	return overrides ? { ...env, ...overrides } : env;
}
