//! The run state machine: dispatch, acceptance, rejection, and invalidation.

use std::sync::Arc;

use omp_core::{FastHashSet, Str};
use serde::Serialize;
use smallvec::SmallVec;

use crate::{
	profile::{Posture, PostureError},
	workflow::{OnReject, Phase, PhaseName, Workflow},
};

/// Attempts a phase may consume before the run halts.
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;

/// One resolved input on a dispatch.
///
/// Records which producer and which acceptance ordinal an attempt consumed. The
/// version is what makes a step auditable: "which evidence did this attempt
/// see" has exactly one answer, and it survives the producer being superseded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SelectedInput {
	/// The producing phase.
	pub phase:   PhaseName,
	/// 1-based acceptance ordinal of the producer's output.
	pub version: u32,
}

/// What the caller should do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
	/// Dispatch this phase.
	Run {
		/// The phase to dispatch.
		///
		/// Shared rather than cloned: the declaration already lives in the
		/// workflow, and a dispatch only needs to name it.
		phase:      Arc<Phase>,
		/// 1-based attempt ordinal; `> 1` means a prior attempt was rejected.
		attempt:    u32,
		/// Verbatim feedback from the rejection that caused this retry.
		///
		/// The engine does not require the caller to reuse the rejected
		/// attempt's session, so this is the only record of what was wrong.
		correction: Option<Str>,
		/// Declared inputs resolved to the versions accepted right now.
		inputs:     SmallVec<SelectedInput, 2>,
	},
	/// Work is in flight but nothing else is ready. Not a terminal state.
	Wait,
	/// A phase declared a posture the host did not meet, so the run stopped.
	///
	/// Terminal. A requirement that degrades into a warning is not a
	/// requirement, so the run halts rather than dispatching unconfined work.
	Blocked {
		/// Why the phase could not dispatch.
		error: PostureError,
	},
	/// The run is over.
	Done {
		/// Whether every phase was accepted.
		accepted: bool,
	},
}

// LOCKED: `Run` carries its phase by handle. Inlining the 152-byte declaration
// instead made every dispatch copy it.
const _: () = assert!(size_of::<Step>() <= 120, "Step must stay compact");

/// What the run decided about a reported result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
	/// The phase was accepted and its output published at `version`.
	Accepted {
		/// The accepted phase.
		phase:       PhaseName,
		/// The 1-based acceptance ordinal now standing for this phase.
		version:     u32,
		/// Consumers whose accepted output this acceptance superseded.
		invalidated: SmallVec<PhaseName, 2>,
	},
	/// The phase will be retried.
	Retried {
		/// The phase to retry.
		phase:   PhaseName,
		/// The attempt ordinal the retry will use.
		attempt: u32,
	},
	/// The run rewound to an upstream phase.
	Rewound {
		/// The phase the run rewound to.
		phase:       PhaseName,
		/// Phases whose acceptance the rewind invalidated.
		invalidated: SmallVec<PhaseName, 2>,
	},
	/// The run halted.
	Halted {
		/// The phase whose rejection halted the run.
		phase: PhaseName,
	},
}

/// A transition the run could not make.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RunError {
	/// A result was reported for a phase that is not currently dispatched.
	#[error("phase is not running")]
	NotRunning {
		/// The phase named in the report.
		phase: PhaseName,
	},
	/// A result was reported for a phase the workflow does not declare.
	#[error("phase is not declared by this workflow")]
	UnknownPhase {
		/// The undeclared name.
		phase: PhaseName,
	},
	/// The attempt consumed a producer version that no longer stands.
	#[error("attempt consumed a superseded producer version")]
	StaleEvidence {
		/// The phase whose acceptance was refused.
		phase:    PhaseName,
		/// The producer whose version moved.
		producer: PhaseName,
		/// The version the attempt was dispatched against.
		consumed: u32,
		/// The version standing now, if the producer has one.
		standing: Option<u32>,
	},
}

/// Where a phase stands in the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Status {
	/// Not yet dispatched, or invalidated back to the queue.
	#[default]
	Pending,
	/// Dispatched and awaiting a result.
	Running,
	/// Accepted.
	Passed,
}

