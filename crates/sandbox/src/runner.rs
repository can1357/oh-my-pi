use std::{
	ffi::{OsStr, OsString},
	io,
	path::{Path, PathBuf},
	process::{Command as StdCommand, ExitStatus, Stdio},
	sync::LazyLock,
	time::Duration,
};

use omp_core::{CowBytes, Str};
use tokio::{
	io::{AsyncReadExt as _, AsyncWriteExt as _},
	process::{Child, Command},
	task::JoinHandle,
	time,
};

use crate::{
	Backend, BackendStatus, CapabilitySet, Caveat, CleanupFailure, CleanupFailures,
	DegradationPolicy, Plan, RunFailure, SandboxError, SandboxSpec,
	backends::{appcontainer, bubblewrap, docker, gvisor, landlock, seatbelt},
	environment::split_entry,
	paths::resolve_program,
};

static SEATBELT_STATUS: LazyLock<BackendStatus> = LazyLock::new(seatbelt::probe);
static BUBBLEWRAP_STATUS: LazyLock<BackendStatus> = LazyLock::new(bubblewrap::probe);
static LANDLOCK_STATUS: LazyLock<BackendStatus> = LazyLock::new(landlock::probe);
static GVISOR_STATUS: LazyLock<BackendStatus> = LazyLock::new(gvisor::probe);
static DOCKER_STATUS: LazyLock<BackendStatus> =
	LazyLock::new(|| docker::probe(Backend::DockerEphemeral));
static DOCKER_RUNSC_STATUS: LazyLock<BackendStatus> =
	LazyLock::new(|| docker::probe(Backend::DockerRunscEphemeral));
static APP_CONTAINER_STATUS: LazyLock<BackendStatus> = LazyLock::new(appcontainer::probe);
pub const COMMAND_WRAPPER_PLACEHOLDER: &str = "<omp-sandbox-command>";

/// Returns the cached live status for one backend.
#[must_use]
pub fn backend_status(backend: Backend) -> BackendStatus {
	match backend {
		Backend::Seatbelt => SEATBELT_STATUS.clone(),
		Backend::Bubblewrap => BUBBLEWRAP_STATUS.clone(),
		Backend::Landlock => LANDLOCK_STATUS.clone(),
		Backend::Gvisor => GVISOR_STATUS.clone(),
		Backend::DockerEphemeral => DOCKER_STATUS.clone(),
		Backend::DockerRunscEphemeral => DOCKER_RUNSC_STATUS.clone(),
		Backend::AppContainer => APP_CONTAINER_STATUS.clone(),
	}
}

/// Iterates over cached live statuses in serialized backend-name order.
pub fn backend_statuses() -> impl ExactSizeIterator<Item = BackendStatus> {
	Backend::all().map(backend_status)
}

/// Compiler and runtime bound to one sandbox backend.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Runner {
	backend: Backend,
}

impl Runner {
	/// Creates a runner for an explicit backend without probing or switching it.
	#[must_use]
	pub const fn for_backend(backend: Backend) -> Self {
		Self { backend }
	}

