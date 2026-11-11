//! OS-level process containment via MXC (`mxc-sdk`), exported via N-API.
//!
//! One [`SandboxProcess`] is one contained process tree: seatbelt on macOS,
//! bubblewrap on Linux, processcontainer on Windows (MXC's
//! `Containment::Process`). The binding owns the translation from the JS
//! request (argv, explicit env, filesystem lists, network mode) to an MXC
//! `ContainerRequest`; policy decisions (which paths, which hosts) belong to
//! the caller.
//!
//! Output is streamed as raw bytes: each stream callback receives the data
//! chunks in order followed by exactly one zero-length chunk at EOF.

use std::{
	collections::HashMap,
	io::{self, Read, Write},
	sync::{Arc, LazyLock},
	thread,
	time::Duration,
};

use mxc_sdk::v1::{
	self, BackendCapability, ClipboardPolicy, ContainerRequest, Containment, FilesystemPolicy,
	MxcProcess, NetworkAction, NetworkEgressPolicy, NetworkIngressPolicy, NetworkPolicy,
	NetworkRuntimeConfig, ProxyEnforcement, RunOptions, SpawnOptions, TelemetryConfig, UiPolicy,
	WaitResult,
	configs::{ProcessContainerConfig, ProcessContainerFilesystem},
	policy::filesystem::{
		FilesystemPolicyResult, ToolsPolicyOptions, available_tools_policy, temporary_files_policy,
		user_profile_policy,
	},
};
use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use tokio::sync::{oneshot, watch};

use crate::{
	shell::{BRIDGE_QUEUE_CHUNKS, FORWARD_STALL_TIMEOUT},
	task,
};

/// MXC telemetry, opted out explicitly. On Windows MXC can emit ETW events
/// (routed to Microsoft only in builds with a provider group GUID, and only
/// with persisted user consent); omission is also off in mxc-sdk 1.0.1, but
/// stating it keeps every invocation off whatever a later SDK defaults to.
const TELEMETRY_OFF: Option<TelemetryConfig> = Some(TelemetryConfig { enabled: Some(false) });

// ---------------------------------------------------------------------------
// Host support
// ---------------------------------------------------------------------------

/// Containment availability on this host.
#[napi(object)]
#[derive(Clone)]
pub struct SandboxSupport {
	/// Whether `SandboxProcess.spawn` can contain processes on this host.
	pub supported: bool,
	/// The backend MXC selects for process containment.
	#[napi(ts_type = "\"seatbelt\" | \"bubblewrap\" | \"processcontainer\"")]
	pub backend:   Option<String>,
	/// Why containment is unavailable, with remediation when MXC supplies it.
	pub reason:    Option<String>,
	/// Loopback-proxy egress confinement is usable on this host. On bubblewrap
	/// `false` also means `network: "allow"` is refused: unrestricted egress
	/// runs through the same slirp-backed private namespace as the proxy.
	pub proxy:     bool,
	/// Capability diagnostics reported by MXC.
	pub warnings:  Vec<String>,
}

/// The process-containment backend `Containment::Process` resolves to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Backend {
	Seatbelt,
	Bubblewrap,
	ProcessContainer,
}

impl Backend {
	const fn wire_name(self) -> &'static str {
		match self {
			Self::Seatbelt => "seatbelt",
			Self::Bubblewrap => "bubblewrap",
			Self::ProcessContainer => "processcontainer",
		}
	}

	/// The backend `Containment::Process` selects on the running OS.
	fn for_host() -> Option<Self> {
		match std::env::consts::OS {
			"macos" => Some(Self::Seatbelt),
			"linux" => Some(Self::Bubblewrap),
			"windows" => Some(Self::ProcessContainer),
			_ => None,
		}
	}
}

/// Host facts the request mapping depends on, probed once per process.
struct HostSupport {
	support:             SandboxSupport,
	backend:             Option<Backend>,
	/// processcontainer only: the selected tier accepts
	/// `network.ingress.hostLoopback = allow` (the `AppContainer` fallback tiers
	/// reject it).
	host_loopback_allow: bool,
	/// processcontainer only: the native tier enforces `enumeratePaths`.
	enumerate_paths:     bool,
}

impl HostSupport {
	/// The backend to spawn with; without a usable one (including a
	/// processcontainer below the native tier) spawning is refused with the
	/// support reason rather than reaching MXC's fallbacks.
	fn usable_backend(&self) -> std::result::Result<Backend, String> {
		self.backend.ok_or_else(|| {
			self
				.support
				.reason
				.clone()
				.unwrap_or_else(|| "OS containment is unavailable on this host".to_owned())
		})
	}
}

static HOST_SUPPORT: LazyLock<HostSupport> = LazyLock::new(probe_host_support);