#[derive(Debug, Default)]
struct PhaseState {
	/// Producer versions the in-flight attempt was dispatched against.
	///
	/// Kept so acceptance can confirm they still stand. An attempt that read
	/// v1 while the producer republished v2 built on evidence that no longer
	/// holds, and accepting it would launder a stale result into the record.
	consumed:   SmallVec<SelectedInput, 2>,
	status:     Status,
	/// Completed attempts. An interrupted dispatch reuses its ordinal.
	attempts:   u32,
	/// Extra attempts granted by a rewind, above `max_attempts`.
	granted:    u32,
	correction: Option<Str>,
	/// Acceptance ordinal currently standing, and the total ever accepted.
	///
	/// The total never decrements: a superseded version's ordinal is history,
	/// so a re-accepted phase publishes a *new* number rather than reusing one
	/// a consumer may already have recorded.
	accepted:   u32,
	published:  Option<u32>,
}

/// A workflow execution.
///
/// Pure: every transition is a total function of recorded facts. No I/O, no
/// clock, no spawning. A caller dispatches what [`Run::next_step`] returns,
/// observes the effects through the systems that own them, and reports the
/// outcome back through [`Run::accept`] or [`Run::reject`].
#[derive(Debug)]
pub struct Run {
	workflow:     Workflow,
	max_attempts: u32,
	states:       Vec<PhaseState>,
	/// The posture the host resolved, once it has reported one.
	///
	/// `None` means unreported, which is not the same as permissive: a phase
	/// that declares a requirement cannot dispatch against an unknown posture,
	/// because "we never checked" must not read as "it passed".
	posture:      Option<Posture>,
	halted:       bool,
}

impl Run {
	/// Starts a run of `workflow` with the default attempt budget.
	pub fn new(workflow: Workflow) -> Self {
		let states = (0..workflow.phases().len())
			.map(|_| PhaseState::default())
			.collect();
		Self { workflow, max_attempts: DEFAULT_MAX_ATTEMPTS, states, posture: None, halted: false }
	}

	/// Sets the per-phase attempt budget, clamped to at least one.
	#[must_use]
	pub const fn with_max_attempts(mut self, attempts: u32) -> Self {
		self.max_attempts = if attempts > 1 { attempts } else { 1 };
		self
	}

	/// Records the execution posture the host resolved for this run.
	#[must_use]
	pub const fn with_posture(mut self, posture: Posture) -> Self {
		self.posture = Some(posture);
		self
	}

	/// The workflow being run.
	#[inline]
	pub const fn workflow(&self) -> &Workflow {
		&self.workflow
	}

	/// The next phase ready to dispatch, or why there is none.
	///
	/// Marks the returned phase `Running`; a second call will not hand out the
	/// same phase again until its result is reported. Phases are considered in
	/// dependency order, so the first ready phase is also the earliest-declared
	/// one that can run.
	pub fn next_step(&mut self) -> Step {
		if self.halted {
			return Step::Done { accepted: false };
		}

		let ready = self
			.workflow
			.phases()
			.iter()
			.enumerate()
			.position(|(index, phase)| {
				self.states[index].status == Status::Pending && self.is_satisfied(phase)
			});

		let Some(index) = ready else {
			return if self
				.states
				.iter()
				.any(|state| state.status == Status::Running)
			{
				Step::Wait
			} else {
				Step::Done { accepted: self.states.iter().all(|s| s.status == Status::Passed) }
			};
		};
		let phase = self.workflow.phases()[index].clone();
		if !phase.requires.is_empty() {
			let blocked = match self.posture {
				Some(posture) => phase.requires.check(&phase.name, &posture).err(),
				// A declared requirement against an unreported posture is
				// unverifiable, and unverifiable is not the same as satisfied.
				None => Some(PostureError::Unreported { phase: phase.name.clone() }),
			};
			if let Some(error) = blocked {
				self.halted = true;
				return Step::Blocked { error };
			}
		}

		let inputs = self.resolve_inputs(&phase);
		let state = &mut self.states[index];
		state.status = Status::Running;
		state.consumed.clone_from(&inputs);

		Step::Run { phase, attempt: state.attempts + 1, correction: state.correction.clone(), inputs }
	}

