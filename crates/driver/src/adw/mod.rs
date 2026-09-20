//! Host for the AI developer workflow domain.
//!
//! `omp-adw` is a pure state machine: it decides which phase may dispatch, how
//! many attempts one has consumed, and what a rejection invalidates. It
//! performs no I/O. This module is the other half — it reads the project's
//! workflow declaration, resolves the execution posture the domain compares
//! requirements against, dispatches what the domain hands back, and reports
//! outcomes in.
//!
//! The split is load-bearing: acceptance is host-owned, so gate results arrive
//! here as observed evidence and go *into* the domain, rather than the domain
//! reaching out for them.

pub mod definition;
pub mod production;

use std::{error::Error as StdError, future::Future, path::Path};

pub use definition::{DefinitionError, PhaseSpec, WorkflowDefinition};
use omp_adw::{OnReject, Outcome, Phase, Posture, Run, RunError, SelectedInput, Step};
use omp_core::Str;
use tokio_util::sync::CancellationToken;

/// What a dispatched phase reported.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PhaseResult {
	/// Whether the phase met its acceptance condition.
	pub accepted: bool,
	/// Why the phase was rejected, forwarded verbatim as the next attempt's
	/// correction. Empty when accepted.
	pub feedback: Str,
}

/// One settled phase, recorded in dispatch order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PhaseRecord {
	/// The phase that ran.
	pub phase:    Str,
	/// The attempt ordinal this record describes.
	pub attempt:  u32,
	/// Whether the attempt was accepted.
	pub accepted: bool,
	/// What the run decided in response, rendered for the operator.
	pub decision: Str,
}

/// How a run finished.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::IntoStaticStr)]
#[strum(serialize_all = "kebab-case")]
pub enum RunStatus {
	/// Every phase was accepted.
	Accepted,
	/// The run halted without accepting every phase.
	Halted,
	/// A phase required a posture the host did not resolve.
	Blocked,
	/// The operator cancelled the run.
	Cancelled,
}

/// The settled result of one workflow run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunExit {
	/// Process exit status: 0 accepted, 1 halted or blocked, 130 cancelled.
	pub code:    u8,
	/// How the run finished.
	pub status:  RunStatus,
	/// Every settled attempt, in dispatch order.
	pub records: Vec<PhaseRecord>,
	/// Why the run stopped, when it did not accept.
	pub reason:  Option<Str>,
}

/// Production seams for posture resolution and phase dispatch.
///
/// Deliberately narrow: the domain already decided *what* runs next, so a host
/// only resolves the posture it can honestly report and executes one phase.
pub trait AdwHost: Sync {
	/// Typed host failure.
	type Error: StdError + Send + Sync + 'static;

	/// The project root this run executes against.
	fn project_root(&self) -> &Path;

	/// Reports the posture the host actually resolved.
	///
	/// Reported once, before the first dispatch. A host that cannot determine
	/// its posture must say so by failing rather than guessing: the domain
	/// treats an unreported posture as unverified and refuses phases that
	/// declare requirements, which is the safe direction.
	fn posture(&self) -> Result<Posture, Self::Error>;

	/// Runs one phase and reports what it produced.
	fn dispatch<'a>(
		&'a self,
		phase: &'a Phase,
		spec: &'a PhaseSpec,
		attempt: u32,
		correction: Option<&'a Str>,
		inputs: &'a [SelectedInput],
		cancel: &'a CancellationToken,
	) -> impl Future<Output = Result<PhaseResult, Self::Error>> + Send + 'a;
}

