//! Environment-host projection of the typed command-stream control context.
//!
//! The host enforces its tool, runtime, worktree, memory, and autolearn policy
//! from one immutable `from_con` projection at composition time.

use std::{fmt, path::PathBuf};

use omp_con::Ctx;
use omp_core::{Duration, DurationError, Str};
use omp_memory::config::{AutolearnSettings, MemorySettings, MnemopiSettings};
use omp_tool::DEFAULT_INTERRUPT_GRACE;
use serde::{
	Deserialize, Deserializer, Serialize, Serializer,
	de::{self, Visitor},
};

use super::tool_settings::ToolSettings;

/// Memory backend value exposed by the command stream.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "kebab-case")]
pub enum MemoryBackendSetting {
	/// Disable durable memory.
	#[default]
	Off,
	/// Use Mnemopi durable memory.
	Mnemopi,
}

omp_con::con_enum!(MemoryBackendSetting);

/// Mnemopi bank scope exposed by the command stream.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "kebab-case")]
pub enum BankScopingSetting {
	/// Use one global bank.
	Global,
	/// Use one canonical-project bank.
	#[default]
	PerProject,
	/// Recall from project and shared banks.
	PerProjectTagged,
}

omp_con::con_enum!(BankScopingSetting);

omp_con::var! {
	/// Courtesy interval before forced interruption.
	pub static SV_INTERRUPT_GRACE = sv_interrupt_grace: Duration {
		default: DEFAULT_INTERRUPT_GRACE,
		flags: archive,
		meta: {
			"legacy.path": "runtime.interrupt_grace",
		},
	};
	/// Select the durable memory backend.
	pub static AI_MEMORY_BACKEND = ai_memory_backend: MemoryBackendSetting {
		default: MemoryBackendSetting::Off,
		flags: archive,
		meta: {
			"ui.tab": "memory",
			"ui.group": "General",
			"ui.label": "Memory Backend",
			"ui.option.off": "Off",
			"ui.option.off.desc": "No memory subsystem runs",
			"ui.option.mnemopi": "Mnemopi",
			"ui.option.mnemopi.desc": "Local SQLite recall/retain backend with optional embeddings",
			"legacy.path": "memory.backend",
		},
	};
	/// Choose canonical-project and shared-bank recall policy.
	pub static AI_MNEMOPI_SCOPING = ai_mnemopi_scoping: BankScopingSetting {
		default: BankScopingSetting::PerProject,
		flags: archive,
		meta: {
			"ui.tab": "memory",
			"ui.group": "Mnemopi",
			"ui.label": "Mnemopi Scoping",
			"ui.when": "ai_memory_backend=mnemopi",
			"ui.option.global": "Global",
			"ui.option.global.desc": "One shared Mnemopi bank for every project",
			"ui.option.per-project": "Per project",
			"ui.option.per-project.desc": "Project-local Mnemopi bank per cwd basename",
			"ui.option.per-project-tagged": "Per project (tagged)",
			"ui.option.per-project-tagged.desc": "Write to a project-local bank but merge project + shared recall results",
			"legacy.path": "mnemopi.scoping",
		},
	};
	/// After the agent stops, nudge it to capture lessons to memory and create or enhance isolated managed skills.
	pub static AI_AUTOLEARN_ENABLED = ai_autolearn_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "memory",
			"ui.group": "Auto-Learn",
			"ui.label": "Auto-Learn (experimental)",
			"legacy.path": "autolearn.enabled",
		},
	};
	/// Auto-run one private capture turn at stop; this uses extra tokens.
	pub static AI_AUTOLEARN_AUTO_CONTINUE = ai_autolearn_auto_continue: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "memory",
			"ui.group": "Auto-Learn",
			"ui.label": "Auto-run capture at stop",
			"ui.when": "ai_autolearn_enabled=true",
			"legacy.path": "autolearn.auto_continue",
			"legacy.path": "autolearn.autoContinue",
		},
	};
	/// Minimum settled tool executions required in one primary turn.
	pub static AI_AUTOLEARN_MIN_TOOL_CALLS = ai_autolearn_min_tool_calls: i64 {
		default: 5,
		min: 0,
		flags: archive,
		meta: {
			"legacy.path": "autolearn.min_tool_calls",
		},
	};
	/// Base directory for agent-managed worktrees; empty selects ~/.omp/wt and OMP_WORKTREE_DIR overrides it.
	pub static SV_WORKTREE_BASE = sv_worktree_base: Str {
		default: Str::default(),
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Isolation",
			"ui.label": "Worktree Base Directory",
			"legacy.path": "worktree.base",
		},
	};
}

/// Runtime durations shared by the agent, eval, and extension-host control
/// planes.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RuntimeDurations {
	/// Courtesy interval between cooperative cancellation and forced
	/// interruption.
	#[serde(with = "nonzero_duration")]
	pub interrupt_grace: Duration,
}

impl Default for RuntimeDurations {
	fn default() -> Self {
		Self { interrupt_grace: DEFAULT_INTERRUPT_GRACE }
	}
}

