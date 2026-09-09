//! Sandboxing policy compiled per execution owner.

use std::{
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
	RUNTIME_READ_ROOTS, Runner, SandboxError, SandboxSpec, WriteMode,
};
use omp_shell::{OpenRequest, PathAccess, PathDenied, PathPolicy, SpawnWrapper};
use parking_lot::Mutex;

use crate::{
	exec_settings::{
		EnvironmentInheritance, ExecSandboxMode, ReadMode, SandboxNetworkMode, SandboxSettings,
		UnscopedWrites,
	},
	sandbox_proxy::ScopedProxy,
};

const CARVE_OUTS: [&str; 3] = [".git", ".omp", ".agents"];

/// One fact established by a sandboxed command attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SandboxDenialFact {
	/// An in-process or kernel policy rejected a read.
	ReadPath(PathBuf),
	/// An in-process or kernel policy rejected a mutation.
	WritePath(PathBuf),
	/// The scoped egress broker rejected this exact connection.
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
}

impl ApprovedPathScope {
	fn capture(path: &Path, access: ApprovedPathAccess) -> io::Result<Self> {
		let requested = normalize_absolute(&std::path::absolute(path)?)?;
		let scope = nearest_existing_scope(&requested)?;
		let identity = PathIdentity::capture(&scope)?;
		Ok(Self { access, display_scope: scope.clone(), scope, identity })
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

/// Precompiled kernel launcher and matching in-process file policy.
pub(crate) struct ExecSandbox {
	wrapper:      Arc<CommandWrapper>,
	file_policy:  FilePolicy,
	failure_note: Str,
	settings:     Arc<SandboxSettings>,
	workspace:    Arc<PathBuf>,
	supervised:   bool,
	_proxy:       Option<Arc<ScopedProxy>>,
}

/// One unforgeable execution attempt within an [`ExecSandbox`] session.
pub(crate) struct ExecSandboxAttempt {
	sandbox:  Arc<ExecSandbox>,
	denial:   Mutex<Option<SandboxDenialFact>>,
	token:    Option<Str>,
	finished: AtomicBool,
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
	) -> Result<Option<Arc<Self>>, SandboxError> {
		Self::compile_amended(settings, workspace_root, supervised, None, None, None)
	}

	fn compile_amended(
		settings: &SandboxSettings,
		workspace_root: &Path,
		supervised: bool,
		amendment: Option<&SandboxDenialFact>,
		approved_scope: Option<&ApprovedPathScope>,
		reused_proxy: Option<Arc<ScopedProxy>>,
	) -> Result<Option<Arc<Self>>, SandboxError> {
		if let Some(scope) = approved_scope {
			scope
				.verify()
				.map_err(|source| SandboxError::Canonicalize {
					path: scope.display_scope.clone(),
					source,
				})?;
		}
		if settings.mode == ExecSandboxMode::Off
			&& settings.network_mode != SandboxNetworkMode::Scoped
		{
			return if settings.environment_policy_is_default()
				&& settings.read_mode == ReadMode::Host
				&& settings.readable_roots.is_empty()
				&& settings.read_deny.is_empty()
				&& settings.read_deny_globs.is_empty()
			{
				Ok(None)
			} else {
				let mut parts = policy_parts_with_approved_scope(
					settings,
					workspace_root,
					WriteMode::Scoped,
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
					_proxy: None,
				})))
			};
		}
		let runner = Runner::native_command()?;
		let proxy = if let Some(proxy) = reused_proxy {
			Some(proxy)
		} else if settings.network_mode == SandboxNetworkMode::Scoped {
			let approved = match amendment {
				Some(SandboxDenialFact::Network { host, port }) => Some((host, *port)),
				_ => None,
			};
			Some(Arc::new(
				match approved {
					Some(approved) => ScopedProxy::start_with_amendment(settings, Some(approved)),
					None => ScopedProxy::start(settings),
				}
				.map_err(|source| SandboxError::BackendIo {
					backend: runner.backend(),
					operation: omp_sandbox::SandboxOperation::Compile,
					source,
				})?,
			))
		} else {
			None
		};
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
		note.push_str(<&'static str>::from(settings.network_mode));
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
			_proxy: proxy,
		})))
	}

	/// Returns the once-per-session effective sandbox diagnostic.
	pub(crate) fn session_note(&self) -> &Str {
		&self.failure_note
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
	pub(crate) fn amended_scope(
		&self,
		scope: &ApprovedPathScope,
	) -> Result<Option<Arc<Self>>, SandboxError> {
		Self::compile_amended(
			&self.settings,
			&self.workspace,
			self.supervised,
			None,
			Some(scope),
			self._proxy.clone(),
		)
	}

	/// Compiles a fresh one-shot policy allowing one broker endpoint.
	pub(crate) fn amended_network(
		&self,
		amendment: &SandboxDenialFact,
	) -> Result<Option<Arc<Self>>, SandboxError> {
		let SandboxDenialFact::Network { .. } = amendment else {
			return Ok(None);
		};
		Self::compile_amended(
			&self.settings,
			&self.workspace,
			self.supervised,
			Some(amendment),
			None,
			None,
		)
	}

	/// Opens one isolated denial collection interval for an execution attempt.
	pub(crate) fn begin_attempt(self: &Arc<Self>) -> Arc<ExecSandboxAttempt> {
		let token = self._proxy.as_ref().map(|proxy| proxy.begin_attempt());
		Arc::new(ExecSandboxAttempt {
			sandbox: Arc::clone(self),
			denial: Mutex::new(None),
			token,
			finished: AtomicBool::new(false),
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
	/// Consumes this attempt's path or proxy denial and invalidates its proxy
	/// capability.
	pub(crate) fn take_denial(&self) -> Option<SandboxDenialFact> {
		let path_denial = self.denial.lock().take();
		let proxy_denial = (!self.finished.swap(true, Ordering::AcqRel))
			.then(|| {
				self
					.token
					.as_ref()
					.and_then(|token| self.sandbox._proxy.as_ref()?.finish_attempt(token))
			})
			.flatten();
		path_denial
			.or_else(|| proxy_denial.map(|(host, port)| SandboxDenialFact::Network { host, port }))
	}

	fn record_path_denial<T>(&self, result: Result<T, PathDenied>) -> Result<T, PathDenied> {
		if let Err(denied) = &result {
			let fact = if denied.access == PathAccess::Read {
				SandboxDenialFact::ReadPath(denied.path.clone())
			} else {
				SandboxDenialFact::WritePath(denied.path.clone())
			};
			*self.denial.lock() = Some(fact);
		}
		result
	}

	fn proxy_environment(&self, environment: &mut Vec<(OsString, OsString)>) {
		let Some(proxy) = &self.sandbox._proxy else {
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

	fn open(&self, path: &Path, request: OpenRequest) -> Result<fs::File, PathDenied> {
		self.record_path_denial(self.sandbox.file_policy.open(path, request))
	}
}

impl Drop for ExecSandboxAttempt {
	fn drop(&mut self) {
		if !self.finished.swap(true, Ordering::AcqRel) {
			if let Some(token) = &self.token {
				let _ = self
					.sandbox
					._proxy
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
}

impl FilePolicy {
	fn denied(path: &Path, access: PathAccess) -> PathDenied {
		PathDenied { path: std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()), access }
	}

	fn check_read(&self, path: &Path) -> Result<(), PathDenied> {
		let lexical = policy_lexical_path(path).map_err(|_| Self::denied(path, PathAccess::Read))?;
		if has_symlink_component(&lexical).map_err(|_| Self::denied(&lexical, PathAccess::Read))?
			&& !is_runtime_baseline_path(&lexical)
		{
			return Err(Self::denied(&lexical, PathAccess::Read));
		}
		let resolved =
			resolve_write_path(&lexical).map_err(|_| Self::denied(&lexical, PathAccess::Read))?;
		if self
			.read_amendment
			.as_ref()
			.is_some_and(|scope| resolved.starts_with(scope))
		{
			return Ok(());
		}
		if resolved == Path::new("/dev/null")
			|| !self.read_restricted
				&& !self
					.read_denied
					.iter()
					.any(|root| resolved.starts_with(root))
			|| self.readable.iter().any(|root| resolved.starts_with(root))
				&& !self
					.read_denied
					.iter()
					.any(|root| resolved.starts_with(root))
		{
			Ok(())
		} else {
			Err(Self::denied(&resolved, PathAccess::Read))
		}
	}

	fn check_write(&self, path: &Path) -> Result<(), PathDenied> {
		let resolved = resolve_write_path(path).map_err(|_| Self::denied(path, PathAccess::Write))?;
		if resolved == Path::new("/dev/null") {
			return Ok(());
		}
		if self
			.write_amendment
			.as_ref()
			.is_some_and(|scope| resolved.starts_with(scope))
		{
			return Ok(());
		}
		let allowed = self.writable.iter().any(|root| resolved.starts_with(root));
		let denied = self
			.write_denied
			.iter()
			.any(|root| resolved.starts_with(root) || root.starts_with(&resolved));
		if allowed && !denied {
			Ok(())
		} else {
			Err(Self::denied(&resolved, PathAccess::Write))
		}
	}

	fn open(&self, path: &Path, request: OpenRequest) -> Result<fs::File, PathDenied> {
		let access = request.access;
		let is_read = matches!(access, PathAccess::Read | PathAccess::ReadWrite);
		if is_read {
			self.check_read(path)?;
		}
		if !matches!(access, PathAccess::Read) {
			self.check_write(path)?;
		}
		let lexical = policy_lexical_path(path).map_err(|_| Self::denied(path, access))?;
		if has_symlink_component(&lexical).map_err(|_| Self::denied(&lexical, access))?
			&& (access != PathAccess::Read || !is_runtime_baseline_path(&lexical))
		{
			return Err(Self::denied(&lexical, access));
		}
		let opened_path = resolve_write_path(path).map_err(|_| Self::denied(path, access))?;
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
			open_beneath_root(root, &opened_path, request)
				.map_err(|_| Self::denied(&opened_path, access))
		}
		#[cfg(not(unix))]
		{
			let _ = access;
			Err(Self::denied(path, access))
		}
	}
}

fn is_runtime_baseline_path(path: &Path) -> bool {
	RUNTIME_READ_ROOTS
		.iter()
		.any(|root| path.starts_with(Path::new(root)))
}

fn has_symlink_component(path: &Path) -> io::Result<bool> {
	let mut current = PathBuf::new();
	for component in path.components() {
		current.push(component.as_os_str());
		match fs::symlink_metadata(&current) {
			Ok(metadata) if metadata.file_type().is_symlink() => return Ok(true),
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(error),
		}
	}
	Ok(false)
}
fn policy_lexical_path(path: &Path) -> io::Result<PathBuf> {
	let path = normalize_absolute(&std::path::absolute(path)?)?;
	#[cfg(target_os = "macos")]
	{
		for (logical, physical) in [
			(Path::new("/tmp"), Path::new("/private/tmp")),
			(Path::new("/var"), Path::new("/private/var")),
			(Path::new("/etc"), Path::new("/private/etc")),
		] {
			if path == logical {
				return Ok(physical.to_path_buf());
			}
			if let Ok(suffix) = path.strip_prefix(logical) {
				return Ok(physical.join(suffix));
			}
		}
	}
	Ok(path)
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

#[cfg(test)]
fn policy_parts(
	settings: &SandboxSettings,
	workspace_root: &Path,
	write: WriteMode,
	proxy: Option<&ScopedProxy>,
	amendment: Option<&SandboxDenialFact>,
) -> Result<PolicyParts, SandboxError> {
	policy_parts_with_approved_scope(settings, workspace_root, write, proxy, amendment, None)
}

fn policy_parts_with_approved_scope(
	settings: &SandboxSettings,
	workspace_root: &Path,
	write: WriteMode,
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
		.set_network(match settings.network_mode {
			SandboxNetworkMode::Disabled => NetworkMode::Disabled,
			SandboxNetworkMode::Open => NetworkMode::Enabled,
			SandboxNetworkMode::Scoped => NetworkMode::Outbound,
		})
		.set_degradation(DegradationPolicy::Reject);
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
			snapshot.push_str(<&'static str>::from(match settings.network_mode {
				SandboxNetworkMode::Disabled => NetworkMode::Disabled,
				SandboxNetworkMode::Open => NetworkMode::Enabled,
				SandboxNetworkMode::Scoped => NetworkMode::Outbound,
			}));
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

fn capability_failure(error: &SandboxError) -> bool {
	matches!(
		error,
		SandboxError::BackendCapabilities { .. } | SandboxError::NoBackendCapabilities { .. }
	)
}

fn resolve_write_path(path: &Path) -> io::Result<PathBuf> {
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
					match fs::symlink_metadata(&candidate) {
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

#[cfg(test)]
mod tests {
	use super::*;

	fn workspace_settings() -> SandboxSettings {
		SandboxSettings { mode: ExecSandboxMode::WorkspaceWrite, ..SandboxSettings::default() }
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
		assert!(parts.spec_snapshot.contains("network=disable"));
		assert!(parts.spec_snapshot.contains("write=scope"));
		for pattern in ["*KEY*", "*SECRET*", "*TOKEN*"] {
			assert!(parts.spec_snapshot.contains(pattern));
		}
	}
	#[test]
	fn off_mode_compiles_environment_only_policy_and_applies_overrides_last() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings {
			env_inherit: EnvironmentInheritance::None,
			env_deny: vec![Str::new_static("*KEY*")],
			env_set: std::collections::BTreeMap::from([(
				Str::new_static("FIXED"),
				Str::new_static("value"),
			)]),
			..SandboxSettings::default()
		};
		let sandbox = ExecSandbox::compile(&settings, workspace.path(), true)
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
		let settings =
			SandboxSettings { env_deny: vec![Str::new_static("*KEY*")], ..SandboxSettings::default() };
		let sandbox = ExecSandbox::compile(&settings, workspace.path(), true)
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
		let settings =
			SandboxSettings { network_mode: SandboxNetworkMode::Scoped, ..SandboxSettings::default() };
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