	/// Selects the first live backend whose compiled plan enforces every
	/// request.
	///
	/// Landlock is intentionally excluded from automatic selection because it
	/// cannot enforce the namespace-based default carve-outs; use
	/// [`Runner::for_backend`] to select it explicitly.
	#[tracing::instrument(
		name = "sandbox_admission",
		level = "debug",
		skip_all,
		fields(
			requested_capabilities = spec.requested_capabilities().len(),
			tolerated_capabilities = spec.tolerated.len(),
			network = %spec.network,
			write = %spec.write,
			degradation = %spec.degradation,
		)
	)]
	pub fn for_spec(spec: &SandboxSpec) -> Result<Self, SandboxError> {
		if let Err(error) = spec.validate() {
			tracing::warn!(%error, "sandbox specification rejected");
			return Err(error);
		}
		let requested = spec.requested_capabilities();
		let required = requested.difference(spec.tolerated);
		let candidates = candidates();
		if candidates.is_empty() {
			tracing::warn!(
				os = std::env::consts::OS,
				"sandbox admission denied: no supported backend"
			);
			return Err(SandboxError::UnsupportedHost { os: std::env::consts::OS });
		}

		let mut available = Vec::new();
		let mut smallest_missing = required;
		for backend in candidates.iter().copied() {
			let status = backend_status(backend);
			if !status.is_available() {
				continue;
			}
			available.push(backend);
			let runner = Self { backend };
			match runner.compile(spec) {
				Ok(plan) => {
					let missing = requested
						.difference(plan.enforced())
						.difference(spec.tolerated);
					if missing.is_empty() {
						if backend == Backend::Gvisor {
							let requirements = gvisor::check_requirements(spec).map_err(|error| {
								tracing::warn!(%error, "sandbox admission denied");
								error
							})?;
							if !requirements.is_available() {
								continue;
							}
						}
						tracing::debug!(
							backend = %backend,
							enforced_capabilities = plan.enforced().len(),
							caveat_count = plan.caveats().len(),
							"sandbox backend admitted"
						);
						return Ok(runner);
					}
					if missing.len() < smallest_missing.len() {
						smallest_missing = missing;
					}
				},
				Err(SandboxError::BackendCapabilities { missing, .. }) => {
					let missing = missing.difference(spec.tolerated);
					if missing.is_empty() {
						tracing::debug!(
							backend = %backend,
							"sandbox backend admitted with tolerated capability gaps"
						);
						return Ok(runner);
					}
					if missing.len() < smallest_missing.len() {
						smallest_missing = missing;
					}
				},
				Err(error) => {
					tracing::warn!(%error, "sandbox admission denied");
					return Err(error);
				},
			}
		}

		if spec.degradation == DegradationPolicy::AllowCaveats {
			let native = fallback_backend().map_err(|error| {
				tracing::warn!(%error, "sandbox admission denied");
				error
			})?;
			let status = backend_status(native);
			return if status.is_available() {
				tracing::debug!(
					backend = %native,
					"sandbox fallback backend admitted"
				);
				Ok(Self { backend: native })
			} else {
				tracing::warn!(
					backend = %native,
					"sandbox admission denied: fallback backend unavailable"
				);
				Err(unavailable(status))
			};
		}
		if available.is_empty() {
			tracing::warn!("sandbox admission denied: no backend passed its live probe");
			return Err(unavailable(backend_status(candidates[0])));
		}
		tracing::warn!(
			missing_capabilities = %smallest_missing,
			"sandbox admission denied: required capabilities unavailable"
		);
		Err(SandboxError::NoBackendCapabilities { missing: smallest_missing })
	}

	/// Returns the live normal-child backend required for inherited descriptors.
	///
	/// Linux normal-child execution requires Bubblewrap and does not fall back
	/// to Landlock.
	pub fn native_command() -> Result<Self, SandboxError> {
		let backend = native_command_backend()?;
		let status = backend_status(backend);
		if status.is_available() {
			Ok(Self { backend })
		} else {
			Err(unavailable(status))
		}
	}

	/// Returns the backend used by this runner.
	#[must_use]
	pub const fn backend(self) -> Backend {
		self.backend
	}

	/// Returns the static capabilities of this runner's backend.
	#[must_use]
	pub const fn capabilities(self) -> CapabilitySet {
		self.backend.capabilities()
	}

	/// Purely compiles a specification into an inspectable plan.
	#[tracing::instrument(
		name = "sandbox_profile_build",
		level = "debug",
		skip_all,
		fields(
			backend = %self.backend,
			requested_capabilities = spec.requested_capabilities().len(),
			network = %spec.network,
			write = %spec.write,
		)
	)]
	pub fn compile(self, spec: &SandboxSpec) -> Result<Plan, SandboxError> {
		spec.validate()?;
		let program = resolve_program(&spec.program)?;
		self.compile_program(spec, &program)
	}

	fn compile_program(self, spec: &SandboxSpec, program: &Path) -> Result<Plan, SandboxError> {
		spec.validate()?;
		let requested = spec.requested_capabilities();
		let missing = requested.difference(self.capabilities());
		let enforced = requested.intersection(self.capabilities());
		let mut plan = match self.backend {
			Backend::Seatbelt => seatbelt::compile(spec, program, requested, enforced),
			Backend::Bubblewrap => bubblewrap::compile(spec, program, requested, enforced),
			Backend::Landlock => landlock::compile(spec, program, requested, enforced),
			Backend::Gvisor => gvisor::compile(spec, program, requested, enforced),
			Backend::DockerEphemeral => docker::compile(spec, program, requested, enforced),
			Backend::DockerRunscEphemeral => docker::compile_runsc(spec, program, requested, enforced),
			Backend::AppContainer => appcontainer::compile(spec, program, requested, enforced),
		}?;
		if spec.degradation == DegradationPolicy::Reject {
			let missing = requested.difference(plan.enforced());
			let fatal = missing.difference(spec.tolerated);
			if !fatal.is_empty() {
				return Err(SandboxError::BackendCapabilities {
					backend: self.backend,
					missing: fatal,
				});
			}
			for capability in missing.iter() {
				if !plan
					.caveats()
					.iter()
					.any(|caveat| caveat.capability == Some(capability))
				{
					plan.add_caveat(Caveat::capability(
						capability,
						Str::from(format!("{} cannot enforce tolerated {capability}", self.backend)),
					));
				}
			}
		}
		if spec.degradation == DegradationPolicy::AllowCaveats {
			for capability in missing.iter() {
				if !plan
					.caveats()
					.iter()
					.any(|caveat| caveat.capability == Some(capability))
				{
					plan.add_caveat(Caveat::capability(
						capability,
						Str::from(format!("{} cannot enforce {capability}", self.backend)),
					));
				}
			}
		}
		tracing::debug!(
			backend = %self.backend,
			enforced_capabilities = plan.enforced().len(),
			caveat_count = plan.caveats().len(),
			profile_generated = plan.profile().is_some(),
			"sandbox profile built"
		);
		Ok(plan)
	}

	/// Compiles a reusable native launcher prefix from a program-less policy.
	pub fn wrap_template(self, spec: &SandboxSpec) -> Result<CommandWrapper, SandboxError> {
		if !matches!(self.backend, Backend::Seatbelt | Backend::Bubblewrap | Backend::Landlock) {
			return Err(SandboxError::CommandWrapperUnsupported { backend: self.backend });
		}
		if self.backend != native_command_backend()? {
			return Err(SandboxError::CommandWrapperUnsupported { backend: self.backend });
		}
		if spec.no_exec {
			return Err(SandboxError::CommandWrapperNoExec { backend: self.backend });
		}

		let placeholder = Path::new(COMMAND_WRAPPER_PLACEHOLDER);
		let plan = self.compile_program(spec, placeholder)?;
		let caveats = plan.caveats().to_vec();
		let mut preparation_spec = spec.clone();
		preparation_spec.environment = crate::EnvironmentPolicy::exact(Vec::new());
		let mut prepared = self.prepare(plan, &preparation_spec)?;
		let launcher = prepared
			.program
			.take()
			.ok_or(SandboxError::EmptyPlanArgv { backend: self.backend })?;
		let mut prefix_args = std::mem::take(&mut prepared.args);
		match self.backend {
			Backend::Seatbelt => {
				prefix_args.truncate(2);
				prefix_args.push(OsString::from("--"));
			},
			Backend::Bubblewrap => {
				let end = if prefix_args
					.iter()
					.any(|arg| arg == OsStr::new(landlock::HIDDEN_CHILD_ARG))
				{
					prefix_args
						.iter()
						.position(|arg| arg == OsStr::new(COMMAND_WRAPPER_PLACEHOLDER))
						.ok_or(SandboxError::MissingPlanPlaceholder {
							backend:     self.backend,
							placeholder: COMMAND_WRAPPER_PLACEHOLDER,
						})?
				} else {
					prefix_args
						.iter()
						.position(|arg| arg == OsStr::new("--"))
						.map(|separator| separator + 1)
						.ok_or(SandboxError::MissingPlanPlaceholder {
							backend:     self.backend,
							placeholder: "--",
						})?
				};
				prefix_args.truncate(end);
			},
			Backend::Landlock => {
				let command = prefix_args
					.iter()
					.position(|arg| arg == OsStr::new(COMMAND_WRAPPER_PLACEHOLDER))
					.ok_or(SandboxError::MissingPlanPlaceholder {
						backend:     self.backend,
						placeholder: COMMAND_WRAPPER_PLACEHOLDER,
					})?;
				prefix_args.truncate(command);
			},
			Backend::Gvisor
			| Backend::DockerEphemeral
			| Backend::DockerRunscEphemeral
			| Backend::AppContainer => unreachable!("native backend checked above"),
		}
		Ok(CommandWrapper {
			launcher: Some(launcher),
			prefix_args,
			environment: spec.environment.clone(),
			caveats,
			resources: std::mem::take(&mut prepared.resources),
		})
	}

	/// Materializes runtime-only files, values, and owned cleanup resources.
	pub fn prepare(self, plan: Plan, spec: &SandboxSpec) -> Result<PreparedSandbox, SandboxError> {
		if plan.backend() != self.backend {
			return Err(SandboxError::PlanBackendMismatch {
				runner: self.backend,
				plan:   plan.backend(),
			});
		}
		let status = backend_status(self.backend);
		if !status.is_available() {
			return Err(unavailable(status));
		}
		if self.backend == Backend::Gvisor {
			let requirements = gvisor::check_requirements(spec)?;
			if !requirements.is_available() {
				return Err(unavailable(requirements));
			}
		}
		let (program, args) = if plan.command_backed() {
			let Some((program, args)) = plan.argv().split_first() else {
				return Err(SandboxError::EmptyPlanArgv { backend: self.backend });
			};
			(Some(program.clone()), args.to_vec())
		} else {
			(None, Vec::new())
		};
		let mut prepared = PreparedSandbox {
			backend: self.backend,
			program,
			args,
			cwd: spec.dir.clone(),
			environment: spec.environment.resolve(),
			resources: Vec::new(),
			state: PreparedBackend::Command,
		};
		match self.backend {
			Backend::Seatbelt => {
				#[cfg(target_os = "macos")]
				crate::runtime::macos::prepare(spec, &mut prepared)?;
			},
			Backend::Bubblewrap => {
				if prepared
					.args
					.iter()
					.any(|arg| arg == OsStr::new(landlock::BPF_PLACEHOLDER))
				{
					landlock::prepare(spec, &mut prepared)?;
				}
				prepared = crate::runtime::bubblewrap::prepare(prepared)?;
			},
			Backend::Landlock => {
				landlock::prepare(spec, &mut prepared)?;
			},
			Backend::Gvisor => {
				#[cfg(target_os = "linux")]
				{
					let state = crate::runtime::gvisor::prepare(&mut prepared, &plan, spec)?;
					prepared.state = PreparedBackend::Gvisor(Some(state));
				}
				#[cfg(not(target_os = "linux"))]
				return Err(SandboxError::UnsupportedHost { os: std::env::consts::OS });
			},
			Backend::DockerEphemeral | Backend::DockerRunscEphemeral => {
				let state = docker::prepare(&plan, spec, &mut prepared)?;
				prepared.state = PreparedBackend::Docker(Some(state));
			},
			Backend::AppContainer => {
				#[cfg(windows)]
				{
					let state = crate::runtime::windows::prepare(&plan, spec)?;
					prepared.state = PreparedBackend::AppContainer(Some(state));
				}
				#[cfg(not(windows))]
				return Err(SandboxError::UnsupportedHost { os: std::env::consts::OS });
			},
		}
		Ok(prepared)
	}

	/// Compiles, prepares, and runs a specification to a reaped process result.
	pub async fn run(
		self,
		spec: &SandboxSpec,
		options: RunOptions,
	) -> Result<RunOutput, SandboxError> {
		let plan = self.compile(spec)?;
		let mut prepared = self.prepare(plan, spec)?;
		match self.backend {
			Backend::Seatbelt => {
				#[cfg(target_os = "macos")]
				{
					let limits = crate::runtime::watchdog_macos::WatchdogLimits::from_spec(spec);
					let result = run_command(&prepared, options, CommandRuntime::Seatbelt(limits)).await;
					let cleanup = prepared.cleanup();
					finish_run(self.backend, result, cleanup)
				}
				#[cfg(not(target_os = "macos"))]
				Err(SandboxError::UnsupportedHost { os: std::env::consts::OS })
			},
			Backend::Bubblewrap => {
				let result = run_command(&prepared, options, CommandRuntime::Plain).await;
				let cleanup = prepared.cleanup();
				finish_run(self.backend, result, cleanup)
			},
			Backend::Landlock => {
				let result = run_command(&prepared, options, CommandRuntime::Plain).await;
				let cleanup = prepared.cleanup();
				finish_run(self.backend, result, cleanup)
			},
			Backend::Gvisor => {
				#[cfg(target_os = "linux")]
				{
					let mut state = take_gvisor(&mut prepared)?;
					let result = crate::runtime::gvisor::run(&prepared, &mut state, options).await;
					let cleanup = prepared.cleanup();
					finish_run(self.backend, result, cleanup)
				}
				#[cfg(not(target_os = "linux"))]
				Err(SandboxError::UnsupportedHost { os: std::env::consts::OS })
			},
			Backend::DockerEphemeral | Backend::DockerRunscEphemeral => {
				let mut state = take_docker(&mut prepared)?;
				let result = run_command(&prepared, options, CommandRuntime::Docker(&mut state)).await;
				let backend_cleanup = state.cleanup().await;
				let cleanup = merge_cleanup(backend_cleanup, prepared.cleanup());
				finish_run(self.backend, result, cleanup)
			},
			Backend::AppContainer => {
				#[cfg(windows)]
				{
					let state = take_appcontainer(&mut prepared)?;
					let result = crate::runtime::windows::run(state, options).await;
					let cleanup = prepared.cleanup();
					finish_run(self.backend, result, cleanup)
				}
				#[cfg(not(windows))]
				Err(SandboxError::UnsupportedHost { os: std::env::consts::OS })
			},
		}
	}
}

