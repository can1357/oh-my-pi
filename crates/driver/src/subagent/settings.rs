//! Typed settings owned and consumed by the subagent runtime.

use std::collections::BTreeMap;

use omp_con::{CfgLoader, Ctx, Kv, Value};
use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

/// Prompt pressure applied to task delegation.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	strum::VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum TaskEagerMode {
	/// Model chooses when delegation helps.
	#[default]
	Default,
	/// Prompt recommends delegation when work decomposes.
	Preferred,
	/// First-turn guidance requires delegation.
	Always,
}

/// Maximum caller-selectable reasoning effort for a subagent.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	strum::VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum TaskEffortCeiling {
	/// Minimal reasoning.
	Minimal,
	/// Low reasoning.
	Low,
	/// Medium reasoning.
	Medium,
	/// High reasoning.
	High,
	/// Extra-high reasoning.
	Xhigh,
	/// Preserve the model's maximum available reasoning.
	#[default]
	Max,
}

/// Environment-owned isolation backend selected for child workspaces.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	strum::VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum TaskIsolationMode {
	/// Run in the parent workspace.
	#[default]
	None,
	/// Let Environment select the best native backend.
	Auto,
	/// APFS clonefile isolation.
	Apfs,
	/// Btrfs subvolume isolation.
	Btrfs,
	/// ZFS clone isolation.
	Zfs,
	/// Native reflink isolation.
	Reflink,
	/// Linux overlay filesystem isolation.
	Overlayfs,
	/// Windows projected filesystem isolation.
	Projfs,
	/// Windows block-clone isolation.
	BlockClone,
	/// Git worktree or recursive-copy fallback.
	Rcopy,
}

/// Merge strategy for a successful isolated child workspace.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	strum::VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum TaskIsolationMerge {
	/// Apply a content-addressed patch.
	#[default]
	Patch,
	/// Merge a retained branch.
	Branch,
}

omp_con::con_enum!(TaskEagerMode);
omp_con::con_enum!(TaskEffortCeiling);
omp_con::con_enum!(TaskIsolationMode);
omp_con::con_enum!(TaskIsolationMerge);

