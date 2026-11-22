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
pub mod remote;
pub mod resume;

use std::{error::Error as StdError, future::Future, path::Path};

pub use definition::{DefinitionError, PhaseSpec, WorkflowDefinition};
use omp_adw::{
	NetworkScope, OnReject, Outcome, Phase, PhaseName, Posture, ReplayError, ReplayEvent, Run,
	RunError, SelectedInput, Step, WriteScope, replay,
};
use omp_core::Str;
use omp_journal::runlog::{
	InputVersion, PhaseDispatch, PhaseSettle, PhaseUncertain, RunDone, RunHalt, RunLog, RunLogError,
	RunRecord, SettleStatus,
};
use tokio_util::sync::CancellationToken;

/// What a dispatched phase reported.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PhaseResult {
	/// Whether the phase met its acceptance condition.
	pub accepted:    bool,
	/// Why the phase was rejected, forwarded verbatim as the next attempt's
	/// correction. Legacy providers leave this empty when accepted; native
	/// verification retains its evidence journal reference on acceptance too.
	pub feedback:    Str,
	/// Verdict decision recorded by the judge (e.g. "accept", "reject",
	/// "needs-human"). Absent when the phase was judged without a verdict.
	pub verdict:     Option<Str>,
	/// Whether the judge route differs from the producer route (independent
	/// review). Absent when not applicable.
	pub independent: Option<bool>,
}

/// The disposition of one settled phase attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::IntoStaticStr)]
#[strum(serialize_all = "kebab-case")]
pub enum PhaseStatus {
	/// The phase met its acceptance condition.
	Accepted,
	/// The phase completed but did not meet its acceptance condition.
	Rejected,
	/// The phase's host stopped before it produced a result.
	Failed,
}

/// One settled phase, recorded in dispatch order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PhaseRecord {
	/// The phase that ran.
	pub phase:    Str,
	/// The attempt ordinal this record describes.
	pub attempt:  u32,
	/// The disposition of this attempt.
	pub status:   PhaseStatus,
	/// What the run decided in response, rendered for the operator.
	pub decision: Str,
	/// What the host reported for this attempt (a code phase's captured
	/// output, a reviewer's reason). Empty when the host stopped before
	/// producing a result.
	pub feedback: Str,
}

/// The typed failure of one phase dispatch.
#[derive(Debug, Eq, PartialEq, thiserror::Error)]
#[error("workflow phase `{phase}` attempt {attempt} failed")]
pub struct PhaseFailure<E: StdError + 'static> {
	/// The phase whose host dispatch failed.
	pub phase:   Str,
	/// The attempt ordinal whose host dispatch failed.
	pub attempt: u32,
	/// The host error that stopped this run.
	#[source]
	pub source:  E,
}

/// How a run finished.
#[derive(Debug, Eq, PartialEq)]
pub enum RunStatus<E: StdError + 'static> {
	/// Every phase was accepted.
	Accepted,
	/// The run halted without accepting every phase.
	Halted,
	/// A phase required a posture the host did not resolve.
	Blocked,
	/// A dispatched phase's host failed.
	Failed(PhaseFailure<E>),
	/// The operator cancelled the run.
	Cancelled,
}

