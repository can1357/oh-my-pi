//! AI developer workflow domain.
//!
//! A workflow is named phases with declared dependencies. This crate decides
//! what that means — which phases may dispatch, which attempt a phase is on,
//! which producer version an attempt consumed, what a rejection invalidates,
//! and whether the run was accepted.
//!
//! The domain is a pure state machine: no I/O, no clock, no spawning. Every
//! transition is a total function of recorded facts, so replaying the same
//! transitions reconstructs the same state. Execution authority lives in
//! `omp-agent` and `omp-envd`; durability lives in `omp-journal`. A caller
//! dispatches what [`Run::next_step`] returns and reports results back.
//!
//! ```
//! use omp_adw::{OnReject, Phase, PhaseKind, PhaseName, Run, Step, Workflow, WorkflowName};
//!
//! let workflow = Workflow::new(WorkflowName::new("ship"), vec![
//! 	Phase::new(PhaseName::new("build"), PhaseKind::Agent),
//! 	Phase::new(PhaseName::new("review"), PhaseKind::Review)
//! 		.consuming([PhaseName::new("build")])
//! 		.on_reject(OnReject::Correct),
//! ])?;
//!
//! let mut run = Run::new(workflow);
//! let Step::Run { phase, .. } = run.next_step() else {
//! 	unreachable!()
//! };
//! assert_eq!(phase.name.as_str(), "build");
//! # Ok::<(), omp_adw::WorkflowError>(())
//! ```

mod profile;
mod run;
mod workflow;

pub use profile::{ApprovalScope, NetworkScope, Posture, PostureError, Requirement, WriteScope};
pub use run::{DEFAULT_MAX_ATTEMPTS, Outcome, Run, RunError, SelectedInput, Step};
pub use workflow::{OnReject, Phase, PhaseKind, PhaseName, Workflow, WorkflowError, WorkflowName};