/// Owned standard-input source for one sandbox run.
#[derive(Clone, Debug, Default)]
pub enum SandboxInput {
	/// Inherit the caller's standard input.
	#[default]
	Inherit,
	/// Attach a null input device.
	Null,
	/// Send these bytes and then close the input pipe.
	Bytes(CowBytes<'static>),
}

/// Destination for one sandbox output stream.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OutputMode {
	/// Inherit the caller's corresponding output stream.
	#[default]
	Inherit,
	/// Discard the stream.
	Null,
	/// Capture the complete stream in [`RunOutput`].
	Capture,
}

/// Owned process I/O and deadline policy for [`Runner::run`].
#[derive(Clone, Debug, Default)]
pub struct RunOptions {
	/// Standard-input source.
	pub input:   SandboxInput,
	/// Standard-output destination.
	pub stdout:  OutputMode,
	/// Standard-error destination.
	pub stderr:  OutputMode,
	/// Optional wall-clock deadline.
	pub timeout: Option<Duration>,
}

/// Platform-neutral exit status for a successfully launched command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SandboxExit {
	/// Process exit code, absent for signal termination.
	pub code:   Option<i32>,
	/// Unix terminating signal, absent on unsupported platforms or normal exit.
	pub signal: Option<i32>,
}

/// Reaped sandbox result; nonzero command exits remain successful run outputs.
#[derive(Clone, Debug)]
pub struct RunOutput {
	/// Process exit status.
	pub exit:   SandboxExit,
	/// Captured standard output, empty unless requested.
	pub stdout: CowBytes<'static>,
	/// Captured standard error, empty unless requested.
	pub stderr: CowBytes<'static>,
}

