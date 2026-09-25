/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import {
	type AgentCompactionThresholdOverride,
	validateAgentCompactionThresholdOverrides,
} from "../config/compaction-threshold";
import { effect, register } from "../config/registry";
import { type ServiceTierInheritSettingValue, validateAgentServiceTierOverrides } from "../config/service-tier";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { logger, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { setFeedModelBadgeEnabled } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";

const EMPTY_AGENT_SERVICE_TIER_OVERRIDES: Record<string, ServiceTierInheritSettingValue> = {};
const EMPTY_AGENT_COMPACTION_THRESHOLD_OVERRIDES: Record<string, AgentCompactionThresholdOverride> = {};

const DEFAULT_AGENT_MODEL_OVERRIDES: Record<string, string | string[]> = {};

// Delegation. Task and isolation settings declare `protocolDefault`: protocol hosts get neutral
// defaults instead of the local user's interactive preferences.
export const cfgTaskIsolationEnabled = register({
	id: "task.isolation.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Isolate Subagents",
		description: "Run subagents in an isolated copy of the checkout and integrate their changes afterwards",
	},
});

export const cfgIsolationBackend = register({
	id: "isolation.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "projfs", "block-clone", "rcopy"] as const,
	default: "auto",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Isolation Backend",
		description: "Backend used for subagent isolation and worktree cloning",
		options: [
			{ value: "auto", label: "Auto", description: "Let the PAL pick the best available backend" },
			{ value: "apfs", label: "APFS", description: "macOS clonefile reflink (APFS)" },
			{ value: "btrfs", label: "btrfs", description: "btrfs subvolume snapshot" },
			{ value: "zfs", label: "ZFS", description: "ZFS snapshot + clone" },
			{ value: "reflink", label: "Reflink", description: "Linux FICLONE per-file reflink" },
			{
				value: "overlayfs",
				label: "Overlayfs",
				description: "Linux kernel overlay (or fuse-overlayfs fallback)",
			},
			{ value: "projfs", label: "ProjFS", description: "Windows Projected File System" },
			{
				value: "block-clone",
				label: "Block clone",
				description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
			},
			{
				value: "rcopy",
				label: "Recursive copy",
				description: "git worktree if available, otherwise recursive copy",
			},
		],
	},
});

export const cfgWorktreeClone = register({
	id: "worktree.clone",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Clone Checkout into Worktrees",
		description:
			"New worktrees from `github pr_checkout` and `git worktree add` in bash start as a copy-on-write clone of the current checkout so ignored build artifacts (node_modules, target) carry over; falls back to a plain checkout when the filesystem cannot clone",
	},
});

export const cfgWorktreeCleanSource = register({
	id: "worktree.cleanSource",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Clean Source Checkout on /wt",
		description:
			"When creating a worktree with `/wt`, reset tracked changes and remove untracked files from the original checkout after carrying them over",
	},
});

export const cfgTaskIsolationApply = register({
	id: "task.isolation.apply",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Apply Isolated Changes",
		description:
			"Automatically apply successful isolated task changes to the parent checkout; disable to retain patch or branch artifacts",
	},
});

export const cfgTaskIsolationMerge = register({
	id: "task.isolation.merge",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["patch", "branch"] as const,
	default: "patch",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Isolation Merge Strategy",
		description: "How isolated task changes are integrated (patch apply or branch merge)",
		options: [
			{ value: "patch", label: "Patch", description: "Combine diffs and git apply" },
			{ value: "branch", label: "Branch", description: "Commit per task, merge with --no-ff" },
		],
	},
});

export const cfgTaskIsolationCommits = register({
	id: "task.isolation.commits",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["generic", "ai"] as const,
	default: "generic",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Isolation Commit Style",
		description: "Commit message style for nested repo changes (generic or AI-generated)",
		options: [
			{ value: "generic", label: "Generic", description: "Static commit message" },
			{ value: "ai", label: "AI", description: "AI-generated commit message from diff" },
		],
	},
});

export const cfgWorktreeBase = register({
	id: "worktree.base",
	type: "string",
	default: undefined,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: "Worktree Base Directory",
		description:
			"Base directory for agent-managed worktrees — task-isolation copies, `github` PR checkouts, and `omp worktree` cleanup all live here. Unset uses ~/.omp/wt. Must be an absolute or ~-relative path; relative paths are ignored. The OMP_WORKTREE_DIR env var overrides this.",
	},
});
effect(cfgWorktreeBase, value => {
	const dir = value?.trim() ? value : undefined;
	// Always applied, so an unset/empty value clears a previous override. setWorktreesDir expands `~`,
	// rejects relative paths, and returns the applied absolute path (undefined when cleared/rejected).
	if (!setWorktreesDir(dir) && dir) {
		logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
	}
});

export const cfgTaskEager = register({
	id: "task.eager",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["default", "preferred", "always"] as const,
	default: "default",
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Prefer Task Delegation",
		description: "How strongly to push delegating work to subagents",
		options: [
			{
				value: "default",
				label: "Default",
				description: "Uses the selected model's policy; some models require an explicit delegation request",
			},
			{ value: "preferred", label: "Preferred", description: "Adds delegation guidance to the system prompt" },
			{ value: "always", label: "Always", description: "Prompt guidance plus a first-turn delegation reminder" },
		],
	},
});

export const cfgTaskBatch = register({
	id: "task.batch",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Batch Task Calls",
		description:
			"Switch the task tool to its batch shape: one call carries { context, tasks[] } — one subagent per item, with an optional per-item agent (defaulting to the session spawn-policy agent), per-item isolation, and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema.",
	},
});

