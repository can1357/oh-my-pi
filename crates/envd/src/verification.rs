//! Fail-closed process authority for native verification of captured inputs.
//!
//! This profile deliberately has no inherited workspace environment, network,
//! model, or credential bridge. It is an execution boundary, not an attestation
//! that project tests are honest. The trusted operating-system runtime and host
//! administrator remain outside the content-addressed dependency boundary.

#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::{
	collections::{BTreeMap, BTreeSet},
	env::{split_paths, var_os},
	fs,
	io::{self, Read},
	mem::take,
	path::{Path, PathBuf},
	str::from_utf8,
	sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use omp_con::{ConError, Ctx, Kv, Origin, Value};
use omp_core::{EnvPath, Hash32, Str};
use omp_env::{ClientError, EnvClient, ExecEvent};
use omp_proto::env::v1::{
	CloseSessionRequest, ExecOutcome, ExecRequest, ExecStatusMsg, OpenSessionRequest, OutputChannel,
	OutputRequest, Script,
};
use tokio::{
	task::{JoinError, spawn_blocking},
	time::{Instant, sleep_until, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
	EnvdError, ProjectEnvironment, RegistryBridges,
	admission::{SandboxState, probe_sandbox},
};

const MAX_DEPENDENCY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_DEPENDENCY_FILES: usize = 200_000;
const DRAIN_GRACE: Duration = Duration::from_secs(10);

/// Executables resolved by the host's trusted binary resolver, never a project.
#[derive(Clone, Debug)]
pub struct HostToolPaths {
	/// Host `just` executable.
	pub just:    PathBuf,
	/// Host Cargo executable (possibly a rustup proxy).
	pub cargo:   PathBuf,
	/// Host compiler executable (possibly a rustup proxy).
	pub rustc:   PathBuf,
	/// Host cargo-nextest executable.
	pub nextest: PathBuf,
}

/// Actual executables admitted for the captured project's selected toolchain.
#[derive(Clone, Debug)]
pub struct VerificationTools {
	/// Canonical `just` executable.
	pub just:           PathBuf,
	/// Toolchain Cargo executable, bypassing rustup dispatch.
	pub cargo:          PathBuf,
	/// Toolchain compiler executable, bypassing rustup dispatch.
	pub rustc:          PathBuf,
	/// Toolchain documentation-test compiler.
	pub rustdoc:        PathBuf,
	/// Canonical cargo-nextest executable.
	pub nextest:        PathBuf,
	/// Controlled nextest configuration with no project setup hooks.
	pub nextest_config: PathBuf,
}

/// Host-owned execution settings; these are not workflow-supplied tool paths.
#[derive(Clone, Debug)]
pub struct VerificationRuntimeOptions {
	/// Captured-input lease root, containing `src`, `out`, and `tmp`.
	pub run_root:         PathBuf,
	/// Parent for owned temporary EnvD state, outside the lease and checkout.
	/// Durable verification receipts and evidence belong to the caller's
	/// session, not this disposable process-host scratch directory.
	pub state_dir:        PathBuf,
	/// Original checkout, excluded from all tool/runtime roots.
	pub project_root:     PathBuf,
	/// Operator-resolved host tools.
	pub tools:            HostToolPaths,
	/// Maximum lifetime of this runtime, including admission probes.
	pub timeout:          Duration,
	/// Combined stdout/stderr limit for one command.
	pub max_output_bytes: usize,
}

/// Bounded original process output and the unmodified terminal protocol facts.
#[derive(Debug)]
pub struct VerificationCommandResult {
	/// Original stdout bytes, never model-facing minimized output.
	pub stdout:        Bytes,
	/// Original stderr bytes.
	pub stderr:        Bytes,
	/// Terminal status, absent when the stream was not successfully drained.
	pub status:        Option<ExecStatusMsg>,
	/// Every original output byte and contiguous frame was retained.
	pub complete:      bool,
	/// Caller cancellation was observed.
	pub cancelled:     bool,
	/// A command or runtime deadline was reached.
	pub timed_out:     bool,
	/// The native host delivered a terminal status for the process tree.
	pub effects_known: bool,
}

impl VerificationCommandResult {
	/// Whether a completely observed process exited successfully.
	pub fn succeeded(&self) -> bool {
		self.complete
			&& self.effects_known
			&& !self.cancelled
			&& !self.timed_out
			&& self.status.as_ref().is_some_and(|status| {
				status.outcome == ExecOutcome::Exited as i32
					&& status.exit_code == Some(0)
					&& !status.aborted
			})
	}
}

/// Failures to admit or operate an isolated verification process authority.
#[derive(Debug, thiserror::Error)]
pub enum VerificationRuntimeError {
	/// A native filesystem operation failed.
	#[error("verification filesystem operation failed at {path}")]
	Io {
		/// Affected host path.
		path:   PathBuf,
		/// Underlying filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A tool, state, or runtime root overlaps untrusted source.
	#[error("verification host path is not admissible: {path}")]
	UntrustedPath {
		/// Refused canonical path.
		path: PathBuf,
	},
	/// Required host input is absent.
	#[error("verification requires host configuration {name}")]
	MissingHostInput {
		/// Static environment key.
		name: &'static str,
	},
	/// A bounded inventory cannot represent all inputs.
	#[error("verification dependency inventory exceeds its resource bound")]
	InventoryLimit,
	/// A dependency has an unsupported filesystem representation.
	#[error("verification dependency is not a regular file or directory: {path}")]
	UnsupportedDependency {
		/// Unsupported path.
		path: PathBuf,
	},
	/// An admitted file changed size during streaming inventory.
	#[error("verification dependency changed during inventory: {path}")]
	DependencyChanged {
		/// File whose observed size was inconsistent.
		path: PathBuf,
	},
	/// A native admission probe did not produce complete success.
	#[error("verification tool admission probe failed: {path}")]
	ProbeFailed {
		/// Tool being probed.
		path:      PathBuf,
		/// Bounded original probe stdout for admission diagnosis.
		stdout:    Bytes,
		/// Bounded original probe stderr.
		stderr:    Bytes,
		/// Whether every original output byte was observed.
		complete:  bool,
		/// Native normal exit code, when available.
		exit_code: Option<i32>,
	},
	/// Compiler sysroot output was not an absolute UTF-8 path.
	#[error("compiler returned an invalid verification sysroot")]
	InvalidSysroot,
	/// Caller supplied an invalid timeout or output limit.
	#[error("invalid verification runtime budget")]
	InvalidBudget,
	/// The host cannot enforce the mandatory source and network fences.
	#[error("native verification confinement is unavailable")]
	ConfinementUnavailable,
	/// Work was cancelled before admission completed.
	#[error("verification runtime admission cancelled")]
	Cancelled,
	/// External-input freshness validation exceeded the runtime deadline.
	#[error("verification runtime deadline reached")]
	Deadline,
	/// Native session teardown exceeded its bounded grace period.
	#[error("verification native session shutdown timed out")]
	ShutdownTimeout,
	/// Typed configuration validation failed.
	#[error(transparent)]
	Configuration(#[from] ConError),
	/// Existing environment composition failed.
	#[error(transparent)]
	Environment(#[from] EnvdError),
	/// Existing typed environment protocol failed.
	#[error(transparent)]
	Client(#[from] ClientError),
	/// Inventory worker failed.
	#[error(transparent)]
	Worker(#[from] JoinError),
}

/// One isolated native process session over a captured source lease.
pub struct VerificationRuntime {
	environment:         Option<ProjectEnvironment>,
	// Fields drop in declaration order: stop the host before deleting its
	// disposable CAS/index state. Session-owned S3 evidence is never stored here.
	owned_state:         Option<tempfile::TempDir>,
	session:             Bytes,
	tools:               VerificationTools,
	environment_digest:  Hash32,
	toolchain_digest:    Hash32,
	tool_bytes_digest:   Hash32,
	dependencies_digest: Hash32,
	source_digest:       Hash32,
	source_root:         PathBuf,
	tool_roots:          Vec<PathBuf>,
	dependency_roots:    Vec<PathBuf>,
	deadline:            Instant,
	max_output_bytes:    usize,
}

impl VerificationRuntime {
	/// Admits actual tools and dependency bytes, then opens a strictly isolated
	/// native environment. Unsupported confinement never falls back to the host.
	pub async fn open(
		options: VerificationRuntimeOptions,
		cancel: &CancellationToken,
	) -> Result<Self, VerificationRuntimeError> {
		if options.timeout.is_zero()
			|| options.timeout > Duration::from_secs(1800)
			|| options.max_output_bytes == 0
			|| options.max_output_bytes > 8 * 1024 * 1024
		{
			return Err(VerificationRuntimeError::InvalidBudget);
		}
		let deadline = Instant::now() + options.timeout;
		let run_root = canonical(&options.run_root)?;
		let source = canonical(&run_root.join("src"))?;
		let source_digest = inventory_before(vec![source.clone()], cancel, deadline).await?;
		let project = canonical(&options.project_root)?;
		fs::create_dir_all(&options.state_dir).map_err(|source| io_at(&options.state_dir, source))?;
		let state = canonical(&options.state_dir)?;
		if state.starts_with(&run_root)
			|| state.starts_with(&project)
			|| run_root.starts_with(&state)
			|| project.starts_with(&state)
			|| run_root.starts_with(&project)
			|| project.starts_with(&run_root)
		{
			return Err(VerificationRuntimeError::UntrustedPath { path: state });
		}
		let owned_state = tempfile::Builder::new()
			.prefix("native-verification-")
			.tempdir_in(&state)
			.map_err(|source| io_at(&state, source))?;
		let state = canonical(owned_state.path())?;
		let out = canonical(&run_root.join("out"))?;
		let tmp = canonical(&run_root.join("tmp"))?;
		if source != run_root.join("src")
			|| out != run_root.join("out")
			|| tmp != run_root.join("tmp")
		{
			return Err(VerificationRuntimeError::UntrustedPath { path: run_root });
		}
		let protected = run_root.join("tools");
		fs::create_dir(&protected).map_err(|source| io_at(&protected, source))?;
		let just = admit_tool(&options.tools.just, &project, &run_root)?;
		let nextest = admit_tool(&options.tools.nextest, &project, &run_root)?;
		let compiler_proxy = admit_tool(&options.tools.rustc, &project, &run_root)?;
		let cargo_proxy = admit_tool(&options.tools.cargo, &project, &run_root)?;
		let cargo_home = host_directory("CARGO_HOME", ".cargo")?;
		let registry = canonical(&cargo_home.join("registry"))?;
		check_external(&registry, &project, &run_root)?;
		let private_home = out.join("home");
		let private_cargo = out.join("cargo");
		for directory in [&private_home, &private_cargo, &out.join("target"), &out.join("xdg")] {
			fs::create_dir_all(directory).map_err(|source| io_at(directory, source))?;
		}
		// Cargo searches both names even with a private CARGO_HOME. Protect
		// existing empty files so build scripts cannot introduce a runner or
		// compiler wrapper through this otherwise writable cache directory.
		for name in ["config", "config.toml"] {
			let path = private_cargo.join(name);
			fs::write(&path, b"").map_err(|source| io_at(&path, source))?;
			let mut permissions = fs::metadata(&path)
				.map_err(|source| io_at(&path, source))?
				.permissions();
			permissions.set_readonly(true);
			fs::set_permissions(&path, permissions).map_err(|source| io_at(&path, source))?;
		}
		#[cfg(unix)]
		symlink(&registry, private_cargo.join("registry"))
			.map_err(|source| io_at(&private_cargo, source))?;
		#[cfg(not(unix))]
		return Err(VerificationRuntimeError::UnsupportedDependency { path: registry });

		let mut env = BTreeMap::new();
		for (name, value) in [
			("HOME", private_home.as_path()),
			("CARGO_HOME", private_cargo.as_path()),
			("CARGO_TARGET_DIR", out.join("target").as_path()),
			("XDG_CONFIG_HOME", out.join("xdg").as_path()),
			("TMPDIR", tmp.as_path()),
			("TMP", tmp.as_path()),
			("TEMP", tmp.as_path()),
		] {
			env.insert(Str::from(name), path_str(value)?);
		}
		for (name, value) in [
			("CARGO_NET_OFFLINE", "true"),
			("CARGO_BUILD_JOBS", "2"),
			("CARGO_TERM_COLOR", "never"),
			("CARGO_INCREMENTAL", "0"),
			("NEXTEST_EXPERIMENTAL_LIBTEST_JSON", "1"),
			("RUSTFLAGS", ""),
			("CARGO_ENCODED_RUSTFLAGS", ""),
			("RUSTDOCFLAGS", ""),
			("CARGO_ENCODED_RUSTDOCFLAGS", ""),
			("RUSTC_WRAPPER", ""),
			("RUSTC_WORKSPACE_WRAPPER", ""),
			("CARGO_BUILD_RUSTC_WRAPPER", ""),
			("CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER", ""),
			("LANG", "C.UTF-8"),
			("TZ", "UTC"),
		] {
			env.insert(Str::from(name), Str::from(value));
		}

		let mut readable = BTreeSet::from([registry.clone()]);
		// Debian-style compiler/linker entry points resolve through this
		// system-managed indirection directory, outside /usr itself.
		let alternatives = Path::new("/etc/alternatives");
		if alternatives.is_dir() {
			readable.insert(alternatives.to_owned());
		}
		let mut dependency_roots = vec![registry];
		let mut paths = BTreeSet::new();
		// Only canonical directories from the operator's PATH are eligible. The
		// checkout and lease are explicitly excluded, including relative PATH.
		if let Some(host_path) = var_os("PATH") {
			for path in split_paths(&host_path).filter(|path| path.is_absolute()) {
				let Ok(path) = fs::canonicalize(path) else {
					continue;
				};
				if check_external(&path, &project, &run_root).is_ok() {
					paths.insert(path);
				}
			}
		}
		for tool in [&just, &nextest, &compiler_proxy, &cargo_proxy] {
			let parent = tool
				.parent()
				.ok_or(VerificationRuntimeError::InvalidSysroot)?;
			check_external(parent, &project, &run_root)?;
			paths.insert(parent.to_owned());
			readable.insert(parent.to_owned());
		}
		readable.extend(paths.iter().cloned());
		// Operating-system runtime roots are the explicit trusted baseline.
		// Operator-installed helper directories outside it are content-fenced.
		for path in &paths {
			if !trusted_os_runtime(path) {
				dependency_roots.push(path.clone());
			}
		}
		if let Some(config) = var_os("PYO3_CONFIG_FILE") {
			let config = canonical(Path::new(&config))?;
			check_external(&config, &project, &run_root)?;
			let bundle = config
				.parent()
				.ok_or(VerificationRuntimeError::InvalidSysroot)?
				.to_owned();
			check_external(&bundle, &project, &run_root)?;
			readable.insert(bundle.clone());
			dependency_roots.push(bundle);
			env.insert(Str::from("PYO3_CONFIG_FILE"), path_str(&config)?);
		}
		// Preserve argv[0] for rustup dispatch, while preventing the checked
		// process from replacing its bootstrap binary.
		let is_rustup = compiler_proxy
			.file_name()
			.is_some_and(|name| name == "rustup");
		let bootstrap_compiler = if is_rustup {
			let path = protected.join("rustc");
			fs::copy(&compiler_proxy, &path).map_err(|source| io_at(&path, source))?;
			path
		} else {
			compiler_proxy.clone()
		};
		let bootstrap_readable = readable.clone();
		if is_rustup {
			let rustup_home = host_directory("RUSTUP_HOME", ".rustup")?;
			check_external(&rustup_home, &project, &run_root)?;
			readable.insert(rustup_home.clone());
			env.insert(Str::from("RUSTUP_HOME"), path_str(&rustup_home)?);
		}
		env.insert(Str::from("PATH"), joined_paths(&paths)?);
		let (bootstrap, bootstrap_session) = open_environment(
			&run_root,
			&source,
			&state.join("bootstrap"),
			&protected,
			&readable,
			&env,
		)
		.await?;
		let probe = execute(
			bootstrap.client(),
			&bootstrap_session,
			&[path_str(&bootstrap_compiler)?, Str::from("--print"), Str::from("sysroot")],
			deadline,
			options.max_output_bytes.min(64 * 1024),
			cancel,
		)
		.await;
		let closed = timeout(
			DRAIN_GRACE,
			bootstrap.client().close_session(CloseSessionRequest {
				session: bootstrap_session,
				..Default::default()
			}),
		)
		.await;
		drop(bootstrap);
		closed.map_err(|_| VerificationRuntimeError::ShutdownTimeout)??;
		let bootstrap_state = state.join("bootstrap");
		fs::remove_dir_all(&bootstrap_state).map_err(|source| io_at(&bootstrap_state, source))?;
		let probe = probe?;
		// Full rustup state is necessary only to resolve the selected sysroot.
		// Final execution admits and fingerprints that sysroot alone.
		readable = bootstrap_readable;
		if !probe.succeeded() {
			return Err(VerificationRuntimeError::ProbeFailed {
				path:      compiler_proxy,
				complete:  probe.complete,
				exit_code: probe.status.as_ref().and_then(|status| status.exit_code),
				stdout:    probe.stdout,
				stderr:    probe.stderr,
			});
		}
		let sysroot = from_utf8(&probe.stdout)
			.ok()
			.map(str::trim)
			.filter(|text| !text.is_empty())
			.map(PathBuf::from)
			.filter(|path| path.is_absolute())
			.ok_or(VerificationRuntimeError::InvalidSysroot)?;
		let sysroot = canonical(&sysroot)?;
		check_external(&sysroot, &project, &run_root)?;
		let actual = |name: &str| admit_tool(&sysroot.join("bin").join(name), &project, &run_root);
		let config = protected.join("nextest.toml");
		fs::write(&config, "[profile.default]\nretries = 0\nfail-fast = false\n")
			.map_err(|source| io_at(&config, source))?;
		let tools = VerificationTools {
			just,
			cargo: actual("cargo")?,
			rustc: actual("rustc")?,
			rustdoc: actual("rustdoc")?,
			nextest,
			nextest_config: config,
		};
		// No rustup mutation, ambient wrappers, or workspace-selected compiler
		// is involved once the selected real toolchain has been admitted.
		env.remove("RUSTUP_HOME");
		for (name, path) in
			[("CARGO", &tools.cargo), ("RUSTC", &tools.rustc), ("RUSTDOC", &tools.rustdoc)]
		{
			env.insert(Str::from(name), path_str(path)?);
		}
		// Build helpers and nextest may invoke Cargo by name. Prefer the
		// admitted toolchain over ambient rustup proxies after bootstrap.
		let compiler_bin = sysroot.join("bin");
		paths.remove(&compiler_bin);
		env.insert(
			Str::from("PATH"),
			Str::from(format!("{}:{}", path_str(&compiler_bin)?, joined_paths(&paths)?)),
		);
		readable.insert(sysroot.clone());
		let tool_roots = vec![
			sysroot,
			tools.just.clone(),
			tools.nextest.clone(),
			protected,
			private_cargo.join("config"),
			private_cargo.join("config.toml"),
		];
		let toolchain_digest = inventory_before(tool_roots.clone(), cancel, deadline).await?;
		let dependencies_digest =
			inventory_before(dependency_roots.clone(), cancel, deadline).await?;
		let (environment, session) = open_environment(
			&run_root,
			&source,
			&state.join("execution"),
			&run_root.join("tools"),
			&readable,
			&env,
		)
		.await?;
		let mut runtime = Self {
			environment: Some(environment),
			owned_state: Some(owned_state),
			session,
			tools,
			environment_digest: environment_hash(&env),
			toolchain_digest,
			tool_bytes_digest: toolchain_digest,
			dependencies_digest,
			source_digest,
			source_root: source,
			tool_roots,
			dependency_roots: take(&mut dependency_roots),
			deadline,
			max_output_bytes: options.max_output_bytes,
		};
		for tool in [
			runtime.tools.just.clone(),
			runtime.tools.cargo.clone(),
			runtime.tools.rustc.clone(),
			runtime.tools.rustdoc.clone(),
			runtime.tools.nextest.clone(),
		] {
			let argument = if tool == runtime.tools.rustc {
				"-Vv"
			} else {
				"--version"
			};
			let result = runtime
				.command(&[path_str(&tool)?, Str::from(argument)], Duration::from_secs(30), cancel)
				.await;
			let result = match result {
				Ok(result) => result,
				Err(error) => {
					runtime.close().await?;
					return Err(error);
				},
			};
			if !result.succeeded() {
				let path = tool;
				runtime.close().await?;
				return Err(VerificationRuntimeError::ProbeFailed {
					path,
					complete: result.complete,
					exit_code: result.status.as_ref().and_then(|status| status.exit_code),
					stdout: result.stdout,
					stderr: result.stderr,
				});
			}
			// Both probe output and binary bytes identify the observed toolchain.
			let mut digest = Hash32::hasher();
			digest
				.update(runtime.toolchain_digest.as_bytes())
				.update(&result.stdout)
				.update(&result.stderr);
			runtime.toolchain_digest = digest.finalize();
		}
		// Retain a separate byte fence: probe transcripts are already included
		// in toolchain_digest and are not recomputed as dependency inventories.
		Ok(runtime)
	}

	/// Existing typed environment client, sharing this runtime's process
	/// authority.
	pub fn client(&self) -> &EnvClient {
		self.environment.as_ref().expect("runtime is open").client()
	}

	/// Actual admitted toolchain executables and controlled nextest
	/// configuration.
	pub const fn tools(&self) -> &VerificationTools {
		&self.tools
	}

	/// Digest of the exact explicit child environment and fixed sandbox profile.
	pub const fn environment_digest(&self) -> Hash32 {
		self.environment_digest
	}

	/// Digest of admitted compiler/runtime bytes and observed version probes.
	pub const fn toolchain_digest(&self) -> Hash32 {
		self.toolchain_digest
	}

	/// Digest of admitted registry and external Python bundle bytes.
	pub const fn dependencies_digest(&self) -> Hash32 {
		self.dependencies_digest
	}

	/// Executes fixed host-composed arguments through the existing raw EnvD
	/// stream.
	pub async fn command(
		&self,
		argv: &[Str],
		timeout: Duration,
		cancel: &CancellationToken,
	) -> Result<VerificationCommandResult, VerificationRuntimeError> {
		if argv.is_empty() || timeout.is_zero() {
			return Err(VerificationRuntimeError::InvalidBudget);
		}
		execute(
			self.client(),
			&self.session,
			argv,
			self.deadline.min(Instant::now() + timeout),
			self.max_output_bytes,
			cancel,
		)
		.await
	}

	/// Rehashes admitted external bytes and the frozen source tree, including
	/// additions/removals by another host process. The original checkout
	/// freshness fence is separately owned by the driver snapshot authority.
	pub async fn revalidate(
		&self,
		parent_cancel: &CancellationToken,
	) -> Result<bool, VerificationRuntimeError> {
		let cancel = parent_cancel.child_token();
		let work = async {
			let tools = inventory(self.tool_roots.clone(), cancel.clone()).await?;
			let dependencies = inventory(self.dependency_roots.clone(), cancel.clone()).await?;
			let source = inventory(vec![self.source_root.clone()], cancel.clone()).await?;
			Ok::<_, VerificationRuntimeError>((tools, dependencies, source))
		};
		let result = timeout_at(self.deadline, work).await;
		cancel.cancel();
		let (tools, dependencies, source) =
			result.map_err(|_| VerificationRuntimeError::Deadline)??;
		// Version probe transcripts belong to the key; the immutable baseline
		// byte digest is the separate freshness fence.
		Ok(tools == self.tool_bytes_digest
			&& dependencies == self.dependencies_digest
			&& source == self.source_digest)
	}

	/// Stops the native session before its captured-input lease can be released.
	pub async fn close(mut self) -> Result<(), VerificationRuntimeError> {
		let result = timeout(
			DRAIN_GRACE,
			self.client().close_session(CloseSessionRequest {
				session: self.session.clone(),
				..Default::default()
			}),
		)
		.await;
		self.environment.take();
		if let Some(state) = self.owned_state.take() {
			let path = state.path().to_owned();
			state.close().map_err(|source| io_at(&path, source))?;
		}
		result.map_err(|_| VerificationRuntimeError::ShutdownTimeout)??;
		Ok(())
	}
}

async fn open_environment(
	root: &Path,
	source: &Path,
	state: &Path,
	protected: &Path,
	readable: &BTreeSet<PathBuf>,
	env: &BTreeMap<Str, Str>,
) -> Result<(ProjectEnvironment, Bytes), VerificationRuntimeError> {
	// Bubblewrap can mask an existing read-deny path, but cannot promise to
	// mask a path created after admission. Create host state before compiling
	// the concrete profile, rather than probing an unenforceable future deny.
	fs::create_dir_all(state).map_err(|source| io_at(state, source))?;
	let ctx = strict_context(root, source, state, protected, readable, env)?;
	if !matches!(probe_sandbox(&ctx, source), SandboxState::Active) {
		return Err(VerificationRuntimeError::ConfinementUnavailable);
	}
	let environment =
		ProjectEnvironment::isolated_with_eval(source, state, ctx, RegistryBridges::default(), false)
			.await?;
	let cwd = EnvPath::new(file_uri(source)?)
		.map_err(|_| VerificationRuntimeError::UntrustedPath { path: source.to_owned() })?;
	let session = environment
		.client()
		.open_session(&cwd, OpenSessionRequest::default())
		.await?
		.session;
	Ok((environment, session))
}

/// Probes the real native sandbox compiler with this profile's mandatory
/// settings. Dispatch may advertise confinement only when this returns true;
/// command admission still probes the concrete lease, existing private state
/// deny, and full readable roots. This synthetic capability probe has no state
/// directory and therefore does not request a future-path read denial.
pub fn strict_sandbox_available(root: &Path) -> Result<bool, VerificationRuntimeError> {
	let root = canonical(root)?;
	let ctx = strict_context(
		&root,
		&root,
		&root.join("state-probe"),
		&root.join("tools"),
		&BTreeSet::new(),
		&BTreeMap::new(),
	)?;
	ctx.set("sv_sandbox_read_deny", Value::List(Vec::new()), Origin::Host)?;
	// Only real existing paths participate in this capability probe. The
	// concrete lease independently admits sibling output roots and immutable
	// Cargo-home configuration before any process can run.
	ctx.set("sv_sandbox_readable_roots", Value::List(Vec::new()), Origin::Host)?;
	ctx.set("sv_sandbox_writable_roots", Value::List(Vec::new()), Origin::Host)?;
	ctx.set("sv_sandbox_write_deny", path_list([root.as_path()])?, Origin::Host)?;
	Ok(matches!(probe_sandbox(&ctx, &root), SandboxState::Active))
}

fn strict_context(
	root: &Path,
	source: &Path,
	state: &Path,
	protected: &Path,
	readable: &BTreeSet<PathBuf>,
	env: &BTreeMap<Str, Str>,
) -> Result<Arc<Ctx>, VerificationRuntimeError> {
	let ctx = Arc::new(Ctx::new());
	let set = |name, value| ctx.set(name, value, Origin::Host).map(|_| ());
	for (name, value) in [
		("sv_sandbox_mode", "workspace-write"),
		("sv_sandbox_network_mode", "disabled"),
		("sv_sandbox_unscoped_writes", "deny"),
		("sv_sandbox_env_inherit", "none"),
		("sv_sandbox_read_mode", "scoped"),
	] {
		set(name, Value::Enum(Str::from(value)))?;
	}
	for name in ["sv_sandbox_exclude_tmpdir", "sv_sandbox_exclude_slash_tmp"] {
		set(name, Value::Bool(true))?;
	}
	set("sv_sandbox_allow_localhost", Value::Bool(false))?;
	for name in [
		"sv_sandbox_allow_domains",
		"sv_sandbox_deny_domains",
		"sv_sandbox_allow_ports",
		"sv_sandbox_allow_unix_sockets",
		"sv_sandbox_env_deny",
		"sv_sandbox_env_include_only",
	] {
		set(name, Value::List(Vec::new()))?;
	}
	// Native platforms do not uniformly provide hard CPU/RAM/PID quotas.
	// Deadline, retained-output bounds and Cargo job count are enforced instead.
	set(
		"sv_sandbox_readable_roots",
		path_list(readable.iter().map(PathBuf::as_path).chain([
			protected,
			root.join("out").as_path(),
			root.join("tmp").as_path(),
		]))?,
	)?;
	set(
		"sv_sandbox_write_deny",
		path_list([
			source,
			protected,
			root.join("out/cargo/config").as_path(),
			root.join("out/cargo/config.toml").as_path(),
		])?,
	)?;
	set("sv_sandbox_read_deny", path_list([state])?)?;
	set(
		"sv_sandbox_writable_roots",
		// The explicit nested Cargo-home mount is intentional. On Bubblewrap
		// its mountpoint cannot be renamed through the writable output parent,
		// preventing replacement of the directory containing denied configs.
		path_list([
			root.join("out").as_path(),
			root.join("out/cargo").as_path(),
			root.join("tmp").as_path(),
		])?,
	)?;
	set(
		"sv_sandbox_env_set",
		Value::Kv(Kv(env
			.iter()
			.map(|(key, value)| (key.clone(), Value::Str(value.clone())))
			.collect())),
	)?;
	Ok(ctx)
}

async fn execute(
	client: &EnvClient,
	session: &Bytes,
	argv: &[Str],
	deadline: Instant,
	limit: usize,
	cancel: &CancellationToken,
) -> Result<VerificationCommandResult, VerificationRuntimeError> {
	let mut result = VerificationCommandResult {
		stdout:        Bytes::new(),
		stderr:        Bytes::new(),
		status:        None,
		complete:      false,
		cancelled:     cancel.is_cancelled(),
		timed_out:     Instant::now() >= deadline,
		effects_known: false,
	};
	if result.cancelled || result.timed_out {
		return Ok(result);
	}
	let text = argv
		.iter()
		.map(|arg| shell_quote(arg))
		.collect::<Vec<_>>()
		.join(" ");
	let request = ExecRequest {
		session: session.clone(),
		source: Some(Script { text, ..Default::default() }),
		output_request: OutputRequest::Complete as i32,
		..Default::default()
	};
	// EnvClient::open_guarded_wire creates its RunGuard before awaiting send;
	// dropping this future queues correlated cancellation even before ExecRun
	// is returned. Without a terminal event effects remain explicitly unknown.
	let mut run = tokio::select! {
		biased;
		() = cancel.cancelled() => {
			result.cancelled = true;
			return Ok(result);
		},
		() = sleep_until(deadline) => {
			result.timed_out = true;
			return Ok(result);
		},
		run = client.exec(request) => run?,
	};
	let mut stdout = Vec::new();
	let mut stderr = Vec::new();
	let mut expected = 1;
	let mut contiguous = true;
	let mut truncated = false;
	let mut draining = false;
	let mut drain_deadline = deadline;
	loop {
		let event = tokio::select! {
			biased;
			() = cancel.cancelled(), if !draining => {
				result.cancelled = true; run.guard().cancel(); draining = true;
				drain_deadline = Instant::now() + DRAIN_GRACE; continue;
			},
			() = sleep_until(if draining { drain_deadline } else { deadline }) => {
				if draining { break; }
				result.timed_out = true; run.guard().cancel(); draining = true;
				drain_deadline = Instant::now() + DRAIN_GRACE; continue;
			},
			event = run.next_event() => event?,
		};
		match event {
			Some(ExecEvent::Started(_)) => {},
			Some(ExecEvent::Output(frame)) => {
				contiguous &= frame.sequence == expected;
				expected = frame.sequence.saturating_add(1);
				if stdout
					.len()
					.saturating_add(stderr.len())
					.saturating_add(frame.data.len())
					> limit
				{
					truncated = true;
					if !draining {
						run.guard().cancel();
						draining = true;
						drain_deadline = Instant::now() + DRAIN_GRACE;
					}
					continue;
				}
				match OutputChannel::try_from(frame.channel) {
					Ok(OutputChannel::Stdout) => stdout.extend_from_slice(&frame.data),
					Ok(OutputChannel::Stderr) => stderr.extend_from_slice(&frame.data),
					_ => {
						contiguous = false;
					},
				}
			},
			Some(ExecEvent::Exit(event)) => {
				result.status = event.status;
				break;
			},
			None => break,
		}
	}
	let count = stdout.len().saturating_add(stderr.len()) as u64;
	result.effects_known = result.status.as_ref().is_some_and(|status| {
		matches!(
			ExecOutcome::try_from(status.outcome),
			Ok(ExecOutcome::Exited
				| ExecOutcome::Failed
				| ExecOutcome::Timeout
				| ExecOutcome::Cancelled
				| ExecOutcome::Denied)
		)
	});
	result.complete = complete_output(result.status.as_ref(), contiguous, truncated, count);
	result.stdout = stdout.into();
	result.stderr = stderr.into();
	Ok(result)
}

fn complete_output(
	status: Option<&ExecStatusMsg>,
	contiguous: bool,
	truncated: bool,
	count: u64,
) -> bool {
	!truncated
		&& contiguous
		&& status.is_some_and(|status| {
			!status.aborted
				&& status.projection.as_ref().is_some_and(|projection| {
					projection.request == OutputRequest::Complete as i32
						&& projection.source_bytes == count
				})
		})
}

fn io_at(path: &Path, source: io::Error) -> VerificationRuntimeError {
	VerificationRuntimeError::Io { path: path.to_owned(), source }
}
fn canonical(path: &Path) -> Result<PathBuf, VerificationRuntimeError> {
	fs::canonicalize(path).map_err(|source| io_at(path, source))
}
fn check_external(
	path: &Path,
	project: &Path,
	lease: &Path,
) -> Result<(), VerificationRuntimeError> {
	if !path.is_absolute()
		|| path.starts_with(project)
		|| path.starts_with(lease)
		|| project.starts_with(path)
		|| lease.starts_with(path)
		|| var_os("HOME")
			.and_then(|home| fs::canonicalize(home).ok())
			.is_some_and(|home| home.starts_with(path))
	{
		return Err(VerificationRuntimeError::UntrustedPath { path: path.to_owned() });
	}
	Ok(())
}

fn trusted_os_runtime(path: &Path) -> bool {
	["/usr", "/bin", "/sbin", "/lib", "/lib64", "/System", "/Library", "/etc/alternatives"]
		.iter()
		.any(|base| path.starts_with(base))
}

fn admit_tool(
	path: &Path,
	project: &Path,
	lease: &Path,
) -> Result<PathBuf, VerificationRuntimeError> {
	if !path.is_absolute() {
		return Err(VerificationRuntimeError::UntrustedPath { path: path.to_owned() });
	}
	let path = canonical(path)?;
	check_external(&path, project, lease)?;
	if !path.is_file() {
		return Err(VerificationRuntimeError::UnsupportedDependency { path });
	}
	Ok(path)
}
fn host_directory(name: &'static str, fallback: &str) -> Result<PathBuf, VerificationRuntimeError> {
	let path = var_os(name)
		.map(PathBuf::from)
		.or_else(|| var_os("HOME").map(|home| PathBuf::from(home).join(fallback)))
		.ok_or(VerificationRuntimeError::MissingHostInput { name })?;
	if !path.is_absolute() {
		return Err(VerificationRuntimeError::UntrustedPath { path });
	}
	canonical(&path)
}
fn path_str(path: &Path) -> Result<Str, VerificationRuntimeError> {
	path
		.to_str()
		.map(Str::from)
		.ok_or_else(|| VerificationRuntimeError::UntrustedPath { path: path.to_owned() })
}
fn path_list<'a>(
	paths: impl IntoIterator<Item = &'a Path>,
) -> Result<Value, VerificationRuntimeError> {
	paths
		.into_iter()
		.map(|path| path_str(path).map(Value::Str))
		.collect::<Result<Vec<_>, _>>()
		.map(Value::List)
}
fn joined_paths(paths: &BTreeSet<PathBuf>) -> Result<Str, VerificationRuntimeError> {
	// Colon is the native Unix PATH separator; non-Unix admission is refused.
	paths
		.iter()
		.map(|path| path_str(path))
		.collect::<Result<Vec<_>, _>>()
		.map(|paths| Str::from(paths.join(":")))
}
fn file_uri(path: &Path) -> Result<String, VerificationRuntimeError> {
	Url::from_file_path(path)
		.map(|url| url.into())
		.map_err(|()| VerificationRuntimeError::UntrustedPath { path: path.to_owned() })
}
fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}
fn environment_hash(env: &BTreeMap<Str, Str>) -> Hash32 {
	let mut hash = Hash32::hasher();
	hash.update(b"omp-native-verification-environment-v2:workspace-write:scoped:none:offline:deadline:output-bound:cargo-jobs2");
	for (key, value) in env {
		hash
			.update((key.len() as u64).to_le_bytes())
			.update(key.as_bytes())
			.update((value.len() as u64).to_le_bytes())
			.update(value.as_bytes());
	}
	hash.finalize()
}
async fn inventory(
	roots: Vec<PathBuf>,
	cancel: CancellationToken,
) -> Result<Hash32, VerificationRuntimeError> {
	spawn_blocking(move || inventory_sync(&roots, &cancel)).await?
}

async fn inventory_before(
	roots: Vec<PathBuf>,
	cancel: &CancellationToken,
	deadline: Instant,
) -> Result<Hash32, VerificationRuntimeError> {
	let worker_cancel = cancel.child_token();
	let result = timeout_at(deadline, inventory(roots, worker_cancel.clone())).await;
	worker_cancel.cancel();
	result.map_err(|_| VerificationRuntimeError::Deadline)?
}

fn inventory_sync(
	roots: &[PathBuf],
	cancel: &CancellationToken,
) -> Result<Hash32, VerificationRuntimeError> {
	let mut hash = Hash32::hasher();
	hash.update(b"omp-native-verification-input-inventory-v1");
	let mut pending = roots.to_vec();
	pending.sort();
	let mut count = 0_usize;
	let mut bytes = 0_u64;
	let mut buffer = vec![0_u8; 64 * 1024];
	while let Some(path) = pending.pop() {
		if cancel.is_cancelled() {
			return Err(VerificationRuntimeError::Cancelled);
		}
		count += 1;
		if count > MAX_DEPENDENCY_FILES {
			return Err(VerificationRuntimeError::InventoryLimit);
		}
		let metadata = fs::symlink_metadata(&path).map_err(|source| io_at(&path, source))?;
		let name = path_str(&path)?;
		hash
			.update((name.len() as u64).to_le_bytes())
			.update(name.as_bytes());
		#[cfg(unix)]
		{
			use std::os::unix::fs::MetadataExt as _;
			hash.update(metadata.mode().to_le_bytes());
		}
		if metadata.is_dir() {
			hash.update(b"directory");
			let mut entries = Vec::new();
			for entry in fs::read_dir(&path).map_err(|source| io_at(&path, source))? {
				if count
					.saturating_add(pending.len())
					.saturating_add(entries.len())
					>= MAX_DEPENDENCY_FILES
				{
					return Err(VerificationRuntimeError::InventoryLimit);
				}
				entries.push(entry.map_err(|source| io_at(&path, source))?.path());
			}
			entries.sort();
			pending.extend(entries);
		} else if metadata.is_file() {
			bytes = bytes
				.checked_add(metadata.len())
				.ok_or(VerificationRuntimeError::InventoryLimit)?;
			if bytes > MAX_DEPENDENCY_BYTES {
				return Err(VerificationRuntimeError::InventoryLimit);
			}
			hash.update(b"file").update(metadata.len().to_le_bytes());
			let mut file = fs::File::open(&path).map_err(|source| io_at(&path, source))?;
			let mut observed = 0_u64;
			loop {
				if cancel.is_cancelled() {
					return Err(VerificationRuntimeError::Cancelled);
				}
				let read = file
					.read(&mut buffer)
					.map_err(|source| io_at(&path, source))?;
				if read == 0 {
					break;
				}
				observed = observed.saturating_add(read as u64);
				if observed > metadata.len() {
					return Err(VerificationRuntimeError::DependencyChanged { path });
				}
				hash.update(&buffer[..read]);
			}
			if observed != metadata.len() {
				return Err(VerificationRuntimeError::DependencyChanged { path });
			}
		} else if metadata.file_type().is_symlink() {
			let target = fs::read_link(&path).map_err(|source| io_at(&path, source))?;
			let resolved = canonical(&path)?;
			// OS runtime bytes are the already-declared trusted host baseline,
			// not content-fenced dependencies. Record this symlink's spelling
			// without claiming to hash its trusted system target. Other targets
			// must remain inside the admitted, inventoried roots.
			if !trusted_os_runtime(&resolved)
				&& !roots
					.iter()
					.any(|root| root.is_dir() && resolved.starts_with(root))
			{
				return Err(VerificationRuntimeError::UnsupportedDependency { path });
			}
			let target = path_str(&target)?;
			hash
				.update(b"symlink")
				.update((target.len() as u64).to_le_bytes())
				.update(target.as_bytes());
		} else {
			return Err(VerificationRuntimeError::UnsupportedDependency { path });
		}
	}
	Ok(hash.finalize())
}

#[cfg(test)]
mod tests {
	use omp_proto::env::v1::OutputProjection;

	use super::*;
	use crate::exec_settings::{
		EnvironmentInheritance, ExecSandboxMode, ReadMode, SandboxNetworkMode, SandboxSettings,
	};

	#[tokio::test]
	async fn failed_admission_removes_owned_scratch_and_preserves_caller_state() {
		let lease = tempfile::tempdir().expect("lease");
		for name in ["src", "out", "tmp"] {
			fs::create_dir(lease.path().join(name)).expect("lease directory");
		}
		let project = tempfile::tempdir().expect("source checkout");
		let state = tempfile::tempdir().expect("caller state");
		let sentinel = state.path().join("durable-receipt");
		fs::write(&sentinel, b"keep").expect("caller-owned receipt");
		let result = VerificationRuntime::open(
			VerificationRuntimeOptions {
				run_root:         lease.path().to_owned(),
				state_dir:        state.path().to_owned(),
				project_root:     project.path().to_owned(),
				tools:            HostToolPaths {
					just:    PathBuf::from("untrusted-relative-tool"),
					cargo:   PathBuf::new(),
					rustc:   PathBuf::new(),
					nextest: PathBuf::new(),
				},
				timeout:          Duration::from_secs(30),
				max_output_bytes: 1024,
			},
			&CancellationToken::new(),
		)
		.await;
		assert!(matches!(result, Err(VerificationRuntimeError::UntrustedPath { .. })));
		assert_eq!(fs::read(&sentinel).expect("preserved receipt"), b"keep");
		assert_eq!(fs::read_dir(state.path()).expect("caller state").count(), 1);
	}

	#[cfg(unix)]
	#[test]
	fn dependency_symlink_can_target_trusted_system_runtime_only() {
		let inputs = tempfile::tempdir().expect("inputs");
		let external = tempfile::tempdir().expect("external user files");
		let system = canonical(Path::new("/usr/bin/env")).expect("system runtime helper");
		symlink(&system, inputs.path().join("helper")).expect("system symlink");
		let roots = [inputs.path().to_owned()];
		let cancel = CancellationToken::new();
		assert!(inventory_sync(&roots, &cancel).is_ok());
		let external_file = external.path().join("helper");
		fs::write(&external_file, b"unadmitted").expect("external input");
		symlink(&external_file, inputs.path().join("outside")).expect("user symlink");
		assert!(matches!(
			inventory_sync(&roots, &cancel),
			Err(VerificationRuntimeError::UnsupportedDependency { .. })
		));
		assert!(!trusted_os_runtime(Path::new("/usr-other/bin/helper")));
	}
	#[test]
	fn quoting_preserves_shell_metacharacters() {
		assert_eq!(shell_quote("a'$(touch bad)\n"), "'a'\\''$(touch bad)\n'");
	}
	#[test]
	fn dependency_fence_includes_content_and_inventory() {
		let temp = tempfile::tempdir().expect("temporary inputs");
		let file = temp.path().join("input");
		fs::write(&file, b"first").expect("input");
		let roots = [temp.path().to_owned()];
		let cancel = CancellationToken::new();
		let first = inventory_sync(&roots, &cancel).expect("inventory");
		fs::write(&file, b"other").expect("changed input");
		assert_ne!(first, inventory_sync(&roots, &cancel).expect("changed inventory"));
		fs::write(&file, b"first").expect("restore input");
		assert_eq!(first, inventory_sync(&roots, &cancel).expect("unchanged content"));
		fs::write(temp.path().join("new"), b"").expect("added input");
		assert_ne!(first, inventory_sync(&roots, &cancel).expect("expanded inventory"));
	}
	#[test]
	fn source_roots_and_their_ancestors_are_not_tool_roots() {
		assert!(
			check_external(
				Path::new("/tmp/project/bin"),
				Path::new("/tmp/project"),
				Path::new("/tmp/lease")
			)
			.is_err()
		);
		assert!(
			check_external(Path::new("/tmp"), Path::new("/tmp/project"), Path::new("/tmp/lease"))
				.is_err()
		);
		assert!(
			check_external(Path::new("/usr/bin"), Path::new("/tmp/project"), Path::new("/tmp/lease"))
				.is_ok()
		);
	}

	#[test]
	fn strict_profile_has_no_ambient_environment_or_network() {
		let root = Path::new("/verification-lease");
		let ctx = strict_context(
			root,
			&root.join("src"),
			Path::new("/verification-state"),
			&root.join("tools"),
			&BTreeSet::new(),
			&BTreeMap::new(),
		)
		.expect("strict context");
		let settings = SandboxSettings::from_con(&ctx);
		assert_eq!(settings.mode, ExecSandboxMode::WorkspaceWrite);
		assert_eq!(settings.network_mode, SandboxNetworkMode::Disabled);
		assert_eq!(settings.env_inherit, EnvironmentInheritance::None);
		assert_eq!(settings.read_mode, ReadMode::Scoped);
		assert!(settings.exclude_tmpdir && settings.exclude_slash_tmp);
		assert!(!settings.allow_localhost && settings.allow_unix_sockets.is_empty());
		assert_eq!(settings.write_deny.len(), 4);
		assert_eq!(settings.writable_roots.len(), 3);
		assert!(
			settings
				.writable_roots
				.iter()
				.any(|path| path.as_str().ends_with("/out/cargo"))
		);
		assert!(
			settings
				.write_deny
				.iter()
				.any(|path| path.as_str().ends_with("/cargo/config"))
		);
		assert!(
			settings
				.write_deny
				.iter()
				.any(|path| path.as_str().ends_with("/cargo/config.toml"))
		);
		assert_eq!(settings.cpu_cores, 0.0);
		assert_eq!(settings.memory_bytes, 0);
		assert_eq!(settings.pids, 0);
	}

	#[test]
	fn raw_integrity_uses_original_bytes_not_model_projection() {
		let mut status = ExecStatusMsg {
			outcome: ExecOutcome::Exited as i32,
			exit_code: Some(0),
			projection: Some(OutputProjection {
				request: OutputRequest::Complete as i32,
				source_bytes: 12,
				inline_bytes: 12,
				omitted: false,
				model_text: Some(String::from("short")),
				..Default::default()
			}),
			..Default::default()
		};
		assert!(complete_output(Some(&status), true, false, 12));
		assert!(!complete_output(Some(&status), true, false, 5));
		assert!(!complete_output(Some(&status), false, false, 12));
		assert!(!complete_output(Some(&status), true, true, 12));
		assert!(!complete_output(None, true, false, 0));
		status.aborted = true;
		assert!(!complete_output(Some(&status), true, false, 12));
	}
}
