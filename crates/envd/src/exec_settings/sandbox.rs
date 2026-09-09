//! Agent command sandbox posture and policy settings.

use std::{collections::BTreeMap, path::Path};

use omp_con::{Ctx, Kv, Value};
use omp_core::Str;
use serde::{Deserialize, Serialize};

/// Exec sandbox posture selected by the user.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Serialize,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum ExecSandboxMode {
	/// Do not sandbox agent commands.
	#[default]
	Off,
	/// Prevent agent commands from writing anywhere.
	ReadOnly,
	/// Permit writes only to the workspace, temporary directories, and extra
	/// roots.
	WorkspaceWrite,
}

/// Handling of writes outside allowed roots under workspace-write.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Serialize,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum UnscopedWrites {
	/// Reject writes outside configured writable roots.
	#[default]
	Deny,
	/// Redirect unscoped writes to an ephemeral sandbox-private layer.
	Overlay,
}
/// Base environment inherited by child processes.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Serialize,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum EnvironmentInheritance {
	/// Inherit every exported environment variable.
	#[default]
	All,
	/// Inherit only platform-core environment variables.
	Core,
	/// Inherit no environment variables.
	None,
}
/// Read authority granted to sandboxed shell operations and children.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Serialize,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum ReadMode {
	/// Permit reads from the host subject to explicit denials.
	#[default]
	Host,
	/// Permit reads only from the workspace root.
	Minimal,
	/// Permit reads from the workspace and configured readable roots.
	Scoped,
}

/// Network authority granted to sandboxed commands.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Serialize,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum SandboxNetworkMode {
	/// Deny IP networking.
	#[default]
	Disabled,
	/// Permit normal IP egress.
	Open,
	/// Permit only policy-authorized egress through the sandbox broker.
	Scoped,
}

omp_con::con_enum!(ExecSandboxMode);
omp_con::con_enum!(UnscopedWrites);
omp_con::con_enum!(EnvironmentInheritance);
omp_con::con_enum!(ReadMode);
omp_con::con_enum!(SandboxNetworkMode);

