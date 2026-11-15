//! Native shell profile, interception, and direnv settings.

use omp_con::{Ctx, Kv, Value};
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize};

/// Whether the nearest allowed direnv environment is loaded.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum DirenvMode {
	/// Load only an `.envrc` accepted by direnv's own allow list.
	#[default]
	Auto,
	/// Never run direnv preflight.
	Off,
}

omp_con::con_enum!(DirenvMode);

/// One configurable shell-intent interception rule.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct InterceptorRule {
	/// Regular expression applied to an admitted shell segment.
	pub pattern: Str,
	/// Live sibling tool which must exist before this rule is active.
	pub tool:    Str,
	/// Model-facing guidance returned instead of executing the command.
	pub message: Str,
}

/// Automatic backgrounding policy for long shell calls.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AutoBackgroundSettings {
	/// Whether eligible calls may detach after the foreground threshold.
	pub enabled:      bool,
	/// Foreground duration before detachment is attempted.
	pub threshold_ms: u64,
}

impl Default for AutoBackgroundSettings {
	fn default() -> Self {
		Self { enabled: true, threshold_ms: 60_000 }
	}
}

/// Shell-intent interception policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct InterceptorSettings {
	/// Whether matching commands return dedicated-tool guidance.
	pub enabled:  bool,
	/// Ordered rules evaluated against admitted command segments.
	pub patterns: Vec<InterceptorRule>,
}

impl Default for InterceptorSettings {
	fn default() -> Self {
		Self { enabled: false, patterns: default_interceptor_rules() }
	}
}

omp_con::var! {
	/// Enable the bash tool for shell command execution.
	pub static SV_SHELL_ENABLED = sv_shell_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "shell",
			"ui.group": "Bash",
			"ui.label": "Bash",
			"legacy.path": "bash.enabled",
		},
	};
	/// Wrapper placed before every admitted shell command; empty disables the wrapper.
	pub static SV_SHELL_COMMAND_PREFIX = sv_shell_command_prefix: Str {
		default: Str::default(),
		flags: archive,
	};
	/// Advertise and enable the embedded builtin command set.
	pub static SV_SHELL_EMBEDDED_BUILTINS = sv_shell_embedded_builtins: bool {
		default: true,
		flags: archive,
	};
	/// Opt-in utility builtins to register in agent shell sessions and detached process scripts,
	/// by name, or `all` for every name this build offers. Each shadows the system command of
	/// the same name, so none is registered by default. `sv_shell_embedded_builtins = false`
	/// suppresses them. Read when a shell is constructed. Deliberately not `PROJECT`: a
	/// repository must not decide whether a command is shadowed (ADR 0054 D2).
	pub static SV_SHELL_BUILTINS_EXTRA = sv_shell_builtins_extra: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_extra_builtins(values),
		flags: archive,
	};
	/// Automatically background long-running bash commands and deliver the result later.
	pub static SV_SHELL_AUTO_BACKGROUND_ENABLED = sv_shell_auto_background_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "shell",
			"ui.group": "Bash",
			"ui.label": "Bash Auto-Background",
			"legacy.path": "bash.autoBackground.enabled",
		},
	};
	/// Foreground milliseconds before eligible shell execution detaches.
	pub static SV_SHELL_AUTO_BACKGROUND_THRESHOLD_MS = sv_shell_auto_background_threshold_ms: i64 {
		default: 60_000,
		min: 0,
		flags: archive,
		meta: {
			"legacy.path": "bash.autoBackground.thresholdMs",
		},
	};
	/// Block shell commands that have dedicated tools.
	pub static SV_SHELL_INTERCEPTOR_ENABLED = sv_shell_interceptor_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "shell",
			"ui.group": "Bash",
			"ui.label": "Bash Interceptor",
			"legacy.path": "bashInterceptor.enabled",
		},
	};
	/// Ordered regular-expression rules gated by live sibling tools.
	pub static SV_SHELL_INTERCEPTOR_PATTERNS = sv_shell_interceptor_patterns: Vec<Kv> {
		default: default_interceptor_kv(),
		flags: archive,
		meta: {
			"legacy.path": "bashInterceptor.patterns",
		},
	};
	/// Auto-load a repo's allowed direnv/devenv `.envrc` into the bash session.
	pub static SV_SHELL_DIRENV = sv_shell_direnv: DirenvMode {
		default: DirenvMode::Auto,
		flags: archive,
		meta: {
			"ui.tab": "shell",
			"ui.group": "Bash",
			"ui.label": "direnv Auto-Load",
			"ui.option.auto": "Auto",
			"ui.option.off": "Off",
			"legacy.path": "bash.direnv",
		},
	};
	/// Max wait for the first `direnv export`; on timeout the session runs without the direnv env.
	pub static SV_SHELL_DIRENV_LOAD_TIMEOUT_MS = sv_shell_direnv_load_timeout_ms: i64 {
		default: 30_000,
		min: 1,
		flags: archive,
		meta: {
			"ui.tab": "shell",
			"ui.group": "Bash",
			"ui.label": "direnv Load Timeout (ms)",
			"ui.unit": "ms",
			"legacy.path": "bash.direnvLoadTimeoutMs",
		},
	};
}