fn probe_host_support() -> HostSupport {
	let platform = v1::platform_support();
	let host_backend = Backend::for_host();
	let listed = host_backend.filter(|backend| {
		platform
			.available_methods
			.iter()
			.any(|method| method == backend.wire_name())
	});
	let mut warnings = Vec::new();
	let mut proxy = false;
	let mut host_loopback_allow = false;
	let mut enumerate_paths = false;
	let mut unavailable = None;
	match listed {
		Some(Backend::Seatbelt) => proxy = true,
		Some(Backend::Bubblewrap) => {
			if let Some(network) = platform.bubblewrap_network.as_ref() {
				proxy = network.proxy_enforcement == ProxyEnforcement::Supported;
				warnings.extend(network.warnings.iter().cloned());
			}
			// `platform_support` only runs `bwrap --version`; user namespaces can
			// still be blocked (AppArmor, container seccomp).
			unavailable = std::panic::catch_unwind(probe_bubblewrap)
				.unwrap_or_else(|_| Err("the Bubblewrap probe panicked".to_owned()))
				.err();
		},
		Some(Backend::ProcessContainer) => {
			// The processcontainer tier and its network capabilities are only
			// reported by the backend probe.
			match v1::available_backends()
				.into_iter()
				.find(|entry| entry.backend == Backend::ProcessContainer.wire_name())
			{
				Some(entry) => {
					unavailable = process_container_tier_support(entry.tier.as_deref()).err();
					proxy = entry
						.capabilities
						.contains(&BackendCapability::IdentitylessLoopbackProxy);
					host_loopback_allow = entry
						.capabilities
						.contains(&BackendCapability::IngressHostLoopbackAllow);
					enumerate_paths = process_container_enumerates();
				},
				None => {
					unavailable = Some("MXC reported no processcontainer backend".to_owned());
				},
			}
		},
		None => {},
	}
	let backend = listed.filter(|_| unavailable.is_none());
	let reason = if backend.is_some() {
		None
	} else {
		Some(
			unavailable
				.or_else(|| platform.reason.clone())
				.unwrap_or_else(|| match host_backend {
					Some(Backend::Bubblewrap) => "Bubblewrap is unavailable: MXC requires bwrap 0.5.0 \
					                              or newer and unprivileged user namespaces"
						.to_owned(),
					Some(other) => {
						format!("MXC {} containment is unavailable on this host", other.wire_name())
					},
					None => format!("MXC does not support {}", std::env::consts::OS),
				}),
		)
	};
	HostSupport {
		support: SandboxSupport {
			supported: backend.is_some(),
			backend: backend.map(|backend| backend.wire_name().to_owned()),
			reason,
			proxy: proxy && backend.is_some(),
			warnings,
		},
		backend,
		host_loopback_allow,
		enumerate_paths,
	}
}

/// Whether the processcontainer's native tier enforces `enumeratePaths`. Only
/// then is it requested: MXC would otherwise push the request to a fallback
/// tier omp refuses.
#[cfg(target_os = "windows")]
fn process_container_enumerates() -> bool {
	v1::probe(None).is_ok_and(|output| output.probes.base_container_supports_enumerate_paths)
}

#[cfg(not(target_os = "windows"))]
const fn process_container_enumerates() -> bool {
	false
}

/// The volume root (`C:\`, `\\server\share\`) of a Windows path, if it has one.
fn windows_volume_root(path: &str) -> Option<String> {
	let bytes = path.as_bytes();
	if bytes.len() >= 3
		&& bytes[0].is_ascii_alphabetic()
		&& bytes[1] == b':'
		&& matches!(bytes[2], b'\\' | b'/')
	{
		return Some(format!("{}:\\", char::from(bytes[0].to_ascii_uppercase())));
	}
	let unc = path
		.strip_prefix(r"\\")
		.or_else(|| path.strip_prefix("//"))?;
	let mut parts = unc.split(['\\', '/']).filter(|part| !part.is_empty());
	let (server, share) = (parts.next()?, parts.next()?);
	if server == "?" || server == "." {
		return None;
	}
	Some(format!(r"\\{server}\{share}\"))
}

/// processcontainer: the volume roots of every granted path, as query-only
/// `enumeratePaths`. The OS grants neither read nor query on a root no policy
/// path names, so `lstat("C:\")` fails, and with it every realpath that walks
/// from the root (Node runs no script file without one). Enumeration is
/// query-only and grants no file reads below the root; the roots themselves
/// are never in the read or write lists (a path in both lists would lose its
/// file reads).
fn volume_root_enumeration(policy: &SandboxPolicy, cwd: Option<&str>) -> Containment {
	let mut roots: Vec<String> = Vec::new();
	let paths = policy
		.readwrite_paths
		.iter()
		.chain(&policy.readonly_paths)
		.map(String::as_str)
		.chain(cwd);
	for root in paths.filter_map(windows_volume_root) {
		if !roots.iter().any(|known| known.eq_ignore_ascii_case(&root)) {
			roots.push(root);
		}
	}
	if roots.is_empty() {
		return Containment::Process;
	}
	let mut filesystem = ProcessContainerFilesystem::default();
	filesystem.enumerate_paths = roots;
	let mut config = ProcessContainerConfig::default();
	config.filesystem = Some(filesystem);
	Containment::ProcessContainer(config)
}

/// Native processcontainer containment needs the `BaseContainer` tier; the
/// `AppContainer` fallback tiers enforce filesystem policy by rewriting the
/// ACLs of host directories, which omp does not accept.
fn process_container_tier_support(tier: Option<&str>) -> std::result::Result<(), String> {
	match tier {
		Some("base-container") => Ok(()),
		other => Err(format!(
			"Windows processcontainer is only available at tier {}; native containment needs the \
			 Process Security Environment API of Windows 11 24H2 build 26100.9278 / 26200.9278 or \
			 newer (the AppContainer fallback would modify ACLs of host directories)",
			other.unwrap_or("unknown")
		)),
	}
}

/// Run `exit 0` contained with networking denied (bubblewrap's isolated mode,
/// no slirp tooling) to prove user namespaces work on this host. Every
/// top-level directory except the device/virtual trees is readable, so a
/// `/bin/sh` that resolves elsewhere (`/nix/store` on NixOS) still starts.
fn probe_bubblewrap() -> std::result::Result<(), String> {
	// An unreadable `/` leaves the list empty; the probe then fails with
	// MXC's own reason.
	let readonly_paths = std::fs::read_dir("/")
		.into_iter()
		.flatten()
		.flatten()
		.filter(|entry| !matches!(entry.file_name().to_str(), Some("dev" | "proc" | "sys")))
		// MXC refuses read-only paths the caller cannot read (`/root`,
		// `/lost+found`); listing the directory proves read access.
		.filter(|entry| std::fs::read_dir(entry.path()).is_ok())
		.map(|entry| entry.path().to_string_lossy().into_owned())
		.collect();
	let request = ContainerRequest {
		filesystem: Some(FilesystemPolicy { readonly_paths, ..Default::default() }),
		network: Some(network_policy(NetworkMode::Deny, None, Backend::Bubblewrap, false)?),
		environment: Some(vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())]),
		inherit_default_environment: Some(false),
		timeout_ms: Some(15_000),
		..ContainerRequest::new("exit 0")
	};
	let detail = match v1::run(request, RunOptions { telemetry: TELEMETRY_OFF }) {
		Ok(output) => match output.outcome {
			WaitResult::Exited(0) => return Ok(()),
			outcome => {
				let stderr = String::from_utf8_lossy(&output.stderr);
				let stderr = stderr.trim();
				if stderr.is_empty() {
					format!("{outcome:?}")
				} else {
					stderr.to_owned()
				}
			},
		},
		Err(error) => mxc_error(&error).reason,
	};
	Err(format!("Bubblewrap cannot start a sandbox on this host: {detail}"))
}