omp_con::var! {
	/// Choose the filesystem sandbox posture for agent commands.
	pub static SV_SANDBOX_MODE = sv_sandbox_mode: ExecSandboxMode {
		default: ExecSandboxMode::Off,
		flags: archive,
		meta: {
			"legacy.path": "sandbox.mode",
		},
	};
	/// Choose disabled, open, or scoped network access.
	pub static SV_SANDBOX_NETWORK_MODE = sv_sandbox_network_mode: SandboxNetworkMode {
		default: SandboxNetworkMode::Disabled,
		flags: archive,
		meta: {
			"legacy.path": "sandbox.network_mode",
		},
	};
	/// Exact or leading wildcard domains allowed by scoped networking.
	pub static SV_SANDBOX_ALLOW_DOMAINS = sv_sandbox_allow_domains: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_domains(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.allow_domains",
		},
	};
	/// Domains denied before scoped allow rules.
	pub static SV_SANDBOX_DENY_DOMAINS = sv_sandbox_deny_domains: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_domains(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.deny_domains",
		},
	};
	/// TCP ports allowed by scoped networking.
	pub static SV_SANDBOX_ALLOW_PORTS = sv_sandbox_allow_ports: Vec<u16> {
		default: vec![80, 443],
		validate: |_ctx, values| validate_ports(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.allow_ports",
		},
	};
	/// Allow scoped networking to loopback addresses.
	pub static SV_SANDBOX_ALLOW_LOCALHOST = sv_sandbox_allow_localhost: bool {
		default: false,
		flags: archive,
		meta: {
			"legacy.path": "sandbox.allow_localhost",
		},
	};
	/// Existing absolute Unix-domain socket paths allowed independently of IP networking.
	pub static SV_SANDBOX_ALLOW_UNIX_SOCKETS = sv_sandbox_allow_unix_sockets: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_sockets(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.allow_unix_sockets",
		},
	};
	/// Absolute paths that workspace-write mode may modify.
	pub static SV_SANDBOX_WRITABLE_ROOTS = sv_sandbox_writable_roots: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_absolute_paths(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.writable_roots",
		},
	};
	/// Choose how workspace-write handles writes outside configured roots.
	pub static SV_SANDBOX_UNSCOPED_WRITES = sv_sandbox_unscoped_writes: UnscopedWrites {
		default: UnscopedWrites::Deny,
		flags: archive,
		meta: {
			"legacy.path": "sandbox.unscoped_writes",
		},
	};
	/// Environment variable name globs withheld from external commands.
	pub static SV_SANDBOX_ENV_DENY = sv_sandbox_env_deny: Vec<Str> {
		default: default_env_deny(),
		validate: |_ctx, values| validate_env_patterns(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.env_deny",
		},
	};
	/// Choose the base environment inherited by child processes.
	pub static SV_SANDBOX_ENV_INHERIT = sv_sandbox_env_inherit: EnvironmentInheritance {
		default: EnvironmentInheritance::All,
		flags: archive,
		meta: {
			"legacy.path": "sandbox.env_inherit",
		},
	};
	/// Environment variable name globs retained before deny filtering.
	pub static SV_SANDBOX_ENV_INCLUDE_ONLY = sv_sandbox_env_include_only: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_env_patterns(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.env_include_only",
		},
	};
	/// Explicit child environment values applied after filtering.
	pub static SV_SANDBOX_ENV_SET = sv_sandbox_env_set: Kv {
		default: Kv::new(),
		validate: |_ctx, values| validate_string_map(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.env_set",
		},
	};
	/// Do not grant workspace-write access to the platform temporary directory.
	pub static SV_SANDBOX_EXCLUDE_TMPDIR = sv_sandbox_exclude_tmpdir: bool {
		default: false,
		flags: archive,
		meta: {
			"legacy.path": "sandbox.exclude_tmpdir",
		},
	};
	/// Do not grant workspace-write access to `/tmp`.
	pub static SV_SANDBOX_EXCLUDE_SLASH_TMP = sv_sandbox_exclude_slash_tmp: bool {
		default: false,
		flags: archive,
		meta: {
			"legacy.path": "sandbox.exclude_slash_tmp",
		},
	};
	/// Additional absolute paths made unreadable by the kernel sandbox.
	pub static SV_SANDBOX_READ_DENY = sv_sandbox_read_deny: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_absolute_paths(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.read_deny",
		},
	};
	/// Choose whether reads use host, workspace-only, or scoped roots.
	pub static SV_SANDBOX_READ_MODE = sv_sandbox_read_mode: ReadMode {
		default: ReadMode::Host,
		flags: archive,
		meta: {
			"legacy.path": "sandbox.read_mode",
		},
	};
	/// Absolute paths readable in scoped mode.
	pub static SV_SANDBOX_READABLE_ROOTS = sv_sandbox_readable_roots: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_absolute_paths(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.readable_roots",
		},
	};
	/// Glob patterns denied when supported by the selected sandbox backend.
	pub static SV_SANDBOX_READ_DENY_GLOBS = sv_sandbox_read_deny_globs: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_path_globs(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.read_deny_globs",
		},
	};
	/// Additional absolute paths protected from writes.
	pub static SV_SANDBOX_WRITE_DENY = sv_sandbox_write_deny: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_absolute_paths(values),
		flags: archive,
		meta: {
			"legacy.path": "sandbox.write_deny",
		},
	};
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
/// User-facing sandbox configuration for agent command execution.
#[serde(default, deny_unknown_fields)]
pub struct SandboxSettings {
	/// Sandbox posture applied to agent command execution.
	pub mode:               ExecSandboxMode,
	/// Network authority granted to sandboxed commands.
	pub network_mode:       SandboxNetworkMode,
	/// Exact or leading `*.` wildcard domain names allowed in scoped mode.
	pub allow_domains:      Vec<Str>,
	/// Domain names denied before scoped allow rules.
	pub deny_domains:       Vec<Str>,
	/// TCP ports allowed in scoped mode.
	pub allow_ports:        Vec<u16>,
	/// Whether scoped mode may connect to loopback addresses.
	pub allow_localhost:    bool,
	/// Existing absolute Unix-domain socket paths allowed independently of IP
	/// networking.
	pub allow_unix_sockets: Vec<Str>,
	/// Additional absolute roots that workspace-write mode may modify.
	pub writable_roots:     Vec<Str>,
	/// Policy for writes outside configured roots in workspace-write mode.
	pub unscoped_writes:    UnscopedWrites,
	/// Exported environment variable name globs withheld from external commands.
	pub env_deny:           Vec<Str>,
	/// Base environment inherited by child processes.
	pub env_inherit:        EnvironmentInheritance,
	/// Environment variable name globs retained before deny filtering.
	pub env_include_only:   Vec<Str>,
	/// Explicit child environment values applied after filtering.
	pub env_set:            BTreeMap<Str, Str>,
	/// Whether workspace-write excludes the platform temporary directory.
	pub exclude_tmpdir:     bool,
	/// Whether workspace-write excludes `/tmp`.
	pub exclude_slash_tmp:  bool,
	/// Additional absolute paths hidden from sandboxed processes.
	pub read_deny:          Vec<Str>,
	/// Additional absolute roots available for reads in scoped mode.
	pub readable_roots:     Vec<Str>,
	/// Read authority posture for shell operations and sandboxed children.
	pub read_mode:          ReadMode,
	/// Denied path globs, rejected when the selected backend cannot enforce
	/// future matches.
	pub read_deny_globs:    Vec<Str>,
	/// Additional absolute paths protected from writes in both policy lanes.
	pub write_deny:         Vec<Str>,
}