omp_con::var! {
	/// Current child depth, seeded into descendants and advanced by the spawner.
	pub static SV_TASK_RECURSION_DEPTH = sv_task_recursion_depth: u32 {
		default: 0,
		flags: session,
	};
	/// How many levels deep subagents can spawn their own subagents.
	pub static SV_TASK_MAX_RECURSION_DEPTH = sv_task_max_recursion_depth: i32 {
		default: 2,
		min: -1,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Subagents",
			"ui.label": "Max Task Recursion",
			"ui.option.-1": "Unlimited",
			"ui.option.0": "None",
			"ui.option.1": "Single",
			"ui.option.2": "Double",
			"ui.option.3": "Triple",
			"legacy.path": "task.maxRecursionDepth",
		},
	};
	/// Maximum number of subagents running concurrently.
	pub static SV_TASK_MAX_CONCURRENCY = sv_task_max_concurrency: u32 {
		default: 32,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Subagents",
			"ui.label": "Max Concurrent Tasks",
			"ui.option.0": "Unlimited",
			"ui.option.1": "1 task",
			"ui.option.2": "2 tasks",
			"ui.option.4": "4 tasks",
			"ui.option.8": "8 tasks",
			"ui.option.16": "16 tasks",
			"ui.option.32": "32 tasks",
			"ui.option.64": "64 tasks",
			"legacy.path": "task.maxConcurrency",
		},
	};
	/// Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against
	/// provider-side stream hangs that escape the inference-layer watchdog; triggers a normal
	/// subagent abort with a 'timed out' reason.
	pub static SV_TASK_MAX_RUNTIME = sv_task_max_runtime: omp_con::Span {
		default: omp_con::Span::Never,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Subagents",
			"ui.label": "Max Subagent Runtime",
			"ui.unit": "ms",
			"ui.option.never": "Unlimited",
			"ui.option.never.desc": "Default",
			"ui.option.5m": "5 minutes",
			"ui.option.15m": "15 minutes",
			"ui.option.30m": "30 minutes",
			"ui.option.1h": "1 hour",
			"legacy.path": "task.maxRuntimeMs",
		},
	};
	/// Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up
	/// steering notice (see task.softRequestBudgetNotice); at 1.5x the budget the run is
	/// force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled
	/// scout/sonic agents cap out at a lower built-in budget, so a value below that cap still
	/// applies to them.
	pub static SV_TASK_SOFT_REQUEST_BUDGET = sv_task_soft_request_budget: u32 {
		default: 200,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Subagents",
			"ui.label": "Soft Subagent Request Budget",
			"ui.option.0": "Disabled",
			"ui.option.90": "90 requests",
			"ui.option.150": "150 requests",
			"ui.option.200": "200 requests",
			"ui.option.200.desc": "Default",
			"legacy.path": "task.softRequestBudget",
		},
	};
	/// Inject one steering notice when a subagent crosses its soft request budget, asking it to
	/// wrap up before the 1.5x forced-yield stop.
	pub static SV_TASK_SOFT_REQUEST_BUDGET_NOTICE = sv_task_soft_request_budget_notice: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Subagents",
			"ui.label": "Soft Request Budget Notice",
			"legacy.path": "task.softRequestBudgetNotice",
		},
	};
	/// Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values
	/// prevent callers from escalating subagents above this ceiling; the default preserves the
	/// model's full range.
	pub static SV_TASK_MAX_EFFORT = sv_task_max_effort: TaskEffortCeiling {
		default: TaskEffortCeiling::Max,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Subagents",
			"ui.label": "Maximum Per-Spawn Effort",
			"ui.option.minimal": "min",
			"ui.option.minimal.desc": "Very brief reasoning (~1k tokens)",
			"ui.option.low": "low",
			"ui.option.low.desc": "Light reasoning (~2k tokens)",
			"ui.option.medium": "medium",
			"ui.option.medium.desc": "Moderate reasoning (~8k tokens)",
			"ui.option.high": "high",
			"ui.option.high.desc": "Deep reasoning (~16k tokens)",
			"ui.option.xhigh": "xhigh",
			"ui.option.xhigh.desc": "Extended reasoning (~32k tokens)",
			"ui.option.max": "max",
			"ui.option.max.desc": "Maximum reasoning the model supports",
			"legacy.path": "task.maxEffort",
		},
	};
	/// How strongly to push delegating work to subagents.
	pub static SV_TASK_EAGER = sv_task_eager: TaskEagerMode {
		default: TaskEagerMode::Default,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Subagents",
			"ui.label": "Prefer Task Delegation",
			"ui.option.default": "Default",
			"ui.option.default.desc": "Uses the selected model's policy; some models require an explicit delegation request",
			"ui.option.preferred": "Preferred",
			"ui.option.preferred.desc": "Adds delegation guidance to the system prompt",
			"ui.option.always": "Always",
			"ui.option.always.desc": "Prompt guidance plus a first-turn delegation reminder",
			"legacy.path": "task.eager",
		},
	};
	/// Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep
	/// subagents cheap; enable when LSP-aware delegation is worth the extra tokens.
	pub static SV_TASK_ENABLE_LSP = sv_task_enable_lsp: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Subagents",
			"ui.label": "LSP in Subagents",
			"legacy.path": "task.enableLsp",
		},
	};
	/// Idle interval before a child loop is parked.
	pub static SV_TASK_AGENT_IDLE_TTL = sv_task_agent_idle_ttl: omp_con::Span {
		default: omp_con::Span::Finite(omp_core::Duration::new(
			420,
			omp_core::DurationUnit::Seconds,
		)),
		flags: archive,
	};
	/// Agent definitions excluded from spawn resolution.
	pub static SV_TASK_DISABLED_AGENTS = sv_task_disabled_agents: Vec<Str> {
		default: Vec::new(),
		flags: archive,
	};
	/// Definition-specific model-role overrides.
	pub static SV_TASK_AGENT_MODEL_OVERRIDES = sv_task_agent_model_overrides: Kv {
		default: Kv::default(),
		flags: archive,
	};
	/// Definition-specific prewalk-role overrides.
	pub static SV_TASK_AGENT_PREWALK = sv_task_agent_prewalk: Kv {
		default: Kv::default(),
		flags: archive,
	};
	/// Definition-specific advisor-role overrides.
	pub static SV_TASK_AGENT_ADVISOR = sv_task_agent_advisor: Kv {
		default: Kv::default(),
		flags: archive,
	};
	/// Backend used for subagent isolation and worktree cloning.
	pub static SV_TASK_ISOLATION_MODE = sv_task_isolation_mode: TaskIsolationMode {
		default: TaskIsolationMode::None,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Isolation",
			"ui.label": "Isolation Backend",
			"ui.option.none": "Disabled",
			"ui.option.auto": "Auto",
			"ui.option.auto.desc": "Let the environment pick the best available backend",
			"ui.option.apfs": "APFS",
			"ui.option.apfs.desc": "macOS clonefile reflink (APFS)",
			"ui.option.btrfs": "btrfs",
			"ui.option.btrfs.desc": "btrfs subvolume snapshot",
			"ui.option.zfs": "ZFS",
			"ui.option.zfs.desc": "ZFS snapshot + clone",
			"ui.option.reflink": "Reflink",
			"ui.option.reflink.desc": "Linux FICLONE per-file reflink",
			"ui.option.overlayfs": "Overlayfs",
			"ui.option.overlayfs.desc": "Linux kernel overlay (or fuse-overlayfs fallback)",
			"ui.option.projfs": "ProjFS",
			"ui.option.projfs.desc": "Windows Projected File System",
			"ui.option.block-clone": "Block clone",
			"ui.option.block-clone.desc": "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
			"ui.option.rcopy": "Recursive copy",
			"ui.option.rcopy.desc": "git worktree if available, otherwise recursive copy",
			"legacy.path": "task.isolation.enabled",
			"legacy.path": "isolation.backend",
		},
	};
	/// Automatically apply successful isolated task changes to the parent checkout; disable to
	/// retain patch or branch artifacts.
	pub static SV_TASK_ISOLATION_APPLY = sv_task_isolation_apply: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Isolation",
			"ui.label": "Apply Isolated Changes",
			"legacy.path": "task.isolation.apply",
		},
	};
	/// How isolated task changes are integrated (patch apply or branch merge).
	pub static SV_TASK_ISOLATION_MERGE = sv_task_isolation_merge: TaskIsolationMerge {
		default: TaskIsolationMerge::Patch,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Isolation",
			"ui.label": "Isolation Merge Strategy",
			"ui.option.patch": "Patch",
			"ui.option.patch.desc": "Combine diffs and git apply",
			"ui.option.branch": "Branch",
			"ui.option.branch.desc": "Commit per task, merge with --no-ff",
			"legacy.path": "task.isolation.merge",
		},
	};
	/// Shows the selected agent-definition badge in task output.
	pub static CL_TASK_SHOW_AGENT_BADGE = cl_task_show_agent_badge: bool {
		default: true,
		flags: archive,
	};
	/// Display the actual model ID used by each subagent in the task widget status line.
	pub static CL_TASK_SHOW_RESOLVED_MODEL_BADGE = cl_task_show_resolved_model_badge: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Display",
			"ui.label": "Show Resolved Model Badge",
			"legacy.path": "task.showResolvedModelBadge",
		},
	};
	/// Default timeout for hub message waits (and send await:true) in milliseconds; 0 disables the
	/// timeout.
	pub static SV_IRC_TIMEOUT = sv_irc_timeout: omp_con::Span {
		default: omp_con::Span::Finite(omp_core::Duration::new(
			120,
			omp_core::DurationUnit::Seconds,
		)),
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Execution",
			"ui.label": "IRC Timeout",
			"ui.unit": "ms",
			"ui.option.never": "Disabled",
			"ui.option.30s": "30 seconds",
			"ui.option.1m": "1 minute",
			"ui.option.2m": "2 minutes",
			"ui.option.5m": "5 minutes",
			"legacy.path": "irc.timeoutMs",
		},
	};
	/// Relays peer-to-peer messages to the main transcript.
	pub static CL_IRC_RELAY_TO_MAIN = cl_irc_relay_to_main: bool {
		default: true,
		flags: archive,
	};
}