/// Complete immutable settings projection consumed by shell construction.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ShellSettings {
	/// Whether the shell tool is registered.
	pub enabled:                bool,
	/// Wrapper placed before each admitted command.
	pub command_prefix:         Option<Str>,
	/// Whether embedded shell builtins are advertised and enabled.
	pub embedded_builtins:      bool,
	/// Opt-in utility builtin names requested by `sv_shell_builtins_extra`,
	/// before the `embedded_builtins` master switch applies; read them through
	/// [`ShellSettings::extra_builtins`].
	pub builtins_extra:         Vec<Str>,
	/// Long-call detachment policy.
	pub auto_background:        AutoBackgroundSettings,
	/// Dedicated-tool interception policy.
	pub interceptor:            InterceptorSettings,
	/// direnv loading mode.
	pub direnv:                 DirenvMode,
	/// Maximum direnv preflight duration.
	pub direnv_load_timeout_ms: u64,
}

impl Default for ShellSettings {
	fn default() -> Self {
		Self {
			enabled:                true,
			command_prefix:         None,
			embedded_builtins:      true,
			builtins_extra:         Vec::new(),
			auto_background:        AutoBackgroundSettings::default(),
			interceptor:            InterceptorSettings::default(),
			direnv:                 DirenvMode::Auto,
			direnv_load_timeout_ms: 30_000,
		}
	}
}

impl ShellSettings {
	/// Resolves shell construction policy from the process control context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			enabled:                SV_SHELL_ENABLED.get(ctx),
			command_prefix:         nonempty(SV_SHELL_COMMAND_PREFIX.get(ctx)),
			embedded_builtins:      SV_SHELL_EMBEDDED_BUILTINS.get(ctx),
			builtins_extra:         SV_SHELL_BUILTINS_EXTRA.get(ctx),
			auto_background:        AutoBackgroundSettings {
				enabled:      SV_SHELL_AUTO_BACKGROUND_ENABLED.get(ctx),
				threshold_ms: SV_SHELL_AUTO_BACKGROUND_THRESHOLD_MS.get(ctx) as u64,
			},
			interceptor:            InterceptorSettings {
				enabled:  SV_SHELL_INTERCEPTOR_ENABLED.get(ctx),
				patterns: SV_SHELL_INTERCEPTOR_PATTERNS
					.get(ctx)
					.into_iter()
					.filter_map(interceptor_rule)
					.collect(),
			},
			direnv:                 SV_SHELL_DIRENV.get(ctx),
			direnv_load_timeout_ms: SV_SHELL_DIRENV_LOAD_TIMEOUT_MS.get(ctx) as u64,
		}
	}

	/// The opt-in builtin names a shell constructed now registers: the
	/// configured list, or none when `sv_shell_embedded_builtins` is off.
	#[must_use]
	pub fn extra_builtins(&self) -> &[Str] {
		if self.embedded_builtins {
			&self.builtins_extra
		} else {
			&[]
		}
	}
}

/// Rejects a name `omp_shell_builtins::extra_builtins` would not register, so a
/// typo or a name this build lacks fails when the convar is set, not silently
/// at the next shell.
fn validate_extra_builtins(values: &[Str]) -> Result<(), Str> {
	omp_shell_builtins::validate_extra_names(values).map_err(|error| match error {
		omp_shell_builtins::ExtraBuiltinError::Unknown { name } => {
			sf!("`{name}` is not an extra builtin this build offers")
		},
	})
}

fn nonempty(value: Str) -> Option<Str> {
	(!value.is_empty()).then_some(value)
}

fn interceptor_rule(value: Kv) -> Option<InterceptorRule> {
	Some(InterceptorRule {
		pattern: value.get("pattern")?.as_str()?.into(),
		tool:    value.get("tool")?.as_str()?.into(),
		message: value.get("message")?.as_str()?.into(),
	})
}

fn default_interceptor_kv() -> Vec<Kv> {
	default_interceptor_rules()
		.into_iter()
		.map(|rule| {
			Kv(vec![
				(Str::new_static("pattern"), Value::Str(rule.pattern)),
				(Str::new_static("tool"), Value::Str(rule.tool)),
				(Str::new_static("message"), Value::Str(rule.message)),
			])
		})
		.collect()
}