/// Precompiled sandbox launcher reused across many command spawns.
///
/// Temporary profile, BPF, policy, and bind-mask resources remain alive until
/// this value is dropped. The wrapper is `Send + Sync`; launcher and policy
/// accessors allocate nothing.
pub struct CommandWrapper {
	launcher:    Option<OsString>,
	prefix_args: Vec<OsString>,
	environment: crate::EnvironmentPolicy,
	caveats:     Vec<Caveat>,
	resources:   Vec<PreparedResource>,
}

impl CommandWrapper {
	/// Creates an environment-filtering wrapper without a kernel launcher.
	#[must_use]
	pub fn environment_only(spec: &SandboxSpec) -> Self {
		Self {
			launcher:    None,
			prefix_args: Vec::new(),
			environment: spec.environment.clone(),
			caveats:     Vec::new(),
			resources:   Vec::new(),
		}
	}

	/// Returns the launcher program, such as `sandbox-exec` or `bwrap`.
	#[must_use]
	pub fn launcher(&self) -> Option<&OsStr> {
		self.launcher.as_deref()
	}

	/// Returns arguments placed before the wrapped program.
	#[must_use]
	pub fn prefix_args(&self) -> &[OsString] {
		&self.prefix_args
	}

	/// Reports whether an exported environment variable may reach the child.
	#[must_use]
	pub fn env_allowed(&self, key: &str) -> bool {
		self.environment.allows(key)
	}