impl Default for SandboxSettings {
	fn default() -> Self {
		Self {
			mode:               ExecSandboxMode::Off,
			network_mode:       SandboxNetworkMode::Disabled,
			allow_domains:      Vec::new(),
			deny_domains:       Vec::new(),
			allow_ports:        vec![80, 443],
			allow_localhost:    false,
			allow_unix_sockets: Vec::new(),
			writable_roots:     Vec::new(),
			unscoped_writes:    UnscopedWrites::Deny,
			env_deny:           default_env_deny(),
			env_inherit:        EnvironmentInheritance::All,
			env_include_only:   Vec::new(),
			env_set:            BTreeMap::new(),
			exclude_tmpdir:     false,
			exclude_slash_tmp:  false,
			read_deny:          Vec::new(),
			readable_roots:     Vec::new(),
			read_mode:          ReadMode::Host,
			read_deny_globs:    Vec::new(),
			write_deny:         Vec::new(),
		}
	}
}
impl SandboxSettings {
	/// Reports whether child environment behavior matches the default policy.
	pub(crate) fn environment_policy_is_default(&self) -> bool {
		self.env_inherit == EnvironmentInheritance::All
			&& self.env_include_only.is_empty()
			&& self.env_set.is_empty()
			&& self
				.env_deny
				.iter()
				.map(Str::as_str)
				.eq(["*KEY*", "*SECRET*", "*TOKEN*"])
	}
}

impl SandboxSettings {
	/// Resolves sandbox policy from the process control context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			mode:               SV_SANDBOX_MODE.get(ctx),
			network_mode:       SV_SANDBOX_NETWORK_MODE.get(ctx),
			allow_domains:      SV_SANDBOX_ALLOW_DOMAINS.get(ctx),
			deny_domains:       SV_SANDBOX_DENY_DOMAINS.get(ctx),
			allow_ports:        SV_SANDBOX_ALLOW_PORTS.get(ctx),
			allow_localhost:    SV_SANDBOX_ALLOW_LOCALHOST.get(ctx),
			allow_unix_sockets: SV_SANDBOX_ALLOW_UNIX_SOCKETS.get(ctx),
			writable_roots:     SV_SANDBOX_WRITABLE_ROOTS.get(ctx),
			unscoped_writes:    SV_SANDBOX_UNSCOPED_WRITES.get(ctx),
			env_deny:           SV_SANDBOX_ENV_DENY.get(ctx),
			env_inherit:        SV_SANDBOX_ENV_INHERIT.get(ctx),
			env_include_only:   SV_SANDBOX_ENV_INCLUDE_ONLY.get(ctx),
			env_set:            SV_SANDBOX_ENV_SET
				.get(ctx)
				.0
				.into_iter()
				.filter_map(|(key, value)| Some((key, Str::new(value.as_str()?))))
				.collect(),
			exclude_tmpdir:     SV_SANDBOX_EXCLUDE_TMPDIR.get(ctx),
			exclude_slash_tmp:  SV_SANDBOX_EXCLUDE_SLASH_TMP.get(ctx),
			read_deny:          SV_SANDBOX_READ_DENY.get(ctx),
			readable_roots:     SV_SANDBOX_READABLE_ROOTS.get(ctx),
			read_mode:          SV_SANDBOX_READ_MODE.get(ctx),
			read_deny_globs:    SV_SANDBOX_READ_DENY_GLOBS.get(ctx),
			write_deny:         SV_SANDBOX_WRITE_DENY.get(ctx),
		}
	}
}

fn validation_error(message: &'static str) -> Str {
	Str::new_static(message)
}