/// Placement policy for Environment-owned isolated worktrees.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorktreeSettings {
	/// Optional base directory. `OMP_WORKTREE_DIR` takes precedence.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub base: Option<PathBuf>,
}

/// Settings the environment host reads without owning the client aggregate.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HostSettings {
	/// Model key selected as the default, used to pin the edit dialect.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub default_model: Option<String>,
	/// Runtime timeout and cancellation settings.
	#[serde(default)]
	pub runtime:       RuntimeDurations,
	/// Built-in tool exposure and execution timeout policy.
	#[serde(default)]
	pub tools:         ToolSettings,
	/// Default-off memory backend selector.
	#[serde(default)]
	pub memory:        MemorySettings,
	/// Mnemopi-specific durable bank and lifecycle settings.
	#[serde(default)]
	pub mnemopi:       MnemopiSettings,
	/// Automatic-learning capture settings.
	#[serde(default)]
	pub autolearn:     AutolearnSettings,
	/// Isolated worktree placement policy.
	#[serde(default)]
	pub worktree:      WorktreeSettings,
}

impl HostSettings {
	/// Resolves host policy from the process control context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		let mut settings = Self::default();
		settings.default_model = omp_catalog::settings::ModelSettings::from_con(ctx)
			.role_selector("default")
			.map(ToString::to_string);
		settings.runtime.interrupt_grace = SV_INTERRUPT_GRACE.get(ctx);
		settings.tools = ToolSettings::from_con(ctx);
		settings.memory.backend = match AI_MEMORY_BACKEND.get(ctx) {
			MemoryBackendSetting::Off => omp_memory::MemoryBackend::Off,
			MemoryBackendSetting::Mnemopi => omp_memory::MemoryBackend::Mnemopi,
		};
		let db_path = omp_ai::settings::AI_MNEMOPI_DB_PATH.get(ctx);
		settings.mnemopi.db_path =
			(!db_path.trim().is_empty()).then(|| PathBuf::from(db_path.as_str()));
		settings.mnemopi.scoping = match AI_MNEMOPI_SCOPING.get(ctx) {
			BankScopingSetting::Global => omp_memory::config::BankScoping::Global,
			BankScopingSetting::PerProject => omp_memory::config::BankScoping::PerProject,
			BankScopingSetting::PerProjectTagged => omp_memory::config::BankScoping::PerProjectTagged,
		};
		settings.autolearn = AutolearnSettings {
			enabled:        AI_AUTOLEARN_ENABLED.get(ctx),
			auto_continue:  AI_AUTOLEARN_AUTO_CONTINUE.get(ctx),
			min_tool_calls: AI_AUTOLEARN_MIN_TOOL_CALLS.get(ctx) as usize,
		};
		settings.worktree.base = {
			let base = SV_WORKTREE_BASE.get(ctx);
			(!base.is_empty()).then(|| PathBuf::from(base.as_str()))
		};
		settings.mnemopi = settings.mnemopi.normalize();
		settings
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn host_settings_project_from_con() {
		let ctx = Ctx::new();
		let grace: Duration = "750ms".parse().expect("duration");
		SV_INTERRUPT_GRACE
			.set(&ctx, grace)
			.expect("set interrupt grace");
		AI_MEMORY_BACKEND
			.set(&ctx, MemoryBackendSetting::Mnemopi)
			.expect("set memory backend");
		AI_AUTOLEARN_MIN_TOOL_CALLS
			.set(&ctx, 9)
			.expect("set threshold");
		omp_ai::settings::AI_MNEMOPI_DB_PATH
			.set(&ctx, Str::new_static("/tmp/mnemopi.sqlite"))
			.expect("set Mnemopi database");
		let settings = HostSettings::from_con(&ctx);
		assert_eq!(settings.runtime.interrupt_grace, grace);
		assert_eq!(settings.memory.backend, omp_memory::MemoryBackend::Mnemopi);
		assert_eq!(settings.autolearn.min_tool_calls, 9);
		assert_eq!(
			settings.mnemopi.db_path.as_deref(),
			Some(std::path::Path::new("/tmp/mnemopi.sqlite"))
		);
	}
}

mod nonzero_duration {
	use super::*;

	pub fn serialize<S>(value: &Duration, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		serializer.collect_str(value)
	}

	pub fn deserialize<'de, D>(deserializer: D) -> Result<Duration, D::Error>
	where
		D: Deserializer<'de>,
	{
		deserializer.deserialize_str(DurationVisitor)
	}

	struct DurationVisitor;

	impl Visitor<'_> for DurationVisitor {
		type Value = Duration;

		fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
			formatter.write_str("a positive integer duration with an explicit ns/us/ms/s/m/h unit")
		}

		fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
		where
			E: de::Error,
		{
			let duration = value.parse::<Duration>().map_err(E::custom)?;
			if duration.value() == 0 {
				return Err(E::custom("duration must be greater than zero"));
			}
			let standard = duration.to_std().map_err(|error| match error {
				DurationError::Overflow => E::custom("duration is too large"),
				other => E::custom(other),
			})?;
			i64::try_from(standard.as_nanos())
				.map_err(|_| E::custom("duration is too large for telemetry serialization"))?;
			Ok(duration)
		}
	}
}
