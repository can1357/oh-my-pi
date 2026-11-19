//! Agent command sandbox posture and policy settings.

use std::{
	borrow::Cow,
	collections::BTreeMap,
	fmt::Write as _,
	fs, io,
	path::{Path, PathBuf},
};

use omp_con::{Ctx, Kv, Value};
use omp_core::Str;
use serde::{Deserialize, Serialize};

use crate::admission::{Provenance, SandboxState};

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
	/// Do not sandbox agent commands. The default `yolo` approval then becomes
	/// `write`.
	Off,
	/// Prevent agent commands from writing anywhere.
	ReadOnly,
	/// Permit writes only to the workspace, temporary directories, and extra
	/// roots.
	#[default]
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
///
/// While `sv_sandbox_mode` is `off`, only an explicitly set `scoped` confines
/// anything; see [`network_confinement`].
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
	Disabled,
	/// Permit normal IP egress.
	Open,
	/// Permit only policy-authorized egress through the session's egress broker.
	/// HTTP(S) and SOCKS clients reach it through the proxy environment; a host
	/// outside `sv_sandbox_allow_domains` is refused, and the user can approve
	/// it for one rerun or for the rest of the session. The shipped default.
	#[default]
	Scoped,
}

/// The network confinement agent shell sessions are configured for.
///
/// One answer for the sandbox compiler, the workflow posture and `/security`.
/// [`SandboxNetworkMode`] is what the user asked for; this is what applies
/// once the filesystem mode and who set the network mode are taken into
/// account. Two consumers run `disabled` whatever this says: a shell session
/// whose egress broker could not start under the shipped default, and eval
/// cells and detached processes, which never hold a broker token.
#[derive(
	Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq, strum::Display, strum::IntoStaticStr,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum NetworkConfinement {
	/// Nothing confines the network: `open`, the sandbox `off` with a defaulted
	/// network mode or with an explicit `disabled` (no sandbox enforces it), or
	/// a requested sandbox that was not constructed.
	Unconfined,
	/// IP networking is denied.
	Disabled,
	/// Egress goes only through the session's policy-enforcing broker.
	Scoped,
}

omp_con::con_enum!(ExecSandboxMode);
omp_con::con_enum!(UnscopedWrites);
omp_con::con_enum!(EnvironmentInheritance);
omp_con::con_enum!(ReadMode);
omp_con::con_enum!(SandboxNetworkMode);