fn default_interceptor_rules() -> Vec<InterceptorRule> {
	[
		(r"^\s*(cat|head|tail|less|more)\s+", "read", "Use the read tool for bounded file access."),
		(
			r"^\s*(grep|rg|ripgrep|ag|ack)\s+",
			"grep",
			"Use the grep tool for repository-aware search.",
		),
		(
			r"^\s*(find|fd|locate)\s+.*(-name|-iname|-type|--type|-glob)",
			"glob",
			"Use the glob tool for repository-aware path discovery.",
		),
		(r"^\s*sed\s+(-i|--in-place)", "edit", "Use the edit tool for in-place changes."),
		(r"^\s*perl\s+.*-[pn]?i", "edit", "Use the edit tool for in-place changes."),
		(r"^\s*awk\s+.*-i\s+inplace", "edit", "Use the edit tool for in-place changes."),
		(
			r"^\s*(echo|printf|cat\s*<<).*>{1,2}\|?\s+[^&]",
			"write",
			"Use the write tool for file replacement.",
		),
		(r"(^\s*nohup\s+)|(&\s*$)", "hub", "Use hub start for supervised background processes."),
		(
			r"^\s*(vite|next\s+dev|nuxt\s+dev|nodemon|lldb|gdb|tail\s+-f)(\s|$)",
			"hub",
			"Use hub start for services, watchers, and debuggers.",
		),
	]
	.into_iter()
	.map(|(pattern, tool, message)| InterceptorRule {
		pattern: Str::new_static(pattern),
		tool:    Str::new_static(tool),
		message: Str::new_static(message),
	})
	.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn shell_auto_background_is_enabled_by_default() {
		let settings = ShellSettings::from_con(&Ctx::new());
		assert!(settings.auto_background.enabled);
		assert_eq!(settings.auto_background.threshold_ms, 60_000);
	}

	/// ADR 0054 D2: nothing extra is registered until the user lists a name.
	#[test]
	fn extra_builtins_are_empty_by_default() {
		let ctx = Ctx::new();
		assert_eq!(SV_SHELL_BUILTINS_EXTRA.get(&ctx), Vec::<Str>::new());
		let settings = ShellSettings::from_con(&ctx);
		assert!(settings.extra_builtins().is_empty());
		assert!(
			omp_shell_builtins::extra_builtins::<omp_shell::extensions::DefaultShellExtensions>(
				settings.extra_builtins()
			)
			.is_empty()
		);
	}

	/// ADR 0054 D2: the master switch suppresses the extras, whatever is listed.
	#[test]
	fn embedded_builtins_off_suppresses_extra_builtins() {
		let on = ShellSettings { builtins_extra: vec![Str::from("all")], ..ShellSettings::default() };
		assert_eq!(on.extra_builtins(), [Str::from("all")]);
		let off = ShellSettings { embedded_builtins: false, ..on };
		assert!(off.extra_builtins().is_empty());
		assert!(
			omp_shell_builtins::extra_builtins::<omp_shell::extensions::DefaultShellExtensions>(
				off.extra_builtins()
			)
			.is_empty()
		);
	}

	/// A name this build does not offer is refused where the convar is set, and
	/// the refused value never lands.
	#[test]
	fn an_unknown_extra_builtin_name_fails_validation() {
		let ctx = Ctx::new();
		for rejected in ["rsync", "tar", "cat", "no-such-tool"] {
			SV_SHELL_BUILTINS_EXTRA
				.set(&ctx, vec![Str::from("all"), Str::from(rejected)])
				.expect_err(rejected);
		}
		assert!(SV_SHELL_BUILTINS_EXTRA.get(&ctx).is_empty());
		SV_SHELL_BUILTINS_EXTRA
			.set(&ctx, vec![Str::from("all")])
			.expect("the all keyword validates");
		assert_eq!(SV_SHELL_BUILTINS_EXTRA.get(&ctx), [Str::from("all")]);
		assert_eq!(ShellSettings::from_con(&ctx).builtins_extra, [Str::from("all")]);
	}

	/// The convar has no `PROJECT` flag: a repository's cfg cannot shadow a
	/// command.
	#[test]
	fn extra_builtins_is_archived_and_not_project_settable() {
		let ctx = Ctx::new();
		let flags = ctx
			.vars()
			.find(|var| var.name == "sv_shell_builtins_extra")
			.expect("the convar is registered")
			.flags;
		assert!(flags.contains(omp_con::VarFlags::ARCHIVE));
		assert!(!flags.contains(omp_con::VarFlags::PROJECT));
	}

	#[test]
	fn shell_con_projection_round_trips() {
		let ctx = Ctx::new();
		SV_SHELL_COMMAND_PREFIX
			.set(&ctx, Str::new_static("time"))
			.expect("set prefix");
		SV_SHELL_EMBEDDED_BUILTINS
			.set(&ctx, false)
			.expect("set builtins");
		assert_eq!(ShellSettings::from_con(&ctx), ShellSettings {
			command_prefix: Some(Str::new_static("time")),
			embedded_builtins: false,
			..ShellSettings::default()
		});
	}
}
