use std::{ffi::OsString, io, path::PathBuf, sync::Arc};

use omp_core::{CowBytes, Str};
use strum::{Display, EnumString, IntoStaticStr};
use thiserror::Error;

use crate::{Backend, CapabilitySet};

/// Resource measured or constrained by a sandbox runtime.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub enum ResourceKind {
	/// CPU time or quota.
	Cpu,
	/// Resident memory.
	Memory,
	/// Process or task count.
	Pids,
}

/// Backend operation associated with a typed sandbox failure.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub enum SandboxOperation {
	/// Verify that a backend installs confinement.
	Probe,
	/// Compile a backend-independent specification.
	Compile,
	/// Materialize runtime files and operating-system resources.
	Prepare,
	/// Start the confined process.
	Launch,
	/// Send standard input to the confined process.
	Input,
	/// Wait for the confined process to exit.
	Wait,
	/// Capture process output.
	Output,
	/// Tear down temporary runtime resources.
	Cleanup,
}

/// Why a live backend probe failed.
#[derive(Debug, Error)]
pub enum ProbeFailure {
	/// The backend executable or operating-system API could not be started.
	#[error("{backend} {operation} could not start")]
	Start {
		/// Backend being checked.
		backend:   Backend,
		/// Probe sub-operation.
		operation: SandboxOperation,
		/// Operating-system failure.
		#[source]
		source:    io::Error,
	},
	/// The backend started but did not enforce the smoke profile successfully.
	#[error("{backend} {operation} exited unsuccessfully")]
	Rejected {
		/// Backend being checked.
		backend:    Backend,
		/// Probe sub-operation.
		operation:  SandboxOperation,
		/// Process exit code when one was available.
		status:     Option<i32>,
		/// Bounded backend diagnostic bytes.
		diagnostic: CowBytes<'static>,
	},
	/// Required backend configuration is absent.
	#[error("{backend} requires configuration variable {variable}")]
	Configuration {
		/// Backend being checked.
		backend:  Backend,
		/// Missing environment variable.
		variable: &'static str,
	},
	/// The running Linux kernel exposes an older Landlock ABI than required.
	#[error("landlock ABI {required} is required, but the kernel exposes ABI {available}")]
	LandlockAbi {
		/// Minimum ABI providing the capabilities advertised by the backend.
		required:  u32,
		/// ABI reported by the running kernel.
		available: u32,
	},
	/// The current host cannot execute this backend.
	#[error("{backend} is not executable on {os}")]
	WrongHost {
		/// Requested backend.
		backend: Backend,
		/// Current operating-system name.
		os:      &'static str,
	},
}

/// Cached result of checking one backend on this host.
#[derive(Clone, Debug)]
pub struct BackendStatus {
	backend: Backend,
	failure: Option<Arc<ProbeFailure>>,
}

impl BackendStatus {
	pub(crate) const fn available(backend: Backend) -> Self {
		Self { backend, failure: None }
	}

	pub(crate) fn unavailable(backend: Backend, failure: ProbeFailure) -> Self {
		Self { backend, failure: Some(Arc::new(failure)) }
	}

	/// Returns the checked backend.
	#[must_use]
	pub const fn backend(&self) -> Backend {
		self.backend
	}

	/// Reports whether the backend passed its live probe.
	#[must_use]
	pub const fn is_available(&self) -> bool {
		self.failure.is_none()
	}

	/// Returns the typed probe failure when the backend is unavailable.
	#[must_use]
	pub fn failure(&self) -> Option<&ProbeFailure> {
		self.failure.as_deref()
	}

	pub(crate) fn failure_arc(&self) -> Option<Arc<ProbeFailure>> {
		self.failure.clone()
	}
}

/// Invalid relationship between sandbox specification fields.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum SpecViolation {
	/// Temporary writes require scoped or overlay write mode.
	#[error("temporary writes require write mode scope or overlay")]
	TempWithoutWritableMode,
	/// Writable paths require scoped or overlay write mode.
	#[error("writable paths require write mode scope or overlay")]
	WritableWithoutWritableMode,
	/// Scoped write mode needs at least one writable location.
	#[error("write mode scope requires a writable path or temporary writes")]
	EmptyWriteScope,
	/// A write-deny carve-out must be nested under an effective writable scope.
	#[error("write-deny paths must be inside an effective writable scope")]
	WriteDenyOutsideScope,
	/// A scoped-read working directory must itself be readable or writable.
	#[error("the working directory is outside every readable and writable scope")]
	DirectoryOutsideScope,
	/// A Mach service allow entry is blank.
	#[error("Mach service names must not be blank")]
	EmptyMachService,
	/// A scoped proxy endpoint has no usable TCP port.
	#[error("sandbox proxy port must be nonzero")]
	ProxyPortZero,
}