omp_con::var! {
	/// Choose the filesystem sandbox posture for agent commands. On by default; where the
	/// platform cannot construct it, commands run unsandboxed under `write` approval; a sandbox
	/// you set yourself fails instead.
	pub static SV_SANDBOX_MODE = sv_sandbox_mode: ExecSandboxMode {
		default: ExecSandboxMode::WorkspaceWrite,
		flags: archive,
	};
	/// Choose network access for sandboxed commands: scoped (default; HTTP(S) and SOCKS clients
	/// go through an egress broker that admits sv_sandbox_allow_domains and asks before a rerun
	/// for any other host, once or for the rest of the session), disabled, or open. While
	/// sv_sandbox_mode is off, only an explicitly set scoped applies (a network-only sandbox);
	/// disabled and open then confine nothing.
	pub static SV_SANDBOX_NETWORK_MODE = sv_sandbox_network_mode: SandboxNetworkMode {
		default: SandboxNetworkMode::Scoped,
		flags: archive,
	};
	/// Cap CPU cores available to one sandboxed command tree; 0 is unlimited.
	pub static SV_SANDBOX_CPU_CORES = sv_sandbox_cpu_cores: f64 {
		default: 0.0,
		validate: |_ctx, value| validate_cpu_cores(*value),
		flags: archive,
	};
	/// Cap resident memory for one sandboxed command tree; 0 is unlimited.
	pub static SV_SANDBOX_MEMORY_BYTES = sv_sandbox_memory_bytes: i64 {
		default: 0,
		validate: |_ctx, value| validate_non_negative(*value),
		flags: archive,
	};
	/// Cap live processes in one sandboxed command tree; 0 is unlimited.
	pub static SV_SANDBOX_PIDS = sv_sandbox_pids: u32 {
		default: 0,
		flags: archive,
	};
	/// Exact or leading wildcard domains allowed by scoped networking.
	pub static SV_SANDBOX_ALLOW_DOMAINS = sv_sandbox_allow_domains: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_domains(values),
		flags: archive,
	};
	/// Domains denied before scoped allow rules. A deny beats every approval: a denied host is
	/// never offered for approval, once or for the session.
	pub static SV_SANDBOX_DENY_DOMAINS = sv_sandbox_deny_domains: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_domains(values),
		flags: archive,
	};
	/// Most reruns one sandboxed command may take on network endpoints approved for the rest of
	/// the session. Each rerun follows the approval of a new host:port the command was refused,
	/// so a multi-host install (pip, cargo, Homebrew) finishes in one call; a once approval still
	/// ends the chain. At least 1.
	pub static SV_SANDBOX_NETWORK_SESSION_RERUNS = sv_sandbox_network_session_reruns: u32 {
		default: DEFAULT_NETWORK_SESSION_RERUNS,
		validate: |_ctx, value| validate_session_reruns(*value),
		flags: archive,
	};
	/// TCP ports allowed by scoped networking.
	pub static SV_SANDBOX_ALLOW_PORTS = sv_sandbox_allow_ports: Vec<u16> {
		default: vec![80, 443],
		validate: |_ctx, values| validate_ports(values),
		flags: archive,
	};
	/// Allow scoped networking to loopback addresses.
	pub static SV_SANDBOX_ALLOW_LOCALHOST = sv_sandbox_allow_localhost: bool {
		default: false,
		flags: archive,
	};
	/// Existing absolute Unix-domain socket paths allowed independently of IP networking.
	pub static SV_SANDBOX_ALLOW_UNIX_SOCKETS = sv_sandbox_allow_unix_sockets: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_sockets(values),
		flags: archive,
	};
	/// Absolute paths that workspace-write mode may modify.
	pub static SV_SANDBOX_WRITABLE_ROOTS = sv_sandbox_writable_roots: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_absolute_paths(values),
		flags: archive,
	};
	/// Choose how workspace-write handles writes outside configured roots.
	pub static SV_SANDBOX_UNSCOPED_WRITES = sv_sandbox_unscoped_writes: UnscopedWrites {
		default: UnscopedWrites::Deny,
		flags: archive,
	};
	/// Environment variable name globs withheld from external commands.
	pub static SV_SANDBOX_ENV_DENY = sv_sandbox_env_deny: Vec<Str> {
		default: default_env_deny(),
		validate: |_ctx, values| validate_env_patterns(values),
		flags: archive,
	};
	/// Choose the base environment inherited by child processes.
	pub static SV_SANDBOX_ENV_INHERIT = sv_sandbox_env_inherit: EnvironmentInheritance {
		default: EnvironmentInheritance::All,
		flags: archive,
	};
	/// Environment variable name globs retained before deny filtering.
	pub static SV_SANDBOX_ENV_INCLUDE_ONLY = sv_sandbox_env_include_only: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_env_patterns(values),
		flags: archive,
	};
	/// Explicit child environment values applied after filtering.
	pub static SV_SANDBOX_ENV_SET = sv_sandbox_env_set: Kv {
		default: Kv::new(),
		validate: |_ctx, values| validate_string_map(values),
		flags: archive,
	};
	/// Do not grant workspace-write access to the platform temporary directory.
	pub static SV_SANDBOX_EXCLUDE_TMPDIR = sv_sandbox_exclude_tmpdir: bool {
		default: false,
		flags: archive,
	};
	/// Do not grant workspace-write access to `/tmp`.
	pub static SV_SANDBOX_EXCLUDE_SLASH_TMP = sv_sandbox_exclude_slash_tmp: bool {
		default: false,
		flags: archive,
	};
	/// Additional absolute paths made unreadable by the kernel sandbox.
	pub static SV_SANDBOX_READ_DENY = sv_sandbox_read_deny: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_absolute_paths(values),
		flags: archive,
	};
	/// Choose whether reads use host, workspace-only, or scoped roots.
	pub static SV_SANDBOX_READ_MODE = sv_sandbox_read_mode: ReadMode {
		default: ReadMode::Host,
		flags: archive,
	};
	/// Absolute paths readable in scoped mode.
	pub static SV_SANDBOX_READABLE_ROOTS = sv_sandbox_readable_roots: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_absolute_paths(values),
		flags: archive,
	};
	/// Glob patterns denied when supported by the selected sandbox backend.
	pub static SV_SANDBOX_READ_DENY_GLOBS = sv_sandbox_read_deny_globs: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_path_globs(values),
		flags: archive,
	};
	/// Additional absolute paths protected from writes.
	pub static SV_SANDBOX_WRITE_DENY = sv_sandbox_write_deny: Vec<Str> {
		default: Vec::new(),
		validate: |_ctx, values| validate_absolute_paths(values),
		flags: archive,
	};
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
/// User-facing sandbox configuration for agent command execution.
#[serde(default, deny_unknown_fields)]
pub struct SandboxSettings {
	/// Sandbox posture applied to agent command execution.
	pub mode:                  ExecSandboxMode,
	/// Network authority granted to sandboxed commands.
	pub network_mode:          SandboxNetworkMode,
	/// Whether the user set `network_mode` or it is the shipped default. A
	/// defaulted mode never sandboxes an explicit `sv_sandbox_mode off`.
	pub network_provenance:    Provenance,
	/// CPU-core ceiling for one sandboxed command tree; zero is unlimited.
	pub cpu_cores:             f64,
	/// Resident-memory ceiling for one sandboxed command tree; zero is
	/// unlimited.
	pub memory_bytes:          i64,
	/// Live-process ceiling for one sandboxed command tree; zero is unlimited.
	pub pids:                  u32,
	/// Exact or leading `*.` wildcard domain names allowed in scoped mode.
	pub allow_domains:         Vec<Str>,
	/// Domain names denied before scoped allow rules.
	pub deny_domains:          Vec<Str>,
	/// TCP ports allowed in scoped mode.
	pub allow_ports:           Vec<u16>,
	/// Most reruns one command may take on network endpoints approved for the
	/// session; at least 1.
	pub network_reruns:        u32,
	/// Whether scoped mode may connect to loopback addresses.
	pub allow_localhost:       bool,
	/// Existing absolute Unix-domain socket paths allowed independently of IP
	/// networking.
	pub allow_unix_sockets:    Vec<Str>,
	/// Additional absolute roots that workspace-write mode may modify.
	pub writable_roots:        Vec<Str>,
	/// Policy for writes outside configured roots in workspace-write mode.
	pub unscoped_writes:       UnscopedWrites,
	/// Exported environment variable name globs withheld from external commands.
	pub env_deny:              Vec<Str>,
	/// Base environment inherited by child processes.
	pub env_inherit:           EnvironmentInheritance,
	/// Environment variable name globs retained before deny filtering.
	pub env_include_only:      Vec<Str>,
	/// Explicit child environment values applied after filtering.
	pub env_set:               BTreeMap<Str, Str>,
	/// Whether workspace-write excludes the platform temporary directory.
	pub exclude_tmpdir:        bool,
	/// Whether workspace-write excludes `/tmp`.
	pub exclude_slash_tmp:     bool,
	/// Additional absolute paths hidden from sandboxed processes.
	pub read_deny:             Vec<Str>,
	/// Additional absolute roots available for reads in scoped mode.
	pub readable_roots:        Vec<Str>,
	/// Read authority posture for shell operations and sandboxed children.
	pub read_mode:             ReadMode,
	/// Denied path globs, rejected when the selected backend cannot enforce
	/// future matches.
	pub read_deny_globs:       Vec<Str>,
	/// Additional absolute paths protected from writes in both policy lanes.
	pub write_deny:            Vec<Str>,
	/// Absolute paths the session owner protects from sandboxed writes,
	/// wherever a sandbox spec is built and enforced, whether they exist yet or
	/// not: the operator grants store and the user extension root. Not a user
	/// convar. Skipped when empty so the policy digest of settings without
	/// protected paths is unchanged. Serialized lossily, so a path that is not
	/// valid UTF-8 still digests: only the daemon policy digest serializes
	/// settings, and enforcement reads the exact paths.
	#[serde(skip_serializing_if = "Vec::is_empty", serialize_with = "serialize_paths_lossy")]
	pub protected_write_paths: Vec<PathBuf>,
	/// Whether the user set any `sv_sandbox_*` convar, rather than leaving the
	/// shipped posture. A sandbox the user asked for that cannot be built is a
	/// hard error; the shipped default degrades to unsandboxed commands under
	/// approval.
	pub explicit:              bool,
}