/// Child workspace isolation defaults.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct TaskIsolationSettings {
	/// Backend selection.
	pub mode:  TaskIsolationMode,
	/// Apply successful changes automatically.
	pub apply: bool,
	/// Merge strategy.
	pub merge: TaskIsolationMerge,
}

impl Default for TaskIsolationSettings {
	fn default() -> Self {
		Self { mode: TaskIsolationMode::None, apply: true, merge: TaskIsolationMerge::Patch }
	}
}

/// Complete typed projection consumed by subagent admission and new spawns.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskSettings {
	/// Maximum recursive child depth; `-1` is unlimited.
	pub max_recursion_depth: i16,
	/// Active child run ceiling; `0` is unlimited.
	pub max_concurrency: usize,
	/// Per-run wall-clock cap in milliseconds; `0` disables it.
	pub max_runtime_ms: u64,
	/// Soft assistant-request budget; `0` disables it.
	pub soft_request_budget: u32,
	/// Emit one wrap-up notice when the soft budget is crossed.
	pub soft_request_budget_notice: bool,
	/// Maximum caller-selectable reasoning effort.
	pub max_effort: TaskEffortCeiling,
	/// Delegation prompt pressure.
	pub eager: TaskEagerMode,
	/// Explicitly grant LSP to children; false by default.
	pub enable_lsp: bool,
	/// Idle live-loop TTL before parking; `0` keeps loops loaded.
	pub agent_idle_ttl_ms: u64,
	/// Agent definitions excluded from spawn resolution.
	pub disabled_agents: Vec<Str>,
	/// Case-insensitive definition-to-model override map.
	pub agent_model_overrides: BTreeMap<Str, Str>,
	/// Definition-specific prewalk role overrides.
	pub agent_prewalk: BTreeMap<Str, Str>,
	/// Definition-specific advisor role overrides.
	pub agent_advisor: BTreeMap<Str, Str>,
	/// Child workspace isolation defaults.
	pub isolation: TaskIsolationSettings,
	/// Show the selected agent-definition badge in task output.
	pub show_agent_badge: bool,
	/// Show the serving model rather than only the requested role.
	pub show_resolved_model_badge: bool,
}