/// The settled result of one workflow run.
#[derive(Debug, Eq, PartialEq)]
pub struct RunExit<E: StdError + 'static> {
	/// Process exit status: 0 accepted, 1 halted, blocked, or failed, 130
	/// cancelled.
	pub code:    u8,
	/// How the run finished.
	pub status:  RunStatus<E>,
	/// Every settled attempt, in dispatch order.
	pub records: Vec<PhaseRecord>,
	/// Why the run stopped, when it did not accept or fail.
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
	/// Reports the actual placement's posture for one phase. Hosts with one
	/// execution environment inherit the run-wide value.
	fn phase_posture(&self, _phase: &Phase, _spec: &PhaseSpec) -> Result<Posture, Self::Error> {
		self.posture()
	}

	/// Refuses a phase before its dispatch is journaled. A refusal ran nothing,
	/// so the run halts with no open dispatch that resume would treat as
	/// possibly effectful.
	fn admit(&self, _phase: &Phase, _spec: &PhaseSpec) -> Result<(), Self::Error> {
		Ok(())
	}

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
	/// Posture resolution failed before a phase could be recorded.
	#[error("workflow runtime posture resolution failed")]
	Posture(#[source] E),
	/// Journal write failed.
	#[error("workflow run log write failed")]
	Journal(#[from] RunLogError),
	/// Replay of recorded journal events failed.
	#[error("workflow run log replay failed")]
	Replay(#[from] ReplayError),
}

/// Drives one workflow to acceptance, halt, block, failure, or cancellation.
///
/// # Errors
///
/// Returns [`Error`] when posture resolution fails before any phase can be
/// recorded or when the domain refuses a transition. A halted, blocked, failed,
/// or cancelled run is a normal outcome carried in [`RunExit`].
pub async fn run<H: AdwHost>(
	definition: &WorkflowDefinition,
	max_attempts: u32,
	host: &H,
	cancel: &CancellationToken,
) -> Result<RunExit<H::Error>, Error<H::Error>> {
	run_with_log(definition, max_attempts, host, cancel, None).await
}

/// Drives one workflow from its first phase, appending every dispatch, settle
/// and stop to `log` before the engine applies it (ADR 0051 D3).
///
/// # Errors
///
/// As [`run`], plus [`Error::Journal`] when an append fails.
pub async fn run_with_log<H: AdwHost>(
	definition: &WorkflowDefinition,
	max_attempts: u32,
	host: &H,
	cancel: &CancellationToken,
	log: Option<&mut RunLog>,
) -> Result<RunExit<H::Error>, Error<H::Error>> {
	let posture = host.posture().map_err(Error::Posture)?;
	let run = Run::new(definition.workflow().clone())
		.with_max_attempts(max_attempts)
		.with_posture(posture);
	drive(definition, max_attempts, host, cancel, log, run).await
}

/// Resumes a run from its journal (ADR 0051 D5, D6).
///
/// The recorded dispatches and settles are replayed into a fresh engine, which
/// then continues. An attempt dispatched and never settled is dispatched again
/// with the same ordinal only when it could not have had an effect: its
/// recorded posture was read-only with networking disabled and it declared no
/// external effects. Any other such attempt is uncertain and is never silently
/// retried: resume records it, halts, and dispatches nothing.
///
/// # Errors
///
/// [`Error::Replay`] when the journal disagrees with the workflow, and the
/// errors of [`run_with_log`].
pub async fn resume_from_log<H: AdwHost>(
	definition: &WorkflowDefinition,
	max_attempts: u32,
	host: &H,
	cancel: &CancellationToken,
	mut log: RunLog,
	records: &[RunRecord],
) -> Result<RunExit<H::Error>, Error<H::Error>> {
	// A journal that already ended in `Done` is final: report its outcome
	// without dispatching, since the log refuses any further append.
	if let Some(RunRecord::Done(done)) = records.last() {
		return Ok(if done.accepted {
			RunExit { code: 0, status: RunStatus::Accepted, records: Vec::new(), reason: None }
		} else {
			halted(Vec::new(), Some(Str::new_static("the recorded run already ended rejected")))
		});
	}
	let posture = host.posture().map_err(Error::Posture)?;
	let mut run = Run::new(definition.workflow().clone())
		.with_max_attempts(max_attempts)
		.with_posture(posture);
	let replayed = replay(&mut run, &records_to_replay_events(records))?;
	if let Some((phase, attempt)) = replayed.in_flight {
		if open_dispatch(records, &phase, attempt).is_some_and(had_no_effect) {
			run.interrupt(&phase)?;
		} else {
			let reason = Str::from(format!(
				"phase `{}` attempt {attempt} was dispatched and never settled; its effects are \
				 unknown",
				phase.as_str()
			));
			if !recorded_uncertain(records, &phase, attempt) {
				log.append(&RunRecord::Uncertain(PhaseUncertain {
					phase: Str::new(phase.as_str()),
					attempt,
					reason: reason.clone(),
				}))?;
			}
			log.append(&RunRecord::Halt(RunHalt { reason: reason.clone() }))?;
			return Ok(halted(Vec::new(), Some(reason)));
		}
	}
	drive(definition, max_attempts, host, cancel, Some(&mut log), run).await
}

/// Converts recorded [`RunRecord`]s into the [`ReplayEvent`]s the engine
/// replays.
///
/// A second dispatch of the same attempt is the redispatch of an interrupted
/// one, so only the later dispatch is kept. Records that carry no engine
/// transition (start, uncertain, halt, done) are skipped.
#[must_use]
pub fn records_to_replay_events(records: &[RunRecord]) -> Vec<ReplayEvent> {
	let mut events: Vec<ReplayEvent> = Vec::with_capacity(records.len());
	for record in records {
		match record {
			RunRecord::Dispatch(dispatch) => {
				let phase = PhaseName::new(dispatch.phase.clone());
				if let Some(ReplayEvent::Dispatch { phase: open, attempt, .. }) = events.last()
					&& *open == phase
					&& *attempt == dispatch.attempt
				{
					events.pop();
				}
				events.push(ReplayEvent::Dispatch {
					phase,
					attempt: dispatch.attempt,
					posture: parse_posture(&dispatch.posture),
				});
			},
			RunRecord::Settle(settle) => events.push(ReplayEvent::Settle {
				phase:    PhaseName::new(settle.phase.clone()),
				accepted: settle.status == SettleStatus::Accepted,
				feedback: settle.feedback.clone(),
			}),
			RunRecord::Start(_)
			| RunRecord::Uncertain(_)
			| RunRecord::Halt(_)
			| RunRecord::Done(_) => {},
		}
	}
	events
}

/// The posture as its three kebab-case scopes, the form a dispatch record
/// stores and [`parse_posture`] reads back.
fn encode_posture(posture: Posture) -> Str {
	Str::from(format!("{}/{}/{}", posture.write, posture.network, posture.approval))
}

fn parse_posture(text: &str) -> Option<Posture> {
	let mut scopes = text.split('/');
	let posture = Posture {
		write:    scopes.next()?.parse().ok()?,
		network:  scopes.next()?.parse().ok()?,
		approval: scopes.next()?.parse().ok()?,
	};
	scopes.next().is_none().then_some(posture)
}

fn open_dispatch<'a>(
	records: &'a [RunRecord],
	phase: &PhaseName,
	attempt: u32,
) -> Option<&'a PhaseDispatch> {
	records.iter().rev().find_map(|record| match record {
		RunRecord::Dispatch(dispatch)
			if dispatch.attempt == attempt && dispatch.phase.as_str() == phase.as_str() =>
		{
			Some(dispatch)
		},
		_ => None,
	})
}

fn had_no_effect(dispatch: &PhaseDispatch) -> bool {
	dispatch.effects.is_empty()
		&& parse_posture(&dispatch.posture).is_some_and(|posture| {
			posture.write == WriteScope::ReadOnly && posture.network == NetworkScope::Disabled
		})
}

fn recorded_uncertain(records: &[RunRecord], phase: &PhaseName, attempt: u32) -> bool {
	records.iter().any(|record| {
		matches!(record, RunRecord::Uncertain(uncertain)
			if uncertain.attempt == attempt && uncertain.phase.as_str() == phase.as_str())
	})
}