impl Default for SandboxSettings {
	fn default() -> Self {
		Self {
			mode:                  ExecSandboxMode::WorkspaceWrite,
			network_mode:          SandboxNetworkMode::Scoped,
			network_provenance:    Provenance::Default,
			cpu_cores:             0.0,
			memory_bytes:          0,
			pids:                  0,
			allow_domains:         Vec::new(),
			deny_domains:          Vec::new(),
			allow_ports:           vec![80, 443],
			network_reruns:        DEFAULT_NETWORK_SESSION_RERUNS,
			allow_localhost:       false,
			allow_unix_sockets:    Vec::new(),
			writable_roots:        Vec::new(),
			unscoped_writes:       UnscopedWrites::Deny,
			env_deny:              default_env_deny(),
			env_inherit:           EnvironmentInheritance::All,
			env_include_only:      Vec::new(),
			env_set:               BTreeMap::new(),
			exclude_tmpdir:        false,
			exclude_slash_tmp:     false,
			read_deny:             Vec::new(),
			readable_roots:        Vec::new(),
			read_mode:             ReadMode::Host,
			read_deny_globs:       Vec::new(),
			write_deny:            Vec::new(),
			protected_write_paths: Vec::new(),
			explicit:              false,
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

	/// The network confinement these settings ask the sandbox compiler for.
	///
	/// `open` confines nothing. With `sv_sandbox_mode off`, only a `scoped`
	/// mode the user set compiles a network-only sandbox, and `disabled`
	/// confines nothing: the shipped `scoped` default does not turn an explicit
	/// `off` back into a sandbox, so hosts without a native backend keep
	/// running commands. Whether a requested sandbox was actually constructed
	/// is [`network_confinement`]'s business.
	pub(crate) const fn network_confinement(&self) -> NetworkConfinement {
		match (self.mode, self.network_mode, self.network_provenance) {
			(_, SandboxNetworkMode::Open, _) => NetworkConfinement::Unconfined,
			(ExecSandboxMode::Off, SandboxNetworkMode::Scoped, Provenance::Explicit) => {
				NetworkConfinement::Scoped
			},
			(ExecSandboxMode::Off, ..) => NetworkConfinement::Unconfined,
			(_, SandboxNetworkMode::Disabled, _) => NetworkConfinement::Disabled,
			(_, SandboxNetworkMode::Scoped, _) => NetworkConfinement::Scoped,
		}
	}
}

/// Reports the network confinement agent shell sessions are configured for
/// under `ctx`.
///
/// `sandbox` is the state [`SandboxState::probe`] reports for the same
/// context: a requested filesystem sandbox that was not constructed confines
/// nothing, network included. A probe starts no egress broker, so this cannot
/// see a broker that fails to start: such a session runs `disabled` (and says
/// so in its session note) while this reports `scoped`. Eval cells and
/// detached processes always run `disabled`.
#[must_use]
pub fn network_confinement(ctx: &Ctx, sandbox: SandboxState) -> NetworkConfinement {
	let settings = SandboxSettings::from_con(ctx);
	if settings.mode != ExecSandboxMode::Off && !sandbox.confines() {
		return NetworkConfinement::Unconfined;
	}
	settings.network_confinement()
}

impl SandboxSettings {
	/// Resolves sandbox policy from the process control context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			mode:                  SV_SANDBOX_MODE.get(ctx),
			network_mode:          SV_SANDBOX_NETWORK_MODE.get(ctx),
			network_provenance:    Provenance::of_convar(ctx, SV_SANDBOX_NETWORK_MODE.name()),
			cpu_cores:             SV_SANDBOX_CPU_CORES.get(ctx),
			memory_bytes:          SV_SANDBOX_MEMORY_BYTES.get(ctx),
			pids:                  SV_SANDBOX_PIDS.get(ctx),
			allow_domains:         SV_SANDBOX_ALLOW_DOMAINS.get(ctx),
			deny_domains:          SV_SANDBOX_DENY_DOMAINS.get(ctx),
			allow_ports:           SV_SANDBOX_ALLOW_PORTS.get(ctx),
			network_reruns:        SV_SANDBOX_NETWORK_SESSION_RERUNS.get(ctx),
			allow_localhost:       SV_SANDBOX_ALLOW_LOCALHOST.get(ctx),
			allow_unix_sockets:    SV_SANDBOX_ALLOW_UNIX_SOCKETS.get(ctx),
			writable_roots:        SV_SANDBOX_WRITABLE_ROOTS.get(ctx),
			unscoped_writes:       SV_SANDBOX_UNSCOPED_WRITES.get(ctx),
			env_deny:              SV_SANDBOX_ENV_DENY.get(ctx),
			env_inherit:           SV_SANDBOX_ENV_INHERIT.get(ctx),
			env_include_only:      SV_SANDBOX_ENV_INCLUDE_ONLY.get(ctx),
			env_set:               SV_SANDBOX_ENV_SET
				.get(ctx)
				.0
				.into_iter()
				.filter_map(|(key, value)| Some((key, Str::new(value.as_str()?))))
				.collect(),
			exclude_tmpdir:        SV_SANDBOX_EXCLUDE_TMPDIR.get(ctx),
			exclude_slash_tmp:     SV_SANDBOX_EXCLUDE_SLASH_TMP.get(ctx),
			read_deny:             SV_SANDBOX_READ_DENY.get(ctx),
			readable_roots:        SV_SANDBOX_READABLE_ROOTS.get(ctx),
			read_mode:             SV_SANDBOX_READ_MODE.get(ctx),
			read_deny_globs:       SV_SANDBOX_READ_DENY_GLOBS.get(ctx),
			write_deny:            SV_SANDBOX_WRITE_DENY.get(ctx),
			protected_write_paths: host_protected_write_paths(),
			explicit:              ctx
				.vars()
				.any(|var| var.name.starts_with("sv_sandbox_") && ctx.is_user_set(var.name)),
		}
	}
}