/// Report whether OS containment is available. Probed once per process; never
/// throws.
#[napi]
pub fn sandbox_support() -> SandboxSupport {
	HOST_SUPPORT.support.clone()
}

/// Directories MXC's policy helpers discover from an environment.
#[napi(object)]
pub struct SandboxDiscoveredPaths {
	/// Tool, SDK and user-profile program directories (PATH and well-known
	/// tool variables).
	pub readonly_paths:  Vec<String>,
	/// The temporary directory, plus tool directories that need write access.
	pub readwrite_paths: Vec<String>,
}

/// PATH/tool/profile/temp directories MXC's policy helpers discover for `env`.
#[napi]
#[allow(clippy::implicit_hasher, reason = "napi converts the JS record into the default HashMap")]
pub fn sandbox_discover_paths(env: HashMap<String, String>) -> SandboxDiscoveredPaths {
	let env: Vec<(String, String)> = env.into_iter().collect();
	let tools = available_tools_policy(Some(&env), ToolsPolicyOptions::default());
	let profile = user_profile_policy(Some(&env));
	let temp = temporary_files_policy(Some(&env));
	let mut readonly_paths = Vec::new();
	let mut readwrite_paths = Vec::new();
	for FilesystemPolicyResult { readonly_paths: ro, readwrite_paths: rw } in [tools, profile, temp]
	{
		push_unique(&mut readonly_paths, ro);
		push_unique(&mut readwrite_paths, rw);
	}
	SandboxDiscoveredPaths { readonly_paths, readwrite_paths }
}

fn push_unique(into: &mut Vec<String>, paths: Vec<String>) {
	for path in paths {
		if !into.contains(&path) {
			into.push(path);
		}
	}
}

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

/// Filesystem and network restrictions for one contained process.
#[napi(object, object_to_js = false)]
pub struct SandboxPolicy {
	/// Read-write grants.
	pub readwrite_paths: Vec<String>,
	/// Read-only grants.
	pub readonly_paths:  Vec<String>,
	/// No read, no write; outranks the other two lists.
	pub denied_paths:    Vec<String>,
	/// Network posture.
	#[napi(ts_type = "\"allow\" | \"deny\" | \"proxy\"")]
	pub network:         String,
	/// Required when network is "proxy": `http://127.0.0.1:<port>`.
	pub proxy_url:       Option<String>,
}

/// Options for [`SandboxProcess::spawn`].
#[napi(object, object_to_js = false)]
pub struct SandboxSpawnOptions {
	/// Program and arguments; delivered to the child byte-exact.
	pub argv:   Vec<String>,
	/// Working directory of the contained process.
	pub cwd:    Option<String>,
	/// Complete environment; nothing is inherited. On bubblewrap MXC passes it
	/// on the host-side `bwrap` command line, readable by other local users
	/// through `/proc/<pid>/cmdline` while the process runs.
	pub env:    HashMap<String, String>,
	/// Containment policy.
	pub policy: SandboxPolicy,
}

/// Network posture requested by the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NetworkMode {
	Allow,
	Deny,
	Proxy,
}

impl NetworkMode {
	fn parse(value: &str) -> std::result::Result<Self, String> {
		match value {
			"allow" => Ok(Self::Allow),
			"deny" => Ok(Self::Deny),
			"proxy" => Ok(Self::Proxy),
			other => Err(format!(
				"invalid sandbox network mode {other:?}; expected \"allow\", \"deny\" or \"proxy\""
			)),
		}
	}
}

/// Quote `argv` for `/bin/sh -c` (seatbelt) / `sh -c` (bubblewrap).
///
/// Every argument is single-quoted (`'` becomes `'\''`) so the shell performs
/// no expansion, and `exec` replaces the shell with the workload so signals
/// and the exit status are the workload's own.
fn unix_command_line(argv: &[String]) -> std::result::Result<String, String> {
	if argv.is_empty() {
		return Err("sandbox argv must not be empty".to_owned());
	}
	let mut command = String::from("exec");
	for arg in argv {
		if arg.contains('\0') {
			return Err("sandbox argv must not contain NUL bytes".to_owned());
		}
		command.push_str(" '");
		command.push_str(&arg.replace('\'', r"'\''"));
		command.push('\'');
	}
	Ok(command)
}

/// Quote `argv` into a Windows command line.
///
/// processcontainer hands the request's command verbatim to `CreateProcessW`
/// as `lpCommandLine` with no application name and no shell (both the
/// `BaseContainer` and `AppContainer` runners), so the child's C runtime
/// splits it with the `CommandLineToArgvW` rules. The program name is always
/// quoted (it cannot contain `"`: the first token ends at the next quote);
/// other arguments are quoted when empty or containing whitespace or `"`, with
/// backslashes doubled only where they precede a quote. Batch files are
/// refused: `cmd.exe` re-parses their arguments with different rules.
fn windows_command_line(argv: &[String]) -> std::result::Result<String, String> {
	let Some((program, args)) = argv.split_first() else {
		return Err("sandbox argv must not be empty".to_owned());
	};
	if argv.iter().any(|arg| arg.contains('\0')) {
		return Err("sandbox argv must not contain NUL bytes".to_owned());
	}
	if program.contains('"') {
		return Err(format!("sandbox program name must not contain '\"': {program}"));
	}
	let is_batch = std::path::Path::new(program)
		.extension()
		.is_some_and(|ext| ext.eq_ignore_ascii_case("bat") || ext.eq_ignore_ascii_case("cmd"));
	if is_batch {
		return Err(format!(
			"sandbox cannot run batch file {program} directly; cmd.exe re-parses batch arguments"
		));
	}
	let mut command = String::with_capacity(program.len() + 2);
	command.push('"');
	command.push_str(program);
	command.push('"');
	for arg in args {
		command.push(' ');
		push_windows_arg(&mut command, arg);
	}
	Ok(command)
}