	/// Records acceptance of a running phase, publishing a new version.
	///
	/// Re-accepting a phase invalidates every consumer that recorded the prior
	/// version: their evidence is stale by construction, so they return to the
	/// queue rather than standing on a version that no longer holds.
	///
	/// # Errors
	///
	/// Returns [`RunError`] when the phase is undeclared, not dispatched, or
	/// consumed a producer version that has since been superseded.
	pub fn accept(&mut self, phase: &PhaseName<str>) -> Result<Outcome, RunError> {
		let index = self.running_index(phase)?;
		self.revalidate_consumed(index)?;

		let state = &mut self.states[index];
		state.status = Status::Passed;
		state.attempts += 1;
		state.correction = None;
		state.accepted += 1;
		let version = state.accepted;
		state.published = Some(version);
		state.consumed = SmallVec::new();

		let name = self.workflow.phases()[index].name.clone();
		let invalidated = self.invalidate_dependents(&name);
		Ok(Outcome::Accepted { phase: name, version, invalidated })
	}

	/// Confirms every version the in-flight attempt consumed still stands.
	fn revalidate_consumed(&self, index: usize) -> Result<(), RunError> {
		for input in &self.states[index].consumed {
			let standing = self
				.workflow
				.position(&input.phase)
				.and_then(|producer| self.states[producer].published);
			if standing != Some(input.version) {
				return Err(RunError::StaleEvidence {
					phase: self.workflow.phases()[index].name.clone(),
					producer: input.phase.clone(),
					consumed: input.version,
					standing,
				});
			}
		}
		Ok(())
	}

	/// Records rejection of a running phase and routes it.
	///
	/// # Errors
	///
	/// Returns [`RunError`] when the phase is undeclared or not dispatched.
	pub fn reject(
		&mut self,
		phase: &PhaseName<str>,
		correction: impl Into<Str>,
	) -> Result<Outcome, RunError> {
		let index = self.running_index(phase)?;
		let correction = correction.into();
		let name = self.workflow.phases()[index].name.clone();
		let route = self.workflow.phases()[index].on_reject;

		let state = &mut self.states[index];
		state.attempts += 1;
		state.status = Status::Pending;

		match route {
			OnReject::Halt => {
				self.halted = true;
				Ok(Outcome::Halted { phase: name })
			},
			OnReject::Retry => {
				let budget = self.max_attempts + self.states[index].granted;
				if self.states[index].attempts >= budget {
					self.halted = true;
					return Ok(Outcome::Halted { phase: name });
				}
				let state = &mut self.states[index];
				state.correction = Some(correction);
				Ok(Outcome::Retried { phase: name, attempt: state.attempts + 1 })
			},
			OnReject::Correct => {
				let Some(target) = self.rewind_target(index) else {
					self.halted = true;
					return Ok(Outcome::Halted { phase: name });
				};
				let target_name = self.workflow.phases()[target].name.clone();
				let state = &mut self.states[target];
				state.status = Status::Pending;
				state.correction = Some(correction);
				// The rewind is the reviewer's decision, not the producer's
				// failure: granting an attempt keeps a correction route from
				// silently consuming the producer's own retry budget.
				state.granted += 1;
				state.published = None;

				let mut invalidated = self.invalidate_dependents(&target_name);
				invalidated.push(target_name.clone());
				Ok(Outcome::Rewound { phase: target_name, invalidated })
			},
		}
	}

	/// Whether every declared phase is accepted.
	#[inline]
	pub fn is_accepted(&self) -> bool {
		!self.halted
			&& self
				.states
				.iter()
				.all(|state| state.status == Status::Passed)
	}

	/// Whether the run stopped without accepting.
	#[inline]
	pub const fn is_halted(&self) -> bool {
		self.halted
	}