/// Returns the same protected paths for both the launching process and its
/// envd.
pub fn protected_write_paths(data_dir: &Path, home: &Path) -> Vec<PathBuf> {
	let mut candidates = vec![data_dir.join("ext")];
	if let Ok(config_root) = omp_core::dirs::profile_config_dir(home) {
		candidates.push(config_root.join("agent/extensions"));
	}
	let mut paths = candidates
		.into_iter()
		.map(protected_spelling)
		.collect::<Vec<_>>();
	paths.sort_unstable();
	paths.dedup();
	paths
}

/// Serializes paths as strings. A path that is not valid UTF-8 serializes as
/// its lossy spelling, a NUL, and the hex of its exact bytes, so two distinct
/// invalid paths never share one digest input. Valid UTF-8 serializes
/// unchanged. Only the daemon policy digest serializes settings, and failing
/// there would take the session down; enforcement reads the exact [`PathBuf`]s.
fn serialize_paths_lossy<S: serde::Serializer>(
	paths: &[PathBuf],
	serializer: S,
) -> Result<S::Ok, S::Error> {
	serializer.collect_seq(paths.iter().map(|path| path_digest_spelling(path)))
}

fn path_digest_spelling(path: &Path) -> Cow<'_, str> {
	if let Some(text) = path.to_str() {
		return Cow::Borrowed(text);
	}
	let mut spelling = path.to_string_lossy().into_owned();
	spelling.push('\0');
	for byte in path.as_os_str().as_encoded_bytes() {
		// Writing to a `String` never fails.
		let _ = write!(spelling, "{byte:02x}");
	}
	Cow::Owned(spelling)
}