async fn drive<H: AdwHost>(
	definition: &WorkflowDefinition,
	max_attempts: u32,
	host: &H,
	cancel: &CancellationToken,
	mut log: Option<&mut RunLog>,
	mut run: Run,
) -> Result<RunExit<H::Error>, Error<H::Error>> {
	let mut records = Vec::new();
	// The domain reports *that* a run halted; only the phase's declared
	// rejection route says why. Captured where both are in scope so the
	// operator is told the actual cause, not a plausible one.
	let mut halt_reason = None;

	loop {
		if cancel.is_cancelled() {
			append(&mut log, || RunRecord::Halt(RunHalt { reason: Str::new_static("cancelled") }))?;
			return Ok(cancelled(records));
		}
		let mut posture_error = None;
		let mut dispatched_posture = None;
		let step = run.next_step_with_posture(|phase| {
			let spec = definition.spec(&phase.name)?;
			match host.phase_posture(phase, spec) {
				Ok(posture) => {
					dispatched_posture = Some(posture);
					Some(posture)
				},
				Err(error) => {
					posture_error = Some(error);
					None
				},
			}
		});
		if let Some(error) = posture_error {
			return Err(Error::Posture(error));
		}
		match step {
			Step::Run { phase, attempt, correction, inputs } => {
				let Some(spec) = definition.spec(&phase.name) else {
					// Unreachable by construction: the loader rejects a phase
					// without execution detail. Treated as a halt rather than a
					// panic so a future loader change degrades visibly.
					let reason =
						Str::from(format!("phase `{}` carries no execution detail", phase.name.as_str()));
					append(&mut log, || RunRecord::Halt(RunHalt { reason: reason.clone() }))?;
					return Ok(halted(records, Some(reason)));
				};
				if let Err(source) = host.admit(&phase, spec) {
					return host_failed(&mut log, records, &phase, attempt, source);
				}
				append(&mut log, || {
					RunRecord::Dispatch(PhaseDispatch {
						phase: Str::new(phase.name.as_str()),
						attempt,
						inputs: inputs
							.iter()
							.map(|input| InputVersion {
								phase:   Str::new(input.phase.as_str()),
								version: input.version,
							})
							.collect(),
						executor: match spec {
							PhaseSpec::Prompt { executor: Some(id), .. } => id.clone(),
							_ => Str::new_static("native"),
						},
						posture: dispatched_posture
							.map_or_else(|| Str::new_static("unreported"), encode_posture),
						effects: Vec::new(),
					})
				})?;
				let result = match host
					.dispatch(&phase, spec, attempt, correction.as_ref(), &inputs, cancel)
					.await
				{
					Ok(result) => result,
					Err(_) if cancel.is_cancelled() => {
						append(&mut log, || {
							RunRecord::Halt(RunHalt { reason: Str::new_static("cancelled") })
						})?;
						return Ok(cancelled(records));
					},
					Err(source) => return host_failed(&mut log, records, &phase, attempt, source),
				};
				// A phase stopped by cancellation did not fail on its merits:
				// feeding it back as a rejection would schedule (and report) a
				// retry the run will never dispatch.
				if cancel.is_cancelled() {
					append(&mut log, || {
						RunRecord::Halt(RunHalt { reason: Str::new_static("cancelled") })
					})?;
					return Ok(cancelled(records));
				}
				append(&mut log, || {
					RunRecord::Settle(PhaseSettle {
						phase: Str::new(phase.name.as_str()),
						attempt,
						status: if result.accepted {
							SettleStatus::Accepted
						} else {
							SettleStatus::Rejected
						},
						feedback: result.feedback.clone(),
						verdict: result.verdict.clone(),
						independent: result.independent,
					})
				})?;
				let feedback = result.feedback.clone();
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
					status: if result.accepted {
						PhaseStatus::Accepted
					} else {
						PhaseStatus::Rejected
					},
					decision: describe(&outcome),
					feedback,
				});
			},
			// Dispatch is serial, so nothing is ever in flight here; a wait
			// with an empty ready set means the graph cannot progress.
			Step::Wait => {
				let reason = Str::new_static("no phase can proceed");
				append(&mut log, || RunRecord::Halt(RunHalt { reason: reason.clone() }))?;
				return Ok(halted(records, Some(reason)));
			},
			// Blocked on posture is resumable: the host's posture may change.
			Step::Blocked { error } => {
				let reason = Str::from(error.to_string());
				append(&mut log, || RunRecord::Halt(RunHalt { reason: reason.clone() }))?;
				return Ok(RunExit {
					code: 1,
					status: RunStatus::Blocked,
					records,
					reason: Some(reason),
				});
			},
			Step::Done { accepted: true } => {
				append(&mut log, || RunRecord::Done(RunDone { accepted: true }))?;
				return Ok(RunExit { code: 0, status: RunStatus::Accepted, records, reason: None });
			},
			// The engine halted the run on a rejection route: that is final,
			// and replay reproduces it, so the journal ends here.
			Step::Done { accepted: false } => {
				append(&mut log, || RunRecord::Done(RunDone { accepted: false }))?;
				return Ok(halted(records, halt_reason));
			},
		}
	}
}

/// Appends one record when the run is journaled; builds it only then.
fn append(
	log: &mut Option<&mut RunLog>,
	record: impl FnOnce() -> RunRecord,
) -> Result<(), RunLogError> {
	if let Some(log) = log.as_mut() {
		log.append(&record())?;
	}
	Ok(())
}

/// Journals a phase its host could not run, and ends the run with it.
fn host_failed<E: StdError + 'static>(
	log: &mut Option<&mut RunLog>,
	mut records: Vec<PhaseRecord>,
	phase: &Phase,
	attempt: u32,
	source: E,
) -> Result<RunExit<E>, Error<E>> {
	append(log, || {
		RunRecord::Halt(RunHalt {
			reason: Str::from(format!(
				"phase `{}` attempt {attempt} failed in its host",
				phase.name.as_str()
			)),
		})
	})?;
	records.push(PhaseRecord {
		phase: Str::new(phase.name.as_str()),
		attempt,
		status: PhaseStatus::Failed,
		decision: Str::new_static("failed"),
		feedback: Str::default(),
	});
	Ok(failed(records, phase.name.as_str(), attempt, source))
}

fn failed<E: StdError + 'static>(
	records: Vec<PhaseRecord>,
	phase: &str,
	attempt: u32,
	source: E,
) -> RunExit<E> {
	RunExit {
		code: 1,
		status: RunStatus::Failed(PhaseFailure { phase: Str::new(phase), attempt, source }),
		records,
		reason: None,
	}
}

fn cancelled<E: StdError + 'static>(records: Vec<PhaseRecord>) -> RunExit<E> {
	RunExit { code: 130, status: RunStatus::Cancelled, records, reason: None }
}

fn halted<E: StdError + 'static>(records: Vec<PhaseRecord>, reason: Option<Str>) -> RunExit<E> {
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

#[cfg(test)]
mod tests {
	use std::{convert::Infallible, fs, future::ready, path::PathBuf};

	use omp_adw::{ApprovalScope, NetworkScope, WriteScope};
	use omp_ext::workspace_trust::{WorkspaceTrust, inventory::WORKFLOWS_DIR};

	use super::*;

	/// Cancels the run from inside its first dispatch and reports the phase
	/// rejected, as a code phase whose process tree was killed does.
	struct CancelledMidPhase {
		root: PathBuf,
	}

	impl AdwHost for CancelledMidPhase {
		type Error = Infallible;

		fn project_root(&self) -> &Path {
			&self.root
		}

		fn posture(&self) -> Result<Posture, Infallible> {
			Ok(Posture {
				write:    WriteScope::Unconfined,
				network:  NetworkScope::Unrestricted,
				approval: ApprovalScope::Write,
			})
		}