	/// Applies the environment base, include-only filters, deny filters, and
	/// explicit overrides in policy order.
	pub fn resolve_env<I, K, V>(&self, environment: I) -> Vec<(OsString, OsString)>
	where
		I: IntoIterator<Item = (K, V)>,
		K: Into<OsString>,
		V: Into<OsString>,
	{
		self.environment.resolve_env(environment)
	}

	/// Returns caveats recorded by the backend for this compiled policy.
	#[must_use]
	pub fn caveats(&self) -> &[Caveat] {
		&self.caveats
	}
}

impl Drop for CommandWrapper {
	fn drop(&mut self) {
		while let Some(mut resource) = self.resources.pop() {
			let _ = resource.cleanup();
		}
	}
}

/// Prepared normal-child command plus resources that must outlive it.
pub struct PreparedSandbox {
	pub(crate) backend:     Backend,
	pub(crate) program:     Option<OsString>,
	pub(crate) args:        Vec<OsString>,
	pub(crate) cwd:         Option<PathBuf>,
	pub(crate) environment: Option<Vec<OsString>>,
	resources:              Vec<PreparedResource>,
	state:                  PreparedBackend,
}
enum PreparedBackend {
	Command,
	Docker(Option<crate::runtime::docker::DockerPrepared>),
	#[cfg(target_os = "linux")]
	Gvisor(Option<crate::runtime::gvisor::GvisorPrepared>),
	#[cfg(windows)]
	AppContainer(Option<crate::runtime::windows::AppContainerPrepared>),
}

impl PreparedSandbox {
	/// Returns the prepared backend.
	#[must_use]
	pub const fn backend(&self) -> Backend {
		self.backend
	}

	/// Returns the launcher program for command-backed plans.
	#[must_use]
	pub fn program(&self) -> Option<&OsStr> {
		self.program.as_deref()
	}

	/// Returns prepared launcher arguments.
	#[must_use]
	pub fn args(&self) -> &[OsString] {
		&self.args
	}

	/// Returns the prepared working directory.
	#[must_use]
	pub fn cwd(&self) -> Option<&Path> {
		self.cwd.as_deref()
	}

	/// Returns the exact prepared environment, or `None` to inherit unchanged.
	#[must_use]
	pub fn environment(&self) -> Option<&[OsString]> {
		self.environment.as_deref()
	}

	/// Constructs a standard command while preserving preparation ownership
	/// here.
	pub fn command(&self) -> Result<StdCommand, SandboxError> {
		let Some(program) = &self.program else {
			return Err(SandboxError::ExternalCommandUnsupported { backend: self.backend });
		};
		let mut command = StdCommand::new(program);
		command.args(&self.args);
		apply_environment(&mut command, self.environment.as_deref());
		if let Some(cwd) = &self.cwd {
			command.current_dir(cwd);
			#[cfg(unix)]
			if self.environment.is_none()
				|| self.environment.as_ref().is_some_and(|environment| {
					environment
						.iter()
						.any(|entry| split_entry(entry).0 == OsStr::new("PWD"))
				}) {
				command.env("PWD", cwd);
			}
		}
		Ok(command)
	}

	pub(crate) fn push_resource(&mut self, resource: PreparedResource) {
		self.resources.push(resource);
	}

	fn cleanup(&mut self) -> Result<(), CleanupFailures> {
		let mut failures = Vec::new();
		while let Some(mut resource) = self.resources.pop() {
			if let Err(failure) = resource.cleanup() {
				failures.push(failure);
			}
		}
		if failures.is_empty() {
			Ok(())
		} else {
			Err(CleanupFailures::new(failures))
		}
	}
}