/// The canonical spelling of a protected location, or its absolute spelling
/// when no ancestor of it can be canonicalized.
fn protected_spelling(path: PathBuf) -> PathBuf {
	canonical_protected_location(&path)
		.unwrap_or_else(|_| std::path::absolute(&path).unwrap_or(path))
}

fn host_protected_write_paths() -> Vec<PathBuf> {
	protected_paths_for_host(
		omp_core::dirs::data_dir(None).ok().as_deref(),
		omp_core::dirs::home_dir().as_deref(),
	)
}

/// Without a home directory only the data directory's store can be protected,
/// spelled like every other protected path; without a data directory, nothing.
fn protected_paths_for_host(data_dir: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
	match (data_dir, home) {
		(Some(data_dir), Some(home)) => protected_write_paths(data_dir, home),
		(Some(data_dir), None) => vec![protected_spelling(data_dir.join("ext"))],
		(None, _) => Vec::new(),
	}
}

/// Canonicalizes a protected path even if its final components do not exist.
pub fn canonical_protected_location(path: &Path) -> io::Result<PathBuf> {
	let absolute = std::path::absolute(path)?;
	let mut probe = absolute.as_path();
	let mut missing = Vec::new();
	loop {
		match fs::canonicalize(probe) {
			Ok(mut canonical) => {
				for component in missing.into_iter().rev() {
					canonical.push(component);
				}
				return Ok(canonical);
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				let name = probe.file_name().ok_or(source)?;
				missing.push(name.to_os_string());
				probe = probe.parent().ok_or_else(|| {
					io::Error::new(io::ErrorKind::NotFound, "protected path has no existing ancestor")
				})?;
			},
			Err(source) => return Err(source),
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

/// Reruns a command may take on network endpoints approved for the session,
/// unless `sv_sandbox_network_session_reruns` says otherwise: enough for the
/// common multi-host toolchains (pip, cargo and go reach two hosts, Homebrew
/// three) while bounding how often a command's earlier side effects repeat.
const DEFAULT_NETWORK_SESSION_RERUNS: u32 = 4;

/// Rejects a rerun bound below one: the first approval always reruns, so a
/// bound of zero could not be honoured.
fn validate_session_reruns(value: u32) -> Result<(), Str> {
	if value == 0 {
		Err(validation_error("a session-approved network endpoint reruns at least once"))
	} else {
		Ok(())
	}
}

fn validate_ports(values: &[u16]) -> Result<(), Str> {
	if values.contains(&0) {
		Err(validation_error("port zero is invalid"))
	} else {
		Ok(())
	}
}

/// Rejects a CPU ceiling the sandbox layer would refuse anyway.
///
/// Catching it here means a bad `sv_sandbox_cpu_cores` fails when it is set,
/// not on the first command that tries to run under it.
fn validate_cpu_cores(value: f64) -> Result<(), Str> {
	if value == 0.0 || (value.is_finite() && value > 0.0) {
		Ok(())
	} else {
		Err(validation_error("cpu core ceiling must be positive and finite, or 0 for unlimited"))
	}
}

/// Rejects a negative byte ceiling before it reaches the sandbox layer.
fn validate_non_negative(value: i64) -> Result<(), Str> {
	if value >= 0 {
		Ok(())
	} else {
		Err(validation_error("byte ceiling must not be negative; use 0 for unlimited"))
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
	valid_domain_name(pattern.strip_prefix("*.").unwrap_or(pattern))
}

/// Whether `domain` is a plain DNS name: dot-separated labels of ASCII
/// letters, digits and hyphens, each 1 to 63 bytes long.
pub(crate) fn valid_domain_name(domain: &str) -> bool {
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
	fn a_nonfinite_cpu_ceiling_is_refused_when_set() {
		let ctx = Ctx::new();

		assert!(
			SV_SANDBOX_CPU_CORES.set(&ctx, f64::NAN).is_err(),
			"an unrepresentable ceiling must fail at the setting, not at the first command"
		);
	}

	#[test]
	fn a_negative_cpu_ceiling_is_refused_when_set() {
		let ctx = Ctx::new();

		assert!(SV_SANDBOX_CPU_CORES.set(&ctx, -1.0).is_err());
	}

	#[test]
	fn zero_means_unlimited_rather_than_invalid() {
		let ctx = Ctx::new();

		assert!(
			SV_SANDBOX_CPU_CORES.set(&ctx, 0.0).is_ok(),
			"zero is the documented spelling of `no ceiling`"
		);
		assert!(SV_SANDBOX_MEMORY_BYTES.set(&ctx, 0).is_ok());
	}

	#[test]
	fn a_negative_byte_ceiling_is_refused_when_set() {
		let ctx = Ctx::new();

		assert!(SV_SANDBOX_MEMORY_BYTES.set(&ctx, -1).is_err());
	}

	#[test]
	fn configured_ceilings_reach_resolved_settings() {
		let ctx = Ctx::new();
		SV_SANDBOX_CPU_CORES.set(&ctx, 2.5).expect("valid ceiling");
		SV_SANDBOX_MEMORY_BYTES
			.set(&ctx, 1 << 30)
			.expect("valid ceiling");
		SV_SANDBOX_PIDS.set(&ctx, 64).expect("valid ceiling");

		let settings = SandboxSettings::from_con(&ctx);

		assert_eq!(settings.cpu_cores, 2.5);
		assert_eq!(settings.memory_bytes, 1 << 30);
		assert_eq!(settings.pids, 64);
	}

	#[test]
	fn default_sandbox_is_workspace_write_with_scoped_network() {
		let settings = SandboxSettings::from_con(&Ctx::new());
		// Host-protected paths come from the machine, not the convars; the rest
		// is the shipped posture.
		let posture = SandboxSettings { protected_write_paths: Vec::new(), ..settings.clone() };
		assert_eq!(posture, SandboxSettings::default());
		assert_eq!(settings.mode, ExecSandboxMode::WorkspaceWrite);
		assert_eq!(ExecSandboxMode::default(), ExecSandboxMode::WorkspaceWrite);
		assert_eq!(settings.network_mode, SandboxNetworkMode::Scoped);
		assert_eq!(SandboxNetworkMode::default(), SandboxNetworkMode::Scoped);
		assert_eq!(settings.network_provenance, Provenance::Default);
		assert_eq!(settings.network_confinement(), NetworkConfinement::Scoped);
		assert!(!settings.explicit, "an untouched sandbox is the shipped default, not a user choice");
		assert_eq!(
			SV_SANDBOX_MODE.get(&Ctx::new()),
			ExecSandboxMode::WorkspaceWrite,
			"the convar default is the shipped posture"
		);
		assert_eq!(
			SV_SANDBOX_NETWORK_MODE.get(&Ctx::new()),
			SandboxNetworkMode::Scoped,
			"the convar default is the shipped network posture"
		);
	}

	#[test]
	fn an_explicit_off_survives_the_default_flip() {
		let ctx = Ctx::new();
		SV_SANDBOX_MODE
			.set(&ctx, ExecSandboxMode::Off)
			.expect("set mode");
		let settings = SandboxSettings::from_con(&ctx);
		assert_eq!(settings.mode, ExecSandboxMode::Off);
		assert!(settings.explicit);
		// The shipped `scoped` network does not sandbox an explicit `off`.
		assert_eq!(settings.network_provenance, Provenance::Default);
		assert_eq!(settings.network_confinement(), NetworkConfinement::Unconfined);
		assert_eq!(network_confinement(&ctx, SandboxState::Off), NetworkConfinement::Unconfined);
	}

	#[test]
	fn network_confinement_follows_mode_and_provenance() {
		let settings = |mode, network_mode, network_provenance| SandboxSettings {
			mode,
			network_mode,
			network_provenance,
			..SandboxSettings::default()
		};
		let cases = [
			(
				ExecSandboxMode::Off,
				SandboxNetworkMode::Scoped,
				Provenance::Default,
				NetworkConfinement::Unconfined,
			),
			(
				ExecSandboxMode::Off,
				SandboxNetworkMode::Scoped,
				Provenance::Explicit,
				NetworkConfinement::Scoped,
			),
			(
				ExecSandboxMode::Off,
				SandboxNetworkMode::Disabled,
				Provenance::Explicit,
				NetworkConfinement::Unconfined,
			),
			(
				ExecSandboxMode::Off,
				SandboxNetworkMode::Open,
				Provenance::Explicit,
				NetworkConfinement::Unconfined,
			),
			(
				ExecSandboxMode::WorkspaceWrite,
				SandboxNetworkMode::Scoped,
				Provenance::Default,
				NetworkConfinement::Scoped,
			),
			(
				ExecSandboxMode::WorkspaceWrite,
				SandboxNetworkMode::Open,
				Provenance::Explicit,
				NetworkConfinement::Unconfined,
			),
			(
				ExecSandboxMode::ReadOnly,
				SandboxNetworkMode::Disabled,
				Provenance::Explicit,
				NetworkConfinement::Disabled,
			),
			(
				ExecSandboxMode::ReadOnly,
				SandboxNetworkMode::Scoped,
				Provenance::Explicit,
				NetworkConfinement::Scoped,
			),
		];
		for (mode, network, provenance, expected) in cases {
			assert_eq!(
				settings(mode, network, provenance).network_confinement(),
				expected,
				"{mode} with {provenance} {network}"
			);
		}

		let ctx = Ctx::new();
		SV_SANDBOX_MODE
			.set(&ctx, ExecSandboxMode::Off)
			.expect("set mode");
		SV_SANDBOX_NETWORK_MODE
			.set(&ctx, SandboxNetworkMode::Scoped)
			.expect("set network");
		let explicit = SandboxSettings::from_con(&ctx);
		assert_eq!(explicit.network_provenance, Provenance::Explicit);
		assert_eq!(explicit.network_confinement(), NetworkConfinement::Scoped);
		// A probe never compiles mode `off`; the explicit network-only sandbox
		// still confines.
		assert_eq!(network_confinement(&ctx, SandboxState::Off), NetworkConfinement::Scoped);
	}

	#[test]
	fn a_requested_sandbox_that_was_not_constructed_confines_no_network() {
		let ctx = Ctx::new();
		assert_eq!(network_confinement(&ctx, SandboxState::Active), NetworkConfinement::Scoped);
		for cause in [
			crate::admission::SandboxUnavailable::UnsupportedHost,
			crate::admission::SandboxUnavailable::BackendUnavailable,
			crate::admission::SandboxUnavailable::PolicyRejected,
		] {
			assert_eq!(
				network_confinement(&ctx, SandboxState::Unavailable { cause }),
				NetworkConfinement::Unconfined
			);
		}
		SV_SANDBOX_NETWORK_MODE
			.set(&ctx, SandboxNetworkMode::Disabled)
			.expect("set network");
		assert_eq!(network_confinement(&ctx, SandboxState::Active), NetworkConfinement::Disabled);
	}

	#[test]
	fn any_sandbox_convar_the_user_sets_makes_the_sandbox_explicit() {
		let ctx = Ctx::new();
		SV_SANDBOX_ALLOW_LOCALHOST
			.set(&ctx, true)
			.expect("set localhost");
		assert!(SandboxSettings::from_con(&ctx).explicit);
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
	fn network_session_reruns_default_to_four_and_project_a_set_bound() {
		assert_eq!(SandboxSettings::default().network_reruns, 4);
		let ctx = Ctx::new();
		assert_eq!(SandboxSettings::from_con(&ctx).network_reruns, 4);
		assert!(
			SV_SANDBOX_NETWORK_SESSION_RERUNS.set(&ctx, 0).is_err(),
			"the first approval always reruns, so zero cannot be honoured"
		);
		SV_SANDBOX_NETWORK_SESSION_RERUNS
			.set(&ctx, 2)
			.expect("valid bound");
		let settings = SandboxSettings::from_con(&ctx);
		assert_eq!(settings.network_reruns, 2);
		assert!(settings.explicit, "the bound is a sandbox setting the user chose");
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

	/// The protected locations are the canonical data-directory store and user
	/// extension root, so a spelling through a link cannot dodge the sandbox
	/// deny.
	#[cfg(unix)]
	#[test]
	fn protected_write_paths_are_the_canonical_store_and_extension_root() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().expect("tree");
		let real = fs::canonicalize(tree.path()).expect("canonical tree");
		fs::create_dir_all(real.join("data-real")).expect("data directory");
		fs::create_dir_all(real.join("home-real")).expect("home directory");
		symlink(real.join("data-real"), real.join("data")).expect("data link");
		symlink(real.join("home-real"), real.join("home")).expect("home link");

		// Both roots are handed over through links, as a launcher might receive them.
		let data_dir = real.join("data");
		let home = real.join("home");
		let extension_root = omp_core::dirs::profile_config_dir(&home)
			.expect("profile config root")
			.join("agent/extensions");
		// `<home>/.o2/agent/extensions`, unless a config override moved the root away.
		let canonical_extension_root = match extension_root.strip_prefix(&home) {
			Ok(inside) => real.join("home-real").join(inside),
			Err(_) => extension_root,
		};
		let mut expected = vec![real.join("data-real/ext"), canonical_extension_root];
		expected.sort_unstable();

		assert_eq!(protected_write_paths(&data_dir, &home), expected);
	}

	/// Two spellings of one location collapse to a single protected path.
	#[cfg(unix)]
	#[test]
	fn protected_write_paths_deduplicate_one_location() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().expect("tree");
		let real = fs::canonicalize(tree.path()).expect("canonical tree");
		let data_dir = real.join("data");
		let home = real.join("home");
		let extension_root = omp_core::dirs::profile_config_dir(&home)
			.expect("profile config root")
			.join("agent/extensions");
		if !extension_root.starts_with(&real) {
			eprintln!("skip: a config override places the extension root outside the test tree");
			return;
		}
		fs::create_dir_all(&extension_root).expect("extension root");
		fs::create_dir_all(&data_dir).expect("data directory");
		// The store resolves to the extension root, so both candidates name it.
		symlink(&extension_root, data_dir.join("ext")).expect("store link");

		assert_eq!(protected_write_paths(&data_dir, &home), [extension_root]);
	}

	/// Without a home directory only the data directory's store is protected,
	/// and it is canonical like the store of every other host.
	#[cfg(unix)]
	#[test]
	fn host_protected_paths_without_a_home_keep_the_canonical_store() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().expect("tree");
		let real = fs::canonicalize(tree.path()).expect("canonical tree");
		fs::create_dir(real.join("data-real")).expect("data directory");
		symlink(real.join("data-real"), real.join("data")).expect("data link");
		let data_dir = real.join("data");

		assert_eq!(protected_paths_for_host(Some(data_dir.as_path()), None), [
			real.join("data-real/ext")
		]);
		assert!(
			protected_paths_for_host(None, Some(real.as_path())).is_empty(),
			"a host without a data directory protects nothing"
		);
	}

	/// Settings without protected paths serialize exactly as before the field
	/// existed, so the daemon policy digest of such a posture is unchanged; the
	/// field defaults when absent and round-trips when set.
	#[test]
	fn empty_protected_write_paths_stay_out_of_serialized_settings() {
		let plain = serde_json::to_value(SandboxSettings::default()).expect("settings JSON");
		assert!(
			plain.get("protected_write_paths").is_none(),
			"empty protected paths changed the serialized settings: {plain}"
		);
		let restored: SandboxSettings =
			serde_json::from_value(plain).expect("settings without the field");
		assert_eq!(restored, SandboxSettings::default());

		let protected = SandboxSettings {
			protected_write_paths: vec![PathBuf::from("/srv/grants")],
			..SandboxSettings::default()
		};
		let value = serde_json::to_value(&protected).expect("settings JSON");
		assert_eq!(value["protected_write_paths"], serde_json::json!(["/srv/grants"]));
		assert_eq!(serde_json::from_value::<SandboxSettings>(value).expect("round trip"), protected);
	}

	/// A protected path that is not valid UTF-8 serializes as its lossy spelling
	/// plus the hex of its bytes, so the daemon policy digest never fails on it
	/// and distinct invalid paths stay distinct; the in-memory path stays exact.
	#[cfg(unix)]
	#[test]
	fn non_utf8_protected_write_paths_serialize_lossily() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let exact = PathBuf::from(OsStr::from_bytes(b"/srv/\xffstore"));
		let settings = SandboxSettings {
			protected_write_paths: vec![exact.clone()],
			..SandboxSettings::default()
		};
		let value = serde_json::to_value(&settings).expect("non-UTF-8 paths still serialize");
		let spelling = format!("/srv/\u{fffd}store\0{}", "2f7372762fff73746f7265");
		assert_eq!(value["protected_write_paths"], serde_json::json!([spelling]));
		assert_eq!(settings.protected_write_paths, [exact], "enforcement keeps the exact path");
		let restored: SandboxSettings = serde_json::from_value(value).expect("round trip");
		assert_eq!(restored.protected_write_paths, [PathBuf::from(spelling)]);
	}
}