fn validate_absolute_paths(values: &[Str]) -> Result<(), Str> {
	if values
		.iter()
		.all(|value| Path::new(value.as_str()).is_absolute())
	{
		Ok(())
	} else {
		Err(validation_error("paths must be absolute"))
	}
}

fn validate_sockets(values: &[Str]) -> Result<(), Str> {
	if values
		.iter()
		.all(|value| is_existing_unix_socket(Path::new(value.as_str())))
	{
		Ok(())
	} else {
		Err(validation_error("Unix socket paths must name existing sockets"))
	}
}

fn validate_ports(values: &[u16]) -> Result<(), Str> {
	if values.contains(&0) {
		Err(validation_error("port zero is invalid"))
	} else {
		Ok(())
	}
}

fn validate_domains(values: &[Str]) -> Result<(), Str> {
	if values
		.iter()
		.all(|value| valid_domain_pattern(value.as_str()))
	{
		Ok(())
	} else {
		Err(validation_error("invalid domain pattern"))
	}
}

fn validate_env_patterns(values: &[Str]) -> Result<(), Str> {
	if values
		.iter()
		.all(|value| omp_sandbox::validate_env_pattern(value.as_str()).is_ok())
	{
		Ok(())
	} else {
		Err(validation_error("invalid environment pattern"))
	}
}

fn validate_path_globs(values: &[Str]) -> Result<(), Str> {
	if values
		.iter()
		.all(|value| globset::Glob::new(value.as_str()).is_ok())
	{
		Ok(())
	} else {
		Err(validation_error("invalid path glob"))
	}
}

fn validate_string_map(values: &Kv) -> Result<(), Str> {
	if values
		.iter()
		.all(|(_, value)| matches!(value, Value::Str(_)))
	{
		Ok(())
	} else {
		Err(validation_error("environment values must be strings"))
	}
}

fn default_env_deny() -> Vec<Str> {
	["*KEY*", "*SECRET*", "*TOKEN*"]
		.into_iter()
		.map(Str::new_static)
		.collect()
}
fn valid_domain_pattern(pattern: &str) -> bool {
	let domain = pattern.strip_prefix("*.").unwrap_or(pattern);
	!domain.is_empty()
		&& domain.split('.').all(|label| {
			!label.is_empty()
				&& label.len() <= 63
				&& label
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
		})
}
fn is_existing_unix_socket(path: &Path) -> bool {
	if !path.is_absolute() {
		return false;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::FileTypeExt as _;
		std::fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
	}
	#[cfg(not(unix))]
	{
		path.exists()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn default_sandbox_projects_off() {
		let settings = SandboxSettings::from_con(&Ctx::new());
		assert_eq!(settings, SandboxSettings::default());
		assert_eq!(settings.mode, ExecSandboxMode::Off);
	}

	#[test]
	fn configured_sandbox_convars_project() {
		let ctx = Ctx::new();
		SV_SANDBOX_MODE
			.set(&ctx, ExecSandboxMode::WorkspaceWrite)
			.expect("set mode");
		SV_SANDBOX_NETWORK_MODE
			.set(&ctx, SandboxNetworkMode::Scoped)
			.expect("set network");
		SV_SANDBOX_ALLOW_DOMAINS
			.set(&ctx, vec![Str::new_static("*.example.com")])
			.expect("set domains");
		SV_SANDBOX_ENV_SET
			.set(&ctx, Kv(vec![(Str::new_static("OMP_TEST"), Value::Str(Str::new_static("yes")))]))
			.expect("set env");
		let settings = SandboxSettings::from_con(&ctx);
		assert_eq!(settings.mode, ExecSandboxMode::WorkspaceWrite);
		assert_eq!(settings.network_mode, SandboxNetworkMode::Scoped);
		assert_eq!(settings.allow_domains, vec![Str::new_static("*.example.com")]);
		assert_eq!(settings.env_set.get("OMP_TEST").map(Str::as_str), Some("yes"));
	}

	#[test]
	fn sandbox_convars_reject_invalid_policy_values() {
		let ctx = Ctx::new();
		assert!(
			SV_SANDBOX_WRITABLE_ROOTS
				.set(&ctx, vec![Str::new_static("relative/path")])
				.is_err()
		);
		assert!(
			SV_SANDBOX_ENV_INCLUDE_ONLY
				.set(&ctx, vec![Str::new_static("[")])
				.is_err()
		);
	}
}
