//! Backend-neutral build and test execution domain (ADR 0040, Part B).
//!
//! A caller's [`BuildCommand`] goes through a [`BuildSystemAdapter`] (slice 1
//! ships [`CargoJust`]) into an [`ExecutionPlan`] of [`ExecutionRequest`]s.
//! [`place`] decides, purely, whether each request runs locally or on an
//! offered backend, from the request's [`Eligibility`], the operator's
//! [`ExecutionPolicy`], and each backend's [`BackendCapabilities`]. A backend
//! implements [`ExecutionBackend`]; its [`ExecutionRun`] streams
//! [`ExecutionEvent`]s ending in an [`ExecutionResult`] or a typed
//! [`ExecutionError`], which [`fallback_eligible`] classifies.
//!
//! The crate performs no I/O and names no vendor: adapters never name a
//! backend, and backends never inspect argv to infer a build system.
//!
//! ```
//! use omp_adw::Requirement;
//! use omp_core::Str;
//! use omp_exec::{
//! 	BuildCommand, BuildSystemAdapter, CargoJust, Eligibility, ExecutionId, ExecutionPolicy,
//! 	Intent, Placement, Platform, RepoPins, place,
//! };
//!
//! let pins = RepoPins {
//! 	rust_toolchain: Str::new_static("nightly-2026-08-08"),
//! 	nextest:        Str::new_static("0.9.146"),
//! 	cpython_tag:    Str::new_static("20260807"),
//! 	cpython:        Str::new_static("3.14.7"),
//! };
//! let command = BuildCommand {
//! 	id:          ExecutionId::new_static("run-1"),
//! 	argv:        [Str::new_static("just"), Str::new_static("fmt")].into(),
//! 	cwd:         None,
//! 	intent:      Intent::Other,
//! 	requirement: Requirement::default(),
//! 	target:      Platform::MACOS_AARCH64,
//! 	host:        Platform::MACOS_AARCH64,
//! };
//! let plan = CargoJust::default().plan(&command, &pins)?;
//! let request = &plan.requests[0];
//! assert_eq!(request.eligibility, Eligibility::LocalRequired);
//! assert_eq!(place(request, &[], &ExecutionPolicy::default()), Ok(Placement::Local));
//! # Ok::<(), omp_exec::PlanError>(())
//! ```

mod adapter;
mod backend;
mod captured_inputs;
mod cargo_just;
mod deny;
mod digest;
mod error;
mod handle;
mod host;
mod ids;
mod place;
mod platform;
mod report;
mod request;
mod result;

pub use adapter::{BuildSystemAdapter, PlanError, RepoPins};
pub use backend::{
	BackendCapabilities, CachePolicy, CacheSupport, CancelOutcome, CancelSupport, ExecutionBackend,
	ExecutionPolicy, ExecutionRun, FallbackPolicy, ReattachContext,
};
pub use captured_inputs::{CaptureEntry, capture_entries};
pub use cargo_just::{
	CARGO_JUST_RECIPES, CARGO_TARGET_CACHE, CargoJust, DEFAULT_TIMEOUT, JUST, RecipeClass,
	recipe_class,
};
pub use deny::DEFAULT_UPLOAD_DENY;
pub use digest::Digest;
pub use error::{
	CasOp, ExecutionError, ExecutionErrorKind, ForeignError, Rejection, RemoteCancel, Stage,
	Unplaceable, fallback_eligible,
};
pub use handle::{ReattachHandle, ReattachSchema, ResumeSupport};
pub use host::{ExecError, ExecEvent, ExecHost, ExecRun, IdentityError, LeaseError, StoreError};
pub use ids::{BackendId, CacheName, ExecutionId, ToolchainId};
pub use place::{Placement, admit, place};
pub use platform::{
	Arch, Need, NeedIndexError, NeedSet, Os, Platform, PlatformRequirement, ResourceRequirements,
};
pub use report::{BuildReport, BuildStatus};
pub use request::{
	BuildCommand, CacheDecl, Eligibility, EnvEntry, Exclusion, ExclusionCounts, ExecutionPlan,
	ExecutionRequest, InputSet, Intent, OutputSpec,
};
pub use result::{
	Artifact, ExecutionEvent, ExecutionResult, ExecutionState, FallbackCause, Logs, Outcome,
	OutputFrame, Stream, Timing, TransferCounts,
};