	/// The version currently standing for a phase, if it has one.
	pub fn published_version(&self, phase: &PhaseName<str>) -> Option<u32> {
		let index = self.workflow.position(phase)?;
		self.states[index].published
	}

	fn running_index(&self, phase: &PhaseName<str>) -> Result<usize, RunError> {
		let index = self
			.workflow
			.position(phase)
			.ok_or_else(|| RunError::UnknownPhase { phase: phase.to_owned() })?;
		if self.states[index].status == Status::Running {
			Ok(index)
		} else {
			Err(RunError::NotRunning { phase: phase.to_owned() })
		}
	}

	fn is_satisfied(&self, phase: &Phase) -> bool {
		phase.required().all(|name| {
			self
				.workflow
				.position(name)
				.is_some_and(|index| self.states[index].status == Status::Passed)
		})
	}

	fn resolve_inputs(&self, phase: &Phase) -> SmallVec<SelectedInput, 2> {
		phase
			.inputs
			.iter()
			.filter_map(|name| {
				let index = self.workflow.position(name)?;
				let version = self.states[index].published?;
				Some(SelectedInput { phase: name.clone(), version })
			})
			.collect()
	}

	/// Returns every transitive consumer of `name` to the pending queue.
	fn invalidate_dependents(&mut self, name: &PhaseName<str>) -> SmallVec<PhaseName, 2> {
		let mut invalidated = SmallVec::new();
		let mut frontier: Vec<PhaseName> = vec![name.to_owned()];
		let mut seen = FastHashSet::default();

		while let Some(current) = frontier.pop() {
			let consumers: Vec<PhaseName> = self
				.workflow
				.dependents(&current)
				.map(|phase| phase.name.clone())
				.collect();

			for consumer in consumers {
				let Some(index) = self.workflow.position(&consumer) else {
					continue;
				};
				// Only a phase that actually reached acceptance carries stale
				// evidence; one still queued has nothing to invalidate.
				if self.states[index].status != Status::Passed {
					continue;
				}
				if !seen.insert(consumer.clone()) {
					continue;
				}
				self.states[index].status = Status::Pending;
				self.states[index].published = None;
				invalidated.push(consumer.clone());
				frontier.push(consumer);
			}
		}

		invalidated
	}