/// One failed best-effort cleanup operation.
#[derive(Debug, Error)]
pub enum CleanupFailure {
	/// A temporary file could not be removed.
	#[error("failed to remove sandbox file {path}")]
	RemoveFile {
		/// File being removed.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A temporary directory could not be removed.
	#[error("failed to remove sandbox directory {path}")]
	RemoveDirectory {
		/// Directory being removed.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A disposable container could not be removed.
	#[error("failed to remove {backend} container {name}")]
	RemoveContainer {
		/// Container backend.
		backend: Backend,
		/// Deterministic container name.
		name:    Str,
		/// Process launch or wait failure.
		#[source]
		source:  io::Error,
	},
	/// A backend cleanup command exited unsuccessfully.
	#[error("{backend} rejected cleanup operation {operation}")]
	BackendCommand {
		/// Active backend.
		backend:    Backend,
		/// Cleanup operation.
		operation:  SandboxOperation,
		/// Exit code when available.
		status:     Option<i32>,
		/// Bounded backend diagnostic bytes.
		diagnostic: CowBytes<'static>,
	},
	/// A backend cleanup operation could not start or wait.
	#[error("failed to execute {backend} cleanup operation {operation}")]
	BackendIo {
		/// Active backend.
		backend:   Backend,
		/// Cleanup operation.
		operation: SandboxOperation,
		/// Operating-system failure.
		#[source]
		source:    io::Error,
	},
	/// A path-specific backend cleanup operation failed.
	#[error("failed to execute {backend} cleanup operation {operation} for {path}")]
	BackendPath {
		/// Active backend.
		backend:   Backend,
		/// Cleanup operation.
		operation: SandboxOperation,
		/// Affected path.
		path:      PathBuf,
		/// Operating-system failure.
		#[source]
		source:    io::Error,
	},
}

/// Typed aggregate of cleanup failures retained in resource order.
#[derive(Debug, Error)]
#[error("one or more sandbox resources could not be cleaned up")]
pub struct CleanupFailures {
	failures: Vec<CleanupFailure>,
}

impl CleanupFailures {
	pub(crate) const fn new(failures: Vec<CleanupFailure>) -> Self {
		Self { failures }
	}

	pub(crate) fn append(&mut self, mut other: Self) {
		self.failures.append(&mut other.failures);
	}

	/// Returns individual cleanup failures in attempted order.
	#[must_use]
	pub fn failures(&self) -> &[CleanupFailure] {
		&self.failures
	}
}

/// Non-recursive runtime failure retained when cleanup also fails.
#[derive(Debug, Error)]
pub enum RunFailure {
	/// The confined process could not be started.
	#[error("process launch failed")]
	Launch {
		/// Process launch failure.
		#[source]
		source: io::Error,
	},
	/// Waiting for the confined process failed.
	#[error("process wait failed")]
	Wait {
		/// Process wait failure.
		#[source]
		source: io::Error,
	},
	/// Sending standard input failed.
	#[error("process input failed")]
	Input {
		/// Pipe failure.
		#[source]
		source: io::Error,
	},
	/// Capturing process output failed.
	#[error("process output failed")]
	Output {
		/// Pipe failure.
		#[source]
		source: io::Error,
	},
	/// The configured wall-clock deadline expired.
	#[error("process timed out")]
	Timeout,
	/// A backend command exited unsuccessfully.
	#[error("backend rejected operation {operation}")]
	BackendCommand {
		/// Failed operation.
		operation:  SandboxOperation,
		/// Exit code when available.
		status:     Option<i32>,
		/// Bounded backend diagnostic bytes.
		diagnostic: CowBytes<'static>,
	},
	/// A backend runtime operation failed.
	#[error("backend operation {operation} failed")]
	BackendIo {
		/// Failed operation.
		operation: SandboxOperation,
		/// Operating-system failure.
		#[source]
		source:    io::Error,
	},
	/// A path-specific backend runtime operation failed.
	#[error("backend operation {operation} failed for {path}")]
	BackendPath {
		/// Failed operation.
		operation: SandboxOperation,
		/// Affected path.
		path:      PathBuf,
		/// Operating-system failure.
		#[source]
		source:    io::Error,
	},
	/// A resource watchdog failed to sample or control the process group.
	#[error("resource watchdog failed")]
	ResourceWatchdog {
		/// Operating-system failure.
		#[source]
		source: io::Error,
	},
	/// A runtime observed a resource ceiling breach.
	#[error("{resource} exceeded: observed {observed}, limit {limit}")]
	ResourceLimitExceeded {
		/// Exceeded resource.
		resource: ResourceKind,
		/// Sampled amount.
		observed: u64,
		/// Configured ceiling.
		limit:    u64,
	},
}

/// Failure to compile, prepare, launch, or clean up a sandbox.
#[derive(Debug, Error)]
pub enum SandboxError {
	/// A filesystem grant or executable could not be canonicalized.
	#[error("failed to canonicalize sandbox path {path}")]
	Canonicalize {
		/// Caller-supplied path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A future deny path could not be normalized safely.
	#[error("sandbox deny path {path} has no canonicalizable ancestor")]
	InvalidDenyPath {
		/// Rejected deny path.
		path: PathBuf,
	},
	/// A configured read-deny glob cannot be enforced by the selected sandbox
	/// backends.
	#[error("sandbox read-deny glob {pattern} cannot be enforced")]
	UnsupportedReadDenyGlob {
		/// Rejected glob pattern.
		pattern: Str,
	},
	/// A writable-root carve-out crosses a symlink that Bubblewrap cannot
	/// protect.
	#[error("sandbox writable root {writable_root} cannot protect {path} through symlink {symlink}")]
	ProtectedWriteDenySymlink {
		/// Writable root containing the protected path.
		writable_root: PathBuf,
		/// Logical path requested as a read-only carve-out.
		path:          PathBuf,
		/// Symlink component a read-only bind would follow.
		symlink:       PathBuf,
	},
	/// A Unix-socket allowance did not identify a socket.
	#[error("sandbox Unix-socket allowance {path} is not a socket")]
	NotUnixSocket {
		/// Rejected path.
		path: PathBuf,
	},
	/// The active backend cannot enforce an exact requested authority.
	#[error("sandbox backend {backend} cannot enforce exact {authority}")]
	EnforcementUnavailable {
		/// Backend which cannot represent the restriction.
		backend:   Backend,
		/// Exact authority which would otherwise be widened.
		authority: &'static str,
	},
	/// An environment glob is syntactically invalid.
	#[error("invalid environment pattern {pattern}")]
	InvalidEnvironmentPattern {
		/// Rejected pattern.
		pattern: Str,
		/// Glob parser failure.
		#[source]
		source:  globset::Error,
	},
	/// An environment allow or deny pattern is blank.
	#[error("environment patterns must not be blank")]
	EmptyEnvironmentPattern,
	/// A CPU limit is negative, zero, NaN, or infinite.
	#[error("CPU limit must be finite and greater than zero, not {value}")]
	InvalidCpuLimit {
		/// Rejected core count.
		value: f64,
	},
	/// A resource limit cannot be represented by the selected backend contract.
	#[error("sandbox {resource} limit cannot represent value {value}")]
	InvalidResourceLimit {
		/// Rejected resource.
		resource: ResourceKind,
		/// Rejected unsigned limit.
		value:    u64,
	},
	/// A specification field combination has no enforceable meaning.
	#[error(transparent)]
	InvalidSpec(#[from] SpecViolation),
	/// A bare executable could not be resolved through `PATH`.
	#[error("sandbox executable {program:?} was not found on PATH")]
	ExecutableNotFound {
		/// Unresolved executable name.
		program: OsString,
	},
	/// The hidden same-binary sandbox child received a malformed argv contract.
	#[error("invalid hidden sandbox child arguments")]
	InvalidSandboxChildArguments,
	/// The kernel accepted the Landlock ruleset request without fully enforcing
	/// it.
	#[cfg(target_os = "linux")]
	#[error("the kernel did not fully enforce the Landlock ruleset")]
	LandlockNotEnforced,
	/// A Landlock ruleset could not be built or installed.
	#[cfg(target_os = "linux")]
	#[error("failed to install the Landlock ruleset")]
	Landlock {
		/// Landlock ruleset failure.
		#[from]
		source: landlock::RulesetError,
	},
	/// A seccomp program could not be built or installed.
	#[cfg(target_os = "linux")]
	#[error("failed to build or install the seccomp filter")]
	Seccomp {
		/// Seccomp compiler or kernel-installation failure.
		#[from]
		source: seccompiler::Error,
	},
	/// A backend mount path cannot be represented safely.
	#[error("sandbox backend {backend} cannot mount path {path}")]
	InvalidMountPath {
		/// Active backend.
		backend: Backend,
		/// Rejected host or container path.
		path:    PathBuf,
	},
	/// A read-only container image declares a writable volume.
	#[error("sandbox backend {backend} image {image:?} declares writable volume {path}")]
	ImageVolumeWrite {
		/// Container backend.
		backend: Backend,
		/// Inspected immutable image identifier.
		image:   OsString,
		/// Undeclared writable volume path.
		path:    PathBuf,
	},
	/// An ephemeral workspace root is not a directory.
	#[error("sandbox ephemeral workspace root {path} is not a directory")]
	WorkspaceRootNotDirectory {
		/// Rejected workspace root.
		path: PathBuf,
	},
	/// A workspace copy encountered an unsupported filesystem entry.
	#[error("sandbox workspace entry {path} has unsupported mode {mode:#o}")]
	UnsupportedWorkspaceEntry {
		/// Unsupported entry.
		path: PathBuf,
		/// Platform file mode.
		mode: u32,
	},
	/// A compiled plan omitted a required typed placeholder.
	#[error("sandbox backend {backend} plan is missing placeholder {placeholder}")]
	MissingPlanPlaceholder {
		/// Active backend.
		backend:     Backend,
		/// Required static placeholder token.
		placeholder: &'static str,
	},
	/// An explicitly selected backend failed its live probe.
	#[error("sandbox backend {backend} is unavailable")]
	BackendUnavailable {
		/// Requested backend.
		backend: Backend,
		/// Cached typed probe failure.
		#[source]
		failure: Arc<ProbeFailure>,
	},
	/// No available backend can enforce all requested capabilities.
	#[error("no available sandbox backend enforces: {missing}")]
	NoBackendCapabilities {
		/// Capabilities absent from every available candidate.
		missing: CapabilitySet,
	},
	/// A plan was passed to a runner for a different backend.
	#[error("sandbox plan uses {plan}, but runner uses {runner}")]
	PlanBackendMismatch {
		/// Runner backend.
		runner: Backend,
		/// Plan backend.
		plan:   Backend,
	},
	/// A command-backed plan contains no launcher argument.
	#[error("sandbox backend {backend} produced an empty command plan")]
	EmptyPlanArgv {
		/// Backend which produced the invalid plan.
		backend: Backend,
	},
	/// Runtime preparation omitted backend-owned state.
	#[error("sandbox backend {backend} has no prepared runtime state")]
	MissingPreparedState {
		/// Backend missing its prepared state.
		backend: Backend,
	},
	/// The selected backend cannot enforce all requested capabilities.
	#[error("sandbox backend {backend} does not enforce: {missing}")]
	BackendCapabilities {
		/// Selected backend.
		backend: Backend,
		/// Missing capabilities.
		missing: CapabilitySet,
	},
	/// This host has no native command-backed sandbox.
	#[error("no native command-backed sandbox exists on {os}")]
	UnsupportedHost {
		/// Current operating-system name.
		os: &'static str,
	},
	/// The backend can run only through its in-process runtime.
	#[error("sandbox backend {backend} cannot produce an external command")]
	ExternalCommandUnsupported {
		/// In-process backend.
		backend: Backend,
	},
	/// The selected backend cannot compile a reusable command wrapper.
	#[error("sandbox backend {backend} cannot compile a reusable command wrapper")]
	CommandWrapperUnsupported {
		/// Backend without a native reusable launcher.
		backend: Backend,
	},
	/// A reusable wrapper cannot enforce a command-specific no-exec rule.
	#[error("sandbox backend {backend} cannot apply no-exec to a program-less command wrapper")]
	CommandWrapperNoExec {
		/// Native backend requiring the initial executable path.
		backend: Backend,
	},
	/// A preparation artifact could not be created or populated.
	#[error("failed to {operation} sandbox artifact {path}")]
	Artifact {
		/// Artifact operation.
		operation: SandboxOperation,
		/// Artifact path.
		path:      PathBuf,
		/// Filesystem failure.
		#[source]
		source:    io::Error,
	},
	/// A backend operation failed before returning an exit status.
	#[error("failed to execute sandbox backend {backend} operation {operation}")]
	BackendIo {
		/// Active backend.
		backend:   Backend,
		/// Failed operation.
		operation: SandboxOperation,
		/// Operating-system failure.
		#[source]
		source:    io::Error,
	},
	/// A path-specific backend operation failed.
	#[error("failed to execute sandbox backend {backend} operation {operation} for {path}")]
	BackendPath {
		/// Active backend.
		backend:   Backend,
		/// Failed operation.
		operation: SandboxOperation,
		/// Affected path.
		path:      PathBuf,
		/// Operating-system failure.
		#[source]
		source:    io::Error,
	},
	/// A backend JSON contract could not be decoded or encoded.
	#[error("sandbox backend {backend} produced invalid JSON during {operation}")]
	BackendJson {
		/// Active backend.
		backend:   Backend,
		/// Failed operation.
		operation: SandboxOperation,
		/// JSON codec failure.
		#[source]
		source:    serde_json::Error,
	},
	/// A resource watchdog could not sample or control the process group.
	#[error("sandbox backend {backend} resource watchdog failed")]
	ResourceWatchdog {
		/// Active backend.
		backend: Backend,
		/// Operating-system failure.
		#[source]
		source:  io::Error,
	},
	/// A runtime killed the process tree after observing a resource ceiling
	/// breach.
	#[error("sandbox backend {backend} exceeded {resource}: observed {observed}, limit {limit}")]
	ResourceLimitExceeded {
		/// Active backend.
		backend:  Backend,
		/// Exceeded resource.
		resource: ResourceKind,
		/// Sampled amount.
		observed: u64,
		/// Configured ceiling.
		limit:    u64,
	},
	/// The confined process could not be started.
	#[error("failed to launch sandbox backend {backend}")]
	Launch {
		/// Active backend.
		backend: Backend,
		/// Process launch failure.
		#[source]
		source:  io::Error,
	},
	/// Waiting for the confined process failed.
	#[error("failed to wait for sandbox backend {backend}")]
	Wait {
		/// Active backend.
		backend: Backend,
		/// Process wait failure.
		#[source]
		source:  io::Error,
	},
	/// Sending sandbox standard input failed.
	#[error("failed to send input to sandbox backend {backend}")]
	Input {
		/// Active backend.
		backend: Backend,
		/// Pipe failure.
		#[source]
		source:  io::Error,
	},
	/// Capturing sandbox output failed.
	#[error("failed to capture output from sandbox backend {backend}")]
	Output {
		/// Active backend.
		backend: Backend,
		/// Pipe or task failure.
		#[source]
		source:  io::Error,
	},
	/// The configured run deadline expired after process-tree termination.
	#[error("sandbox backend {backend} exceeded its timeout")]
	Timeout {
		/// Active backend.
		backend: Backend,
	},
	/// Runtime resources remained after a successfully launched command.
	#[error(transparent)]
	Cleanup(#[from] CleanupFailures),
	/// Launch and cleanup both failed.
	#[error("sandbox backend {backend} failed to launch and clean up")]
	RunAndCleanup {
		/// Active backend.
		backend: Backend,
		/// Process launch failure.
		run:     RunFailure,
		/// Resource cleanup failures.
		cleanup: CleanupFailures,
	},
	/// A backend rejected a preparation or runtime command.
	#[error("sandbox backend {backend} rejected {operation}")]
	BackendCommand {
		/// Active backend.
		backend:    Backend,
		/// Failed operation.
		operation:  SandboxOperation,
		/// Backend exit code when available.
		status:     Option<i32>,
		/// Bounded diagnostic bytes.
		diagnostic: CowBytes<'static>,
	},
}