fn push_windows_arg(command: &mut String, arg: &str) {
	let needs_quotes = arg.is_empty() || arg.contains([' ', '\t', '\n', '\x0b', '"']);
	if !needs_quotes {
		command.push_str(arg);
		return;
	}
	command.push('"');
	let mut backslashes = 0usize;
	for ch in arg.chars() {
		match ch {
			'\\' => backslashes += 1,
			'"' => {
				// Backslashes before a quote are doubled, plus one escapes the
				// quote itself.
				command.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
				command.push('"');
				backslashes = 0;
			},
			_ => {
				command.extend(std::iter::repeat_n('\\', backslashes));
				command.push(ch);
				backslashes = 0;
			},
		}
	}
	// Trailing backslashes precede the closing quote.
	command.extend(std::iter::repeat_n('\\', backslashes * 2));
	command.push('"');
}

/// Map a network posture to MXC's directional policy, within each backend's
/// own acceptance rules (MXC 1.0.1 sources):
///
/// - seatbelt: one egress default, an ingress default and host loopback; a
///   proxy needs `egress = deny` and a loopback endpoint; `hostLoopback =
///   allow` needs `ingress = allow`.
/// - bubblewrap: always a private network namespace, which refuses `ingress =
///   allow` and `hostLoopback = allow` outright; a proxy needs `egress = deny`
///   with no rules and an IPv4-loopback endpoint. Unrestricted egress (`allow`)
///   runs through the same slirp-backed namespace as the proxy, so it fails
///   where `SandboxSupport.proxy` is `false`.
/// - processcontainer: a proxy needs `egress = deny`, and the identity-less
///   host proxy needs `ingress` and `hostLoopback = allow`; the `AppContainer`
///   fallback tiers refuse `hostLoopback = allow`, so `allow` only grants it
///   when the host tier supports it.
fn network_policy(
	mode: NetworkMode,
	proxy_url: Option<&str>,
	backend: Backend,
	host_loopback_allow: bool,
) -> std::result::Result<NetworkPolicy, String> {
	let directional =
		|egress: NetworkAction, ingress: NetworkAction, host_loopback: NetworkAction| NetworkPolicy {
			egress:         Some(NetworkEgressPolicy { default: Some(egress), ..Default::default() }),
			ingress:        Some(NetworkIngressPolicy {
				default:       Some(ingress),
				host_loopback: Some(host_loopback),
			}),
			runtime_config: None,
		};
	use NetworkAction::{Allow, Deny};
	match mode {
		NetworkMode::Allow => Ok(match backend {
			Backend::Seatbelt => directional(Allow, Allow, Allow),
			Backend::Bubblewrap => directional(Allow, Deny, Deny),
			Backend::ProcessContainer => {
				directional(Allow, Allow, if host_loopback_allow { Allow } else { Deny })
			},
		}),
		NetworkMode::Deny => Ok(directional(Deny, Deny, Deny)),
		NetworkMode::Proxy => {
			let url =
				proxy_url.ok_or_else(|| "sandbox network \"proxy\" requires proxyUrl".to_owned())?;
			validate_proxy_url(url)?;
			let mut policy = match backend {
				Backend::Seatbelt | Backend::Bubblewrap => directional(Deny, Deny, Deny),
				Backend::ProcessContainer => directional(Deny, Allow, Allow),
			};
			policy.runtime_config = Some(NetworkRuntimeConfig { network_proxy: Some(url.to_owned()) });
			Ok(policy)
		},
	}
}

/// Accept only `http://127.0.0.1:<port>` / `http://localhost:<port>`: the one
/// endpoint form every backend confines to (bubblewrap rejects `[::1]`).
fn validate_proxy_url(url: &str) -> std::result::Result<(), String> {
	let invalid = || format!("sandbox proxyUrl must be http://127.0.0.1:<port>, got {url:?}");
	let rest = url.strip_prefix("http://").ok_or_else(invalid)?;
	let authority = rest.strip_suffix('/').unwrap_or(rest);
	let (host, port) = authority.rsplit_once(':').ok_or_else(invalid)?;
	if host != "127.0.0.1" && !host.eq_ignore_ascii_case("localhost") {
		return Err(invalid());
	}
	match port.parse::<u16>() {
		Ok(port) if port != 0 => Ok(()),
		_ => Err(invalid()),
	}
}

fn build_request(
	options: SandboxSpawnOptions,
	backend: Backend,
	host_loopback_allow: bool,
	windows: bool,
	enumerate_paths: bool,
) -> std::result::Result<ContainerRequest, String> {
	let SandboxSpawnOptions { argv, cwd, env, policy } = options;
	let command = if windows {
		windows_command_line(&argv)?
	} else {
		unix_command_line(&argv)?
	};
	let mode = NetworkMode::parse(&policy.network)?;
	let network = network_policy(mode, policy.proxy_url.as_deref(), backend, host_loopback_allow)?;
	let containment = if windows && enumerate_paths {
		volume_root_enumeration(&policy, cwd.as_deref())
	} else {
		Containment::Process
	};
	Ok(ContainerRequest {
		filesystem: Some(FilesystemPolicy {
			readwrite_paths:      policy.readwrite_paths,
			readonly_paths:       policy.readonly_paths,
			denied_paths:         policy.denied_paths,
			clear_policy_on_exit: None,
		}),
		network: Some(network),
		// MXC's default UI policy disables Win32k system calls, and every program
		// that links user32 (git, powershell, Git's bash, the pi_natives addon)
		// then dies in DLL init with STATUS_DLL_INIT_FAILED. Keep Win32k; the
		// job object still denies clipboard access and input injection.
		ui: windows.then_some(UiPolicy {
			disable:               false,
			clipboard:             ClipboardPolicy::None,
			allow_input_injection: false,
		}),
		containment,
		working_directory: cwd,
		environment: Some(env.into_iter().collect()),
		inherit_default_environment: Some(false),
		timeout_ms: None,
		..ContainerRequest::new(command)
	})
}