export const cfgTaskEnableEffort = register({
	id: "task.enableEffort",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Per-Task Effort",
		description:
			"Expose the optional effort parameter on task spawns, allowing callers to override each subagent's thinking level",
	},
});

export const cfgTaskMaxConcurrency = register({
	id: "task.maxConcurrency",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 32,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Max Concurrent Tasks",
		description: "Maximum number of subagents running concurrently",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "1", label: "1 task" },
			{ value: "2", label: "2 tasks" },
			{ value: "4", label: "4 tasks" },
			{ value: "8", label: "8 tasks" },
			{ value: "16", label: "16 tasks" },
			{ value: "32", label: "32 tasks" },
			{ value: "64", label: "64 tasks" },
		],
	},
});

export const cfgTaskAgentCatalogDescriptionBudgetChars = register({
	id: "task.agentCatalogDescriptionBudgetChars",
	type: "number",
	default: -1,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Agent Catalogue Description Budget",
		description:
			"Character budget for agent descriptions in the task tool prompt. -1 leaves every description intact, 0 renders names only. A positive value is spent in catalogue order, so agents past the cap render as names without descriptions. Every agent stays spawnable either way.",
		options: [
			{ value: "-1", label: "Unlimited" },
			{ value: "0", label: "Names only" },
			{ value: "500", label: "500 characters" },
			{ value: "1000", label: "1000 characters" },
			{ value: "2000", label: "2000 characters" },
			{ value: "4000", label: "4000 characters" },
			{ value: "8000", label: "8000 characters" },
		],
	},
});

export const cfgTaskEnableLsp = register({
	id: "task.enableLsp",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "LSP in Subagents",
		description:
			"Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.",
	},
});

export const cfgTaskMaxRecursionDepth = register({
	id: "task.maxRecursionDepth",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 2,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Max Task Recursion",
		description: "How many levels deep subagents can spawn their own subagents",
		options: [
			{ value: "-1", label: "Unlimited" },
			{ value: "0", label: "None" },
			{ value: "1", label: "Single" },
			{ value: "2", label: "Double" },
			{ value: "3", label: "Triple" },
		],
	},
});

export const cfgTaskMaxRuntimeMs = register({
	id: "task.maxRuntimeMs",
	type: "number",
	default: 0,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Max Subagent Runtime",
		description:
			"Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.",
		options: [
			{ value: "0", label: "Unlimited", description: "Default" },
			{ value: "300000", label: "5 minutes" },
			{ value: "900000", label: "15 minutes" },
			{ value: "1800000", label: "30 minutes" },
			{ value: "3600000", label: "1 hour" },
		],
	},
});

export const cfgTaskAgentIdleTtlMs = register({
	id: "task.agentIdleTtlMs",
	type: "number",
	default: 420_000,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Agent Idle TTL",
		description:
			"How long an idle subagent stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit.",
	},
});

export const cfgTaskSoftRequestBudget = register({
	id: "task.softRequestBudget",
	type: "number",
	default: 200,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Soft Subagent Request Budget",
		description:
			"Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see task.softRequestBudgetNotice); at 1.5x the budget the run is force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled scout/sonic agents cap out at a lower built-in budget, so a value below that cap still applies to them.",
		options: [
			{ value: "0", label: "Disabled" },
			{ value: "90", label: "90 requests" },
			{ value: "150", label: "150 requests" },
			{ value: "200", label: "200 requests", description: "Default" },
		],
	},
});

export const cfgTaskSoftRequestBudgetNotice = register({
	id: "task.softRequestBudgetNotice",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Soft Request Budget Notice",
		description:
			"Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop.",
	},
});

export const cfgTaskMaxEffort = register({
	id: "task.maxEffort",
	type: "enum",
	values: THINKING_EFFORTS,
	default: "max",
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Maximum Per-Spawn Effort",
		description:
			"Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values prevent callers from escalating subagents above this ceiling; the default preserves the model's full range.",
		options: THINKING_EFFORTS.map(getThinkingLevelMetadata),
	},
});

export const cfgTaskDisabledAgents = register({
	id: "task.disabledAgents",
	protocolDefault: ["rpc", "acp"],
	type: "array",
	default: [] as string[],
});

export const cfgTaskAgentModelOverrides = register({
	id: "task.agentModelOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: DEFAULT_AGENT_MODEL_OVERRIDES,
});

export const cfgTaskAgentServiceTierOverrides = register({
	id: "task.agentServiceTierOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: EMPTY_AGENT_SERVICE_TIER_OVERRIDES,
	validate: validateAgentServiceTierOverrides,
});

export const cfgTaskAgentCompactionThresholdOverrides = register({
	id: "task.agentCompactionThresholdOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: EMPTY_AGENT_COMPACTION_THRESHOLD_OVERRIDES,
	validate: validateAgentCompactionThresholdOverrides,
});

export const cfgTaskAgentPrewalk = register({
	id: "task.agentPrewalk",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: {} as Record<string, string>,
});

export const cfgTaskAgentAdvisor = register({
	id: "task.agentAdvisor",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: {} as Record<string, string>,
});

export const cfgTaskPrewalk = register({
	id: "task.prewalk",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Generic Task Prewalk",
		description:
			"Arm prewalk for the bundled generic `task` subagent: it starts on its resolved model, plans and begins the implementation, then hands off to the 'smol' role at its first edit/write. Per-agent overrides (task.agentPrewalk, configured from the /agents hub) and user agent `prewalk` frontmatter apply regardless of this toggle.",
	},
});

export const cfgTaskShowResolvedModelBadge = register({
	id: "task.showResolvedModelBadge",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Show Resolved Model Badge",
		description: "Display the actual model ID used by each subagent in the task widget status line",
	},
});
effect(cfgTaskShowResolvedModelBadge, setFeedModelBadgeEnabled);