impl Default for TaskSettings {
	fn default() -> Self {
		Self {
			max_recursion_depth: 2,
			max_concurrency: 32,
			max_runtime_ms: 0,
			soft_request_budget: 200,
			soft_request_budget_notice: true,
			max_effort: TaskEffortCeiling::Max,
			eager: TaskEagerMode::Default,
			enable_lsp: false,
			agent_idle_ttl_ms: 420_000,
			disabled_agents: Vec::new(),
			agent_model_overrides: BTreeMap::new(),
			agent_prewalk: BTreeMap::new(),
			agent_advisor: BTreeMap::new(),
			isolation: TaskIsolationSettings::default(),
			show_agent_badge: true,
			show_resolved_model_badge: false,
		}
	}
}

impl TaskSettings {
	/// Resolves the effective subagent policy from the process console context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			max_recursion_depth: i16::try_from(SV_TASK_MAX_RECURSION_DEPTH.get(ctx))
				.unwrap_or(i16::MAX),
			max_concurrency: usize::try_from(SV_TASK_MAX_CONCURRENCY.get(ctx)).unwrap_or(usize::MAX),
			max_runtime_ms: span_millis(SV_TASK_MAX_RUNTIME.get(ctx)),
			soft_request_budget: SV_TASK_SOFT_REQUEST_BUDGET.get(ctx),
			soft_request_budget_notice: SV_TASK_SOFT_REQUEST_BUDGET_NOTICE.get(ctx),
			max_effort: SV_TASK_MAX_EFFORT.get(ctx),
			eager: SV_TASK_EAGER.get(ctx),
			enable_lsp: SV_TASK_ENABLE_LSP.get(ctx),
			agent_idle_ttl_ms: span_millis(SV_TASK_AGENT_IDLE_TTL.get(ctx)),
			disabled_agents: SV_TASK_DISABLED_AGENTS.get(ctx),
			agent_model_overrides: string_map(SV_TASK_AGENT_MODEL_OVERRIDES.get(ctx)),
			agent_prewalk: string_map(SV_TASK_AGENT_PREWALK.get(ctx)),
			agent_advisor: string_map(SV_TASK_AGENT_ADVISOR.get(ctx)),
			isolation: TaskIsolationSettings {
				mode:  SV_TASK_ISOLATION_MODE.get(ctx),
				apply: SV_TASK_ISOLATION_APPLY.get(ctx),
				merge: SV_TASK_ISOLATION_MERGE.get(ctx),
			},
			show_agent_badge: CL_TASK_SHOW_AGENT_BADGE.get(ctx),
			show_resolved_model_badge: CL_TASK_SHOW_RESOLVED_MODEL_BADGE.get(ctx),
		}
	}

	/// Whether an agent at `depth` may not spawn children: its `task` tool is
	/// withheld rather than advertised and refused.
	#[must_use]
	pub fn at_recursion_limit(&self, depth: u32) -> bool {
		self.max_recursion_depth >= 0
			&& depth >= u32::try_from(self.max_recursion_depth).unwrap_or(u32::MAX)
	}
}