fn mxc_error(error: &v1::Error) -> Error {
	match error.remediation.as_deref() {
		Some(remediation) => Error::from_reason(format!("{error}. Remediation: {remediation}")),
		None => Error::from_reason(error.to_string()),
	}
}

// ---------------------------------------------------------------------------
// Process handle
// ---------------------------------------------------------------------------

type ChunkCallback = ThreadsafeFunction<Uint8Array, UnknownReturnValue>;

/// How a contained process ended.
#[napi(object)]
#[derive(Clone)]
pub struct SandboxExit {
	/// Exit code; `-1` when a signal terminated the process on Unix.
	pub exit_code: Option<i32>,
	/// The backend reported a timeout (never set: callers own timeouts).
	pub timed_out: bool,
}

type ExitOutcome = std::result::Result<SandboxExit, String>;

enum StdinOp {
	Write(Vec<u8>, oneshot::Sender<io::Result<()>>),
	Close,
}

struct Inner {
	pid:            u32,
	/// Present until the watcher observes the exit and finalizes the process.
	process:        Mutex<Option<MxcProcess>>,
	/// Warnings sampled when the process was finalized.
	final_warnings: Mutex<Vec<String>>,
	exit:           watch::Sender<Option<ExitOutcome>>,
	/// The stdin writer's queue; dropped when the process exits or the handle
	/// is collected, which ends the writer thread and closes the pipe.
	stdin:          Mutex<Option<flume::Sender<StdinOp>>>,
}

/// A process tree running inside an MXC container.
#[napi]
pub struct SandboxProcess {
	inner: Arc<Inner>,
}

#[napi]
impl SandboxProcess {
	/// Spawn `argv` contained by `policy`. Rejects with the MXC code, message
	/// and remediation when the request is refused or the backend cannot
	/// launch. Each callback receives output chunks, then one zero-length
	/// chunk at EOF.
	#[napi(ts_return_type = "Promise<SandboxProcess>")]
	pub fn spawn(
		env: &Env,
		options: SandboxSpawnOptions,
		#[napi(ts_arg_type = "(err: Error | null, chunk: Uint8Array) => void")]
		on_stdout: ChunkCallback,
		#[napi(ts_arg_type = "(err: Error | null, chunk: Uint8Array) => void")]
		on_stderr: ChunkCallback,
	) -> Result<PromiseRaw<'_, Self>> {
		let host = &*HOST_SUPPORT;
		// Every failure, including an invalid request, rejects the Promise.
		let request = host.usable_backend().and_then(|backend| {
			build_request(
				options,
				backend,
				host.host_loopback_allow,
				cfg!(target_os = "windows"),
				host.enumerate_paths,
			)
		});
		task::future(env, "sandbox.spawn", async move {
			let request = request.map_err(Error::from_reason)?;
			let process = tokio::task::spawn_blocking(move || {
				v1::spawn(request, SpawnOptions { telemetry: TELEMETRY_OFF })
			})
			.await
			.map_err(|err| Error::from_reason(format!("sandbox spawn task failed: {err}")))?
			.map_err(|err| mxc_error(&err))?;
			Ok(Self::start(process, on_stdout, on_stderr))
		})
	}

	/// The contained process id.
	#[napi(getter)]
	pub fn pid(&self) -> u32 {
		self.inner.pid
	}

	/// Policy and operational warnings reported by MXC for this container.
	#[napi(getter)]
	pub fn warnings(&self) -> Vec<String> {
		if let Some(process) = self.inner.process.lock().as_ref() {
			return process.warnings();
		}
		self.inner.final_warnings.lock().clone()
	}

	/// Write bytes to the process's stdin. Writes are delivered in call order.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn write<'env>(&self, env: &'env Env, data: Uint8Array) -> Result<PromiseRaw<'env, ()>> {
		let (reply_tx, reply_rx) = oneshot::channel();
		let queued = self
			.inner
			.stdin
			.lock()
			.as_ref()
			.is_some_and(|stdin| stdin.send(StdinOp::Write(data.to_vec(), reply_tx)).is_ok());
		task::future(env, "sandbox.write", async move {
			let closed = || Error::from_reason("sandbox stdin is closed");
			if !queued {
				return Err(closed());
			}
			match reply_rx.await {
				Ok(Ok(())) => Ok(()),
				Ok(Err(err)) => {
					Err(Error::from_reason(format!("Failed to write sandbox stdin: {err}")))
				},
				Err(_) => Err(closed()),
			}
		})
	}

	/// Close stdin after pending writes. Idempotent.
	#[napi]
	pub fn close_stdin(&self) {
		if let Some(stdin) = self.inner.stdin.lock().as_ref() {
			let _ = stdin.send(StdinOp::Close);
		}
	}

	/// Kill the whole contained process tree. Idempotent.
	#[napi]
	pub fn kill(&self) -> Result<()> {
		if let Some(process) = self.inner.process.lock().as_mut() {
			process.kill().map_err(|err| {
				Error::from_reason(format!("Failed to kill sandboxed process: {err}"))
			})?;
		}
		Ok(())
	}

	/// Resolves once the process exited.
	#[napi(ts_return_type = "Promise<SandboxExit>")]
	pub fn wait<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, SandboxExit>> {
		let mut exit = self.inner.exit.subscribe();
		task::future(env, "sandbox.wait", async move {
			let outcome = exit
				.wait_for(Option::is_some)
				.await
				.map_err(|_| Error::from_reason("sandbox process watcher stopped"))?
				.clone();
			match outcome {
				Some(Ok(exit)) => Ok(exit),
				Some(Err(message)) => Err(Error::from_reason(message)),
				None => Err(Error::from_reason("sandbox process watcher stopped")),
			}
		})
	}
}