		fn dispatch<'a>(
			&'a self,
			_phase: &'a Phase,
			_spec: &'a PhaseSpec,
			_attempt: u32,
			_correction: Option<&'a Str>,
			_inputs: &'a [SelectedInput],
			cancel: &'a CancellationToken,
		) -> impl Future<Output = Result<PhaseResult, Infallible>> + Send + 'a {
			cancel.cancel();
			ready(Ok(PhaseResult {
				accepted:    false,
				feedback:    Str::new_static("killed"),
				verdict:     None,
				independent: None,
			}))
		}
	}

	#[tokio::test]
	async fn a_phase_cut_short_by_cancellation_settles_the_run_without_a_retry() {
		let project = tempfile::tempdir().expect("project");
		let directory = project.path().join(WORKFLOWS_DIR);
		fs::create_dir_all(&directory).expect("workflow directory");
		fs::write(
			directory.join("slow.toml"),
			"name = \"slow\"\n\n[[phase]]\nname = \"wait\"\nkind = \"code\"\ncommand = [\"sleep\", \
			 \"60\"]\n",
		)
		.expect("workflow file");
		let definition = definition::load(project.path(), "slow").expect("definition");
		let host = CancelledMidPhase { root: project.path().to_path_buf() };

		let exit = run(&definition, 3, &host, &CancellationToken::new())
			.await
			.expect("run");

		assert_eq!(exit.status, RunStatus::Cancelled);
		assert_eq!(exit.code, 130);
		assert!(
			exit.records.is_empty(),
			"a cancelled attempt is not a rejection: {:?}",
			exit.records
		);
	}

	#[derive(Debug, thiserror::Error)]
	#[error("provider rejected the request")]
	struct ProviderFailure;

	/// Host whose first model dispatch ends with the provider's typed error.
	struct ProviderFails {
		root: PathBuf,
	}

	impl AdwHost for ProviderFails {
		type Error = ProviderFailure;

		fn project_root(&self) -> &Path {
			&self.root
		}

		fn posture(&self) -> Result<Posture, ProviderFailure> {
			Ok(Posture {
				write:    WriteScope::Unconfined,
				network:  NetworkScope::Unrestricted,
				approval: ApprovalScope::Write,
			})
		}

		fn dispatch<'a>(
			&'a self,
			_phase: &'a Phase,
			_spec: &'a PhaseSpec,
			_attempt: u32,
			_correction: Option<&'a Str>,
			_inputs: &'a [SelectedInput],
			_cancel: &'a CancellationToken,
		) -> impl Future<Output = Result<PhaseResult, ProviderFailure>> + Send + 'a {
			ready(Err(ProviderFailure))
		}
	}

	#[tokio::test]
	async fn a_provider_failure_settles_as_a_recorded_run_outcome() {
		let project = tempfile::tempdir().expect("project");
		let directory = project.path().join(WORKFLOWS_DIR);
		fs::create_dir_all(&directory).expect("workflow directory");
		fs::write(
			directory.join("plan.toml"),
			"name = \"plan\"\n\n[[phase]]\nname = \"plan\"\nkind = \"agent\"\nprompt = \"Plan it.\"\n",
		)
		.expect("workflow file");
		let definition = definition::load(project.path(), "plan").expect("definition");
		let host = ProviderFails { root: project.path().to_path_buf() };

		let exit = run(&definition, 3, &host, &CancellationToken::new())
			.await
			.expect("provider failure settles as a recorded outcome");

		assert_eq!(exit.code, 1);
		assert_eq!(exit.records, vec![PhaseRecord {
			phase:    Str::new_static("plan"),
			attempt:  1,
			status:   PhaseStatus::Failed,
			decision: Str::new_static("failed"),
			feedback: Str::default(),
		}]);
		assert!(matches!(
			exit.status,
			RunStatus::Failed(PhaseFailure { phase, attempt: 1, source: ProviderFailure })
				if phase == Str::new_static("plan")
		));
	}

	#[derive(Debug, thiserror::Error)]
	#[error("child turn was interrupted")]
	struct CancelledHostError;

	/// Host whose child reports cancellation as a typed dispatch error.
	struct CancelledWithHostError {
		root: PathBuf,
	}

	impl AdwHost for CancelledWithHostError {
		type Error = CancelledHostError;

		fn project_root(&self) -> &Path {
			&self.root
		}

		fn posture(&self) -> Result<Posture, CancelledHostError> {
			Ok(Posture {
				write:    WriteScope::Unconfined,
				network:  NetworkScope::Unrestricted,
				approval: ApprovalScope::Write,
			})
		}

		fn dispatch<'a>(
			&'a self,
			_phase: &'a Phase,
			_spec: &'a PhaseSpec,
			_attempt: u32,
			_correction: Option<&'a Str>,
			_inputs: &'a [SelectedInput],
			cancel: &'a CancellationToken,
		) -> impl Future<Output = Result<PhaseResult, CancelledHostError>> + Send + 'a {
			cancel.cancel();
			ready(Err(CancelledHostError))
		}
	}

	#[tokio::test]
	async fn a_host_error_after_cancellation_settles_as_cancelled() {
		let project = tempfile::tempdir().expect("project");
		let directory = project.path().join(WORKFLOWS_DIR);
		fs::create_dir_all(&directory).expect("workflow directory");
		fs::write(
			directory.join("plan.toml"),
			"name = \"plan\"\n\n[[phase]]\nname = \"plan\"\nkind = \"agent\"\nprompt = \"Plan it.\"\n",
		)
		.expect("workflow file");
		let definition = definition::load(project.path(), "plan").expect("definition");
		let host = CancelledWithHostError { root: project.path().to_path_buf() };

		let exit = run(&definition, 3, &host, &CancellationToken::new())
			.await
			.expect("cancelled run");

		assert!(matches!(exit.status, RunStatus::Cancelled));
		assert!(exit.records.is_empty());
		assert!(exit.records.is_empty());
	}

	struct RefusesBeforeDispatch {
		root: PathBuf,
	}

	impl AdwHost for RefusesBeforeDispatch {
		type Error = std::io::Error;

		fn project_root(&self) -> &Path {
			&self.root
		}

		fn posture(&self) -> Result<Posture, std::io::Error> {
			Ok(CONFINED)
		}

		fn admit(&self, _phase: &Phase, _spec: &PhaseSpec) -> Result<(), std::io::Error> {
			Err(std::io::Error::other("untrusted workspace"))
		}

		fn dispatch<'a>(
			&'a self,
			_phase: &'a Phase,
			_spec: &'a PhaseSpec,
			_attempt: u32,
			_correction: Option<&'a Str>,
			_inputs: &'a [SelectedInput],
			_cancel: &'a CancellationToken,
		) -> impl Future<Output = Result<PhaseResult, std::io::Error>> + Send + 'a {
			ready(Err(std::io::Error::other("a refused phase was dispatched")))
		}
	}

	#[tokio::test]
	async fn a_phase_refused_before_dispatch_journals_no_dispatch() {
		let (project, definition) = two_phase_project();
		let path = project.path().join("run.oms");
		let mut log = RunLog::create(&path, start(&definition)).expect("create");
		let host = RefusesBeforeDispatch { root: project.path().to_path_buf() };
		let exit = run_with_log(&definition, 2, &host, &CancellationToken::new(), Some(&mut log))
			.await
			.expect("a refusal is a run outcome, not an error");
		assert!(matches!(exit.status, RunStatus::Failed(_)), "{:?}", exit.status);
		assert_eq!(record_kinds(&path), ["start", "halt"], "a refused phase journaled a dispatch");
	}

	/// Reads its own journal from inside the dispatch it authorizes.
	struct ReadsJournalInDispatch {
		root:    PathBuf,
		journal: PathBuf,
	}

	impl AdwHost for ReadsJournalInDispatch {
		type Error = Infallible;

		fn project_root(&self) -> &Path {
			&self.root
		}

		fn posture(&self) -> Result<Posture, Infallible> {
			Ok(CONFINED)
		}

		fn dispatch<'a>(
			&'a self,
			phase: &'a Phase,
			_spec: &'a PhaseSpec,
			attempt: u32,
			_correction: Option<&'a Str>,
			_inputs: &'a [SelectedInput],
			_cancel: &'a CancellationToken,
		) -> impl Future<Output = Result<PhaseResult, Infallible>> + Send + 'a {
			let durable = RunLog::read(&self.journal)
				.expect("read")
				.iter()
				.any(|record| {
					matches!(record, RunRecord::Dispatch(dispatch)
					if dispatch.phase.as_str() == phase.name.as_str() && dispatch.attempt == attempt)
				});
			assert!(durable, "the host ran before its dispatch was journaled");
			ready(Ok(PhaseResult {
				accepted:    true,
				feedback:    Str::default(),
				verdict:     None,
				independent: None,
			}))
		}
	}

	#[tokio::test]
	async fn a_dispatch_is_journaled_before_its_host_runs() {
		let (project, definition) = two_phase_project();
		let path = project.path().join("run.oms");
		let mut log = RunLog::create(&path, start(&definition)).expect("create");
		let host =
			ReadsJournalInDispatch { root: project.path().to_path_buf(), journal: path.clone() };
		let exit = run_with_log(&definition, 2, &host, &CancellationToken::new(), Some(&mut log))
			.await
			.expect("run");
		assert_eq!(exit.status, RunStatus::Accepted);
	}

	#[tokio::test]
	async fn run_journals_dispatch_settle_and_done_in_order() {
		let (project, definition) = two_phase_project();
		let host = Scripted::new(project.path(), CONFINED);
		let path = project.path().join("run.oms");
		let mut log = RunLog::create(&path, start(&definition)).expect("create");
		let exit = run_with_log(&definition, 2, &host, &CancellationToken::new(), Some(&mut log))
			.await
			.expect("run");
		assert_eq!(exit.status, RunStatus::Accepted);
		let kinds: Vec<&str> = RunLog::read(&path)
			.expect("read")
			.iter()
			.map(|record| match record {
				RunRecord::Start(_) => "start",
				RunRecord::Dispatch(_) => "dispatch",
				RunRecord::Settle(_) => "settle",
				RunRecord::Uncertain(_) => "uncertain",
				RunRecord::Halt(_) => "halt",
				RunRecord::Done(_) => "done",
			})
			.collect();
		assert_eq!(kinds, ["start", "dispatch", "settle", "dispatch", "settle", "done"]);
	}

	#[tokio::test]
	async fn resume_continues_without_redispatching_a_settled_phase() {
		let (project, definition) = two_phase_project();
		let path = project.path().join("run.oms");
		let mut log = RunLog::create(&path, start(&definition)).expect("create");
		log.append(&dispatch("build", CONFINED)).expect("dispatch");
		log.append(&settle("build")).expect("settle");
		log.append(&dispatch("review", CONFINED))
			.expect("open dispatch");
		drop(log);

		let (log, records) = RunLog::open(&path, definition.digest()).expect("open");
		let host = Scripted::new(project.path(), CONFINED);
		let exit = resume_from_log(&definition, 2, &host, &CancellationToken::new(), log, &records)
			.await
			.expect("resume");

		assert_eq!(exit.status, RunStatus::Accepted);
		assert_eq!(*host.seen.lock(), [(String::from("review"), 1)]);
		let events = records_to_replay_events(&RunLog::read(&path).expect("read"));
		let mut replayed = Run::new(definition.workflow().clone()).with_max_attempts(2);
		replay(&mut replayed, &events).expect("the resumed journal replays cleanly");
	}

	#[tokio::test]
	async fn resume_halts_on_an_open_dispatch_that_could_have_written() {
		let (project, definition) = two_phase_project();
		let path = project.path().join("run.oms");
		let mut log = RunLog::create(&path, start(&definition)).expect("create");
		log.append(&dispatch("build", UNCONFINED))
			.expect("open dispatch");
		drop(log);

		let (log, records) = RunLog::open(&path, definition.digest()).expect("open");
		let host = Scripted::new(project.path(), UNCONFINED);
		let exit = resume_from_log(&definition, 2, &host, &CancellationToken::new(), log, &records)
			.await
			.expect("resume");

		assert_eq!(exit.status, RunStatus::Halted);
		assert!(host.seen.lock().is_empty(), "an uncertain attempt is never retried");
		let records = RunLog::read(&path).expect("read");
		assert!(matches!(&records[records.len() - 2], RunRecord::Uncertain(u) if u.attempt == 1));
		assert!(matches!(records.last(), Some(RunRecord::Halt(_))));
	}

	#[tokio::test]
	async fn a_cancelled_run_resumes() {
		let (project, definition) = two_phase_project();
		let path = project.path().join("run.oms");
		let mut log = RunLog::create(&path, start(&definition)).expect("create");
		let cancel = CancellationToken::new();
		cancel.cancel();
		let host = Scripted::new(project.path(), CONFINED);
		let exit = run_with_log(&definition, 2, &host, &cancel, Some(&mut log))
			.await
			.expect("run");
		assert_eq!(exit.status, RunStatus::Cancelled);
		drop(log);

		let (log, records) = RunLog::open(&path, definition.digest()).expect("open");
		let exit = resume_from_log(&definition, 2, &host, &CancellationToken::new(), log, &records)
			.await
			.expect("resume");
		assert_eq!(exit.status, RunStatus::Accepted);
	}

	#[tokio::test]
	async fn resuming_a_finished_run_reports_it_without_dispatching() {
		let (project, definition) = two_phase_project();
		let path = project.path().join("run.oms");
		let mut log = RunLog::create(&path, start(&definition)).expect("create");
		let host = Scripted::new(project.path(), CONFINED);
		run_with_log(&definition, 2, &host, &CancellationToken::new(), Some(&mut log))
			.await
			.expect("run");
		drop(log);
		host.seen.lock().clear();

		let (log, records) = RunLog::open(&path, definition.digest()).expect("open");
		let exit = resume_from_log(&definition, 2, &host, &CancellationToken::new(), log, &records)
			.await
			.expect("resuming a finished run is not an error");
		assert_eq!(exit.status, RunStatus::Accepted);
		assert!(host.seen.lock().is_empty());
		assert_eq!(RunLog::read(&path).expect("read").len(), records.len(), "nothing appended");
	}

	#[test]
	fn posture_round_trips_through_its_journal_form() {
		for posture in [CONFINED, UNCONFINED] {
			assert_eq!(parse_posture(&encode_posture(posture)), Some(posture));
		}
		assert_eq!(parse_posture("unreported"), None);
	}

	const CONFINED: Posture = Posture {
		write:    WriteScope::ReadOnly,
		network:  NetworkScope::Disabled,
		approval: ApprovalScope::AlwaysAsk,
	};
	const UNCONFINED: Posture = Posture {
		write:    WriteScope::Unconfined,
		network:  NetworkScope::Unrestricted,
		approval: ApprovalScope::Write,
	};

	/// Accepts every phase and records what it was asked to dispatch.
	struct Scripted {
		root:    PathBuf,
		posture: Posture,
		seen:    std::sync::Arc<parking_lot::Mutex<Vec<(String, u32)>>>,
	}

	impl Scripted {
		fn new(root: &Path, posture: Posture) -> Self {
			Self {
				root: root.to_path_buf(),
				posture,
				seen: std::sync::Arc::new(parking_lot::Mutex::new(Vec::new())),
			}
		}
	}

	impl AdwHost for Scripted {
		type Error = Infallible;

		fn project_root(&self) -> &Path {
			&self.root
		}

		fn posture(&self) -> Result<Posture, Infallible> {
			Ok(self.posture)
		}

		fn dispatch<'a>(
			&'a self,
			phase: &'a Phase,
			_spec: &'a PhaseSpec,
			attempt: u32,
			_correction: Option<&'a Str>,
			_inputs: &'a [SelectedInput],
			_cancel: &'a CancellationToken,
		) -> impl Future<Output = Result<PhaseResult, Infallible>> + Send + 'a {
			self
				.seen
				.lock()
				.push((phase.name.as_str().to_owned(), attempt));
			ready(Ok(PhaseResult {
				accepted:    true,
				feedback:    Str::default(),
				verdict:     None,
				independent: None,
			}))
		}
	}

	fn two_phase_project() -> (tempfile::TempDir, WorkflowDefinition) {
		let project = tempfile::tempdir().expect("project");
		let directory = project.path().join(WORKFLOWS_DIR);
		fs::create_dir_all(&directory).expect("workflow directory");
		fs::write(
			directory.join("flow.toml"),
			"name = \"flow\"\n\n[[phase]]\nname = \"build\"\nkind = \"agent\"\nprompt = \
			 \"b\"\n\n[[phase]]\nname = \"review\"\nkind = \"agent\"\nprompt = \"r\"\ndepends_on = \
			 [\"build\"]\n",
		)
		.expect("workflow file");
		let definition = definition::load(project.path(), "flow").expect("definition");
		(project, definition)
	}

	fn start(definition: &WorkflowDefinition) -> omp_journal::runlog::RunStart {
		omp_journal::runlog::RunStart {
			run:                 Str::new_static("01JADWTEST0000000000000000"),
			workflow:            Str::new_static("flow"),
			workflow_digest:     Str::from(definition.digest()),
			input_digest:        Str::default(),
			max_attempts:        2,
			model:               Str::new_static("default"),
			model_explicit:      false,
			exec_policy:         Str::new_static("local-only"),
			exec_fallback_local: false,
			workspace_trusted:   true,
			workspace_root:      Str::new_static("/project"),
			workspace_head:      None,
			created:             Str::new_static("2026-11-12T00:00:00Z"),
		}
	}

	fn dispatch(phase: &'static str, posture: Posture) -> RunRecord {
		RunRecord::Dispatch(PhaseDispatch {
			phase:    Str::new_static(phase),
			attempt:  1,
			inputs:   Vec::new(),
			executor: Str::new_static("native"),
			posture:  encode_posture(posture),
			effects:  Vec::new(),
		})
	}

	fn settle(phase: &'static str) -> RunRecord {
		RunRecord::Settle(PhaseSettle {
			phase:       Str::new_static(phase),
			attempt:     1,
			status:      SettleStatus::Accepted,
			feedback:    Str::default(),
			verdict:     None,
			independent: None,
		})
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "the host factory is fallible by signature; this test host never fails"
	)]
	fn opened(
		host: Scripted,
		trust: WorkspaceTrust,
	) -> Result<resume::OpenedHost<Scripted>, Infallible> {
		Ok(resume::OpenedHost { host, trust })
	}

	fn resume_request<'a>(
		run: resume::RunRef<'a>,
		project: &'a Path,
		require_trusted: bool,
	) -> resume::ResumeRequest<'a> {
		resume::ResumeRequest { run, project, require_trusted, approval_ceiling: None }
	}

	#[tokio::test]
	async fn adw_resume_refuses_an_invalid_or_unknown_run_id_before_any_host_opens() {
		let (project, _definition) = two_phase_project();
		let runs = project.path().join("runs");
		fs::create_dir_all(&runs).expect("runs directory");
		let cancel = CancellationToken::new();
		let reached = std::cell::Cell::new(false);

		let invalid = resume::resume(
			resume_request(
				resume::RunRef::Id { runs_dir: &runs, id: "../escape" },
				project.path(),
				false,
			),
			|_| {
				reached.set(true);
				opened(Scripted::new(project.path(), CONFINED), WorkspaceTrust::Trusted)
			},
			&cancel,
		)
		.await;
		assert!(matches!(invalid, Err(resume::ResumeError::InvalidRunId(_))), "{invalid:?}");

		let unknown = resume::resume(
			resume_request(
				resume::RunRef::Id { runs_dir: &runs, id: "01JMISSING0000000000000000" },
				project.path(),
				false,
			),
			|_| {
				reached.set(true);
				opened(Scripted::new(project.path(), CONFINED), WorkspaceTrust::Trusted)
			},
			&cancel,
		)
		.await;
		assert!(matches!(unknown, Err(resume::ResumeError::UnknownRun { .. })), "{unknown:?}");
		assert!(!reached.get(), "a refused run id opens no host");
	}

	#[tokio::test]
	async fn adw_resume_reports_a_finished_run_without_dispatching() {
		let (project, definition) = two_phase_project();
		let runs = project.path().join("runs");
		fs::create_dir_all(&runs).expect("runs directory");
		let id = "01JADWTEST0000000000000000";
		let journal = runs.join(format!("{id}.oms"));
		let mut log = RunLog::create(&journal, start(&definition)).expect("create");
		run_with_log(
			&definition,
			2,
			&Scripted::new(project.path(), CONFINED),
			&CancellationToken::new(),
			Some(&mut log),
		)
		.await
		.expect("run");
		drop(log);
		let recorded = RunLog::read(&journal).expect("read").len();

		let host = Scripted::new(project.path(), CONFINED);
		let seen = std::sync::Arc::clone(&host.seen);
		let outcome = resume::resume(
			resume_request(resume::RunRef::Id { runs_dir: &runs, id }, project.path(), true),
			|_| opened(host, WorkspaceTrust::Trusted),
			&CancellationToken::new(),
		)
		.await
		.expect("a finished run is not an error");
		assert!(
			matches!(outcome, resume::ResumeOutcome::Finished { accepted: true, .. }),
			"{outcome:?}"
		);
		assert!(seen.lock().is_empty(), "a finished run dispatches nothing");
		assert_eq!(RunLog::read(&journal).expect("read").len(), recorded, "nothing is appended");
	}

	#[tokio::test]
	async fn adw_resume_refuses_an_untrusted_workspace_before_any_phase_dispatches() {
		let (project, definition) = two_phase_project();
		let runs = project.path().join("runs");
		fs::create_dir_all(&runs).expect("runs directory");
		let id = "01JADWTEST0000000000000000";
		let journal = runs.join(format!("{id}.oms"));
		drop(RunLog::create(&journal, start(&definition)).expect("create"));
		let recorded = RunLog::read(&journal).expect("read").len();

		let host = Scripted::new(project.path(), CONFINED);
		let seen = std::sync::Arc::clone(&host.seen);
		let refused = resume::resume(
			resume_request(resume::RunRef::Id { runs_dir: &runs, id }, project.path(), true),
			|_| opened(host, WorkspaceTrust::Untrusted),
			&CancellationToken::new(),
		)
		.await;
		assert!(matches!(refused, Err(resume::ResumeError::UntrustedWorkspace)), "{refused:?}");
		assert!(seen.lock().is_empty(), "no phase dispatches in an untrusted workspace");
		assert_eq!(RunLog::read(&journal).expect("read").len(), recorded, "nothing is appended");
	}

	#[tokio::test]
	async fn adw_resume_continues_a_halted_run_through_the_shared_path() {
		let (project, definition) = two_phase_project();
		let runs = project.path().join("runs");
		fs::create_dir_all(&runs).expect("runs directory");
		let id = "01JADWTEST0000000000000000";
		let journal = runs.join(format!("{id}.oms"));
		let mut log = RunLog::create(&journal, start(&definition)).expect("create");
		log.append(&dispatch("build", CONFINED)).expect("dispatch");
		log.append(&settle("build")).expect("settle");
		log.append(&RunRecord::Halt(RunHalt { reason: Str::new_static("stopped by the operator") }))
			.expect("halt");
		drop(log);

		let host = Scripted::new(project.path(), CONFINED);
		let seen = std::sync::Arc::clone(&host.seen);
		let outcome = resume::resume(
			resume_request(resume::RunRef::Id { runs_dir: &runs, id }, project.path(), true),
			|_| opened(host, WorkspaceTrust::Trusted),
			&CancellationToken::new(),
		)
		.await
		.expect("the halted run resumes");
		let exit = match outcome {
			resume::ResumeOutcome::Resumed { exit, .. } => exit,
			other => panic!("the halted run was not resumed: {other:?}"),
		};
		assert_eq!(exit.status, RunStatus::Accepted);
		assert_eq!(*seen.lock(), [(String::from("review"), 1)]);
		let events = records_to_replay_events(&RunLog::read(&journal).expect("read"));
		let mut replayed = Run::new(definition.workflow().clone()).with_max_attempts(2);
		replay(&mut replayed, &events).expect("the resumed journal replays cleanly");
	}

	#[tokio::test]
	async fn adw_resume_refuses_host_approval_above_the_request_ceiling() {
		let (project, definition) = two_phase_project();
		let runs = project.path().join("runs");
		fs::create_dir_all(&runs).expect("runs directory");
		let id = "01JADWTEST0000000000000000";
		let journal = runs.join(format!("{id}.oms"));
		drop(RunLog::create(&journal, start(&definition)).expect("create"));
		let recorded = RunLog::read(&journal).expect("read").len();

		let host = Scripted::new(project.path(), UNCONFINED);
		let seen = std::sync::Arc::clone(&host.seen);
		let mut request =
			resume_request(resume::RunRef::Id { runs_dir: &runs, id }, project.path(), true);
		request.approval_ceiling = Some(ApprovalScope::AlwaysAsk);
		let refused = resume::resume(
			request,
			|_| opened(host, WorkspaceTrust::Trusted),
			&CancellationToken::new(),
		)
		.await;
		assert!(
			matches!(
				refused,
				Err(resume::ResumeError::ApprovalExceedsCeiling {
					host:    ApprovalScope::Write,
					ceiling: ApprovalScope::AlwaysAsk,
				})
			),
			"{refused:?}"
		);
		assert!(seen.lock().is_empty(), "the refused host dispatches nothing");
		assert_eq!(RunLog::read(&journal).expect("read").len(), recorded, "nothing is appended");

		let host = Scripted::new(project.path(), CONFINED);
		let mut request =
			resume_request(resume::RunRef::Id { runs_dir: &runs, id }, project.path(), true);
		request.approval_ceiling = Some(ApprovalScope::Write);
		let allowed = resume::resume(
			request,
			|_| opened(host, WorkspaceTrust::Trusted),
			&CancellationToken::new(),
		)
		.await
		.expect("approval within the ceiling resumes");
		assert!(matches!(allowed, resume::ResumeOutcome::Resumed { .. }), "{allowed:?}");
	}

	/// Cancels the run from inside its first dispatch and reports the phase
	/// killed, under a posture with no possible effects so the attempt can be
	/// dispatched again.
	struct CancelOnFirstDispatch {
		root: PathBuf,
	}

	impl AdwHost for CancelOnFirstDispatch {
		type Error = Infallible;

		fn project_root(&self) -> &Path {
			&self.root
		}

		fn posture(&self) -> Result<Posture, Infallible> {
			Ok(CONFINED)
		}

		fn dispatch<'a>(
			&'a self,
			_phase: &'a Phase,
			_spec: &'a PhaseSpec,
			_attempt: u32,
			_correction: Option<&'a Str>,
			_inputs: &'a [SelectedInput],
			cancel: &'a CancellationToken,
		) -> impl Future<Output = Result<PhaseResult, Infallible>> + Send + 'a {
			cancel.cancel();
			ready(Ok(PhaseResult {
				accepted:    false,
				feedback:    Str::new_static("killed"),
				verdict:     None,
				independent: None,
			}))
		}
	}

	/// The journal's record kinds, in order.
	fn record_kinds(path: &Path) -> Vec<&'static str> {
		RunLog::read(path)
			.expect("read")
			.iter()
			.map(|record| match record {
				RunRecord::Start(_) => "start",
				RunRecord::Dispatch(_) => "dispatch",
				RunRecord::Settle(_) => "settle",
				RunRecord::Uncertain(_) => "uncertain",
				RunRecord::Halt(_) => "halt",
				RunRecord::Done(_) => "done",
			})
			.collect()
	}

	#[tokio::test]
	async fn adw_resume_cancelled_before_dispatch_dispatches_nothing_and_resumes_later() {
		let (project, definition) = two_phase_project();
		let runs = project.path().join("runs");
		fs::create_dir_all(&runs).expect("runs directory");
		let id = "01JADWTEST0000000000000000";
		let journal = runs.join(format!("{id}.oms"));
		drop(RunLog::create(&journal, start(&definition)).expect("create"));

		let cancelled = CancellationToken::new();
		cancelled.cancel();
		let host = Scripted::new(project.path(), CONFINED);
		let seen = std::sync::Arc::clone(&host.seen);
		let outcome = resume::resume(
			resume_request(resume::RunRef::Id { runs_dir: &runs, id }, project.path(), true),
			|_| opened(host, WorkspaceTrust::Trusted),
			&cancelled,
		)
		.await
		.expect("a cancelled resume is not an error");
		let (exit, cancelled) = match outcome {
			resume::ResumeOutcome::Resumed { exit, cancelled, .. } => (exit, cancelled),
			other => panic!("the resume was not started: {other:?}"),
		};
		assert_eq!(exit.status, RunStatus::Cancelled);
		assert_eq!(cancelled, Some(resume::CancelledAt::BeforeAnyPhase));
		assert!(seen.lock().is_empty(), "a cancelled resume dispatches nothing");
		assert_eq!(record_kinds(&journal), ["start", "halt"], "nothing but the halt is appended");

		let host = Scripted::new(project.path(), CONFINED);
		let seen = std::sync::Arc::clone(&host.seen);
		let outcome = resume::resume(
			resume_request(resume::RunRef::Id { runs_dir: &runs, id }, project.path(), true),
			|_| opened(host, WorkspaceTrust::Trusted),
			&CancellationToken::new(),
		)
		.await
		.expect("the cancelled log resumes");
		let exit = match outcome {
			resume::ResumeOutcome::Resumed { exit, .. } => exit,
			other => panic!("the resume was not started: {other:?}"),
		};
		assert_eq!(exit.status, RunStatus::Accepted);
		assert_eq!(*seen.lock(), [(String::from("build"), 1), (String::from("review"), 1)]);
	}

	#[tokio::test]
	async fn adw_resume_cancelled_mid_phase_dispatches_no_further_phase() {
		let (project, definition) = two_phase_project();
		let runs = project.path().join("runs");
		fs::create_dir_all(&runs).expect("runs directory");
		let id = "01JADWTEST0000000000000000";
		let journal = runs.join(format!("{id}.oms"));
		drop(RunLog::create(&journal, start(&definition)).expect("create"));

		let host = CancelOnFirstDispatch { root: project.path().to_path_buf() };
		let outcome = resume::resume(
			resume_request(resume::RunRef::Id { runs_dir: &runs, id }, project.path(), true),
			|_| Ok::<_, Infallible>(resume::OpenedHost { host, trust: WorkspaceTrust::Trusted }),
			&CancellationToken::new(),
		)
		.await
		.expect("a cancelled resume is not an error");
		let (exit, cancelled) = match outcome {
			resume::ResumeOutcome::Resumed { exit, cancelled, .. } => (exit, cancelled),
			other => panic!("the resume was not started: {other:?}"),
		};
		assert_eq!(exit.status, RunStatus::Cancelled);
		assert_eq!(
			cancelled,
			Some(resume::CancelledAt::Interrupted {
				phase:            Str::new_static("build"),
				attempt:          1,
				may_have_effects: true,
			})
		);
		assert_eq!(
			record_kinds(&journal),
			["start", "dispatch", "halt"],
			"the cancelled build stays in flight; review is never dispatched"
		);
	}
}