impl Drop for PreparedSandbox {
	fn drop(&mut self) {
		let _ = self.cleanup();
	}
}

pub enum PreparedResource {
	Directory(Option<tempfile::TempDir>),
	File(Option<tempfile::NamedTempFile>),
}

impl PreparedResource {
	fn cleanup(&mut self) -> Result<(), CleanupFailure> {
		match self {
			Self::Directory(directory) => {
				let Some(directory) = directory.take() else {
					return Ok(());
				};
				let path = directory.path().to_path_buf();
				directory
					.close()
					.map_err(|source| CleanupFailure::RemoveDirectory { path, source })
			},
			Self::File(file) => {
				let Some(file) = file.take() else {
					return Ok(());
				};
				let path = file.path().to_path_buf();
				file
					.close()
					.map_err(|source| CleanupFailure::RemoveFile { path, source })
			},
		}
	}
}

fn take_docker(
	prepared: &mut PreparedSandbox,
) -> Result<crate::runtime::docker::DockerPrepared, SandboxError> {
	match &mut prepared.state {
		PreparedBackend::Docker(state) => state
			.take()
			.ok_or(SandboxError::MissingPreparedState { backend: prepared.backend }),
		_ => Err(SandboxError::MissingPreparedState { backend: prepared.backend }),
	}
}

#[cfg(target_os = "linux")]
fn take_gvisor(
	prepared: &mut PreparedSandbox,
) -> Result<crate::runtime::gvisor::GvisorPrepared, SandboxError> {
	match &mut prepared.state {
		PreparedBackend::Gvisor(state) => state
			.take()
			.ok_or(SandboxError::MissingPreparedState { backend: prepared.backend }),
		_ => Err(SandboxError::MissingPreparedState { backend: prepared.backend }),
	}
}

#[cfg(windows)]
fn take_appcontainer(
	prepared: &mut PreparedSandbox,
) -> Result<crate::runtime::windows::AppContainerPrepared, SandboxError> {
	match &mut prepared.state {
		PreparedBackend::AppContainer(state) => state
			.take()
			.ok_or(SandboxError::MissingPreparedState { backend: prepared.backend }),
		_ => Err(SandboxError::MissingPreparedState { backend: prepared.backend }),
	}
}

fn merge_cleanup(
	left: Result<(), CleanupFailures>,
	right: Result<(), CleanupFailures>,
) -> Result<(), CleanupFailures> {
	match (left, right) {
		(Ok(()), Ok(())) => Ok(()),
		(Err(failures), Ok(())) | (Ok(()), Err(failures)) => Err(failures),
		(Err(mut left), Err(right)) => {
			left.append(right);
			Err(left)
		},
	}
}

fn finish_run(
	backend: Backend,
	result: Result<RunOutput, SandboxError>,
	cleanup: Result<(), CleanupFailures>,
) -> Result<RunOutput, SandboxError> {
	match (result, cleanup) {
		(Ok(output), Ok(())) => Ok(output),
		(Ok(_), Err(cleanup)) => Err(SandboxError::Cleanup(cleanup)),
		(Err(error), Ok(())) => Err(error),
		(Err(SandboxError::RunAndCleanup { backend, run, mut cleanup }), Err(extra)) => {
			cleanup.append(extra);
			Err(SandboxError::RunAndCleanup { backend, run, cleanup })
		},
		(Err(SandboxError::Cleanup(mut cleanup)), Err(extra)) => {
			cleanup.append(extra);
			Err(SandboxError::Cleanup(cleanup))
		},
		(Err(error), Err(cleanup)) => match run_failure(error) {
			Ok(run) => Err(SandboxError::RunAndCleanup { backend, run, cleanup }),
			Err(error) => Err(error),
		},
	}
}

fn run_failure(error: SandboxError) -> Result<RunFailure, SandboxError> {
	match error {
		SandboxError::Launch { source, .. } => Ok(RunFailure::Launch { source }),
		SandboxError::Wait { source, .. } => Ok(RunFailure::Wait { source }),
		SandboxError::Input { source, .. } => Ok(RunFailure::Input { source }),
		SandboxError::Output { source, .. } => Ok(RunFailure::Output { source }),
		SandboxError::Timeout { .. } => Ok(RunFailure::Timeout),
		SandboxError::BackendCommand { operation, status, diagnostic, .. } => {
			Ok(RunFailure::BackendCommand { operation, status, diagnostic })
		},
		SandboxError::BackendIo { operation, source, .. } => {
			Ok(RunFailure::BackendIo { operation, source })
		},
		SandboxError::BackendPath { operation, path, source, .. } => {
			Ok(RunFailure::BackendPath { operation, path, source })
		},
		SandboxError::ResourceWatchdog { source, .. } => Ok(RunFailure::ResourceWatchdog { source }),
		SandboxError::ResourceLimitExceeded { resource, observed, limit, .. } => {
			Ok(RunFailure::ResourceLimitExceeded { resource, observed, limit })
		},
		error => Err(error),
	}
}