impl SandboxProcess {
	/// Wire up stdio forwarding, the stdin writer and the exit watcher. Must run
	/// inside the napi Tokio runtime (the output pumps are Tokio tasks).
	fn start(mut process: MxcProcess, on_stdout: ChunkCallback, on_stderr: ChunkCallback) -> Self {
		let pid = process.id();
		forward_output(process.take_stdout(), on_stdout);
		forward_output(process.take_stderr(), on_stderr);
		let stdin = process.take_stdin();
		let (stdin_tx, stdin_rx) = flume::unbounded();
		thread::spawn(move || write_stdin(stdin, &stdin_rx));
		let (exit, _) = watch::channel(None);
		let inner = Arc::new(Inner {
			pid,
			process: Mutex::new(Some(process)),
			final_warnings: Mutex::new(Vec::new()),
			exit,
			stdin: Mutex::new(Some(stdin_tx)),
		});
		let watched = Arc::clone(&inner);
		thread::spawn(move || watch_exit(&watched));
		Self { inner }
	}
}

impl Drop for SandboxProcess {
	fn drop(&mut self) {
		self.inner.stdin.lock().take();
	}
}

/// Serialize stdin writes on one thread so they reach the child in call order
/// and a `Close` lands after every write queued before it.
fn write_stdin(mut stdin: Option<Box<dyn Write + Send>>, ops: &flume::Receiver<StdinOp>) {
	while let Ok(op) = ops.recv() {
		match op {
			StdinOp::Write(bytes, reply) => {
				let result = match stdin.as_mut() {
					Some(writer) => writer.write_all(&bytes).and_then(|()| writer.flush()),
					None => Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdin is closed")),
				};
				let _ = reply.send(result);
			},
			StdinOp::Close => stdin = None,
		}
	}
}

/// Poll for the exit (MXC's `wait` needs `&mut` for its whole duration, which
/// would lock out `kill`), then finalize: `wait` reaps and runs backend
/// teardown, and the process object is released so backends that keep pipe
/// ends until drop let the readers see EOF.
fn watch_exit(inner: &Inner) {
	const MAX_POLL: Duration = Duration::from_millis(50);
	let mut interval = Duration::from_millis(1);
	loop {
		let mut guard = inner.process.lock();
		let Some(process) = guard.as_mut() else {
			return;
		};
		let outcome = match process.try_wait() {
			Ok(None) => None,
			Ok(Some(_)) => Some(match process.wait() {
				Ok(WaitResult::Exited(code)) => {
					Ok(SandboxExit { exit_code: Some(code), timed_out: false })
				},
				Ok(WaitResult::TimedOut) => Ok(SandboxExit { exit_code: None, timed_out: true }),
				Err(err) => Err(format!("Failed to wait for sandboxed process: {err}")),
			}),
			Err(err) => {
				let _ = process.kill();
				Some(Err(format!("Failed to wait for sandboxed process: {err}")))
			},
		};
		if let Some(outcome) = outcome {
			*inner.final_warnings.lock() = process.warnings();
			let finished = guard.take();
			drop(guard);
			drop(finished);
			inner.stdin.lock().take();
			inner.exit.send_replace(Some(outcome));
			return;
		}
		drop(guard);
		thread::sleep(interval);
		interval = (interval * 2).min(MAX_POLL);
	}
}

/// Forward one output stream to `callback`: a reader thread feeds a bounded
/// queue (backpressuring the child through its pipe), and a Tokio pump
/// coalesces queued chunks into ≤64 KiB batches, awaiting each JS callback
/// before sending the next, then sends the zero-length EOF chunk.
fn forward_output(stream: Option<Box<dyn Read + Send>>, callback: ChunkCallback) {
	let Some(mut stream) = stream else {
		callback.call(Ok(Uint8Array::from(Vec::new())), ThreadsafeFunctionCallMode::NonBlocking);
		return;
	};
	let (tx, rx) = flume::bounded::<Vec<u8>>(BRIDGE_QUEUE_CHUNKS);
	thread::spawn(move || {
		let mut buf = vec![0u8; 64 * 1024];
		let mut forwarding = true;
		loop {
			match stream.read(&mut buf) {
				Ok(0) => break,
				// After the consumer is gone keep draining, so the child never
				// blocks on a full pipe.
				Ok(n) => forwarding = forwarding && tx.send(buf[..n].to_vec()).is_ok(),
				Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
				Err(_) => break,
			}
		}
	});
	napi::tokio::spawn(pump_output(rx, callback));
}

