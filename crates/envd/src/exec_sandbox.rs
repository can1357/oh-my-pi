//! Sandboxing policy compiled per execution owner.

use std::{
	borrow::Cow,
	collections::VecDeque,
	ffi::{OsStr, OsString},
	fs, io,
	path::{Component, Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use omp_core::{Str, StrMut, sf};
use omp_sandbox::{
	Capability, CommandWrapper, DegradationPolicy, EnvironmentSource, NetworkMode,
	RUNTIME_READ_ROOTS, ResourceLimits, Runner, SandboxError, SandboxSpec, WriteMode,
};
use omp_shell::{
	OpenError, OpenRequest, PathAccess, PathDenied, PathPolicy, SpawnWrapper, sys::fs::PathExt as _,
};
use parking_lot::Mutex;

#[cfg(test)]
use crate::exec_settings::SandboxNetworkMode;
use crate::{
	admission::{SandboxState, SandboxUnavailable},
	exec_network_diag::is_network_url,
	exec_settings::{
		EnvironmentInheritance, ExecSandboxMode, NetworkConfinement, ReadMode, SandboxSettings,
		UnscopedWrites,
	},
	sandbox_proxy::{BrokerDenial, BrokerRefusal, EgressGrants, ScopedProxy},
};

const CARVE_OUTS: [&str; 3] = [".git", ".omp", ".agents"];

/// One fact established by a sandboxed command attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SandboxDenialFact {
	/// An in-process or kernel policy rejected a read.
	ReadPath(PathBuf),
	/// An in-process or kernel policy rejected a mutation.
	WritePath(PathBuf),
	/// The scoped egress broker's policy rejected this exact connection, which
	/// the user can approve for one rerun or for the rest of the session. A
	/// refusal that no approval could cure (an explicit deny rule, the name
	/// did not resolve, it is not a public address, the upstream failed) is
	/// never this fact; see [`AttemptFacts::refusal`].
	Network {
		/// Requested hostname.
		host: Str,
		/// Requested TCP port.
		port: u16,
	},
	/// The diagnostic is permission-like but cannot support a narrow grant.
	Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
enum ApprovedPathAccess {
	Read,
	Write,
}

/// Immutable path authority captured before a user approves a one-shot rerun.
#[derive(Clone, Debug)]
pub(crate) struct ApprovedPathScope {
	access:        ApprovedPathAccess,
	scope:         PathBuf,
	display_scope: PathBuf,
	identity:      PathIdentity,
	/// A handle on the captured scope, held while the approval is pending so
	/// its inode stays allocated: ext4 and tmpfs hand a removed directory's
	/// inode number to the next one created, so a replacement would otherwise
	/// carry the same identity. Absent only when the scope could not be
	/// opened; `verify` then has the identity alone.
	#[cfg(unix)]
	_anchor:       Option<Arc<rustix::fd::OwnedFd>>,
}

impl ApprovedPathScope {
	fn capture(path: &Path, access: ApprovedPathAccess) -> io::Result<Self> {
		let requested = normalize_absolute(&std::path::absolute(path)?)?;
		let scope = nearest_existing_scope(&requested)?;
		#[cfg(unix)]
		{
			// The identity is read from the held handle, so it describes exactly
			// the object the anchor keeps alive.
			let anchor = PathIdentity::anchor(&scope);
			let identity = match &anchor {
				Some(anchor) => PathIdentity::of_handle(anchor)?,
				None => PathIdentity::capture(&scope)?,
			};
			Ok(Self {
				access,
				display_scope: scope.clone(),
				scope,
				identity,
				_anchor: anchor.map(Arc::new),
			})
		}
		#[cfg(not(unix))]
		{
			let identity = PathIdentity::capture(&scope)?;
			Ok(Self { access, display_scope: scope.clone(), scope, identity })
		}
	}

	/// Formats the immutable access and path shown in approval prompts.
	pub(crate) fn label(&self) -> Str {
		let access: &'static str = self.access.into();
		sf!("{access} {}", self.display_scope.display())
	}

	fn verify(&self) -> io::Result<()> {
		if PathIdentity::capture(&self.scope)? == self.identity {
			Ok(())
		} else {
			Err(io::Error::other("approved path scope identity changed"))
		}
	}
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PathIdentity {
	device: u64,
	inode:  u64,
}

#[cfg(unix)]
impl PathIdentity {
	fn capture(path: &Path) -> io::Result<Self> {
		use std::os::unix::fs::MetadataExt as _;

		let metadata = fs::metadata(path)?;
		Ok(Self { device: metadata.dev(), inode: metadata.ino() })
	}

	/// Opens a handle that keeps `path`'s inode allocated without needing read
	/// permission on it where the platform allows (`O_PATH` on Linux).
	fn anchor(path: &Path) -> Option<rustix::fd::OwnedFd> {
		use rustix::fs::{Mode, OFlags};

		#[cfg(any(target_os = "linux", target_os = "android"))]
		let flags = OFlags::PATH | OFlags::CLOEXEC;
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		let flags = OFlags::RDONLY | OFlags::CLOEXEC;
		rustix::fs::open(path, flags, Mode::empty()).ok()
	}

	fn of_handle(handle: &rustix::fd::OwnedFd) -> io::Result<Self> {
		use std::os::unix::fs::MetadataExt as _;

		let metadata = fs::File::from(handle.try_clone()?).metadata()?;
		Ok(Self { device: metadata.dev(), inode: metadata.ino() })
	}
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PathIdentity {
	volume_serial: Option<u32>,
	file_index:    Option<u64>,
}

#[cfg(windows)]
impl PathIdentity {
	fn capture(path: &Path) -> io::Result<Self> {
		use std::os::windows::fs::MetadataExt as _;

		let metadata = fs::metadata(path)?;
		Ok(Self {
			volume_serial: metadata.volume_serial_number(),
			file_index:    metadata.file_index(),
		})
	}
}

#[cfg(not(any(unix, windows)))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct PathIdentity(PathBuf);

#[cfg(not(any(unix, windows)))]
impl PathIdentity {
	fn capture(path: &Path) -> io::Result<Self> {
		fs::canonicalize(path).map(Self)
	}
}

/// What a compiled sandbox is for, which decides how a `scoped` network is
/// realised.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SandboxConsumer {
	/// A shell session. Each command attempt holds a broker capability token,
	/// so a scoped network starts the session's egress broker.
	Session,
	/// An eval worker or a detached process. Neither ever holds an attempt
	/// token, so the broker would refuse every request it made: a scoped
	/// network compiles as disabled and starts no broker.
	Child,
	/// A construction probe. Nothing runs under it, so a scoped network
	/// compiles without starting a broker.
	Probe,
}

/// Where a compile takes its network from.
enum NetworkSource {
	/// A first compile: the settings and the consumer decide.
	Fresh(SandboxConsumer),
	/// A path amendment keeps the session's resolved network and its broker,
	/// so a session that fell back to a disabled network stays disabled.
	Reuse { confinement: NetworkConfinement, proxy: Option<Arc<ScopedProxy>> },
}

/// The network one compiled wrapper applies.
struct ResolvedNetwork {
	confinement:        NetworkConfinement,
	mode:               NetworkMode,
	proxy:              Option<Arc<ScopedProxy>>,
	/// The scoped broker could not start under the shipped default, so the
	/// network is disabled instead.
	broker_unavailable: bool,
}

impl ResolvedNetwork {
	const fn unconfined() -> Self {
		Self {
			confinement:        NetworkConfinement::Unconfined,
			mode:               NetworkMode::Enabled,
			proxy:              None,
			broker_unavailable: false,
		}
	}

	const fn disabled(broker_unavailable: bool) -> Self {
		Self {
			confinement: NetworkConfinement::Disabled,
			mode: NetworkMode::Disabled,
			proxy: None,
			broker_unavailable,
		}
	}

	const fn scoped(proxy: Option<Arc<ScopedProxy>>) -> Self {
		Self {
			confinement: NetworkConfinement::Scoped,
			mode: NetworkMode::Outbound,
			proxy,
			broker_unavailable: false,
		}
	}
}

/// Precompiled kernel launcher and matching in-process file policy.
pub(crate) struct ExecSandbox {
	wrapper:      Arc<CommandWrapper>,
	file_policy:  FilePolicy,
	failure_note: Str,
	settings:     Arc<SandboxSettings>,
	workspace:    Arc<PathBuf>,
	supervised:   bool,
	/// The confinement this wrapper really applies: `disabled` after a broker
	/// fallback even though the settings ask for `scoped`.
	network:      NetworkConfinement,
	proxy:        Option<Arc<ScopedProxy>>,
}

/// What one finished execution attempt established.
#[derive(Debug, Default)]
pub(crate) struct AttemptFacts {
	/// The typed denial the denial-and-rerun flow judges: a refused path, or
	/// the broker's policy refusal as [`SandboxDenialFact::Network`]. A
	/// fail-closed broker refusal is never one, so a name that does not
	/// resolve stays an ordinary command failure rather than a denial.
	pub(crate) denial:          Option<SandboxDenialFact>,
	/// The egress broker's refusal of any cause, for the model-visible
	/// network diag. It is kept even when a path denial takes precedence.
	pub(crate) refusal:         Option<BrokerDenial>,
	/// A program the attempt launched, one that exists and can run, was given
	/// a network URL while the attempt had no network at all, the only sign a
	/// quiet client leaves there: no backend records a connection its kernel
	/// refuses.
	pub(crate) network_locator: bool,
}

/// One unforgeable execution attempt within an [`ExecSandbox`] session.
pub(crate) struct ExecSandboxAttempt {
	sandbox:         Arc<ExecSandbox>,
	denial:          Mutex<Option<SandboxDenialFact>>,
	token:           Option<Str>,
	finished:        AtomicBool,
	network_locator: AtomicBool,
}

#[derive(Clone)]
struct FilePolicy {
	writable:        Arc<[PathBuf]>,
	write_denied:    Arc<[PathBuf]>,
	readable:        Arc<[PathBuf]>,
	read_denied:     Arc<[PathBuf]>,
	read_restricted: bool,
	read_amendment:  Option<PathBuf>,
	write_amendment: Option<PathBuf>,
}

struct PolicyParts {
	spec:           SandboxSpec,
	file_policy:    FilePolicy,
	roots_label:    Str,
	inactive_roots: Arc<[PathBuf]>,
	#[cfg(test)]
	spec_snapshot:  Str,
}

impl ExecSandbox {
	/// Compiles one native command wrapper for one execution owner.
	pub(crate) fn compile(
		settings: &SandboxSettings,
		workspace_root: &Path,
		supervised: bool,
		consumer: SandboxConsumer,
	) -> Result<Option<Arc<Self>>, SandboxError> {
		Self::compile_amended(
			settings,
			workspace_root,
			supervised,
			NetworkSource::Fresh(consumer),
			None,
			None,
		)
	}

	fn compile_amended(
		settings: &SandboxSettings,
		workspace_root: &Path,
		supervised: bool,
		network: NetworkSource,
		amendment: Option<&SandboxDenialFact>,
		approved_scope: Option<&ApprovedPathScope>,
	) -> Result<Option<Arc<Self>>, SandboxError> {
		if let Some(scope) = approved_scope {
			scope
				.verify()
				.map_err(|source| SandboxError::Canonicalize {
					path: scope.display_scope.clone(),
					source,
				})?;
		}
		let requested = match &network {
			NetworkSource::Fresh(_) => settings.network_confinement(),
			NetworkSource::Reuse { confinement, .. } => *confinement,
		};
		if settings.mode == ExecSandboxMode::Off && requested != NetworkConfinement::Scoped {
			return if settings.environment_policy_is_default()
				&& settings.read_mode == ReadMode::Host
				&& settings.readable_roots.is_empty()
				&& settings.read_deny.is_empty()
				&& settings.read_deny_globs.is_empty()
			{
				Ok(None)
			} else {
				// No launcher applies this spec's network; only its environment
				// and the in-process file policy are used.
				let mut parts = policy_parts_with_approved_scope(
					settings,
					workspace_root,
					WriteMode::Scoped,
					NetworkMode::Enabled,
					None,
					amendment,
					approved_scope,
				)?;
				parts.spec.set_supervised(supervised);
				let wrapper = CommandWrapper::environment_only(&parts.spec);
				let mut note = StrMut::new("sandbox: backend=environment-only");
				for root in parts.inactive_roots.iter() {
					note.push_str("; inactive root=");
					note.push_str(root.to_string_lossy().as_ref());
				}
				Ok(Some(Arc::new(Self {
					wrapper: Arc::new(wrapper),
					file_policy: parts.file_policy,
					failure_note: note.freeze(),
					settings: Arc::new(settings.clone()),
					workspace: Arc::new(workspace_root.to_path_buf()),
					supervised,
					network: NetworkConfinement::Unconfined,
					proxy: None,
				})))
			};
		}
		let runner = Runner::native_command()?;
		let network = resolve_network(settings, requested, network, amendment).map_err(|source| {
			SandboxError::BackendIo {
				backend: runner.backend(),
				operation: omp_sandbox::SandboxOperation::Compile,
				source,
			}
		})?;
		let proxy = network.proxy.clone();
		let requested_write = if settings.mode == ExecSandboxMode::WorkspaceWrite
			&& settings.unscoped_writes == UnscopedWrites::Overlay
		{
			WriteMode::Overlay
		} else if settings.mode == ExecSandboxMode::WorkspaceWrite {
			WriteMode::Scoped
		} else if settings.mode == ExecSandboxMode::Off {
			// A network- or environment-only sandbox preserves the host filesystem
			// view; the explicit root satisfies native scoped-write backends.
			WriteMode::Scoped
		} else {
			WriteMode::Deny
		};
		let parts = policy_parts_with_approved_scope(
			settings,
			workspace_root,
			requested_write,
			network.mode,
			proxy.as_deref(),
			amendment,
			approved_scope,
		)?;
		let mut parts = parts;
		parts.spec.set_supervised(supervised);
		let (wrapper, parts, degraded) = match runner.wrap_template(&parts.spec) {
			Ok(wrapper) => (wrapper, parts, false),
			Err(source) if requested_write == WriteMode::Overlay && capability_failure(&source) => {
				let scoped = policy_parts_with_approved_scope(
					settings,
					workspace_root,
					WriteMode::Scoped,
					network.mode,
					proxy.as_deref(),
					amendment,
					approved_scope,
				)?;
				let wrapper = runner.wrap_template(&scoped.spec)?;
				(wrapper, scoped, true)
			},
			Err(source) => return Err(source),
		};
		let mut note = StrMut::new("sandbox: backend=");
		note.push_str(<&'static str>::from(runner.backend()));
		note.push_str("; mode=");
		note.push_str(<&'static str>::from(settings.mode));
		note.push_str("; writes outside ");
		note.push_str(parts.roots_label.as_str());
		note.push_str(" are denied");
		note.push_str("; network=");
		note.push_str(<&'static str>::from(network.confinement));
		if network.broker_unavailable {
			note.push_str(" (scoped broker unavailable)");
		}
		if degraded {
			note.push_str("; overlay unavailable, using scoped writes");
		}
		for caveat in wrapper.caveats() {
			note.push_str("; ");
			note.push_str(caveat.message.as_str());
		}
		for root in parts.inactive_roots.iter() {
			note.push_str("; inactive root=");
			note.push_str(root.to_string_lossy().as_ref());
		}
		Ok(Some(Arc::new(Self {
			wrapper: Arc::new(wrapper),
			file_policy: parts.file_policy,
			failure_note: note.freeze(),
			settings: Arc::new(settings.clone()),
			workspace: Arc::new(workspace_root.to_path_buf()),
			supervised,
			network: network.confinement,
			proxy,
		})))
	}

	/// Returns the once-per-session effective sandbox diagnostic.
	pub(crate) fn session_note(&self) -> &Str {
		&self.failure_note
	}

	/// The network confinement this wrapper really applies.
	pub(crate) const fn network(&self) -> NetworkConfinement {
		self.network
	}

	/// Most reruns one command may take on network endpoints approved for the
	/// session (`sv_sandbox_network_session_reruns`).
	pub(crate) fn network_reruns(&self) -> u32 {
		self.settings.network_reruns
	}

	/// The network confinement the settings asked for. For a shell session it
	/// differs from [`Self::network`] only when the egress broker could not
	/// start under the shipped default and the network fell back to disabled.
	pub(crate) fn requested_network(&self) -> NetworkConfinement {
		self.settings.network_confinement()
	}

	/// Captures the immutable filesystem authority implicated by `denial`.
	///
	/// The caller must capture this before asking for approval and pass the
	/// returned value to [`Self::amended_scope`] after approval.
	pub(crate) fn freeze_amendment(&self, denial: &SandboxDenialFact) -> Option<ApprovedPathScope> {
		let (path, access) = match denial {
			SandboxDenialFact::ReadPath(path) => (path, ApprovedPathAccess::Read),
			SandboxDenialFact::WritePath(path) => (path, ApprovedPathAccess::Write),
			SandboxDenialFact::Network { .. } | SandboxDenialFact::Unknown => return None,
		};
		ApprovedPathScope::capture(path, access).ok()
	}

	/// Compiles a fresh one-shot policy using a previously frozen path scope.
	///
	/// The rerun keeps this session's resolved network and broker: a session
	/// whose broker could not start stays network-disabled.
	pub(crate) fn amended_scope(
		&self,
		scope: &ApprovedPathScope,
	) -> Result<Option<Arc<Self>>, SandboxError> {
		Self::compile_amended(
			&self.settings,
			&self.workspace,
			self.supervised,
			NetworkSource::Reuse { confinement: self.network, proxy: self.proxy.clone() },
			None,
			Some(scope),
		)
	}

	/// Compiles a fresh one-shot policy allowing one broker endpoint.
	///
	/// Only a session that owns a broker can be amended this way; any other
	/// session has no broker endpoint to widen.
	pub(crate) fn amended_network(
		&self,
		amendment: &SandboxDenialFact,
	) -> Result<Option<Arc<Self>>, SandboxError> {
		let SandboxDenialFact::Network { .. } = amendment else {
			return Ok(None);
		};
		if self.proxy.is_none() {
			return Ok(None);
		}
		Self::compile_amended(
			&self.settings,
			&self.workspace,
			self.supervised,
			NetworkSource::Fresh(SandboxConsumer::Session),
			Some(amendment),
			None,
		)
	}

	/// An environment-only session wrapper that owns a started egress broker,
	/// so broker refusals can be exercised on hosts with no native backend.
	#[cfg(test)]
	pub(crate) fn with_test_broker(settings: &SandboxSettings, workspace_root: &Path) -> Arc<Self> {
		let proxy = Arc::new(ScopedProxy::start(settings).expect("test broker starts"));
		let parts = policy_parts_with_approved_scope(
			settings,
			workspace_root,
			WriteMode::Scoped,
			NetworkMode::Outbound,
			Some(&proxy),
			None,
			None,
		)
		.expect("test policy");
		Arc::new(Self {
			wrapper:      Arc::new(CommandWrapper::environment_only(&parts.spec)),
			file_policy:  parts.file_policy,
			failure_note: Str::new_static("sandbox: backend=environment-only; network=scoped"),
			settings:     Arc::new(settings.clone()),
			workspace:    Arc::new(workspace_root.to_path_buf()),
			supervised:   true,
			network:      NetworkConfinement::Scoped,
			proxy:        Some(proxy),
		})
	}

	/// An environment-only session wrapper that reports a disabled network,
	/// so what a session with no network records and reports can be exercised
	/// on hosts with no native backend. Nothing enforces that network: only
	/// the wrapper's own account of it is under test. `settings` decide whether
	/// it reads as `disabled` or as a scoped broker that could not start.
	#[cfg(test)]
	pub(crate) fn with_test_disabled_network(
		settings: &SandboxSettings,
		workspace_root: &Path,
	) -> Arc<Self> {
		let parts = policy_parts_with_approved_scope(
			settings,
			workspace_root,
			WriteMode::Scoped,
			NetworkMode::Disabled,
			None,
			None,
			None,
		)
		.expect("test policy");
		Arc::new(Self {
			wrapper:      Arc::new(CommandWrapper::environment_only(&parts.spec)),
			file_policy:  parts.file_policy,
			failure_note: Str::new_static("sandbox: backend=environment-only; network=disabled"),
			settings:     Arc::new(settings.clone()),
			workspace:    Arc::new(workspace_root.to_path_buf()),
			supervised:   true,
			network:      NetworkConfinement::Disabled,
			proxy:        None,
		})
	}

	/// Opens one isolated denial collection interval for an execution attempt.
	///
	/// `grants` are the session egress grants of the approval binding that
	/// issued the command; the session's broker admits them live for this
	/// attempt only.
	pub(crate) fn begin_attempt(
		self: &Arc<Self>,
		grants: Option<&EgressGrants>,
	) -> Arc<ExecSandboxAttempt> {
		let token = self
			.proxy
			.as_ref()
			.map(|proxy| proxy.begin_attempt(grants.cloned()));
		Arc::new(ExecSandboxAttempt {
			sandbox: Arc::clone(self),
			denial: Mutex::new(None),
			token,
			finished: AtomicBool::new(false),
			network_locator: AtomicBool::new(false),
		})
	}

	/// Creates a launcher command followed by the real program and arguments.
	pub(crate) fn command(&self, program: &OsStr, args: &[&OsStr]) -> std::process::Command {
		let mut command = std::process::Command::new(self.wrapper.launcher().unwrap_or(program));
		if self.wrapper.launcher().is_some() {
			command.args(self.wrapper.prefix_args()).arg(program);
		}
		command.args(args);
		command
	}

	/// Creates an asynchronous launcher command prefixed with the real program.
	pub(crate) fn tokio_command(&self, program: &OsStr) -> tokio::process::Command {
		let mut command = tokio::process::Command::new(self.wrapper.launcher().unwrap_or(program));
		if self.wrapper.launcher().is_some() {
			command.args(self.wrapper.prefix_args()).arg(program);
		}
		command
	}

	/// Applies the compiled child environment policy.
	pub(crate) fn resolve_env<I>(&self, environment: I) -> Vec<(OsString, OsString)>
	where
		I: IntoIterator<Item = (OsString, OsString)>,
	{
		self.wrapper.resolve_env(environment)
	}
}

impl ExecSandboxAttempt {
	/// Consumes this attempt's path denial, broker refusal and network
	/// locator, and invalidates its proxy capability. A path denial takes
	/// precedence over a policy refusal as the attempt's denial.
	pub(crate) fn take_facts(&self) -> AttemptFacts {
		let path_denial = self.denial.lock().take();
		let refusal = (!self.finished.swap(true, Ordering::AcqRel))
			.then(|| {
				self
					.token
					.as_ref()
					.and_then(|token| self.sandbox.proxy.as_ref()?.finish_attempt(token))
			})
			.flatten();
		let denial = path_denial.or_else(|| {
			refusal
				.as_ref()
				.filter(|refusal| refusal.cause == BrokerRefusal::Policy)
				.map(|refusal| SandboxDenialFact::Network {
					host: refusal.host.clone(),
					port: refusal.port,
				})
		});
		let network_locator = self.network_locator.swap(false, Ordering::AcqRel);
		AttemptFacts { denial, refusal, network_locator }
	}

	/// Asks the session broker, with this attempt's capability, to tunnel to
	/// `host:port`, and returns the broker's response head: the status line and
	/// headers, as `curl -v` prints them.
	#[cfg(test)]
	pub(crate) fn connect_through_broker(&self, host: &str, port: u16) -> String {
		use std::io::{BufRead as _, Write as _};

		let proxy = self.sandbox.proxy.as_ref().expect("session broker");
		let token = self.token.as_ref().expect("attempt capability");
		let credential =
			omp_core::encoding::base64::encode(format!("omp:{token}").as_bytes()).into_string();
		#[cfg(target_os = "linux")]
		let mut stream = std::os::unix::net::UnixStream::connect(proxy.socket()).expect("broker socket");
		#[cfg(not(target_os = "linux"))]
		let mut stream = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, proxy.port()))
			.expect("broker port");
		write!(
			stream,
			"CONNECT {host}:{port} HTTP/1.1\r\nProxy-Authorization: Basic {credential}\r\n\r\n"
		)
		.expect("request");
		let mut reader = std::io::BufReader::new(stream);
		let mut head = String::new();
		while !head.ends_with("\r\n\r\n") {
			if reader.read_line(&mut head).expect("broker response head") == 0 {
				break;
			}
		}
		head
	}

	fn record_path_denial<T>(&self, result: Result<T, PathDenied>) -> Result<T, PathDenied> {
		if let Err(denied) = &result {
			self.record_denied(denied);
		}
		result
	}

	fn record_denied(&self, denied: &PathDenied) {
		let fact = if denied.access == PathAccess::Read {
			SandboxDenialFact::ReadPath(denied.path.clone())
		} else {
			SandboxDenialFact::WritePath(denied.path.clone())
		};
		*self.denial.lock() = Some(fact);
	}

	fn proxy_environment(&self, environment: &mut Vec<(OsString, OsString)>) {
		let Some(proxy) = &self.sandbox.proxy else {
			return;
		};
		let Some(token) = &self.token else {
			return;
		};
		let http = OsString::from(proxy.http_url(token));
		let socks = OsString::from(proxy.socks_url(token));
		for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
			set_environment(environment, name, http.clone());
		}
		for name in ["ALL_PROXY", "all_proxy"] {
			set_environment(environment, name, socks.clone());
		}
	}
}
impl PathPolicy for ExecSandboxAttempt {
	fn check_read(&self, path: &Path) -> Result<(), PathDenied> {
		self.record_path_denial(self.sandbox.file_policy.check_read(path))
	}

	fn check_write(&self, path: &Path) -> Result<(), PathDenied> {
		self.record_path_denial(self.sandbox.file_policy.check_write(path))
	}

	fn open(&self, path: &Path, request: OpenRequest) -> Result<fs::File, OpenError> {
		let result = self.sandbox.file_policy.open(path, request);
		if let Err(OpenError::Denied(denied)) = &result {
			self.record_denied(denied);
		}
		result
	}
}

impl Drop for ExecSandboxAttempt {
	fn drop(&mut self) {
		if !self.finished.swap(true, Ordering::AcqRel) {
			if let Some(token) = &self.token {
				let _ = self
					.sandbox
					.proxy
					.as_ref()
					.and_then(|proxy| proxy.finish_attempt(token));
			}
		}
	}
}

fn set_environment(environment: &mut Vec<(OsString, OsString)>, name: &str, value: OsString) {
	if let Some((_, current)) = environment
		.iter_mut()
		.find(|(key, _)| key == OsStr::new(name))
	{
		*current = value;
	} else {
		environment.push((OsString::from(name), value));
	}
}

impl SpawnWrapper for ExecSandbox {
	fn launcher(&self) -> Option<(&OsStr, &[OsString])> {
		self
			.wrapper
			.launcher()
			.map(|launcher| (launcher, self.wrapper.prefix_args()))
	}

	fn env_allowed(&self, key: &str) -> bool {
		self.wrapper.env_allowed(key)
	}

	fn resolve_env(&self, environment: &mut Vec<(OsString, OsString)>) {
		*environment = self.wrapper.resolve_env(environment.drain(..));
	}
}

impl SpawnWrapper for ExecSandboxAttempt {
	fn launcher(&self) -> Option<(&OsStr, &[OsString])> {
		self
			.sandbox
			.wrapper
			.launcher()
			.map(|launcher| (launcher, self.sandbox.wrapper.prefix_args()))
	}

	fn env_allowed(&self, key: &str) -> bool {
		self.sandbox.wrapper.env_allowed(key)
	}

	fn resolve_env(&self, environment: &mut Vec<(OsString, OsString)>) {
		*environment = self.sandbox.wrapper.resolve_env(environment.drain(..));
		self.proxy_environment(environment);
	}

	/// Records a network URL handed to a program while this attempt has no
	/// network. Under `scoped` the broker records what a client asks for, so
	/// nothing is scanned there; once one URL is recorded, later launches are
	/// not scanned either. A program that does not exist or cannot run never
	/// reached the network, whether the shell fails to spawn it (exit 127 or
	/// 126) or a launcher fails to exec it after its own spawn succeeded, so
	/// only a program [`FilePolicy::launchable`] admits counts, and none counts
	/// when the shell found no program for a bare name. The program is asked
	/// for and judged only once a URL is found. The shell has already resolved
	/// it for this attempt's read check, so asking costs nothing more, while
	/// the judgment's own path walk is spent only then.
	fn observe_launch<'p>(
		&self,
		program: &dyn Fn() -> Option<Cow<'p, Path>>,
		args: &mut dyn Iterator<Item = &OsStr>,
	) {
		if self.sandbox.network != NetworkConfinement::Disabled
			|| self.network_locator.load(Ordering::Acquire)
		{
			return;
		}
		for arg in args {
			if is_network_url(arg.as_encoded_bytes()) {
				if program().is_some_and(|program| self.sandbox.file_policy.launchable(&program)) {
					self.network_locator.store(true, Ordering::Release);
				}
				return;
			}
		}
	}
}

impl FilePolicy {
	/// Whether `program` can run in this policy's view: its read is admitted
	/// (judged here, so a refusal records no denial), and only then, as the
	/// shell's path search judges it, it is not a directory and is executable
	/// by this user. A program this policy hides never counts, so a diag never
	/// claims it ran and never tells what lies behind the sandbox. The shell
	/// already refuses to launch such a program, a simple command and `exec`
	/// alike: `compose_std_command` reads it through the attempt's
	/// [`PathPolicy`] before it observes the launch, so the launch ends in a
	/// read denial. Judging it here again keeps the fact true without relying
	/// on that order. The backend is no substitute. Bubblewrap masks a
	/// `read_deny` root; Seatbelt denies both `file-read*` and
	/// `process-exec*` for each root, so the kernel enforces the boundary
	/// for both reads and native execution.
	fn launchable(&self, program: &Path) -> bool {
		self.check_read(program).is_ok() && !program.is_dir() && program.executable()
	}

	fn denied(path: &Path, access: PathAccess) -> PathDenied {
		PathDenied { path: std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()), access }
	}

	fn check_read(&self, path: &Path) -> Result<(), PathDenied> {
		self.admit_read(path).map(drop)
	}

	/// Admits a read and returns the physical path it judged.
	///
	/// The path is walked the way the kernel will walk it for `open(2)`,
	/// `read_dir` or a spawned child: each symlink is followed where it stands
	/// and a later `..` leaves the link target's directory, not the link's. So
	/// `link/../key` is judged, and opened by [`Self::open`], as the target's
	/// sibling `key`. The read is refused when that walk enters a `read_deny`
	/// root at any step (so no read passes through a link entry inside one, as
	/// under bubblewrap's mask), when it ends inside one, or when the
	/// `..`-collapsed spelling lies inside one.
	///
	/// The `host` read view follows symlinks, so PATH entries that link into a
	/// toolchain store (Homebrew `bin` into `Cellar`, rustup proxies, nix
	/// profiles) run. The restricted views still refuse any walk that follows a
	/// symlink unless the collapsed spelling lies under a runtime root, because
	/// their kernel profiles need the traversed link entries themselves granted.
	/// Resolution failures (loops, unreadable links) are denials, and a dangling
	/// link is judged by the target it would reach, so one aimed into a denied
	/// root stays refused before that target exists.
	fn admit_read(&self, path: &Path) -> Result<PathBuf, PathDenied> {
		let lexical = policy_lexical_path(path).map_err(|_| Self::denied(path, PathAccess::Read))?;
		let physical =
			policy_physical_spelling(path).map_err(|_| Self::denied(path, PathAccess::Read))?;
		let mut followed_link = false;
		let mut denied_entry = None::<PathBuf>;
		let resolved = resolve_physical_path(&physical, |entry, is_link| {
			followed_link |= is_link;
			if denied_entry.is_none() && self.read_denied_under(entry) {
				denied_entry = Some(entry.to_path_buf());
			}
		})
		.map_err(|_| Self::denied(&lexical, PathAccess::Read))?;
		if self.read_restricted && followed_link && !is_runtime_baseline_path(&lexical) {
			return Err(Self::denied(&lexical, PathAccess::Read));
		}
		if self
			.read_amendment
			.as_ref()
			.is_some_and(|scope| resolved.starts_with(scope))
		{
			return Ok(resolved);
		}
		if self.read_denied_under(&lexical) {
			return Err(Self::denied(&lexical, PathAccess::Read));
		}
		if resolved == Path::new("/dev/null") {
			return Ok(resolved);
		}
		if self.read_denied_under(&resolved) {
			return Err(Self::denied(&resolved, PathAccess::Read));
		}
		if let Some(entry) = denied_entry {
			return Err(Self::denied(&entry, PathAccess::Read));
		}
		if self.read_restricted && !self.readable.iter().any(|root| resolved.starts_with(root)) {
			return Err(Self::denied(&resolved, PathAccess::Read));
		}
		Ok(resolved)
	}

	fn read_denied_under(&self, path: &Path) -> bool {
		self.read_denied.iter().any(|root| path.starts_with(root))
	}

	fn check_write(&self, path: &Path) -> Result<(), PathDenied> {
		self.admit_write(path).map(drop)
	}

	/// Admits a write and returns the physical path it judged, with whether the
	/// walk to it followed a symlink.
	///
	/// The target is resolved like a read (see [`Self::admit_read`]) and checked
	/// against the writable and `write_deny` roots. Builtins gated here through
	/// `check_write` write through links to an admitted target;
	/// [`Self::open`] refuses any write whose walk followed one.
	fn admit_write(&self, path: &Path) -> Result<(PathBuf, bool), PathDenied> {
		let physical =
			policy_physical_spelling(path).map_err(|_| Self::denied(path, PathAccess::Write))?;
		let mut followed_link = false;
		let resolved = resolve_physical_path(&physical, |_, is_link| followed_link |= is_link)
			.map_err(|_| Self::denied(path, PathAccess::Write))?;
		if resolved == Path::new("/dev/null") {
			return Ok((resolved, followed_link));
		}
		if self
			.write_amendment
			.as_ref()
			.is_some_and(|scope| resolved.starts_with(scope))
		{
			return Ok((resolved, followed_link));
		}
		let allowed = self.writable.iter().any(|root| resolved.starts_with(root));
		let denied = self
			.write_denied
			.iter()
			.any(|root| resolved.starts_with(root) || root.starts_with(&resolved));
		if allowed && !denied {
			Ok((resolved, followed_link))
		} else {
			Err(Self::denied(&resolved, PathAccess::Write))
		}
	}

	/// Opens `path` after admitting it. A refusal, and any failure of the
	/// confined open other than a missing final file (a link swapped in after
	/// admission fails `O_NOFOLLOW`), is a denial; a missing file is the
	/// ordinary `NotFound` the caller reports as such.
	fn open(&self, path: &Path, request: OpenRequest) -> Result<fs::File, OpenError> {
		let access = request.access;
		let is_read = matches!(access, PathAccess::Read | PathAccess::ReadWrite);
		// Admission walks the path once and returns the physical path it judged;
		// that exact path is opened below from its root with `O_NOFOLLOW` on
		// every component, so the file read or written is the one admitted, and
		// a link swapped in after admission fails the open instead of
		// redirecting it. A write refuses any walk that followed a symlink.
		let opened_path = if access == PathAccess::Read {
			self.admit_read(path)?
		} else {
			let read = if is_read {
				Some(self.admit_read(path)?)
			} else {
				None
			};
			let (written, followed_link) = self.admit_write(path)?;
			if followed_link {
				let lexical = policy_lexical_path(path).map_err(|_| Self::denied(path, access))?;
				return Err(Self::denied(&lexical, access).into());
			}
			// Two walks of one link-free path agree unless it changed between them.
			if read.is_some_and(|read| read != written) {
				return Err(Self::denied(&written, access).into());
			}
			written
		};
		#[cfg(unix)]
		{
			let root = if opened_path == Path::new("/dev/null") {
				Some(Path::new("/"))
			} else if is_read && !self.read_restricted {
				Some(Path::new("/"))
			} else if is_read {
				self
					.read_amendment
					.as_deref()
					.filter(|root| opened_path.starts_with(root))
					.and_then(|root| root.is_file().then(|| root.parent()).unwrap_or(Some(root)))
					.or_else(|| {
						self
							.readable
							.iter()
							.find(|root| opened_path.starts_with(root))
							.map(PathBuf::as_path)
					})
			} else {
				self
					.write_amendment
					.as_deref()
					.filter(|root| opened_path.starts_with(root))
					.and_then(|root| root.is_file().then(|| root.parent()).unwrap_or(Some(root)))
					.or_else(|| {
						self
							.writable
							.iter()
							.find(|root| opened_path.starts_with(root))
							.map(PathBuf::as_path)
					})
			}
			.ok_or_else(|| Self::denied(&opened_path, access))?;
			open_beneath_root(root, &opened_path, request).map_err(|error| {
				if error.kind() == io::ErrorKind::NotFound {
					OpenError::Io(error)
				} else {
					OpenError::Denied(Self::denied(&opened_path, access))
				}
			})
		}
		#[cfg(not(unix))]
		{
			let _ = access;
			Err(Self::denied(path, access).into())
		}
	}
}

fn is_runtime_baseline_path(path: &Path) -> bool {
	RUNTIME_READ_ROOTS
		.iter()
		.any(|root| path.starts_with(Path::new(root)))
}

/// The absolute, `..`-collapsed spelling the policy matches literally.
fn policy_lexical_path(path: &Path) -> io::Result<PathBuf> {
	Ok(system_link_targets(normalize_absolute(&std::path::absolute(path)?)?))
}

/// The absolute spelling a physical walk starts from: `..` is kept so the walk
/// applies it where the kernel does, after any link before it.
fn policy_physical_spelling(path: &Path) -> io::Result<PathBuf> {
	Ok(system_link_targets(std::path::absolute(path)?))
}

/// Replaces macOS's fixed `/tmp`, `/var` and `/etc` links with their targets,
/// so a path under them is not counted as crossing a symlink.
fn system_link_targets(path: PathBuf) -> PathBuf {
	#[cfg(target_os = "macos")]
	{
		for (logical, physical) in [
			(Path::new("/tmp"), Path::new("/private/tmp")),
			(Path::new("/var"), Path::new("/private/var")),
			(Path::new("/etc"), Path::new("/private/etc")),
		] {
			if path == logical {
				return physical.to_path_buf();
			}
			if let Ok(suffix) = path.strip_prefix(logical) {
				return physical.join(suffix);
			}
		}
	}
	path
}

#[cfg(unix)]
fn open_beneath_root(root: &Path, path: &Path, request: OpenRequest) -> io::Result<fs::File> {
	use std::{
		ffi::CString,
		os::{fd::FromRawFd as _, unix::ffi::OsStrExt as _},
	};

	let access = request.access;
	let relative = path.strip_prefix(root).map_err(|_| {
		io::Error::new(io::ErrorKind::PermissionDenied, "path escapes authorized root")
	})?;
	let root_name = CString::new(root.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in root path"))?;
	// SAFETY: the C string is NUL terminated and points to immutable memory.
	let mut fd = unsafe {
		libc::open(
			root_name.as_ptr(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	let components = relative.components().collect::<Vec<_>>();
	for component in &components[..components.len().saturating_sub(1)] {
		let Component::Normal(name) = component else {
			unsafe { libc::close(fd) };
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid relative path"));
		};
		let name = CString::new(name.as_bytes())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))?;
		// SAFETY: `fd` is owned here and the component string is NUL terminated.
		let next = unsafe {
			libc::openat(
				fd,
				name.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		unsafe { libc::close(fd) };
		if next < 0 {
			return Err(io::Error::last_os_error());
		}
		fd = next;
	}
	let final_name = relative
		.file_name()
		.unwrap_or_else(|| std::ffi::OsStr::new("."));
	let final_name = CString::new(final_name.as_bytes())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))?;
	let flags = match access {
		PathAccess::Read => libc::O_RDONLY,
		PathAccess::CreateNew => libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
		PathAccess::Truncate => libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
		PathAccess::Append => libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
		PathAccess::ReadWrite => libc::O_RDWR | libc::O_CREAT,
		PathAccess::Write => libc::O_WRONLY | libc::O_CREAT,
	};
	// SAFETY: `fd` is owned here and the final component string is NUL terminated.
	let opened = unsafe {
		libc::openat(
			fd,
			final_name.as_ptr(),
			flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			request.create_mode as libc::mode_t as libc::c_uint,
		)
	};
	unsafe { libc::close(fd) };
	if opened < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `opened` is a freshly opened descriptor whose ownership transfers to
	// File.
	Ok(unsafe { fs::File::from_raw_fd(opened) })
}

/// The kernel network mode `settings` name, before any consumer or
/// provenance rule: what a policy-only test compiles.
#[cfg(test)]
const fn requested_network_mode(settings: &SandboxSettings) -> NetworkMode {
	match settings.network_mode {
		SandboxNetworkMode::Disabled => NetworkMode::Disabled,
		SandboxNetworkMode::Open => NetworkMode::Enabled,
		SandboxNetworkMode::Scoped => NetworkMode::Outbound,
	}
}

#[cfg(test)]
fn policy_parts(
	settings: &SandboxSettings,
	workspace_root: &Path,
	write: WriteMode,
	proxy: Option<&ScopedProxy>,
	amendment: Option<&SandboxDenialFact>,
) -> Result<PolicyParts, SandboxError> {
	policy_parts_with_approved_scope(
		settings,
		workspace_root,
		write,
		requested_network_mode(settings),
		proxy,
		amendment,
		None,
	)
}

fn policy_parts_with_approved_scope(
	settings: &SandboxSettings,
	workspace_root: &Path,
	write: WriteMode,
	network: NetworkMode,
	proxy: Option<&ScopedProxy>,
	_amendment: Option<&SandboxDenialFact>,
	approved_scope: Option<&ApprovedPathScope>,
) -> Result<PolicyParts, SandboxError> {
	if let Some(scope) = approved_scope {
		scope
			.verify()
			.map_err(|source| SandboxError::Canonicalize {
				path: scope.display_scope.clone(),
				source,
			})?;
	}
	let mut spec = SandboxSpec::new(OsString::new());
	spec
		.set_write(write)
		.set_network(network)
		.set_degradation(DegradationPolicy::Reject);
	// Validated here rather than at the call site: `ResourceLimits::new`
	// rejects a nonfinite or negative core count, and a ceiling that cannot be
	// represented must fail loudly instead of silently running unlimited.
	spec.set_resource_limits(ResourceLimits::new(
		Some(settings.cpu_cores),
		u64::try_from(settings.memory_bytes).ok(),
		Some(settings.pids),
	)?);
	// Seatbelt's deny-default profile still permits the baseline POSIX IPC and
	// DNS Unix sockets required by ordinary commands, so it cannot claim full
	// `ipc.restrict`. Everything else missing keeps rejecting compilation.
	spec.tolerate_missing(Capability::IpcRestrict);
	for path in &settings.allow_unix_sockets {
		spec.allow_unix_socket(path.as_str())?;
	}

	match settings.env_inherit {
		EnvironmentInheritance::All => {},
		EnvironmentInheritance::Core => {
			spec.set_env_core(true);
		},
		EnvironmentInheritance::None => {
			spec.set_environment(EnvironmentSource::Exact(Vec::new()));
		},
	}
	for pattern in &settings.env_include_only {
		spec.allow_env(pattern.as_str())?;
	}
	for pattern in &settings.env_deny {
		spec.deny_env(pattern.as_str())?;
	}
	for (name, value) in &settings.env_set {
		spec.env_set(name.as_str(), value.as_str());
	}
	if let Some(proxy) = proxy {
		#[cfg(target_os = "linux")]
		spec.set_proxy_endpoint(proxy.port(), Some(proxy.socket()))?;
		#[cfg(not(target_os = "linux"))]
		spec.set_proxy_endpoint(proxy.port(), None)?;
		let http_proxy = format!("http://127.0.0.1:{}", proxy.port());
		let socks_proxy = format!("socks5h://127.0.0.1:{}", proxy.port());
		for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
			spec.env_set(name, &http_proxy);
		}
		for name in ["ALL_PROXY", "all_proxy"] {
			spec.env_set(name, &socks_proxy);
		}
	}
	for pattern in &settings.read_deny_globs {
		return Err(SandboxError::UnsupportedReadDenyGlob { pattern: pattern.clone() });
	}

	let mut readable = Vec::new();
	let mut read_denied = Vec::new();
	let mut inactive_roots = Vec::new();
	if settings.read_mode != ReadMode::Host {
		spec.allow_read(workspace_root)?;
		push_unique(
			&mut readable,
			fs::canonicalize(workspace_root).map_err(|source| SandboxError::Canonicalize {
				path: workspace_root.to_path_buf(),
				source,
			})?,
		);
		for root in RUNTIME_READ_ROOTS {
			let root = Path::new(root);
			if !root.exists() {
				continue;
			}
			spec.allow_read(root)?;
			push_unique(
				&mut readable,
				fs::canonicalize(root)
					.map_err(|source| SandboxError::Canonicalize { path: root.to_path_buf(), source })?,
			);
		}
		if settings.read_mode == ReadMode::Scoped {
			for configured in &settings.readable_roots {
				let root = PathBuf::from(configured.as_str());
				if !root.exists() {
					push_unique(&mut inactive_roots, root);
					continue;
				}
				spec.allow_read(&root)?;
				push_unique(
					&mut readable,
					fs::canonicalize(&root)
						.map_err(|source| SandboxError::Canonicalize { path: root.clone(), source })?,
				);
			}
		}
	}
	for path in &settings.read_deny {
		spec.deny_read(path.as_str())?;
		let absolute = std::path::absolute(path.as_str()).map_err(|source| {
			SandboxError::Canonicalize { path: PathBuf::from(path.as_str()), source }
		})?;
		push_unique(
			&mut read_denied,
			normalize_absolute(&absolute)
				.map_err(|source| SandboxError::Canonicalize { path: absolute.clone(), source })?,
		);
		push_unique(
			&mut read_denied,
			resolve_write_path(&absolute)
				.map_err(|source| SandboxError::Canonicalize { path: absolute, source })?,
		);
	}

	let mut writable = Vec::new();
	let mut denied = Vec::new();
	if settings.mode == ExecSandboxMode::WorkspaceWrite {
		let mut configured = Vec::with_capacity(3 + settings.writable_roots.len());
		configured.push((workspace_root.to_path_buf(), true));
		configured.extend(
			settings
				.writable_roots
				.iter()
				.map(|root| (PathBuf::from(root.as_str()), true)),
		);
		if !settings.exclude_tmpdir {
			configured.push((std::env::temp_dir(), false));
		}
		if !settings.exclude_slash_tmp {
			configured.push((PathBuf::from("/tmp"), false));
		}

		let mut roots = Vec::with_capacity(configured.len());
		for (root, protect_carve_outs) in configured {
			if root != workspace_root && !root.exists() {
				push_unique(&mut inactive_roots, root);
				continue;
			}
			let canonical_root = resolve_write_path(&root)
				.map_err(|source| SandboxError::Canonicalize { path: root.clone(), source })?;
			spec.allow_write(&root)?;
			push_unique(&mut writable, canonical_root.clone());
			roots.push((root, canonical_root, protect_carve_outs));
		}
		// Every root is now known before a carve-out is classified. A gitdir
		// target under a later root therefore remains protected.
		for (logical_root, canonical_root, protect_carve_outs) in roots {
			if !protect_carve_outs {
				continue;
			}
			for name in CARVE_OUTS {
				for carve_out in
					carve_out_paths(&logical_root, &canonical_root, name).map_err(|source| {
						SandboxError::Canonicalize { path: logical_root.join(name), source }
					})? {
					record_write_deny(&mut spec, &writable, &mut denied, write, carve_out)?;
				}
			}
		}
	}
	if settings.mode == ExecSandboxMode::Off && write == WriteMode::Scoped {
		spec.allow_write(Path::new("/"))?;
		writable.push(PathBuf::from("/"));
	}
	// The owner-protected locations are absolute by contract and denied under
	// both their literal and resolved spellings wherever a sandbox spec is built
	// and enforced; a location that does not exist yet is denied by spelling,
	// like a missing carve-out.
	for path in &settings.protected_write_paths {
		if !path.is_absolute() {
			return Err(SandboxError::InvalidDenyPath { path: path.clone() });
		}
		let literal = normalize_absolute(path)
			.map_err(|source| SandboxError::Canonicalize { path: path.clone(), source })?;
		let resolved = resolve_write_path(path)
			.map_err(|source| SandboxError::Canonicalize { path: literal.clone(), source })?;
		// A location that contains a writable root cannot be denied without denying
		// that root itself, which would refuse in-process writes the session needs.
		// Admission already withholds CONTROL grants for it
		// (`ProtectedLocationError::ContainsWritable`), so nothing relies on this
		// deny. The exception holds only while the protected path is itself outside
		// every writable root: when it lies in scope, descendants it does not
		// share with a nested root would otherwise stay writable, so the deny stays.
		let contains_writable_root = |location: &Path| {
			writable
				.iter()
				.any(|root| root.as_path() != location && root.starts_with(location))
		};
		let in_scope = |location: &Path| writable.iter().any(|root| location.starts_with(root));
		if (contains_writable_root(&literal) || contains_writable_root(&resolved))
			&& !in_scope(&literal)
			&& !in_scope(&resolved)
		{
			continue;
		}
		record_write_deny(&mut spec, &writable, &mut denied, write, literal)?;
		record_write_deny(&mut spec, &writable, &mut denied, write, resolved)?;
	}
	for path in &settings.write_deny {
		let absolute = std::path::absolute(path.as_str()).map_err(|source| {
			SandboxError::Canonicalize { path: PathBuf::from(path.as_str()), source }
		})?;
		let literal = normalize_absolute(&absolute).map_err(|source| SandboxError::Canonicalize {
			path: PathBuf::from(path.as_str()),
			source,
		})?;
		let resolved = resolve_write_path(&absolute)
			.map_err(|source| SandboxError::Canonicalize { path: literal.clone(), source })?;
		record_write_deny(&mut spec, &writable, &mut denied, write, literal)?;
		record_write_deny(&mut spec, &writable, &mut denied, write, resolved)?;
	}

	let read_amendment = approved_scope
		.filter(|scope| scope.access == ApprovedPathAccess::Read)
		.map(|scope| scope.scope.clone());
	let write_amendment = approved_scope
		.filter(|scope| scope.access == ApprovedPathAccess::Write)
		.map(|scope| scope.scope.clone());
	if let Some(path) = read_amendment.as_ref() {
		spec.allow_read_override(path)?;
	}
	if let Some(path) = write_amendment.as_ref() {
		spec.allow_write_override(path)?;
	}

	let roots_label = if writable.is_empty() {
		Str::new_static("no roots")
	} else {
		let mut label = StrMut::new("");
		for (index, root) in writable.iter().enumerate() {
			if index != 0 {
				label.push_str(", ");
			}
			label.push_str(root.to_string_lossy().as_ref());
		}
		label.freeze()
	};
	Ok(PolicyParts {
		spec,
		file_policy: FilePolicy {
			writable: writable.into(),
			write_denied: denied.into(),
			readable: readable.into(),
			read_denied: read_denied.into(),
			read_restricted: settings.read_mode != ReadMode::Host,
			read_amendment,
			write_amendment,
		},
		roots_label,
		inactive_roots: inactive_roots.into(),
		#[cfg(test)]
		spec_snapshot: {
			let mut snapshot = StrMut::new("network=");
			snapshot.push_str(<&'static str>::from(network));
			snapshot.push_str(";write=");
			snapshot.push_str(<&'static str>::from(write));
			snapshot.push_str(";tmpdir=");
			snapshot.push_str(if settings.exclude_tmpdir {
				"exclude"
			} else {
				"allow"
			});
			snapshot.push_str(";slash_tmp=");
			snapshot.push_str(if settings.exclude_slash_tmp {
				"exclude"
			} else {
				"allow"
			});
			snapshot.push_str(";env_deny=");
			for pattern in &settings.env_deny {
				snapshot.push_str(pattern.as_str());
				snapshot.push_str(",");
			}
			snapshot.freeze()
		},
	})
}

fn nearest_existing_scope(path: &Path) -> io::Result<PathBuf> {
	let mut candidate = normalize_absolute(path)?;
	loop {
		match fs::canonicalize(&candidate) {
			Ok(path) => return normalize_absolute(&path),
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				if !candidate.pop() {
					return Err(error);
				}
			},
			Err(error) => return Err(error),
		}
	}
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
	if !paths.contains(&path) {
		paths.push(path);
	}
}

fn record_write_deny(
	spec: &mut SandboxSpec,
	writable: &[PathBuf],
	denied: &mut Vec<PathBuf>,
	write: WriteMode,
	path: PathBuf,
) -> Result<(), SandboxError> {
	let logical = policy_lexical_path(&path)
		.map_err(|source| SandboxError::Canonicalize { path: path.clone(), source })?;
	let resolved = resolve_write_path(&logical)
		.map_err(|source| SandboxError::Canonicalize { path: logical.clone(), source })?;
	// Preserve an in-scope logical symlink even when its target escapes. The
	// backend must reject or protect the directory entry itself before mounts.
	let logical_in_scope = writable.iter().any(|root| logical.starts_with(root));
	let resolved_in_scope = writable.iter().any(|root| resolved.starts_with(root));
	if logical_in_scope && !resolved_in_scope {
		spec.deny_write_lexical(&logical)?;
	} else if write == WriteMode::Overlay || logical_in_scope || resolved_in_scope {
		spec.deny_write(&logical)?;
	}
	push_unique(denied, logical);
	push_unique(denied, resolved);
	Ok(())
}

fn carve_out_paths(root: &Path, resolved_root: &Path, name: &str) -> io::Result<Vec<PathBuf>> {
	let mut paths = Vec::with_capacity(4);
	let absolute = std::path::absolute(root.join(name))?;
	let literal = normalize_absolute(&absolute)?;
	let canonical_entry = normalize_absolute(&resolved_root.join(name))?;
	let resolved = resolve_write_path(&absolute)?;
	push_unique(&mut paths, literal);
	push_unique(&mut paths, canonical_entry);
	push_unique(&mut paths, resolved.clone());

	for candidate in paths.clone() {
		let metadata = match fs::metadata(&candidate) {
			Ok(metadata) => metadata,
			Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
			Err(error) => return Err(error),
		};
		if !metadata.is_file() {
			continue;
		}
		let contents = fs::read_to_string(&candidate)?;
		let Some(gitdir) = contents
			.lines()
			.next()
			.and_then(|line| line.strip_prefix("gitdir: "))
			.map(str::trim)
			.filter(|path| !path.is_empty())
		else {
			continue;
		};
		let target = Path::new(gitdir);
		let target = if target.is_absolute() {
			target.to_path_buf()
		} else {
			candidate.parent().unwrap_or(resolved_root).join(target)
		};
		let absolute_target = std::path::absolute(target)?;
		let literal_target = normalize_absolute(&absolute_target)?;
		let resolved_target = resolve_write_path(&absolute_target)?;
		push_unique(&mut paths, literal_target);
		push_unique(&mut paths, resolved_target);
	}
	Ok(paths)
}

/// Classifies a failed compile as a platform limit or a refused policy.
pub(crate) fn classify_unavailable(error: &SandboxError) -> SandboxUnavailable {
	match error {
		SandboxError::UnsupportedHost { .. } => SandboxUnavailable::UnsupportedHost,
		SandboxError::BackendUnavailable { .. } => SandboxUnavailable::BackendUnavailable,
		_ => SandboxUnavailable::PolicyRejected,
	}
}

/// Whether commands may still run, unsandboxed and under approval.
///
/// A refused policy is a configuration fault that keeps failing closed.
pub(crate) const fn runs_unsandboxed(cause: SandboxUnavailable) -> bool {
	!matches!(cause, SandboxUnavailable::PolicyRejected)
}

/// Constructs the sandbox `settings` ask for, once, and reports what applies.
///
/// Only a constructed filesystem sandbox is [`SandboxState::Active`]; a
/// network- or environment-only wrapper keeps the host filesystem view and is
/// not confinement.
pub(crate) fn probe(settings: &SandboxSettings, workspace_root: &Path) -> SandboxState {
	if settings.mode == ExecSandboxMode::Off {
		return SandboxState::Off;
	}
	match ExecSandbox::compile(settings, workspace_root, true, SandboxConsumer::Probe) {
		Ok(Some(_)) => SandboxState::Active,
		Ok(None) => SandboxState::Off,
		Err(error) => SandboxState::Unavailable { cause: classify_unavailable(&error) },
	}
}

/// Resolves the network one native compile applies.
///
/// Under `scoped`, a session starts its broker (a network amendment starts a
/// one-shot broker that also allows the approved endpoint), a tokenless child
/// gets a disabled network, and a probe compiles the scoped profile without a
/// broker. When the session broker cannot start under the shipped default,
/// the network falls back to disabled rather than failing every command; a
/// sandbox the user configured, or an approved amendment, fails instead.
fn resolve_network(
	settings: &SandboxSettings,
	requested: NetworkConfinement,
	source: NetworkSource,
	amendment: Option<&SandboxDenialFact>,
) -> io::Result<ResolvedNetwork> {
	let consumer = match source {
		NetworkSource::Reuse { confinement, proxy } => {
			return Ok(match (confinement, proxy) {
				(NetworkConfinement::Scoped, Some(proxy)) => ResolvedNetwork::scoped(Some(proxy)),
				// A scoped session always owns its broker; without one, fail closed.
				(NetworkConfinement::Scoped | NetworkConfinement::Disabled, _) => {
					ResolvedNetwork::disabled(false)
				},
				(NetworkConfinement::Unconfined, _) => ResolvedNetwork::unconfined(),
			});
		},
		NetworkSource::Fresh(consumer) => consumer,
	};
	match (requested, consumer) {
		(NetworkConfinement::Unconfined, _) => Ok(ResolvedNetwork::unconfined()),
		(NetworkConfinement::Disabled, _) | (NetworkConfinement::Scoped, SandboxConsumer::Child) => {
			Ok(ResolvedNetwork::disabled(false))
		},
		(NetworkConfinement::Scoped, SandboxConsumer::Probe) => Ok(ResolvedNetwork::scoped(None)),
		(NetworkConfinement::Scoped, SandboxConsumer::Session) => {
			let approved = match amendment {
				Some(SandboxDenialFact::Network { host, port }) => Some((host, *port)),
				_ => None,
			};
			match start_broker(settings, approved) {
				Ok(proxy) => Ok(ResolvedNetwork::scoped(Some(Arc::new(proxy)))),
				Err(source) if approved.is_none() && !settings.explicit => {
					tracing::warn!(
						%source,
						"scoped egress broker unavailable; commands run with the network disabled"
					);
					Ok(ResolvedNetwork::disabled(true))
				},
				Err(source) => Err(source),
			}
		},
	}
}

/// Starts a session egress broker, or a one-shot broker that also allows one
/// approved endpoint.
fn start_broker(
	settings: &SandboxSettings,
	approved: Option<(&Str, u16)>,
) -> io::Result<ScopedProxy> {
	#[cfg(test)]
	if tests::BROKER_START_FAILS.with(std::cell::Cell::get) {
		return Err(io::Error::other("injected broker start failure"));
	}
	match approved {
		Some(approved) => ScopedProxy::start_with_amendment(settings, Some(approved)),
		None => ScopedProxy::start(settings),
	}
}

fn capability_failure(error: &SandboxError) -> bool {
	matches!(
		error,
		SandboxError::BackendCapabilities { .. } | SandboxError::NoBackendCapabilities { .. }
	)
}

fn resolve_write_path(path: &Path) -> io::Result<PathBuf> {
	resolve_physical_path(path, |_, _| {})
}

/// Resolves `path` physically: each symlink is followed where it stands and a
/// later `..` leaves the directory the walk is in, as the kernel does. Missing
/// components are kept as spelled, so a path still to be created resolves.
///
/// `visit` sees every entry the walk examines, with whether it is a symlink the
/// walk then follows.
fn resolve_physical_path(path: &Path, mut visit: impl FnMut(&Path, bool)) -> io::Result<PathBuf> {
	let mut pending = std::path::absolute(path)?;
	for _ in 0..40 {
		let mut components = pending.components().collect::<VecDeque<_>>();
		let mut resolved = PathBuf::new();
		let mut followed_symlink = false;
		while let Some(component) = components.pop_front() {
			match component {
				Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
				Component::RootDir => resolved.push(component.as_os_str()),
				Component::CurDir => {},
				Component::ParentDir => {
					if !resolved.pop() {
						return Err(io::Error::new(
							io::ErrorKind::InvalidInput,
							"write path escapes root",
						));
					}
				},
				Component::Normal(name) => {
					let candidate = resolved.join(name);
					let metadata = fs::symlink_metadata(&candidate);
					visit(
						&candidate,
						metadata
							.as_ref()
							.is_ok_and(|metadata| metadata.file_type().is_symlink()),
					);
					match metadata {
						Ok(metadata) if metadata.file_type().is_symlink() => {
							let target = fs::read_link(&candidate)?;
							let mut redirected = if target.is_absolute() {
								target
							} else {
								resolved.join(target)
							};
							for remaining in components {
								redirected.push(remaining.as_os_str());
							}
							pending = redirected;
							followed_symlink = true;
							break;
						},
						Ok(_) => resolved = candidate,
						Err(error) if error.kind() == io::ErrorKind::NotFound => {
							resolved = candidate;
						},
						Err(error) => return Err(error),
					}
				},
			}
		}
		if !followed_symlink {
			return normalize_absolute(&resolved);
		}
	}
	Err(io::Error::other("too many symbolic links in write path"))
}

fn normalize_absolute(path: &Path) -> io::Result<PathBuf> {
	let mut normalized = PathBuf::new();
	for component in path.components() {
		match component {
			Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
			Component::RootDir => normalized.push(component.as_os_str()),
			Component::CurDir => {},
			Component::ParentDir => {
				if !normalized.pop() {
					return Err(io::Error::new(io::ErrorKind::InvalidInput, "write path escapes root"));
				}
			},
			Component::Normal(name) => normalized.push(name),
		}
	}
	Ok(normalized)
}

/// Builds a Homebrew-shaped prefix under `root` for symlinked-toolchain tests.
///
/// `Cellar/tool/1.0/bin/tool` is an executable script printing its arguments;
/// `bin/tool` links to it and `opt/tool` links to its keg, both relatively.
#[cfg(all(test, unix))]
pub(crate) fn homebrew_shaped_prefix(root: &Path) -> PathBuf {
	use std::os::unix::fs::{PermissionsExt as _, symlink};

	let prefix = root.join("prefix");
	let keg = prefix.join("Cellar/tool/1.0");
	fs::create_dir_all(keg.join("bin")).expect("keg bin");
	fs::create_dir_all(prefix.join("bin")).expect("prefix bin");
	fs::create_dir_all(prefix.join("opt")).expect("prefix opt");
	let tool = keg.join("bin/tool");
	fs::write(&tool, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n").expect("tool script");
	fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).expect("tool mode");
	symlink("../Cellar/tool/1.0/bin/tool", prefix.join("bin/tool")).expect("bin link");
	symlink("../Cellar/tool/1.0", prefix.join("opt/tool")).expect("opt link");
	prefix
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;
	use crate::admission::Provenance;

	thread_local! {
		/// Makes [`start_broker`] fail on this thread, as a loopback bind, a
		/// read-only temporary directory or a thread spawn can in production.
		pub(super) static BROKER_START_FAILS: Cell<bool> = const { Cell::new(false) };
	}

	/// Fails every broker start on this thread until dropped.
	struct BrokerStartFails;

	impl BrokerStartFails {
		fn arm() -> Self {
			BROKER_START_FAILS.with(|fails| fails.set(true));
			Self
		}
	}

	impl Drop for BrokerStartFails {
		fn drop(&mut self) {
			BROKER_START_FAILS.with(|fails| fails.set(false));
		}
	}

	fn workspace_settings() -> SandboxSettings {
		SandboxSettings { mode: ExecSandboxMode::WorkspaceWrite, ..SandboxSettings::default() }
	}

	/// Whether this host builds native command wrappers; the compile proofs
	/// below need one and return early elsewhere (Linux without bwrap).
	fn native_backend() -> bool {
		Runner::native_command().is_ok()
	}

	fn explicit_scoped(mode: ExecSandboxMode) -> SandboxSettings {
		SandboxSettings {
			mode,
			network_mode: SandboxNetworkMode::Scoped,
			network_provenance: Provenance::Explicit,
			explicit: true,
			..SandboxSettings::default()
		}
	}

	#[test]
	fn explicit_off_with_the_defaulted_network_stays_environment_only() {
		let workspace = tempfile::tempdir().expect("workspace");
		// Mode `off` set by the user, network left at its scoped default: no
		// native backend is consulted, so this holds where none exists.
		let settings = SandboxSettings {
			mode: ExecSandboxMode::Off,
			explicit: true,
			..SandboxSettings::default()
		};
		assert_eq!(settings.network_mode, SandboxNetworkMode::Scoped);
		assert!(
			ExecSandbox::compile(&settings, workspace.path(), true, SandboxConsumer::Session)
				.expect("no sandbox")
				.is_none()
		);
		let settings = SandboxSettings {
			env_set: std::collections::BTreeMap::from([(
				Str::new_static("FIXED"),
				Str::new_static("value"),
			)]),
			..settings
		};
		let sandbox =
			ExecSandbox::compile(&settings, workspace.path(), true, SandboxConsumer::Session)
				.expect("environment policy")
				.expect("environment-only wrapper");
		assert!(sandbox.wrapper.launcher().is_none());
		assert!(sandbox.proxy.is_none(), "no broker serves an unsandboxed session");
		assert_eq!(sandbox.network, NetworkConfinement::Unconfined);
	}

	#[test]
	fn explicit_off_with_an_explicit_scoped_network_compiles_a_network_only_wrapper() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = explicit_scoped(ExecSandboxMode::Off);
		let compiled =
			ExecSandbox::compile(&settings, workspace.path(), true, SandboxConsumer::Session);
		if !native_backend() {
			// The user asked for this network-only sandbox; without a backend it
			// is a construction failure, never a silent unsandboxed run.
			assert!(compiled.is_err());
			return;
		}
		let sandbox = compiled
			.expect("network-only policy")
			.expect("network-only wrapper");
		assert!(sandbox.wrapper.launcher().is_some());
		assert!(sandbox.proxy.is_some(), "the session owns its broker");
		assert_eq!(sandbox.network, NetworkConfinement::Scoped);
		assert!(sandbox.session_note().contains("network=scoped"), "{}", sandbox.session_note());
	}

	#[test]
	fn scoped_network_resolves_by_consumer() {
		let settings = SandboxSettings::default();
		let child = resolve_network(
			&settings,
			NetworkConfinement::Scoped,
			NetworkSource::Fresh(SandboxConsumer::Child),
			None,
		)
		.expect("child network");
		assert_eq!(child.confinement, NetworkConfinement::Disabled);
		assert_eq!(child.mode, NetworkMode::Disabled);
		assert!(child.proxy.is_none(), "a tokenless child gets no broker");
		assert!(!child.broker_unavailable);
		let probe = resolve_network(
			&settings,
			NetworkConfinement::Scoped,
			NetworkSource::Fresh(SandboxConsumer::Probe),
			None,
		)
		.expect("probe network");
		assert_eq!(probe.confinement, NetworkConfinement::Scoped);
		assert_eq!(probe.mode, NetworkMode::Outbound);
		assert!(probe.proxy.is_none(), "a probe starts no broker");
		let session = resolve_network(
			&settings,
			NetworkConfinement::Scoped,
			NetworkSource::Fresh(SandboxConsumer::Session),
			None,
		)
		.expect("session network");
		assert_eq!(session.confinement, NetworkConfinement::Scoped);
		assert_eq!(session.mode, NetworkMode::Outbound);
		let proxy = session.proxy.expect("the session starts its broker");
		let reused = resolve_network(
			&settings,
			NetworkConfinement::Scoped,
			NetworkSource::Reuse {
				confinement: NetworkConfinement::Scoped,
				proxy:       Some(Arc::clone(&proxy)),
			},
			None,
		)
		.expect("reused network");
		assert!(
			reused
				.proxy
				.is_some_and(|reused| Arc::ptr_eq(&reused, &proxy))
		);
		for (confinement, mode) in [
			(NetworkConfinement::Disabled, NetworkMode::Disabled),
			(NetworkConfinement::Unconfined, NetworkMode::Enabled),
		] {
			let resolved = resolve_network(
				&settings,
				confinement,
				NetworkSource::Fresh(SandboxConsumer::Session),
				None,
			)
			.expect("unscoped network");
			assert_eq!((resolved.confinement, resolved.mode), (confinement, mode));
			assert!(resolved.proxy.is_none());
		}
	}

	#[test]
	fn broker_start_failure_degrades_only_the_shipped_default() {
		let _fails = BrokerStartFails::arm();
		let degraded = resolve_network(
			&SandboxSettings::default(),
			NetworkConfinement::Scoped,
			NetworkSource::Fresh(SandboxConsumer::Session),
			None,
		)
		.expect("the shipped default degrades");
		assert_eq!(degraded.confinement, NetworkConfinement::Disabled);
		assert_eq!(degraded.mode, NetworkMode::Disabled);
		assert!(degraded.proxy.is_none());
		assert!(degraded.broker_unavailable);

		// Any sandbox convar the user set makes the sandbox theirs: hard error.
		for explicit in [
			SandboxSettings { explicit: true, ..SandboxSettings::default() },
			explicit_scoped(ExecSandboxMode::WorkspaceWrite),
			explicit_scoped(ExecSandboxMode::Off),
		] {
			assert!(
				resolve_network(
					&explicit,
					NetworkConfinement::Scoped,
					NetworkSource::Fresh(SandboxConsumer::Session),
					None,
				)
				.is_err()
			);
		}
		// An approved network amendment cannot be honoured without its broker.
		let approved = SandboxDenialFact::Network { host: Str::new_static("example.com"), port: 443 };
		assert!(
			resolve_network(
				&SandboxSettings::default(),
				NetworkConfinement::Scoped,
				NetworkSource::Fresh(SandboxConsumer::Session),
				Some(&approved),
			)
			.is_err()
		);
		// A scoped session without a broker fails closed rather than open.
		let reused = resolve_network(
			&SandboxSettings::default(),
			NetworkConfinement::Scoped,
			NetworkSource::Reuse { confinement: NetworkConfinement::Scoped, proxy: None },
			None,
		)
		.expect("reused network");
		assert_eq!(reused.mode, NetworkMode::Disabled);
	}

	#[test]
	fn tokenless_children_and_probes_compile_without_a_broker() {
		if !native_backend() {
			return;
		}
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings::default();
		let child = ExecSandbox::compile(&settings, workspace.path(), false, SandboxConsumer::Child)
			.expect("child policy")
			.expect("child wrapper");
		assert_eq!(child.network, NetworkConfinement::Disabled);
		assert!(child.proxy.is_none());
		assert!(child.session_note().contains("network=disabled"), "{}", child.session_note());
		let probe = ExecSandbox::compile(&settings, workspace.path(), true, SandboxConsumer::Probe)
			.expect("probe policy")
			.expect("probe wrapper");
		assert_eq!(probe.network, NetworkConfinement::Scoped);
		assert!(probe.proxy.is_none());
		let session =
			ExecSandbox::compile(&settings, workspace.path(), true, SandboxConsumer::Session)
				.expect("session policy")
				.expect("session wrapper");
		assert_eq!(session.network, NetworkConfinement::Scoped);
		assert!(session.proxy.is_some());
		assert!(session.session_note().contains("network=scoped"), "{}", session.session_note());
	}

	fn observe(attempt: &ExecSandboxAttempt, program: Option<&Path>, args: &[&str]) {
		SpawnWrapper::observe_launch(
			attempt,
			&|| program.map(Cow::Borrowed),
			&mut args.iter().map(OsStr::new),
		);
	}

	/// An attempt with no network records that a program it launched was
	/// given a network URL, once, consumed with its other facts; a URL that is
	/// only text never counts, and neither does one handed to a program that
	/// cannot run (a bare name the shell found nowhere, a missing path, a
	/// directory, a file without its exec bit) or one the session's file
	/// policy hides (an executable under `read_deny`), which leaves later
	/// launches free to count. Under `scoped` the broker records what clients
	/// ask for, so arguments are not scanned at all.
	#[cfg(unix)]
	#[test]
	fn attempts_record_network_urls_only_without_a_network() {
		use std::os::unix::fs::PermissionsExt as _;

		let workspace = tempfile::tempdir().expect("workspace");
		let program = std::env::current_exe().expect("the test binary runs");
		let program = Some(program.as_path());
		let missing = workspace.path().join("missing/wget");
		let script = workspace.path().join("script.sh");
		fs::write(&script, "#!/bin/sh\n").expect("script without its exec bit");
		let hidden = workspace.path().join("hidden");
		fs::create_dir(&hidden).expect("hidden root");
		let hidden_program = hidden.join("curl");
		fs::write(&hidden_program, "#!/bin/sh\n").expect("hidden program");
		fs::set_permissions(&hidden_program, fs::Permissions::from_mode(0o755))
			.expect("hidden program is executable");
		assert!(launchable_outside_any_sandbox(&hidden_program));
		let unlaunchable = [
			None,
			Some(missing.as_path()),
			Some(workspace.path()),
			Some(script.as_path()),
			Some(hidden_program.as_path()),
		];
		let read_deny = vec![Str::from(hidden.to_string_lossy().as_ref())];
		let explicit_disabled = SandboxSettings {
			network_mode: SandboxNetworkMode::Disabled,
			network_provenance: Provenance::Explicit,
			explicit: true,
			read_deny: read_deny.clone(),
			..workspace_settings()
		};
		let mut disabled = vec![
			ExecSandbox::with_test_disabled_network(&explicit_disabled, workspace.path()),
			// A scoped broker that could not start leaves no network either.
			ExecSandbox::with_test_disabled_network(
				&SandboxSettings { read_deny, ..SandboxSettings::default() },
				workspace.path(),
			),
		];
		if native_backend() {
			disabled.push(
				ExecSandbox::compile(
					&explicit_disabled,
					workspace.path(),
					true,
					SandboxConsumer::Session,
				)
				.expect("disabled policy")
				.expect("disabled wrapper"),
			);
		}
		for sandbox in &disabled {
			assert_eq!(sandbox.network, NetworkConfinement::Disabled);
			let attempt = sandbox.begin_attempt(None);
			observe(&attempt, program, &["-sS", "-o", "/dev/null"]);
			observe(&attempt, program, &[
				"see https://example.com",
				"file:///etc/hosts",
				"--url=https://x",
			]);
			assert!(!attempt.take_facts().network_locator, "text is not a fetch");

			let attempt = sandbox.begin_attempt(None);
			for cannot_run in unlaunchable {
				observe(&attempt, cannot_run, &["-q", "https://example.com"]);
			}
			assert!(!attempt.take_facts().network_locator, "nothing ran");

			let attempt = sandbox.begin_attempt(None);
			for cannot_run in unlaunchable {
				observe(&attempt, cannot_run, &["-q", "https://example.com"]);
			}
			observe(&attempt, program, &["-sI", "--max-time", "20", "https://example.com"]);
			observe(&attempt, program, &["git+ssh://git@github.com/org/repo.git"]);
			let facts = attempt.take_facts();
			assert!(facts.network_locator);
			assert_eq!(facts.denial, None);
			assert!(facts.refusal.is_none());
			assert!(!attempt.take_facts().network_locator, "taken once");
		}

		let scoped = ExecSandbox::with_test_broker(&SandboxSettings::default(), workspace.path());
		let attempt = scoped.begin_attempt(None);
		observe(&attempt, program, &["-sI", "https://example.com"]);
		assert!(!attempt.take_facts().network_locator);
	}

	/// What the shell's path search alone would say of `program`.
	#[cfg(unix)]
	fn launchable_outside_any_sandbox(program: &Path) -> bool {
		!program.is_dir() && program.executable()
	}

	/// A launch's program is asked for, and judged, only when it could count:
	/// never under `scoped`, never for a launch with no network URL, and never
	/// once the attempt has recorded one, so the default posture spends
	/// nothing on the judgment. That the shell resolves a program only when
	/// asked is pinned on its side by
	/// `compose_std_command_resolves_programs_only_when_asked`.
	#[test]
	fn programs_are_resolved_only_for_a_url_without_a_network() {
		let workspace = tempfile::tempdir().expect("workspace");
		let program = std::env::current_exe().expect("the test binary runs");
		let resolved = std::cell::Cell::new(0_u32);
		let observe = |attempt: &ExecSandboxAttempt, args: &[&str]| {
			let program = || {
				resolved.set(resolved.get() + 1);
				Some(Cow::Borrowed(program.as_path()))
			};
			SpawnWrapper::observe_launch(attempt, &program, &mut args.iter().map(OsStr::new));
		};

		let scoped = ExecSandbox::with_test_broker(&SandboxSettings::default(), workspace.path());
		let attempt = scoped.begin_attempt(None);
		observe(&attempt, &["-sI", "https://example.com"]);
		assert_eq!(resolved.get(), 0, "scoped never resolves");

		let disabled =
			ExecSandbox::with_test_disabled_network(&SandboxSettings::default(), workspace.path());
		let attempt = disabled.begin_attempt(None);
		observe(&attempt, &["-sI", "--max-time", "20", "see https://example.com"]);
		assert_eq!(resolved.get(), 0, "no URL, no resolution");
		observe(&attempt, &["-sI", "https://example.com"]);
		assert_eq!(resolved.get(), 1, "a URL resolves its program once");
		observe(&attempt, &["https://other.example"]);
		assert_eq!(resolved.get(), 1, "a recorded attempt stops resolving");
		assert!(attempt.take_facts().network_locator);
	}

	#[test]
	fn a_path_amendment_after_the_broker_fallback_stays_network_disabled() {
		if !native_backend() {
			return;
		}
		let workspace = tempfile::tempdir().expect("workspace");
		let outside = tempfile::tempdir().expect("outside");
		let settings = SandboxSettings::default();
		let degraded = {
			let _fails = BrokerStartFails::arm();
			ExecSandbox::compile(&settings, workspace.path(), true, SandboxConsumer::Session)
				.expect("the shipped default degrades")
				.expect("session wrapper")
		};
		assert_eq!(degraded.network, NetworkConfinement::Disabled);
		assert!(degraded.proxy.is_none());
		assert!(
			degraded
				.session_note()
				.contains("network=disabled (scoped broker unavailable)"),
			"{}",
			degraded.session_note()
		);
		{
			// An explicitly scoped network keeps failing hard.
			let _fails = BrokerStartFails::arm();
			let explicit = ExecSandbox::compile(
				&explicit_scoped(ExecSandboxMode::WorkspaceWrite),
				workspace.path(),
				true,
				SandboxConsumer::Session,
			);
			assert!(matches!(explicit, Err(SandboxError::BackendIo { .. })));
			assert_eq!(
				probe(&explicit_scoped(ExecSandboxMode::WorkspaceWrite), workspace.path()),
				SandboxState::Active,
				"a probe starts no broker, so it cannot see this failure"
			);
		}
		// The broker could start now; the approved rerun still keeps the
		// session's disabled network instead of re-deriving scoped from settings.
		let scope = ApprovedPathScope::capture(outside.path(), ApprovedPathAccess::Write)
			.expect("approved scope");
		let amended = degraded
			.amended_scope(&scope)
			.expect("amended policy")
			.expect("amended wrapper");
		assert_eq!(amended.network, NetworkConfinement::Disabled);
		assert!(amended.proxy.is_none());
		assert!(amended.session_note().contains("network=disabled"), "{}", amended.session_note());
		assert!(
			degraded
				.amended_network(&SandboxDenialFact::Network {
					host: Str::new_static("example.com"),
					port: 443,
				})
				.expect("no network amendment")
				.is_none(),
			"a session without a broker has no endpoint to widen"
		);
	}

	#[test]
	fn construction_failures_classify_as_platform_limits_or_refused_policy() {
		let unsupported = classify_unavailable(&SandboxError::UnsupportedHost { os: "plan9" });
		assert_eq!(unsupported, SandboxUnavailable::UnsupportedHost);
		assert!(runs_unsandboxed(unsupported));
		let refused = classify_unavailable(&SandboxError::EmptyEnvironmentPattern);
		assert_eq!(refused, SandboxUnavailable::PolicyRejected);
		assert!(!runs_unsandboxed(refused), "a refused policy keeps failing the session open");
	}

	#[test]
	fn probing_an_off_sandbox_constructs_nothing_and_reports_off() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings { mode: ExecSandboxMode::Off, ..SandboxSettings::default() };
		assert_eq!(probe(&settings, workspace.path()), SandboxState::Off);
	}

	#[test]
	fn default_workspace_policy_has_roots_carve_outs_network_and_env_scrubbing() {
		let workspace = tempfile::tempdir().expect("workspace");
		for name in CARVE_OUTS {
			fs::create_dir(workspace.path().join(name)).expect("carve-out");
		}
		let settings = workspace_settings();
		let parts =
			policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None).expect("policy");
		let root = fs::canonicalize(workspace.path()).expect("canonical workspace");
		assert!(parts.file_policy.writable.contains(&root));
		// Each carve-out is denied under both its literal spelling and its
		// firmlink/symlink-resolved form.
		for name in CARVE_OUTS {
			for form in [
				policy_lexical_path(&workspace.path().join(name)).expect("logical carve-out"),
				root.join(name),
			] {
				assert!(parts.file_policy.write_denied.contains(&form), "missing denied form {form:?}");
			}
		}
		assert!(
			parts
				.file_policy
				.check_write(&root.join("src/new.rs"))
				.is_ok()
		);
		assert!(
			parts
				.file_policy
				.check_write(&root.join(".git/config"))
				.is_err()
		);
		assert!(
			parts
				.file_policy
				.check_write(&std::env::temp_dir().join("omp-sandbox-test"))
				.is_ok()
		);
		assert!(parts.spec_snapshot.contains("network=outbound"));
		assert!(parts.spec_snapshot.contains("write=scope"));
		for pattern in ["*KEY*", "*SECRET*", "*TOKEN*"] {
			assert!(parts.spec_snapshot.contains(pattern));
		}
	}
	#[test]
	fn off_mode_compiles_environment_only_policy_and_applies_overrides_last() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::Off,
			env_inherit: EnvironmentInheritance::None,
			env_deny: vec![Str::new_static("*KEY*")],
			env_set: std::collections::BTreeMap::from([(
				Str::new_static("FIXED"),
				Str::new_static("value"),
			)]),
			..SandboxSettings::default()
		};
		let sandbox =
			ExecSandbox::compile(&settings, workspace.path(), true, SandboxConsumer::Session)
				.expect("environment policy")
				.expect("environment-only wrapper");
		assert!(sandbox.wrapper.launcher().is_none());
		assert_eq!(
			sandbox.resolve_env([
				(OsString::from("api_key"), OsString::from("secret")),
				(OsString::from("KEEP"), OsString::from("discarded")),
			]),
			vec![(OsString::from("FIXED"), OsString::from("value"))],
		);
		let settings = SandboxSettings {
			mode: ExecSandboxMode::Off,
			env_deny: vec![Str::new_static("*KEY*")],
			..SandboxSettings::default()
		};
		let sandbox =
			ExecSandbox::compile(&settings, workspace.path(), true, SandboxConsumer::Session)
				.expect("case-insensitive environment policy")
				.expect("environment-only wrapper");
		assert_eq!(
			sandbox.resolve_env([
				(OsString::from("api_key"), OsString::from("secret")),
				(OsString::from("KEEP"), OsString::from("retained")),
			]),
			vec![(OsString::from("KEEP"), OsString::from("retained"))],
		);
	}
	#[test]
	fn temporary_roots_can_be_excluded_from_both_policy_lanes() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::WorkspaceWrite,
			exclude_tmpdir: true,
			exclude_slash_tmp: true,
			..SandboxSettings::default()
		};
		let parts = policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None)
			.expect("policy parts");
		assert!(
			parts
				.file_policy
				.check_write(&std::env::temp_dir().join("blocked"))
				.is_err()
		);
		assert!(parts.spec_snapshot.contains("tmpdir=exclude"));
		assert!(parts.spec_snapshot.contains("slash_tmp=exclude"));
	}
	#[test]
	fn network_only_policy_keeps_the_host_write_view() {
		let workspace = tempfile::tempdir().expect("workspace");
		let external = tempfile::tempdir().expect("external");
		// Only a user-set `scoped` makes mode `off` compile a network-only policy.
		let settings = explicit_scoped(ExecSandboxMode::Off);
		assert_eq!(settings.network_confinement(), NetworkConfinement::Scoped);
		let parts = policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None)
			.expect("network-only policy");
		assert_eq!(parts.file_policy.writable.as_ref(), [PathBuf::from("/")]);
		assert!(
			parts
				.file_policy
				.check_write(&external.path().join("redirect"))
				.is_ok()
		);
		assert!(parts.spec_snapshot.contains("network=outbound"));
	}
	#[test]
	fn approved_read_override_reopens_only_the_frozen_scope() {
		let workspace = tempfile::tempdir().expect("workspace");
		let denied = workspace.path().join("denied");
		fs::write(&denied, "private").expect("denied file");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::ReadOnly,
			read_deny: vec![Str::from(denied.to_string_lossy().as_ref())],
			..SandboxSettings::default()
		};
		let base = policy_parts(&settings, workspace.path(), WriteMode::Deny, None, None)
			.expect("base policy");
		assert!(base.file_policy.check_read(&denied).is_err());
		let scope = ApprovedPathScope::capture(&denied, ApprovedPathAccess::Read).expect("scope");
		let amended = policy_parts_with_approved_scope(
			&settings,
			workspace.path(),
			WriteMode::Deny,
			requested_network_mode(&settings),
			None,
			None,
			Some(&scope),
		)
		.expect("amended policy");
		assert!(amended.file_policy.check_read(&denied).is_ok());
	}
	#[test]
	fn missing_configured_roots_are_inactive_not_compile_failures() {
		let workspace = tempfile::tempdir().expect("workspace");
		let missing = workspace.path().join("missing");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::WorkspaceWrite,
			writable_roots: vec![Str::from(missing.to_string_lossy().as_ref())],
			read_mode: ReadMode::Scoped,
			readable_roots: vec![Str::from(missing.to_string_lossy().as_ref())],
			..SandboxSettings::default()
		};
		let parts =
			policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None).expect("policy");
		assert!(parts.inactive_roots.contains(&missing));
	}
	#[test]
	fn read_deny_globs_fail_when_no_backend_can_enforce_future_matches() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::Off,
			read_deny_globs: vec![Str::new_static("/private/**")],
			..SandboxSettings::default()
		};
		assert!(matches!(
			policy_parts(&settings, workspace.path(), WriteMode::Deny, None, None),
			Err(SandboxError::UnsupportedReadDenyGlob { .. })
		));
	}

	#[cfg(unix)]
	#[test]
	fn restricted_reads_admit_runtime_executables_but_not_arbitrary_programs() {
		let workspace = tempfile::tempdir().expect("workspace");
		let external = tempfile::tempdir().expect("external");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::ReadOnly,
			read_mode: ReadMode::Minimal,
			..Default::default()
		};
		let policy = policy_parts(&settings, workspace.path(), WriteMode::Deny, None, None)
			.expect("policy")
			.file_policy;
		assert!(policy.check_read(Path::new("/bin/sh")).is_ok());
		assert!(
			policy
				.open(Path::new("/bin/sh"), OpenRequest {
					access:      PathAccess::Read,
					create_mode: 0o666,
				},)
				.is_ok()
		);
		let arbitrary = external.path().join("unapproved-executable");
		fs::write(&arbitrary, "#!/bin/sh\n").expect("arbitrary executable");
		assert!(policy.check_read(&arbitrary).is_err());
	}

	#[cfg(unix)]
	const READ: OpenRequest = OpenRequest { access: PathAccess::Read, create_mode: 0o666 };

	#[cfg(unix)]
	#[test]
	fn host_read_mode_admits_programs_reached_through_symlinks() {
		let workspace = tempfile::tempdir().expect("workspace");
		let tools = tempfile::tempdir().expect("tools");
		let prefix = homebrew_shaped_prefix(tools.path());
		let policy =
			policy_parts(&workspace_settings(), workspace.path(), WriteMode::Scoped, None, None)
				.expect("policy")
				.file_policy;
		assert!(!policy.read_restricted, "the default read view is host");
		// Exec lane (PATH hit as found), glob base through a linked keg, and the
		// program reached through that keg link.
		for path in ["bin/tool", "opt/tool/bin", "opt/tool/bin/tool"] {
			assert!(policy.check_read(&prefix.join(path)).is_ok(), "{path} must be readable");
		}
		let mut opened = policy
			.open(&prefix.join("bin/tool"), READ)
			.expect("in-shell read through a link");
		let mut contents = String::new();
		io::Read::read_to_string(&mut opened, &mut contents).expect("linked contents");
		assert!(contents.starts_with("#!/bin/sh\n"));
		// The write lane keeps refusing symlink components even where the
		// resolved target is writable.
		let new = prefix.join("opt/tool/bin/new");
		assert!(policy.check_write(&new).is_ok(), "the resolved target is writable");
		for access in [PathAccess::Truncate, PathAccess::ReadWrite] {
			assert!(
				policy
					.open(&new, OpenRequest { access, create_mode: 0o666 })
					.is_err()
			);
		}
		assert!(!prefix.join("Cellar/tool/1.0/bin/new").exists());
	}

	#[cfg(unix)]
	#[test]
	fn host_read_mode_resolves_symlinks_into_read_deny() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let outside = tempfile::tempdir().expect("outside");
		let secret = outside.path().join("secret");
		fs::create_dir(&secret).expect("secret root");
		fs::write(secret.join("key"), "private").expect("secret file");
		fs::write(outside.path().join("public"), "public").expect("public file");
		let links = outside.path().join("links");
		fs::create_dir(&links).expect("links");
		symlink(secret.join("key"), links.join("to-secret")).expect("secret link");
		symlink(outside.path().join("public"), links.join("to-public")).expect("public link");
		let settings = SandboxSettings {
			read_deny: vec![Str::from(secret.to_string_lossy().as_ref())],
			..workspace_settings()
		};
		let policy = policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		let denied = policy
			.check_read(&links.join("to-secret"))
			.expect_err("a link into read_deny is refused");
		assert_eq!(denied.access, PathAccess::Read);
		assert_eq!(denied.path, fs::canonicalize(secret.join("key")).expect("canonical key"));
		assert!(policy.open(&links.join("to-secret"), READ).is_err());
		assert!(policy.check_read(&links.join("to-public")).is_ok());
		assert!(policy.open(&links.join("to-public"), READ).is_ok());
	}

	#[cfg(unix)]
	#[test]
	fn host_read_mode_refuses_links_inside_read_deny_roots() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let outside = tempfile::tempdir().expect("outside");
		let denied_root = outside.path().join("denied");
		fs::create_dir(&denied_root).expect("denied root");
		let public = outside.path().join("public");
		fs::write(&public, "public").expect("public file");
		let link = denied_root.join("link");
		symlink(&public, &link).expect("link escaping the denied root");
		let settings = SandboxSettings {
			read_deny: vec![Str::from(denied_root.to_string_lossy().as_ref())],
			..workspace_settings()
		};
		let policy = policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		let denied = policy
			.check_read(&link)
			.expect_err("an entry inside read_deny stays refused");
		assert_eq!(denied.path, policy_lexical_path(&link).expect("lexical link"));
		assert!(policy.open(&link, READ).is_err());
		assert!(policy.check_read(&public).is_ok());
	}

	#[cfg(unix)]
	#[test]
	fn host_read_resolution_errors_fail_closed() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let outside = tempfile::tempdir().expect("outside");
		let denied_root = outside.path().join("denied");
		fs::create_dir(&denied_root).expect("denied root");
		symlink("loop", outside.path().join("loop")).expect("symlink loop");
		symlink(denied_root.join("future"), outside.path().join("dangling-denied"))
			.expect("dangling link into read_deny");
		symlink(outside.path().join("missing"), outside.path().join("dangling"))
			.expect("dangling link");
		let settings = SandboxSettings {
			read_deny: vec![Str::from(denied_root.to_string_lossy().as_ref())],
			..workspace_settings()
		};
		let policy = policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		assert!(policy.check_read(&outside.path().join("loop")).is_err());
		assert!(
			policy
				.check_read(&outside.path().join("loop/file"))
				.is_err()
		);
		assert!(
			policy
				.open(&outside.path().join("loop/file"), READ)
				.is_err()
		);
		assert!(
			policy
				.check_read(&outside.path().join("dangling-denied"))
				.is_err()
		);
		assert!(policy.open(&outside.path().join("dangling"), READ).is_err());
	}

	/// `link/../name` names the link target's sibling for the kernel, while its
	/// `..`-collapsed spelling names the link's own sibling. Admission and the
	/// opened file must both follow the kernel.
	#[cfg(unix)]
	#[test]
	fn host_read_applies_parent_components_after_following_a_link() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let outside = tempfile::tempdir().expect("outside");
		let ws = workspace.path();
		let denied_root = outside.path().join("denied");
		fs::create_dir_all(denied_root.join("dir")).expect("denied root");
		fs::write(denied_root.join("key"), "private").expect("denied key");
		let public = outside.path().join("public");
		fs::create_dir_all(public.join("dir")).expect("public dir");
		fs::write(public.join("sibling"), "physical").expect("physical sibling");
		// What each request's `..`-collapsed spelling would name instead.
		fs::write(ws.join("key"), "lexical").expect("lexical key");
		fs::write(ws.join("sibling"), "lexical").expect("lexical sibling");
		symlink(denied_root.join("missing"), ws.join("dangling")).expect("dangling link");
		symlink(denied_root.join("dir"), ws.join("dir-link")).expect("directory link");
		symlink(denied_root.join("key"), ws.join("file-link")).expect("file link");
		symlink(public.join("dir"), ws.join("public-link")).expect("public link");
		let settings = SandboxSettings {
			read_deny: vec![Str::from(denied_root.to_string_lossy().as_ref())],
			..workspace_settings()
		};
		let policy = policy_parts(&settings, ws, WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		let denied_root = fs::canonicalize(&denied_root).expect("canonical denied root");
		let key = denied_root.join("key");
		let sibling = denied_root.join("sibling");
		for (request, judged) in [
			("dangling/../key", key.as_path()),
			("dir-link/../key", key.as_path()),
			("file-link/../key", key.as_path()),
			("file-link/../sibling", sibling.as_path()),
			// A glob base: listing it lists the denied root.
			("dir-link/..", denied_root.as_path()),
			// Out through `..` again: the walk entered the denied root.
			("dir-link/../../public/sibling", denied_root.as_path()),
		] {
			let denied = policy.check_read(&ws.join(request)).expect_err(request);
			assert_eq!(denied.path, judged, "{request} is judged where the kernel walks");
			assert!(policy.open(&ws.join(request), READ).is_err(), "{request}");
		}
		let request = ws.join("public-link/../sibling");
		assert!(policy.check_read(&request).is_ok());
		let mut opened = policy.open(&request, READ).expect("physical sibling");
		let mut contents = String::new();
		io::Read::read_to_string(&mut opened, &mut contents).expect("sibling contents");
		assert_eq!(contents, "physical", "the opened file is the one the kernel names");
	}

	#[cfg(unix)]
	#[test]
	fn restricted_read_mode_refuses_parent_components_after_a_link() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let ws = workspace.path();
		let secrets = ws.join(".secrets");
		fs::create_dir_all(secrets.join("dir")).expect("denied root");
		fs::write(secrets.join("key"), "private").expect("denied key");
		fs::write(ws.join("key"), "lexical").expect("lexical key");
		fs::create_dir(ws.join("sub")).expect("plain directory");
		symlink(secrets.join("dir"), ws.join("link")).expect("link into read_deny");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::ReadOnly,
			read_mode: ReadMode::Minimal,
			read_deny: vec![Str::from(secrets.to_string_lossy().as_ref())],
			..Default::default()
		};
		let policy = policy_parts(&settings, ws, WriteMode::Deny, None, None)
			.expect("policy")
			.file_policy;
		// The collapsed spelling `<ws>/key` crosses no link and is readable, but
		// the walk follows `link` and would open `.secrets/key`.
		let request = ws.join("link/../key");
		assert!(policy.check_read(&request).is_err());
		assert!(policy.open(&request, READ).is_err());
		// `..` over a plain directory stays admitted.
		let mut opened = policy
			.open(&ws.join("sub/../key"), READ)
			.expect("plain parent component");
		let mut contents = String::new();
		io::Read::read_to_string(&mut opened, &mut contents).expect("key contents");
		assert_eq!(contents, "lexical");
	}

	#[cfg(unix)]
	#[test]
	fn restricted_read_mode_still_refuses_symlinks_outside_readable_roots() {
		let workspace = tempfile::tempdir().expect("workspace");
		let tools = tempfile::tempdir().expect("tools");
		let prefix = homebrew_shaped_prefix(tools.path());
		let settings = SandboxSettings {
			mode: ExecSandboxMode::ReadOnly,
			read_mode: ReadMode::Minimal,
			..Default::default()
		};
		let policy = policy_parts(&settings, workspace.path(), WriteMode::Deny, None, None)
			.expect("policy")
			.file_policy;
		let link = prefix.join("bin/tool");
		let denied = policy
			.check_read(&link)
			.expect_err("restricted reads refuse symlinks");
		// The symlink rule reports the requested spelling, not the link target.
		assert_eq!(denied.path, policy_lexical_path(&link).expect("lexical link"));
		assert!(policy.open(&link, READ).is_err());
	}

	#[cfg(unix)]
	#[test]
	fn approved_read_scope_admits_a_link_whose_target_is_read_denied() {
		let workspace = tempfile::tempdir().expect("workspace");
		let tools = tempfile::tempdir().expect("tools");
		let prefix = homebrew_shaped_prefix(tools.path());
		let keg = prefix.join("Cellar/tool/1.0");
		fs::write(keg.join("bin/other"), "other").expect("sibling");
		let settings = SandboxSettings {
			read_deny: vec![Str::from(keg.to_string_lossy().as_ref())],
			..workspace_settings()
		};
		let link = prefix.join("bin/tool");
		let target = fs::canonicalize(&link).expect("canonical target");
		let base = policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None)
			.expect("base policy")
			.file_policy;
		let denied = base
			.check_read(&link)
			.expect_err("the linked target is read-denied");
		assert_eq!(denied.path, target);
		let scope = ApprovedPathScope::capture(&link, ApprovedPathAccess::Read).expect("scope");
		assert_eq!(scope.label(), sf!("read {}", target.display()));
		let amended = policy_parts_with_approved_scope(
			&settings,
			workspace.path(),
			WriteMode::Scoped,
			requested_network_mode(&settings),
			None,
			None,
			Some(&scope),
		)
		.expect("amended policy")
		.file_policy;
		assert!(amended.check_read(&link).is_ok());
		assert!(amended.open(&link, READ).is_ok());
		assert!(amended.check_read(&keg.join("bin/other")).is_err());
	}

	#[test]
	fn read_only_policy_denies_every_write() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings { mode: ExecSandboxMode::ReadOnly, ..Default::default() };
		let policy = policy_parts(&settings, workspace.path(), WriteMode::Deny, None, None)
			.expect("policy")
			.file_policy;
		assert!(policy.check_write(&workspace.path().join("file")).is_err());
		assert!(
			policy
				.check_write(&std::env::temp_dir().join("file"))
				.is_err()
		);
		assert!(policy.check_write(Path::new("/dev/null")).is_ok());
	}

	#[cfg(unix)]
	#[test]
	fn default_policy_denies_device_write_other_than_dev_null() {
		let workspace = tempfile::tempdir().expect("workspace");
		let policy =
			policy_parts(&workspace_settings(), workspace.path(), WriteMode::Scoped, None, None)
				.expect("policy")
				.file_policy;
		assert!(policy.check_write(Path::new("/dev/zero")).is_err());
		assert!(
			policy
				.open(Path::new("/dev/zero"), OpenRequest {
					access:      PathAccess::Truncate,
					create_mode: 0o666,
				})
				.is_err()
		);
		assert!(policy.check_write(Path::new("/dev/null")).is_ok());
	}

	#[test]
	fn denied_carve_out_also_protects_its_strict_ancestors() {
		let workspace = tempfile::tempdir().expect("workspace");
		fs::create_dir(workspace.path().join(".git")).expect("carve-out");
		let policy =
			policy_parts(&workspace_settings(), workspace.path(), WriteMode::Scoped, None, None)
				.expect("policy")
				.file_policy;
		assert!(policy.check_write(workspace.path()).is_err());
		assert!(policy.check_write(&workspace.path().join("src")).is_ok());
	}

	#[test]
	fn parent_escape_is_resolved_before_root_matching() {
		let sandbox = tempfile::tempdir().expect("sandbox");
		let workspace = sandbox.path().join("workspace");
		fs::create_dir(&workspace).expect("workspace root");
		let settings = workspace_settings();
		let policy = policy_parts(&settings, &workspace, WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		// `..` traversal resolves before matching: the target lands in the
		// denied `.git` carve-out even though the lexical path never names it.
		let escaped = workspace.join("missing/../.git/config");
		assert!(policy.check_write(&escaped).is_err());
		// The sibling resolved the same way stays writable.
		assert!(
			policy
				.check_write(&workspace.join("missing/../kept.txt"))
				.is_ok()
		);
	}
	#[cfg(unix)]
	#[test]
	fn symlink_escape_is_resolved_before_root_matching() {
		use std::os::unix::fs::symlink;

		let sandbox = tempfile::tempdir().expect("sandbox");
		let workspace = sandbox.path().join("workspace");
		fs::create_dir(&workspace).expect("workspace root");
		fs::create_dir(workspace.join(".git")).expect("carve-out root");
		symlink(workspace.join(".git"), workspace.join("link")).expect("escape symlink");
		let policy = policy_parts(&workspace_settings(), &workspace, WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		// The symlink resolves into the denied carve-out before matching.
		assert!(policy.check_write(&workspace.join("link/config")).is_err());
	}

	/// The grants store and the user extension root are denied to sandboxed
	/// writes even under a writable root, whether they exist yet or not; only
	/// absolute paths are accepted.
	#[test]
	fn sandbox_denies_write_to_protected_paths() {
		let workspace = tempfile::tempdir().expect("workspace");
		let root = fs::canonicalize(workspace.path()).expect("canonical workspace");
		let store = root.join("data/ext");
		fs::create_dir_all(&store).expect("store");
		fs::write(store.join("grants.toml"), "").expect("grants file");
		let protected_file = root.join("protected.toml");
		fs::write(&protected_file, "").expect("protected file");
		let missing = root.join("config/agent/extensions");
		let protected = vec![store.clone(), protected_file.clone(), missing.clone()];
		let settings =
			SandboxSettings { protected_write_paths: protected.clone(), ..SandboxSettings::default() };
		let parts = policy_parts(&settings, &root, WriteMode::Scoped, None, None).expect("policy");
		for denied in [
			store.join("grants.toml"),
			store.join("new.toml"),
			store.clone(),
			protected_file.clone(),
			missing.clone(),
			missing.join("evil/manifest.toml"),
		] {
			assert!(
				parts.file_policy.check_write(&denied).is_err(),
				"allowed a write to {}",
				denied.display()
			);
		}
		assert!(
			parts
				.file_policy
				.check_write(&root.join("src/new.rs"))
				.is_ok(),
			"denied an ordinary workspace write"
		);
		let relative = SandboxSettings {
			protected_write_paths: vec![PathBuf::from("relative/ext")],
			..workspace_settings()
		};
		assert!(
			policy_parts(&relative, &root, WriteMode::Scoped, None, None).is_err(),
			"a relative protected path was accepted"
		);
		if native_backend() {
			let settings =
				SandboxSettings { protected_write_paths: protected, ..workspace_settings() };
			ExecSandbox::compile(&settings, &root, true, SandboxConsumer::Probe)
				.expect("native policy with protected paths");
		}
	}

	/// A protected location that contains the workspace cannot be denied without
	/// denying every in-process write the workspace needs. Admission already
	/// withholds control grants for it, so the file lane keeps the workspace
	/// writable while a protected location inside the workspace stays denied.
	#[test]
	fn workspace_under_a_protected_path_keeps_in_process_writes() {
		let dir = tempfile::tempdir().expect("base");
		let base = fs::canonicalize(dir.path()).expect("canonical base");
		let extension_root = base.join("config/agent/extensions");
		let workspace = extension_root.join("my-extension");
		let inner_store = workspace.join("data/ext");
		fs::create_dir_all(&inner_store).expect("workspace under the protected root");
		let settings = SandboxSettings {
			protected_write_paths: vec![extension_root, inner_store.clone()],
			exclude_tmpdir: true,
			exclude_slash_tmp: true,
			..SandboxSettings::default()
		};

		let parts =
			policy_parts(&settings, &workspace, WriteMode::Scoped, None, None).expect("policy");
		assert!(
			parts
				.file_policy
				.check_write(&workspace.join("src/lib.rs"))
				.is_ok(),
			"denied an ordinary write in a workspace under a protected path"
		);
		assert!(
			parts
				.file_policy
				.check_write(&inner_store.join("grants.toml"))
				.is_err(),
			"a protected location inside the workspace must stay denied"
		);
	}

	/// A protected location that contains a writable root is skipped only while
	/// it is itself outside every writable root. When the workspace already
	/// covers it, the deny stays, so a sibling of the nested root is not left
	/// writable.
	#[test]
	fn protected_path_in_scope_stays_denied_when_it_contains_a_writable_root() {
		let dir = tempfile::tempdir().expect("base");
		let base = fs::canonicalize(dir.path()).expect("canonical base");
		let outer = base.join("outer");
		let protected = outer.join("ext");
		let nested_root = protected.join("dev");
		fs::create_dir_all(&nested_root).expect("nested writable root");
		fs::create_dir_all(protected.join("other")).expect("sibling of the nested root");
		let settings = SandboxSettings {
			writable_roots: vec![Str::from(nested_root.to_string_lossy().as_ref())],
			protected_write_paths: vec![protected.clone()],
			exclude_tmpdir: true,
			exclude_slash_tmp: true,
			..SandboxSettings::default()
		};

		let parts = policy_parts(&settings, &outer, WriteMode::Scoped, None, None).expect("policy");
		assert!(
			parts
				.file_policy
				.check_write(&outer.join("src/lib.rs"))
				.is_ok(),
			"denied an ordinary write in the workspace"
		);
		assert!(
			parts
				.file_policy
				.check_write(&protected.join("other/x"))
				.is_err(),
			"a protected path inside the workspace must stay denied beside a nested writable root"
		);
	}
	#[cfg(unix)]
	#[test]
	fn external_target_carve_out_keeps_its_logical_kernel_deny_in_scope() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let external = tempfile::tempdir().expect("external");
		symlink(external.path(), workspace.path().join(".git")).expect("carve-out symlink");
		let root = fs::canonicalize(workspace.path()).expect("canonical workspace");
		let mut spec = SandboxSpec::new(std::env::current_exe().expect("current test executable"));
		spec.set_write(WriteMode::Scoped);
		spec.allow_write(&root).expect("write scope");
		record_write_deny(
			&mut spec,
			std::slice::from_ref(&root),
			&mut Vec::new(),
			WriteMode::Scoped,
			workspace.path().join(".git"),
		)
		.expect("logical carve-out");
		let error = omp_sandbox::Runner::for_backend(omp_sandbox::Backend::Bubblewrap)
			.compile(&spec)
			.expect_err("logical carve-out symlink must fail closed");
		assert!(
			matches!(error, omp_sandbox::SandboxError::ProtectedWriteDenySymlink { .. }),
			"unexpected error: {error:?}"
		);
	}

	#[cfg(unix)]
	#[test]
	fn protected_open_rejects_symlink_traversal_without_opening_target() {
		use std::os::unix::fs::symlink;

		let root = tempfile::tempdir().expect("root");
		let outside = tempfile::tempdir().expect("outside");
		let workspace = root.path().join("workspace");
		fs::create_dir(&workspace).expect("workspace");
		let target = outside.path().join("must-not-open");
		symlink(outside.path(), workspace.join("link")).expect("symlink");
		let policy = policy_parts(&workspace_settings(), &workspace, WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		assert!(
			policy
				.open(&workspace.join("link/must-not-open"), OpenRequest {
					access:      PathAccess::Truncate,
					create_mode: 0o666,
				},)
				.is_err()
		);
		assert!(!target.exists());
	}
	#[cfg(unix)]
	#[test]
	fn protected_open_refuses_a_write_walk_through_a_link_before_parent_components() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let ws = workspace.path();
		fs::create_dir_all(ws.join("sub/dir")).expect("link target");
		symlink(ws.join("sub/dir"), ws.join("link")).expect("link");
		let policy = policy_parts(&workspace_settings(), ws, WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		let request = ws.join("link/../new");
		// Builtin writes resolve the link and judge the writable target.
		assert!(policy.check_write(&request).is_ok());
		// A redirection never writes through a link, even one that `..` removes
		// from the collapsed spelling.
		for access in [PathAccess::Truncate, PathAccess::ReadWrite] {
			assert!(
				policy
					.open(&request, OpenRequest { access, create_mode: 0o666 })
					.is_err()
			);
		}
		assert!(!ws.join("sub/new").exists());
		assert!(!ws.join("new").exists());
	}
	#[cfg(unix)]
	#[test]
	fn policy_open_uses_the_requested_creation_mode() {
		use std::os::unix::fs::PermissionsExt as _;

		let workspace = tempfile::tempdir().expect("workspace");
		let policy =
			policy_parts(&workspace_settings(), workspace.path(), WriteMode::Scoped, None, None)
				.expect("policy")
				.file_policy;
		let path = workspace.path().join("private");
		policy
			.open(&path, OpenRequest { access: PathAccess::Truncate, create_mode: 0o600 })
			.expect("create through policy");
		assert_eq!(fs::metadata(path).expect("metadata").permissions().mode() & 0o777, 0o600);
	}

	#[cfg(unix)]
	#[test]
	fn frozen_scope_rejects_replaced_existing_ancestor() {
		let root = tempfile::tempdir().expect("root");
		let scope = root.path().join("approved");
		fs::create_dir(&scope).expect("scope");
		let frozen =
			ApprovedPathScope::capture(&scope.join("not-yet-created"), ApprovedPathAccess::Write)
				.expect("freeze scope");
		fs::remove_dir(&scope).expect("remove scope");
		fs::create_dir(&scope).expect("replace scope");
		assert!(frozen.verify().is_err());
	}

	#[cfg(unix)]
	#[test]
	fn dangling_symlink_is_followed_into_a_future_carve_out_path() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		fs::create_dir(workspace.path().join(".git")).expect("carve-out root");
		symlink(".git/new", workspace.path().join("link")).expect("dangling redirect");
		let policy =
			policy_parts(&workspace_settings(), workspace.path(), WriteMode::Scoped, None, None)
				.expect("policy")
				.file_policy;
		assert!(
			policy
				.check_write(&workspace.path().join("link/config"))
				.is_err()
		);
	}
	#[cfg(unix)]
	#[test]
	fn resolution_errors_fail_closed() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		symlink("loop", workspace.path().join("loop")).expect("symlink loop");
		let policy =
			policy_parts(&workspace_settings(), workspace.path(), WriteMode::Scoped, None, None)
				.expect("policy")
				.file_policy;
		assert!(
			policy
				.check_write(&workspace.path().join("loop/file"))
				.is_err()
		);
	}

	#[cfg(unix)]
	#[test]
	fn carve_out_symlink_protects_literal_and_resolved_target() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		fs::create_dir(workspace.path().join("metadata")).expect("metadata target");
		symlink("metadata", workspace.path().join(".omp")).expect("carve-out symlink");
		let policy =
			policy_parts(&workspace_settings(), workspace.path(), WriteMode::Scoped, None, None)
				.expect("policy")
				.file_policy;
		assert!(policy.check_write(&workspace.path().join(".omp")).is_err());
		assert!(
			policy
				.check_write(&workspace.path().join("metadata/state"))
				.is_err()
		);
	}

	#[test]
	fn gitdir_pointer_protects_referenced_directory() {
		let workspace = tempfile::tempdir().expect("workspace");
		fs::create_dir(workspace.path().join("metadata")).expect("metadata target");
		fs::write(workspace.path().join(".git"), "gitdir: metadata\n").expect("gitdir pointer");
		let policy =
			policy_parts(&workspace_settings(), workspace.path(), WriteMode::Scoped, None, None)
				.expect("policy")
				.file_policy;
		assert!(
			policy
				.check_write(&workspace.path().join("metadata/config"))
				.is_err()
		);
	}
	#[cfg(unix)]
	#[test]
	fn symlinked_writable_root_protects_its_symlinked_metadata_entry() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let real = tempfile::tempdir().expect("real root");
		let external = tempfile::tempdir().expect("external metadata");
		let logical = workspace.path().join("logical");
		symlink(real.path(), &logical).expect("logical root");
		symlink(external.path(), real.path().join(".git")).expect("metadata link");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::WorkspaceWrite,
			writable_roots: vec![Str::from(logical.to_string_lossy().as_ref())],
			exclude_tmpdir: true,
			exclude_slash_tmp: true,
			..SandboxSettings::default()
		};
		let policy = policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		assert!(
			policy
				.check_write(&real.path().join(".git/config"))
				.is_err()
		);
	}
	#[test]
	fn gitdir_target_in_later_writable_root_stays_protected() {
		let workspace = tempfile::tempdir().expect("workspace");
		let later = tempfile::tempdir().expect("later root");
		let target = later.path().join("metadata");
		fs::create_dir(&target).expect("gitdir target");
		fs::write(workspace.path().join(".git"), format!("gitdir: {}\n", target.display()))
			.expect("gitdir pointer");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::WorkspaceWrite,
			writable_roots: vec![Str::from(later.path().to_string_lossy().as_ref())],
			exclude_tmpdir: true,
			exclude_slash_tmp: true,
			..SandboxSettings::default()
		};
		let policy = policy_parts(&settings, workspace.path(), WriteMode::Scoped, None, None)
			.expect("policy")
			.file_policy;
		assert!(policy.check_write(&target.join("config")).is_err());
	}
	#[test]
	fn scoped_policy_owns_broker_and_forces_loopback_proxy_environment() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings {
			mode: ExecSandboxMode::ReadOnly,
			network_mode: SandboxNetworkMode::Scoped,
			allow_domains: vec![Str::new_static("example.test")],
			..SandboxSettings::default()
		};
		let proxy = ScopedProxy::start(&settings).expect("broker");
		let parts = policy_parts(&settings, workspace.path(), WriteMode::Deny, Some(&proxy), None)
			.expect("scoped policy");
		let wrapper = CommandWrapper::environment_only(&parts.spec);
		let env = wrapper
			.resolve_env([(OsString::from("HTTP_PROXY"), OsString::from("http://untrusted.invalid"))]);
		let expected_http = OsString::from(format!("http://127.0.0.1:{}", proxy.port()));
		let expected_socks = OsString::from(format!("socks5h://127.0.0.1:{}", proxy.port()));
		for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
			assert!(env.contains(&(OsString::from(name), expected_http.clone())));
		}
		for name in ["ALL_PROXY", "all_proxy"] {
			assert!(env.contains(&(OsString::from(name), expected_socks.clone())));
		}
		assert!(parts.spec_snapshot.contains("network=outbound"));
	}
}