enum CommandRuntime<'a> {
	Plain,
	Docker(&'a mut crate::runtime::docker::DockerPrepared),
	#[cfg(target_os = "macos")]
	Seatbelt(Option<crate::runtime::watchdog_macos::WatchdogLimits>),
}

async fn run_command(
	prepared: &PreparedSandbox,
	options: RunOptions,
	mut runtime: CommandRuntime<'_>,
) -> Result<RunOutput, SandboxError> {
	let mut command = prepared.command()?;
	command.stdin(match options.input {
		SandboxInput::Inherit => Stdio::inherit(),
		SandboxInput::Null => Stdio::null(),
		SandboxInput::Bytes(_) => Stdio::piped(),
	});
	command.stdout(output_stdio(options.stdout));
	command.stderr(output_stdio(options.stderr));
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt as _;
		command.process_group(0);
	}
	let mut child = ChildGuard::new(
		Command::from(command)
			.kill_on_drop(true)
			.spawn()
			.map_err(|source| SandboxError::Launch { backend: prepared.backend, source })?,
		prepared.backend,
	);
	if let CommandRuntime::Docker(state) = &mut runtime {
		state.mark_active();
	}
	#[cfg(target_os = "macos")]
	let (watchdog_done, watchdog) = match &runtime {
		CommandRuntime::Seatbelt(Some(limits)) => {
			let pgid = child
				.child_mut()
				.id()
				.ok_or_else(|| SandboxError::ResourceWatchdog {
					backend: Backend::Seatbelt,
					source:  io::Error::new(
						io::ErrorKind::NotFound,
						"sandbox process has no process id",
					),
				})? as i32;
			let (done, receiver) = tokio::sync::watch::channel(false);
			let task = tokio::spawn(crate::runtime::watchdog_macos::watch_process_group(
				pgid, *limits, receiver,
			));
			(Some(done), Some(task))
		},
		CommandRuntime::Plain | CommandRuntime::Docker(_) | CommandRuntime::Seatbelt(None) => {
			(None, None)
		},
	};
	let input = match options.input {
		SandboxInput::Bytes(bytes) => child.child_mut().stdin.take().map(|mut stdin| {
			tokio::spawn(async move {
				stdin.write_all(&bytes).await?;
				stdin.shutdown().await
			})
		}),
		SandboxInput::Inherit | SandboxInput::Null => None,
	};
	let stdout = capture(child.child_mut().stdout.take());
	let stderr = capture(child.child_mut().stderr.take());
	let status = match options.timeout {
		Some(timeout) => {
			if let Ok(status) = time::timeout(timeout, child.wait()).await {
				status?
			} else {
				if let CommandRuntime::Docker(state) = &mut runtime {
					let _ = state.terminate_and_reap(child.child_mut()).await;
					let _ = child.wait().await;
				} else {
					child.kill_tree();
					let _ = child.wait().await;
				}
				#[cfg(target_os = "macos")]
				if let Some(done) = watchdog_done {
					let _ = done.send(true);
				}
				let _ = join_input(input, prepared.backend).await;
				let _ = join_output(stdout, prepared.backend).await;
				let _ = join_output(stderr, prepared.backend).await;
				return Err(SandboxError::Timeout { backend: prepared.backend });
			}
		},
		None => child.wait().await?,
	};
	if let CommandRuntime::Docker(state) = &mut runtime {
		state.mark_finished();
	}
	#[cfg(target_os = "macos")]
	{
		if let Some(done) = watchdog_done {
			let _ = done.send(true);
		}
		if let Some(watchdog) = watchdog {
			watchdog
				.await
				.map_err(|source| SandboxError::ResourceWatchdog {
					backend: Backend::Seatbelt,
					source:  io::Error::other(source),
				})??;
		}
	}
	join_input(input, prepared.backend).await?;
	let stdout = join_output(stdout, prepared.backend).await?;
	let stderr = join_output(stderr, prepared.backend).await?;
	Ok(RunOutput { exit: sandbox_exit(status), stdout: stdout.into(), stderr: stderr.into() })
}

fn output_stdio(mode: OutputMode) -> Stdio {
	match mode {
		OutputMode::Inherit => Stdio::inherit(),
		OutputMode::Null => Stdio::null(),
		OutputMode::Capture => Stdio::piped(),
	}
}

fn capture<R>(stream: Option<R>) -> Option<JoinHandle<io::Result<Vec<u8>>>>
where
	R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
	stream.map(|mut stream| {
		tokio::spawn(async move {
			let mut bytes = Vec::new();
			stream.read_to_end(&mut bytes).await?;
			Ok(bytes)
		})
	})
}

async fn join_input(
	input: Option<JoinHandle<io::Result<()>>>,
	backend: Backend,
) -> Result<(), SandboxError> {
	if let Some(input) = input {
		input
			.await
			.map_err(io::Error::other)
			.and_then(|result| result)
			.map_err(|source| SandboxError::Input { backend, source })?;
	}
	Ok(())
}