async fn pump_output(rx: flume::Receiver<Vec<u8>>, callback: ChunkCallback) {
	const MAX_BATCH_BYTES: usize = 64 * 1024;
	let mut consumer_alive = true;
	while let Ok(mut batch) = rx.recv_async().await {
		while batch.len() < MAX_BATCH_BYTES {
			match rx.try_recv() {
				Ok(more) => batch.extend_from_slice(&more),
				Err(_) => break,
			}
		}
		let forwarded = napi::tokio::time::timeout(
			FORWARD_STALL_TIMEOUT,
			callback.call_async(Ok(Uint8Array::from(batch))),
		)
		.await;
		if !matches!(forwarded, Ok(Ok(_))) {
			consumer_alive = false;
			break;
		}
	}
	// Disconnect the queue so the reader stops forwarding and only drains.
	drop(rx);
	let eof = Uint8Array::from(Vec::new());
	if consumer_alive {
		let _ = callback.call_async(Ok(eof)).await;
	} else {
		callback.call(Ok(eof), ThreadsafeFunctionCallMode::NonBlocking);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn args(values: &[&str]) -> Vec<String> {
		values.iter().map(|value| (*value).to_owned()).collect()
	}

	/// Inverse of [`push_windows_arg`]'s rules: the `CommandLineToArgvW`
	/// splitting of arguments after the program name.
	fn split_windows_args(line: &str) -> Vec<String> {
		let mut out = Vec::new();
		let mut chars = line.chars().peekable();
		loop {
			while chars.next_if(|ch| *ch == ' ' || *ch == '\t').is_some() {}
			if chars.peek().is_none() {
				return out;
			}
			let mut arg = String::new();
			let mut quoted = false;
			let mut backslashes = 0usize;
			while let Some(&ch) = chars.peek() {
				if !quoted && (ch == ' ' || ch == '\t') {
					break;
				}
				chars.next();
				match ch {
					'\\' => backslashes += 1,
					'"' => {
						arg.extend(std::iter::repeat_n('\\', backslashes / 2));
						if backslashes % 2 == 1 {
							arg.push('"');
						} else if quoted && chars.peek() == Some(&'"') {
							chars.next();
							arg.push('"');
						} else {
							quoted = !quoted;
						}
						backslashes = 0;
					},
					_ => {
						arg.extend(std::iter::repeat_n('\\', backslashes));
						backslashes = 0;
						arg.push(ch);
					},
				}
			}
			arg.extend(std::iter::repeat_n('\\', backslashes));
			out.push(arg);
		}
	}

	#[test]
	fn unix_command_line_quotes_every_argument_and_execs() {
		let argv = args(&["printf", "%s|", "a b", "it's", "$HOME", "`id`", "", "\\n\"x\""]);
		assert_eq!(
			unix_command_line(&argv).unwrap(),
			r#"exec 'printf' '%s|' 'a b' 'it'\''s' '$HOME' '`id`' '' '\n"x"'"#
		);
	}

	#[test]
	fn unix_command_line_round_trips_through_shlex() {
		let argv =
			args(&["/bin/echo", "-n", "a b", "it's", "$(x)", "\t", "\"", "'''", "line1\nline2", "ü"]);
		let line = unix_command_line(&argv).unwrap();
		let words = shlex::split(&line).unwrap();
		assert_eq!(words[0], "exec");
		assert_eq!(&words[1..], argv.as_slice());
	}

	#[test]
	fn command_lines_reject_empty_argv_and_nul() {
		assert!(unix_command_line(&[]).is_err());
		assert!(windows_command_line(&[]).is_err());
		assert!(unix_command_line(&args(&["a\0b"])).is_err());
		assert!(windows_command_line(&args(&["prog", "a\0b"])).is_err());
	}

	#[test]
	fn windows_command_line_quotes_program_and_escapes_arguments() {
		let argv = args(&[
			r"C:\Program Files\node.exe",
			"plain",
			"a b",
			"",
			r#"say "hi""#,
			r"C:\dir\",
			r#"tail\\"#,
		]);
		assert_eq!(
			windows_command_line(&argv).unwrap(),
			r#""C:\Program Files\node.exe" plain "a b" "" "say \"hi\"" C:\dir\ tail\\"#
		);
		let quoted_trailing = args(&["prog", r"a b\"]);
		assert_eq!(windows_command_line(&quoted_trailing).unwrap(), r#""prog" "a b\\""#);
	}

	#[test]
	fn windows_command_line_round_trips_through_argv_rules() {
		let argv = args(&[
			"prog.exe",
			"-n",
			"a b",
			"line1\nline2",
			"",
			r#"x"y"#,
			r#"\""#,
			r"trailing\",
			r"trail space \",
			r#"\\"\\"#,
			"$HOME %PATH%",
			"tab\there",
			"ü",
		]);
		let line = windows_command_line(&argv).unwrap();
		let rest = line.strip_prefix("\"prog.exe\"").unwrap();
		assert_eq!(split_windows_args(rest), argv[1..].to_vec());
	}

	#[test]
	fn windows_command_line_rejects_quoted_program_and_batch_files() {
		assert!(windows_command_line(&args(&["a\"b.exe"])).is_err());
		assert!(windows_command_line(&args(&["run.BAT", "x"])).is_err());
		assert!(windows_command_line(&args(&[r"C:\x\run.cmd"])).is_err());
	}

	fn actions(
		policy: &NetworkPolicy,
	) -> (NetworkAction, NetworkAction, NetworkAction, Option<String>) {
		let egress = policy.egress.as_ref().unwrap();
		let ingress = policy.ingress.as_ref().unwrap();
		(
			egress.default.unwrap(),
			ingress.default.unwrap(),
			ingress.host_loopback.unwrap(),
			policy
				.runtime_config
				.as_ref()
				.and_then(|config| config.network_proxy.clone()),
		)
	}

	#[test]
	fn network_mapping_per_backend() {
		use NetworkAction::{Allow, Deny};
		let proxy = Some("http://127.0.0.1:8080");
		let cases = [
			// Seatbelt: hostLoopback allow only alongside ingress allow.
			(NetworkMode::Allow, Backend::Seatbelt, false, (Allow, Allow, Allow, None)),
			// Bubblewrap refuses ingress and hostLoopback allow outright.
			(NetworkMode::Allow, Backend::Bubblewrap, false, (Allow, Deny, Deny, None)),
			(NetworkMode::Allow, Backend::ProcessContainer, true, (Allow, Allow, Allow, None)),
			// The AppContainer fallback refuses hostLoopback allow.
			(NetworkMode::Allow, Backend::ProcessContainer, false, (Allow, Allow, Deny, None)),
			(NetworkMode::Deny, Backend::Seatbelt, false, (Deny, Deny, Deny, None)),
			(NetworkMode::Deny, Backend::Bubblewrap, false, (Deny, Deny, Deny, None)),
			(NetworkMode::Deny, Backend::ProcessContainer, true, (Deny, Deny, Deny, None)),
			// Every backend needs egress deny under a proxy.
			(NetworkMode::Proxy, Backend::Seatbelt, false, (Deny, Deny, Deny, proxy)),
			(NetworkMode::Proxy, Backend::Bubblewrap, false, (Deny, Deny, Deny, proxy)),
			// The identity-less host proxy needs ingress and hostLoopback allow.
			(NetworkMode::Proxy, Backend::ProcessContainer, false, (Deny, Allow, Allow, proxy)),
		];
		for (mode, backend, loopback, (egress, ingress, host_loopback, url)) in cases {
			let policy = network_policy(mode, proxy, backend, loopback).unwrap();
			assert_eq!(
				actions(&policy),
				(egress, ingress, host_loopback, url.map(str::to_owned)),
				"{mode:?} on {backend:?} (hostLoopback capability {loopback})"
			);
		}
	}

	#[test]
	fn proxy_mode_requires_a_loopback_http_url() {
		for backend in [Backend::Seatbelt, Backend::Bubblewrap, Backend::ProcessContainer] {
			assert!(network_policy(NetworkMode::Proxy, None, backend, false).is_err());
			for bad in [
				"https://127.0.0.1:8080",
				"http://[::1]:8080",
				"http://10.0.0.1:8080",
				"http://127.0.0.1",
				"http://127.0.0.1:0",
				"http://user:pw@127.0.0.1:8080",
				"http://127.0.0.1:99999",
			] {
				assert!(
					network_policy(NetworkMode::Proxy, Some(bad), backend, false).is_err(),
					"{bad}"
				);
			}
			for good in ["http://127.0.0.1:8080", "http://localhost:1/"] {
				assert!(
					network_policy(NetworkMode::Proxy, Some(good), backend, false).is_ok(),
					"{good}"
				);
			}
		}
	}

	#[test]
	fn network_mode_parsing() {
		assert_eq!(NetworkMode::parse("allow").unwrap(), NetworkMode::Allow);
		assert_eq!(NetworkMode::parse("deny").unwrap(), NetworkMode::Deny);
		assert_eq!(NetworkMode::parse("proxy").unwrap(), NetworkMode::Proxy);
		assert!(NetworkMode::parse("allowlist").is_err());
	}

	#[test]
	fn request_carries_explicit_env_cwd_and_fs_lists() {
		let options = SandboxSpawnOptions {
			argv:   args(&["tool", "a b"]),
			cwd:    Some("/work".to_owned()),
			env:    HashMap::from([("PATH".to_owned(), "/bin".to_owned())]),
			policy: SandboxPolicy {
				readwrite_paths: args(&["/work"]),
				readonly_paths:  args(&["/usr"]),
				denied_paths:    args(&["/home/u/.ssh"]),
				network:         "deny".to_owned(),
				proxy_url:       None,
			},
		};
		let request = build_request(options, Backend::Seatbelt, false, false, false).unwrap();
		assert_eq!(request.working_directory.as_deref(), Some("/work"));
		assert_eq!(request.environment, Some(vec![("PATH".to_owned(), "/bin".to_owned())]));
		// `Some(true)` would overlay MXC's default PATH/HOME/TERM block onto the
		// caller's environment.
		assert_eq!(request.inherit_default_environment, Some(false));
		let fs = request.filesystem.unwrap();
		assert_eq!(fs.readwrite_paths, args(&["/work"]));
		assert_eq!(fs.readonly_paths, args(&["/usr"]));
		assert_eq!(fs.denied_paths, args(&["/home/u/.ssh"]));
	}

	#[test]
	fn request_uses_windows_quoting_for_windows_hosts() {
		let options = SandboxSpawnOptions {
			argv:   args(&["node.exe", "a b"]),
			cwd:    None,
			env:    HashMap::new(),
			policy: SandboxPolicy {
				readwrite_paths: Vec::new(),
				readonly_paths:  Vec::new(),
				denied_paths:    Vec::new(),
				network:         "allow".to_owned(),
				proxy_url:       None,
			},
		};
		let request = build_request(options, Backend::ProcessContainer, false, true, false).unwrap();
		assert_eq!(request.command, r#""node.exe" "a b""#);
		// MXC's default disables Win32k, which kills every user32 client (git,
		// powershell) in DLL init; clipboard and input injection stay denied.
		let ui = request
			.ui
			.expect("Windows requests carry an explicit UI policy");
		assert!(!ui.disable);
		assert!(matches!(ui.clipboard, ClipboardPolicy::None));
		assert!(!ui.allow_input_injection);
	}

	#[test]
	fn windows_requests_make_the_volume_roots_of_granted_paths_queryable() {
		let options = || SandboxSpawnOptions {
			argv:   args(&["node.exe", "app.js"]),
			cwd:    Some("D:\\work\\sub".to_owned()),
			env:    HashMap::new(),
			policy: SandboxPolicy {
				readwrite_paths: args(&["D:\\work", "C:\\Users\\u\\AppData\\Local\\Temp\\omp-sb-1"]),
				readonly_paths:  args(&["c:\\Users\\u", "\\\\server\\share\\tools"]),
				denied_paths:    args(&["C:\\Users\\u\\.ssh"]),
				network:         "deny".to_owned(),
				proxy_url:       None,
			},
		};
		let request = build_request(options(), Backend::ProcessContainer, false, true, true).unwrap();
		let Containment::ProcessContainer(config) = &request.containment else {
			panic!("expected explicit processcontainer containment, got {:?}", request.containment);
		};
		let filesystem = config.filesystem.as_ref().expect("enumerate paths");
		assert_eq!(filesystem.enumerate_paths, args(&["D:\\", "C:\\", "\\\\server\\share\\"]));

		// Requesting enumeration where PSEC cannot enforce it would push MXC to a
		// fallback tier that rewrites host ACLs.
		let request =
			build_request(options(), Backend::ProcessContainer, false, true, false).unwrap();
		assert_eq!(request.containment, Containment::Process);
	}

	#[test]
	fn process_container_requires_the_native_tier() {
		assert!(process_container_tier_support(Some("base-container")).is_ok());
		for tier in [Some("appcontainer-bfs"), Some("appcontainer-dacl"), None] {
			let reason = process_container_tier_support(tier).unwrap_err();
			assert!(reason.contains("26100.9278"), "{reason}");
		}
	}

	#[test]
	fn spawn_is_refused_with_the_reason_when_no_backend_is_usable() {
		let host = |backend: Option<Backend>, reason: Option<&str>| HostSupport {
			support: SandboxSupport {
				supported: backend.is_some(),
				backend:   backend.map(|backend| backend.wire_name().to_owned()),
				reason:    reason.map(str::to_owned),
				proxy:     false,
				warnings:  Vec::new(),
			},
			backend,
			host_loopback_allow: false,
			enumerate_paths: false,
		};
		assert_eq!(
			host(Some(Backend::ProcessContainer), None).usable_backend(),
			Ok(Backend::ProcessContainer)
		);
		assert_eq!(
			host(None, Some("tier appcontainer-dacl")).usable_backend(),
			Err("tier appcontainer-dacl".to_owned())
		);
	}
}