/// A workflow run that could not proceed.
#[derive(Debug, thiserror::Error)]
pub enum Error<E: StdError + 'static> {
	/// The project declares no such workflow, or it is invalid.
	#[error("workflow definition could not be loaded")]
	Definition(#[from] DefinitionError),
	/// The domain refused a transition.
	#[error("workflow run rejected a transition")]
	Transition(#[from] RunError),
	/// Posture resolution or phase dispatch failed.
	#[error("workflow runtime host failed")]
	Host(#[source] E),
}

/// Drives one workflow to acceptance, halt, block, or cancellation.
///
/// # Errors
///
/// Returns [`Error`] when the definition cannot be loaded, the host fails, or
/// the domain refuses a transition. A halted or blocked run is a normal
/// outcome carried in [`RunExit`], not an error.
pub async fn run<H: AdwHost>(
	definition: &WorkflowDefinition,
	max_attempts: u32,
	host: &H,
	cancel: &CancellationToken,
) -> Result<RunExit, Error<H::Error>> {
	let posture = host.posture().map_err(Error::Host)?;
	let mut run = Run::new(definition.workflow().clone())
		.with_max_attempts(max_attempts)
		.with_posture(posture);
	let mut records = Vec::new();
	// The domain reports *that* a run halted; only the phase's declared
	// rejection route says why. Captured where both are in scope so the
	// operator is told the actual cause, not a plausible one.
	let mut halt_reason = None;

	loop {
		if cancel.is_cancelled() {
			return Ok(cancelled(records));
		}
		match run.next_step() {
			Step::Run { phase, attempt, correction, inputs } => {
				let Some(spec) = definition.spec(&phase.name) else {
					// Unreachable by construction: the loader rejects a phase
					// without execution detail. Treated as a halt rather than a
					// panic so a future loader change degrades visibly.
					return Ok(halted(
						records,
						Some(Str::from(format!(
							"phase `{}` carries no execution detail",
							phase.name.as_str()
						))),
					));
				};
				let result = host
					.dispatch(&phase, spec, attempt, correction.as_ref(), &inputs, cancel)
					.await
					.map_err(Error::Host)?;
				let outcome = if result.accepted {
					run.accept(&phase.name)?
				} else {
					run.reject(&phase.name, result.feedback)?
				};
				if matches!(outcome, Outcome::Halted { .. }) {
					halt_reason = Some(match phase.on_reject {
						OnReject::Halt => Str::from(format!(
							"phase `{}` was rejected and halts the run",
							phase.name.as_str()
						)),
						OnReject::Retry => Str::from(format!(
							"phase `{}` exhausted its {max_attempts} attempts",
							phase.name.as_str()
						)),
						OnReject::Correct => Str::from(format!(
							"phase `{}` was rejected with no upstream phase to correct",
							phase.name.as_str()
						)),
					});
				}
				records.push(PhaseRecord {
					phase: Str::new(phase.name.as_str()),
					attempt,
					accepted: result.accepted,
					decision: describe(&outcome),
				});
			},
			// Dispatch is serial, so nothing is ever in flight here; a wait
			// with an empty ready set means the graph cannot progress.
			Step::Wait => return Ok(halted(records, Some(Str::new_static("no phase can proceed")))),
			Step::Blocked { error } => {
				return Ok(RunExit {
					code: 1,
					status: RunStatus::Blocked,
					records,
					reason: Some(Str::from(error.to_string())),
				});
			},
			Step::Done { accepted: true } => {
				return Ok(RunExit { code: 0, status: RunStatus::Accepted, records, reason: None });
			},
			Step::Done { accepted: false } => return Ok(halted(records, halt_reason)),
		}
	}
}

fn cancelled(records: Vec<PhaseRecord>) -> RunExit {
	RunExit { code: 130, status: RunStatus::Cancelled, records, reason: None }
}

fn halted(records: Vec<PhaseRecord>, reason: Option<Str>) -> RunExit {
	RunExit { code: 1, status: RunStatus::Halted, records, reason }
}

fn describe(outcome: &Outcome) -> Str {
	match outcome {
		Outcome::Accepted { version, invalidated, .. } if invalidated.is_empty() => {
			Str::from(format!("accepted as v{version}"))
		},
		Outcome::Accepted { version, invalidated, .. } => Str::from(format!(
			"accepted as v{version}; invalidated {}",
			join(invalidated.iter().map(|name| name.as_str()))
		)),
		Outcome::Retried { attempt, .. } => Str::from(format!("retrying as attempt {attempt}")),
		Outcome::Rewound { phase, .. } => Str::from(format!("rewound to `{}`", phase.as_str())),
		Outcome::Halted { .. } => Str::new_static("halted the run"),
	}
}

fn join<'a>(names: impl Iterator<Item = &'a str>) -> String {
	let mut text = String::new();
	for name in names {
		if !text.is_empty() {
			text.push_str(", ");
		}
		text.push_str(name);
	}
	text
}