async fn join_output(
	output: Option<JoinHandle<io::Result<Vec<u8>>>>,
	backend: Backend,
) -> Result<Vec<u8>, SandboxError> {
	match output {
		Some(output) => output
			.await
			.map_err(io::Error::other)
			.and_then(|result| result)
			.map_err(|source| SandboxError::Output { backend, source }),
		None => Ok(Vec::new()),
	}
}

struct ChildGuard {
	child:   Option<Child>,
	backend: Backend,
	reaped:  bool,
}

impl ChildGuard {
	const fn new(child: Child, backend: Backend) -> Self {
		Self { child: Some(child), backend, reaped: false }
	}

	const fn child_mut(&mut self) -> &mut Child {
		self.child.as_mut().expect("child exists until reaped")
	}

	async fn wait(&mut self) -> Result<ExitStatus, SandboxError> {
		let status = self
			.child_mut()
			.wait()
			.await
			.map_err(|source| SandboxError::Wait { backend: self.backend, source })?;
		self.reaped = true;
		Ok(status)
	}

	fn kill_tree(&mut self) {
		if let Some(child) = &mut self.child {
			#[cfg(unix)]
			if let Some(id) = child.id() {
				let _ = nix::sys::signal::kill(
					nix::unistd::Pid::from_raw(-(id as i32)),
					nix::sys::signal::Signal::SIGKILL,
				);
			}
			let _ = child.start_kill();
		}
	}
}

impl Drop for ChildGuard {
	fn drop(&mut self) {
		if self.reaped {
			return;
		}
		self.kill_tree();
		let Some(mut child) = self.child.take() else {
			return;
		};
		if let Ok(handle) = tokio::runtime::Handle::try_current() {
			handle.spawn(async move {
				let _ = child.wait().await;
			});
		}
	}
}

fn apply_environment(command: &mut StdCommand, environment: Option<&[OsString]>) {
	let Some(environment) = environment else {
		return;
	};
	command.env_clear();
	for entry in environment {
		let (name, value) = split_entry(entry);
		command.env(name, value);
	}
}

fn sandbox_exit(status: ExitStatus) -> SandboxExit {
	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt as _;
		SandboxExit { code: status.code(), signal: status.signal() }
	}
	#[cfg(not(unix))]
	{
		SandboxExit { code: status.code(), signal: None }
	}
}

fn candidates() -> &'static [Backend] {
	candidates_for(std::env::consts::OS)
}

fn candidates_for(os: &str) -> &'static [Backend] {
	match os {
		"macos" => &[Backend::Seatbelt, Backend::DockerRunscEphemeral, Backend::DockerEphemeral],
		"linux" => &[
			Backend::Gvisor,
			Backend::Bubblewrap,
			Backend::DockerRunscEphemeral,
			Backend::DockerEphemeral,
		],
		"windows" => &[Backend::AppContainer],
		_ => &[],
	}
}

fn fallback_backend() -> Result<Backend, SandboxError> {
	match std::env::consts::OS {
		"macos" => Ok(Backend::Seatbelt),
		"linux" => Ok(Backend::Bubblewrap),
		"windows" => Ok(Backend::AppContainer),
		_ => Err(SandboxError::UnsupportedHost { os: std::env::consts::OS }),
	}
}

fn native_command_backend() -> Result<Backend, SandboxError> {
	match std::env::consts::OS {
		"macos" => Ok(Backend::Seatbelt),
		"linux" => Ok(Backend::Bubblewrap),
		_ => Err(SandboxError::UnsupportedHost { os: std::env::consts::OS }),
	}
}

fn unavailable(status: BackendStatus) -> SandboxError {
	SandboxError::BackendUnavailable {
		backend: status.backend(),
		failure: status
			.failure_arc()
			.expect("unavailable status carries failure"),
	}
}

#[cfg(test)]
mod tests {
	use super::candidates_for;
	#[cfg(target_os = "linux")]
	use super::{fallback_backend, native_command_backend};
	use crate::Backend;

	#[test]
	fn backend_candidates_keep_the_locked_per_os_order() {
		assert_eq!(candidates_for("macos"), [
			Backend::Seatbelt,
			Backend::DockerRunscEphemeral,
			Backend::DockerEphemeral
		],);
		assert_eq!(candidates_for("linux"), [
			Backend::Gvisor,
			Backend::Bubblewrap,
			Backend::DockerRunscEphemeral,
			Backend::DockerEphemeral,
		],);
		assert!(!candidates_for("linux").contains(&Backend::Landlock));
		assert_eq!(candidates_for("windows"), [Backend::AppContainer]);
		assert!(candidates_for("plan9").is_empty());
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn linux_native_selection_requires_bubblewrap() {
		assert_eq!(fallback_backend().expect("Linux fallback backend"), Backend::Bubblewrap);
		assert_eq!(
			native_command_backend().expect("Linux native command backend"),
			Backend::Bubblewrap
		);
	}
}