	/// The nearest upstream phase a correction should rewind to.
	fn rewind_target(&self, from: usize) -> Option<usize> {
		let phase = &self.workflow.phases()[from];
		phase
			.inputs
			.iter()
			.chain(phase.depends_on.iter().flat_map(|names| names.iter()))
			.filter_map(|name| self.workflow.position(name))
			.next_back()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::workflow::{PhaseKind, WorkflowName};

	fn agent(name: &str) -> Phase {
		Phase::new(PhaseName::new(name), PhaseKind::Agent)
	}

	fn run_of(phases: Vec<Phase>) -> Run {
		Run::new(Workflow::new(WorkflowName::new("w"), phases).expect("valid workflow"))
	}

	fn dispatch(run: &mut Run) -> (PhaseName, u32) {
		match run.next_step() {
			Step::Run { phase, attempt, .. } => (phase.name.clone(), attempt),
			other => panic!("expected a dispatch, got {other:?}"),
		}
	}
	mod posture {
		use super::*;
		use crate::profile::{ApprovalScope, NetworkScope, Requirement, WriteScope};

		const UNCONFINED: Posture = Posture {
			write:    WriteScope::Unconfined,
			network:  NetworkScope::Unrestricted,
			approval: ApprovalScope::Yolo,
		};

		fn reviewer() -> Phase {
			agent("review").requiring(Requirement::default().writing(WriteScope::ReadOnly))
		}

		#[test]
		fn blocks_a_phase_whose_requirement_the_host_cannot_meet() {
			let mut run = run_of(vec![reviewer()]).with_posture(UNCONFINED);

			let Step::Blocked { error } = run.next_step() else {
				panic!("a read-only phase must not dispatch against an unconfined host");
			};
			assert!(matches!(error, PostureError::Write { .. }), "unexpected block reason: {error}");
		}

		#[test]
		fn a_blocked_run_does_not_report_acceptance() {
			let mut run = run_of(vec![reviewer()]).with_posture(UNCONFINED);
			run.next_step();

			assert!(!run.is_accepted(), "a run stopped by an unmet requirement was never accepted");
			assert_eq!(run.next_step(), Step::Done { accepted: false });
		}

		#[test]
		fn blocks_when_the_host_reported_no_posture_at_all() {
			let mut run = run_of(vec![reviewer()]);

			let Step::Blocked { error } = run.next_step() else {
				panic!("an unverifiable requirement must block, not pass by default");
			};
			assert_eq!(error, PostureError::Unreported { phase: PhaseName::new("review") });
		}

		#[test]
		fn dispatches_when_the_host_meets_the_requirement() {
			let mut run = run_of(vec![reviewer()]).with_posture(Posture {
				write:    WriteScope::ReadOnly,
				network:  NetworkScope::Disabled,
				approval: ApprovalScope::AlwaysAsk,
			});

			assert!(
				matches!(run.next_step(), Step::Run { .. }),
				"a satisfied requirement must not stand in the way of dispatch"
			);
		}

		#[test]
		fn a_phase_without_requirements_dispatches_against_any_posture() {
			let mut run = run_of(vec![agent("build")]).with_posture(UNCONFINED);

			assert!(
				matches!(run.next_step(), Step::Run { .. }),
				"an undeclared posture must inherit the operator's, not block"
			);
		}
	}

	mod next_step {
		use super::*;

		#[test]
		fn blocks_a_phase_until_its_dependency_is_accepted() {
			let mut run = run_of(vec![agent("plan"), agent("build")]);

			let (first, _) = dispatch(&mut run);
			assert_eq!(first.as_str(), "plan");
			assert_eq!(
				run.next_step(),
				Step::Wait,
				"build depends on plan, so nothing else may dispatch while plan is in flight"
			);
		}

		#[test]
		fn dispatches_independent_phases_concurrently() {
			let mut run =
				run_of(vec![agent("left").depending_on([]), agent("right").depending_on([])]);

			let (first, _) = dispatch(&mut run);
			let (second, _) = dispatch(&mut run);

			assert_eq!(
				[first.as_str(), second.as_str()],
				["left", "right"],
				"independent phases must both be dispatchable without waiting"
			);
		}

		#[test]
		fn reports_accepted_when_every_phase_passed() {
			let mut run = run_of(vec![agent("only")]);
			dispatch(&mut run);
			run.accept(PhaseName::from_ref("only"))
				.expect("running phase");

			assert_eq!(run.next_step(), Step::Done { accepted: true });
		}

		#[test]
		fn carries_the_correction_into_the_retry() {
			let mut run = run_of(vec![agent("only")]);
			dispatch(&mut run);
			run.reject(PhaseName::from_ref("only"), "missing the error path")
				.expect("running");

			let Step::Run { correction, attempt, .. } = run.next_step() else {
				panic!("a retried phase must dispatch again");
			};
			assert_eq!(attempt, 2);
			assert_eq!(
				correction.as_deref(),
				Some("missing the error path"),
				"the retry must carry the rejection feedback verbatim"
			);
		}

		#[test]
		fn resolves_declared_inputs_to_accepted_versions() {
			let mut run = run_of(vec![
				agent("producer").depending_on([]),
				agent("consumer")
					.depending_on([])
					.consuming([PhaseName::new("producer")]),
			]);

			dispatch(&mut run);
			run.accept(PhaseName::from_ref("producer"))
				.expect("running phase");

			let Step::Run { inputs, .. } = run.next_step() else {
				panic!("consumer must dispatch once its producer is accepted");
			};
			assert_eq!(
				inputs.as_slice(),
				[SelectedInput { phase: PhaseName::new("producer"), version: 1 }],
				"a dispatch must record which producer version it consumed"
			);
		}
	}

	mod accept {
		use super::*;

		#[test]
		fn republishing_a_producer_invalidates_its_consumer() {
			let mut run = run_of(vec![
				agent("producer").depending_on([]),
				agent("consumer")
					.depending_on([])
					.consuming([PhaseName::new("producer")]),
			]);

			dispatch(&mut run);
			run.accept(PhaseName::from_ref("producer"))
				.expect("running phase");
			dispatch(&mut run);
			run.accept(PhaseName::from_ref("consumer"))
				.expect("running phase");

			// The producer runs again — a rewind, a correction, a re-review.
			run.states[0].status = Status::Running;
			let outcome = run
				.accept(PhaseName::from_ref("producer"))
				.expect("running phase");

			let Outcome::Accepted { version, invalidated, .. } = outcome else {
				panic!("expected acceptance");
			};
			assert_eq!(version, 2, "a re-accepted phase must publish a new ordinal, never reuse one");
			assert_eq!(
				invalidated.as_slice(),
				[PhaseName::new("consumer")],
				"a consumer holding the superseded version must be invalidated"
			);
		}

		#[test]
		fn invalidated_consumer_reruns_against_the_new_version() {
			let mut run = run_of(vec![
				agent("producer").depending_on([]),
				agent("consumer")
					.depending_on([])
					.consuming([PhaseName::new("producer")]),
			]);

			dispatch(&mut run);
			run.accept(PhaseName::from_ref("producer"))
				.expect("running phase");
			dispatch(&mut run);
			run.accept(PhaseName::from_ref("consumer"))
				.expect("running phase");

			run.states[0].status = Status::Running;
			run.accept(PhaseName::from_ref("producer"))
				.expect("running phase");

			let Step::Run { inputs, .. } = run.next_step() else {
				panic!("the invalidated consumer must dispatch again");
			};
			assert_eq!(
				inputs.as_slice(),
				[SelectedInput { phase: PhaseName::new("producer"), version: 2 }],
				"the rerun must consume the new version, not the superseded one"
			);
		}

		#[test]
		fn rejects_a_phase_that_is_not_running() {
			let mut run = run_of(vec![agent("only")]);

			let error = run
				.accept(PhaseName::from_ref("only"))
				.expect_err("never dispatched");

			assert_eq!(error, RunError::NotRunning { phase: PhaseName::new("only") });
		}

		#[test]
		fn refuses_an_attempt_that_consumed_a_superseded_version() {
			let mut run = run_of(vec![
				agent("producer").depending_on([]),
				agent("consumer")
					.depending_on([])
					.consuming([PhaseName::new("producer")]),
			]);

			dispatch(&mut run);
			run.accept(PhaseName::from_ref("producer"))
				.expect("running phase");
			// The consumer starts against v1 and is still in flight.
			dispatch(&mut run);

			// The producer republishes underneath it.
			run.states[0].status = Status::Running;
			run.accept(PhaseName::from_ref("producer"))
				.expect("running phase");
			run.states[1].status = Status::Running;

			let error = run
				.accept(PhaseName::from_ref("consumer"))
				.expect_err("the attempt read evidence that no longer stands");

			assert_eq!(error, RunError::StaleEvidence {
				phase:    PhaseName::new("consumer"),
				producer: PhaseName::new("producer"),
				consumed: 1,
				standing: Some(2),
			});
		}

		#[test]
		fn accepts_an_attempt_whose_evidence_still_stands() {
			let mut run = run_of(vec![
				agent("producer").depending_on([]),
				agent("consumer")
					.depending_on([])
					.consuming([PhaseName::new("producer")]),
			]);

			dispatch(&mut run);
			run.accept(PhaseName::from_ref("producer"))
				.expect("running phase");
			dispatch(&mut run);

			assert!(
				run.accept(PhaseName::from_ref("consumer")).is_ok(),
				"unchanged evidence must not stand in the way of acceptance"
			);
		}

		#[test]
		fn rejects_an_undeclared_phase() {
			let mut run = run_of(vec![agent("only")]);

			let error = run
				.accept(PhaseName::from_ref("ghost"))
				.expect_err("not in the workflow");

			assert_eq!(error, RunError::UnknownPhase { phase: PhaseName::new("ghost") });
		}
	}

	mod reject {
		use super::*;

		#[test]
		fn halts_once_the_attempt_budget_is_spent() {
			let mut run = run_of(vec![agent("only")]).with_max_attempts(2);

			dispatch(&mut run);
			run.reject(PhaseName::from_ref("only"), "first")
				.expect("running phase");
			dispatch(&mut run);
			let outcome = run
				.reject(PhaseName::from_ref("only"), "second")
				.expect("running phase");

			assert_eq!(outcome, Outcome::Halted { phase: PhaseName::new("only") });
			assert!(run.is_halted(), "an exhausted budget must halt rather than retry forever");
			assert_eq!(run.next_step(), Step::Done { accepted: false });
		}

		#[test]
		fn halt_route_stops_the_run_on_first_rejection() {
			let mut run = run_of(vec![agent("only").on_reject(OnReject::Halt)]);

			dispatch(&mut run);
			let outcome = run
				.reject(PhaseName::from_ref("only"), "fatal")
				.expect("running phase");

			assert_eq!(outcome, Outcome::Halted { phase: PhaseName::new("only") });
		}

		#[test]
		fn correct_route_rewinds_to_the_producer() {
			let mut run = run_of(vec![
				agent("build").depending_on([]),
				Phase::new(PhaseName::new("review"), PhaseKind::Review)
					.depending_on([])
					.consuming([PhaseName::new("build")])
					.on_reject(OnReject::Correct),
			]);

			dispatch(&mut run);
			run.accept(PhaseName::from_ref("build"))
				.expect("running phase");
			dispatch(&mut run);
			let outcome = run
				.reject(PhaseName::from_ref("review"), "wrong layer")
				.expect("running phase");

			let Outcome::Rewound { phase, .. } = outcome else {
				panic!("a correction route must rewind, not retry the reviewer");
			};
			assert_eq!(phase.as_str(), "build");
		}

		#[test]
		fn rewind_redispatches_the_producer_with_the_feedback() {
			let mut run = run_of(vec![
				agent("build").depending_on([]),
				Phase::new(PhaseName::new("review"), PhaseKind::Review)
					.depending_on([])
					.consuming([PhaseName::new("build")])
					.on_reject(OnReject::Correct),
			]);

			dispatch(&mut run);
			run.accept(PhaseName::from_ref("build"))
				.expect("running phase");
			dispatch(&mut run);
			run.reject(PhaseName::from_ref("review"), "wrong layer")
				.expect("running phase");

			let Step::Run { phase, correction, .. } = run.next_step() else {
				panic!("the rewind target must dispatch again");
			};
			assert_eq!(phase.name.as_str(), "build");
			assert_eq!(
				correction.as_deref(),
				Some("wrong layer"),
				"the producer must receive the reviewer's reason for the rewind"
			);
		}

		#[test]
		fn rewind_does_not_consume_the_producer_attempt_budget() {
			let mut run = run_of(vec![
				agent("build").depending_on([]),
				Phase::new(PhaseName::new("review"), PhaseKind::Review)
					.depending_on([])
					.consuming([PhaseName::new("build")])
					.on_reject(OnReject::Correct),
			])
			.with_max_attempts(1);

			dispatch(&mut run);
			run.accept(PhaseName::from_ref("build"))
				.expect("running phase");
			dispatch(&mut run);
			run.reject(PhaseName::from_ref("review"), "again")
				.expect("running phase");

			assert!(
				matches!(run.next_step(), Step::Run { ref phase, .. } if phase.name.as_str() == "build"),
				"a reviewer-driven rewind must not be charged to the producer's own budget"
			);
		}

		#[test]
		fn correct_route_halts_when_nothing_precedes_the_phase() {
			let mut run = run_of(vec![agent("only").depending_on([]).on_reject(OnReject::Correct)]);

			dispatch(&mut run);
			let outcome = run
				.reject(PhaseName::from_ref("only"), "nowhere")
				.expect("running phase");

			assert_eq!(
				outcome,
				Outcome::Halted { phase: PhaseName::new("only") },
				"a correction with no upstream target must halt, not silently retry"
			);
		}
	}
}
