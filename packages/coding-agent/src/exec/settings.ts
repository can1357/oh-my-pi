/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register, type SettingValueOf } from "../config/registry";

/** One bash-interceptor rule: commands matching `pattern` are redirected to `tool`. */
export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

const EMPTY_STRING_ARRAY: string[] = [];
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "grep",
		message: "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "glob",
		message: "Use the `glob` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		// `>` must sit outside quoted regions (so `echo "a -> b"` passes) and be
		// followed by a plausible filename — including `$VAR` targets; `>|`
		// (clobber) counts as a redirect; `>&2`/`2>&1` style fd duplication is
		// not matched. Allowed device sinks are consumed while looking for later
		// real file redirects because the write tool cannot replace shell
		// output/discard targets.
		pattern:
			"^\\s*(echo|printf|cat\\s*<<)\\s+(?:(?:[^\"'>]|\"[^\"]*\"|'[^']*')|(?<!\\|)>{1,2}\\|?\\s*(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))*(?<!\\|)>{1,2}\\|?\\s*(?!(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
	{
		pattern: "^\\s*nohup\\s+|(?<!&)\\&\\s*$",
		tool: "bash",
		message:
			"Use `bash` with `name` instead of nohup or background shell syntax so the service stays observable and managed.",
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:dev|start)(?:\\s|$)|(?:vite|next\\s+dev|nuxt\\s+dev|nodemon|lldb|gdb|tail\\s+-f)(?:\\s|$)|docker\\s+compose\\s+up(?!.*(?:\\s-d(?:\\s|$)|--detach))(?:\\s|$))",
		tool: "bash",
		message: "Use `bash` with `name` for services, watchers, and debuggers; inspect with `read proc://<name>`.",
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?\\S+|cargo\\s+watch|watchexec|pytest|vitest|jest|tsc)(?:.|\\n)*(?:--watch|-w)(?:\\s|$)",
		tool: "bash",
		message: "Use `bash` with `name` for watch mode so its output, input, and lifecycle stay managed.",
	},
];

export const cfgShellPath = register({ id: "shellPath", type: "string", default: undefined });

export const cfgBashEnabled = register({
	id: "bash.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash",
		description: "Enable the bash tool for shell command execution",
	},
});

export const cfgBashAllowCompoundCommands = register({
	id: "bash.allowCompoundCommands",
	safetySensitive: true,
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Allow Compound Commands",
		description:
			"Evaluate literal && chains per command; unmatched commands use normal bash approval policy and mode",
	},
});

export const cfgBashAutoBackgroundEnabled = register({
	id: "bash.autoBackground.enabled",
	protocolDefault: ["rpc"],
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Auto-Background",
		description: "Automatically background long-running bash commands and deliver the result later",
	},
});

export const cfgBashPatterns = register({
	id: "bash.patterns",
	type: "array",
	default: [],
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Approval Patterns",
		description:
			"Ordered bash command approval rules. Each item has match and approval fields; only '*' wildcards are supported.",
	},
});

// Bash interceptor
export const cfgBashInterceptorEnabled = register({
	id: "bashInterceptor.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Interceptor",
		description: "Block shell commands that have dedicated tools",
	},
});

export const cfgBashInterceptorPatterns = register({
	id: "bashInterceptor.patterns",
	type: "array",
	default: DEFAULT_BASH_INTERCEPTOR_RULES,
});

export const cfgBashDirenv = register({
	id: "bash.direnv",
	type: "enum",
	values: ["auto", "off"] as const,
	default: "auto",
	ui: {
		tab: "shell",
		group: "Bash",
		label: "direnv Auto-Load",
		description:
			"Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed",
	},
});

export const cfgBashDirenvLoadTimeoutMs = register({
	id: "bash.direnvLoadTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "direnv Load Timeout (ms)",
		description:
			"Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env",
	},
});

// Shell output minimizer
export const cfgShellMinimizerEnabled = register({
	id: "shellMinimizer.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Shell Minimizer",
		description: "Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent",
	},
});

export const cfgShellMinimizerSettingsPath = register({
	id: "shellMinimizer.settingsPath",
	type: "string",
	default: undefined,
});

export const cfgShellMinimizerOnly = register({
	id: "shellMinimizer.only",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgShellMinimizerExcept = register({
	id: "shellMinimizer.except",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgShellMinimizerMaxCaptureBytes = register({
	id: "shellMinimizer.maxCaptureBytes",
	type: "number",
	default: 4 * 1024 * 1024,
});

export const cfgShellMinimizerSourceOutlineLevel = register({
	id: "shellMinimizer.sourceOutlineLevel",
	type: "enum",
	values: ["default", "aggressive"] as const,
	default: "default",
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Shell Minimizer Source Outline",
		description: "Source outline mode for cat/read of source files: default or aggressive",
	},
});

export const cfgShellMinimizerLegacyFilters = register({
	id: "shellMinimizer.legacyFilters",
	type: "boolean",
	default: undefined,
});

/** Shell output minimizer configuration (`shellMinimizer.*`). */
export const cfgShellMinimizer = combine({
	enabled: cfgShellMinimizerEnabled,
	settingsPath: cfgShellMinimizerSettingsPath,
	only: cfgShellMinimizerOnly,
	except: cfgShellMinimizerExcept,
	maxCaptureBytes: cfgShellMinimizerMaxCaptureBytes,
	sourceOutlineLevel: cfgShellMinimizerSourceOutlineLevel,
	legacyFilters: cfgShellMinimizerLegacyFilters,
});

/** Shell output minimizer configuration ({@link cfgShellMinimizer}). */
export type ShellMinimizerSettings = SettingValueOf<typeof cfgShellMinimizer>;

export const cfgBashAutoBackgroundThresholdMs = register({
	id: "bash.autoBackground.thresholdMs",
	protocolDefault: ["rpc"],
	type: "number",
	default: 60_000,
});
