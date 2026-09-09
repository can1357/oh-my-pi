//! Backend-independent process confinement specifications, plans, and runtimes.
//!
//! [`SandboxSpec`] describes required capabilities without choosing an
//! implementation. [`Runner`] selects or binds a backend, compiles a pure
//! inspectable [`Plan`], and then materializes secrets and temporary resources
//! in [`PreparedSandbox`] for either caller-owned launching or [`Runner::run`].

mod backends;
mod capability;
mod environment;
mod error;
mod paths;
mod plan;
mod runner;
mod runtime;
mod spec;

pub use backends::landlock::{HIDDEN_CHILD_ARG, abi as landlock_abi, run_child_entry};
pub use capability::{Backend, Capability, CapabilitySet, portable_capabilities};
pub use environment::{
	EnvironmentPolicy, EnvironmentSource, core_environment_names, validate_env_pattern,
};
pub use error::{
	BackendStatus, CleanupFailure, CleanupFailures, ProbeFailure, ResourceKind, RunFailure,
	SandboxError, SandboxOperation, SpecViolation,
};
pub use plan::{Caveat, FilesystemVirtualizationKind, Plan};
pub use runner::{
	CommandWrapper, OutputMode, PreparedSandbox, RunOptions, RunOutput, Runner, SandboxExit,
	SandboxInput, backend_status, backend_statuses,
};
pub use spec::{
	DegradationPolicy, NetworkMode, RUNTIME_READ_ROOTS, ResourceLimits, SandboxSpec, WriteMode,
};