/// Whether the kernel composed for `ctx` sits at the configured recursion
/// limit and must not receive `task@1`.
#[must_use]
pub fn task_withheld(ctx: &Ctx) -> bool {
	TaskSettings::from_con(ctx).at_recursion_limit(SV_TASK_RECURSION_DEPTH.get(ctx))
}

fn span_millis(span: omp_con::Span) -> u64 {
	span
		.to_std()
		.map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
		.unwrap_or(0)
}

fn string_map(values: Kv) -> BTreeMap<Str, Str> {
	values
		.0
		.into_iter()
		.filter_map(|(name, value)| match value {
			Value::Str(value) | Value::Enum(value) => Some((name, value)),
			_ => None,
		})
		.collect()
}

/// Creates a child console context in ADR 0013 order: the parent's live
/// effective picture (every variable, engagement binds included), then
/// `subagent.cfg`, then `<agent>.cfg`. `config.cfg` is deliberately not
/// re-read: the parent already applied it, and re-running it would let a
/// stale archived value override what the parent changed since startup.
/// Whatever the spawner sets explicitly comes after this call.
pub fn child_ctx(
	parent: &Ctx,
	loader: &dyn CfgLoader,
	agent: &str,
) -> Result<Ctx, omp_con::ConError> {
	let seed = parent.seed_child();
	let child = Ctx::new();
	let (dynamic_vars, values) = seed.into_parts();
	for spec in dynamic_vars {
		child.register_dynamic_var(spec)?;
	}
	for (name, value) in values {
		child.set_value(name.as_str(), value, omp_con::SetSource::Code)?;
	}
	let outcome = child.exec_spawn_configs(loader, agent)?;
	if outcome.failed > 0 {
		tracing::warn!(
			agent,
			failed = outcome.failed,
			"child cfg contained statements this build does not understand; they were skipped"
		);
	}
	Ok(child)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn task_is_withheld_only_at_the_configured_recursion_ceiling() {
		let ctx = Ctx::new();
		SV_TASK_MAX_RECURSION_DEPTH.set(&ctx, 2).expect("ceiling");
		SV_TASK_RECURSION_DEPTH.set(&ctx, 1).expect("depth");
		assert!(!task_withheld(&ctx), "one level below the ceiling may still delegate");
		SV_TASK_RECURSION_DEPTH.set(&ctx, 2).expect("depth");
		assert!(task_withheld(&ctx), "a child at the ceiling never sees `task`");
		SV_TASK_MAX_RECURSION_DEPTH
			.set(&ctx, -1)
			.expect("unlimited");
		assert!(!task_withheld(&ctx), "-1 is unlimited");
	}
}
