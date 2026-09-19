//! Phase declarations and the dependency graph they form.
#![allow(missing_docs, reason = "strum IntoStaticStr emits undocumented inherent methods")]

use std::sync::Arc;

use omp_core::{FastHashMap, string_id};
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;
use strum::{Display, EnumString, IntoStaticStr};

use crate::profile::Requirement;

string_id!(
	/// Name of a phase within a workflow. Unique per workflow.
	PhaseName
);

string_id!(
	/// Name of a workflow definition.
	WorkflowName
);

/// How a phase produces its result.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, Display, EnumString, IntoStaticStr, Serialize, Deserialize,
)]
#[strum(serialize_all = "snake_case", const_into_str)]
#[serde(rename_all = "snake_case")]
pub enum PhaseKind {
	/// A model turn that reports a structured result.
	Agent,
	/// A deterministic command whose exit status decides the outcome.
	Code,
	/// A model turn that judges another phase's output.
	Review,
}

/// What a rejected phase does to the run.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, Display, EnumString, IntoStaticStr, Serialize, Deserialize,
)]
#[strum(serialize_all = "snake_case", const_into_str)]
#[serde(rename_all = "snake_case")]
pub enum OnReject {
	/// Retry this phase with the rejection feedback as correction.
	Retry,
	/// Rewind to the phase that produced the rejected work.
	Correct,
	/// Halt the run.
	Halt,
}

/// A declared phase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Phase {
	/// Unique name within the workflow.
	pub name:       PhaseName,
	/// How the phase produces its result.
	pub kind:       PhaseKind,
	/// Phases that must be accepted before this one dispatches.
	///
	/// `None` means "whatever came before me" and is resolved to an implicit
	/// serial edge by [`Workflow::new`]. An explicit empty list means the phase
	/// is genuinely independent and may dispatch immediately — the distinction
	/// is the whole reason this is an `Option`.
	pub depends_on: Option<SmallVec<PhaseName, 2>>,
	/// Producers whose accepted output this phase consumes.
	///
	/// Inputs imply dependencies: a declared input is also an edge.
	pub inputs:     SmallVec<PhaseName, 2>,
	/// What a rejection of this phase does.
	pub on_reject:  OnReject,
	/// The execution posture this phase requires.
	///
	/// Empty by default: a phase inherits the operator's posture unless it
	/// states otherwise. A declared requirement is enforced at dispatch, never
	/// silently degraded.
	pub requires:   Requirement,
}

impl Phase {
	/// Declares a phase with implicit serial ordering and no declared inputs.
	pub fn new(name: impl Into<PhaseName>, kind: PhaseKind) -> Self {
		Self {
			name: name.into(),
			kind,
			depends_on: None,
			inputs: SmallVec::new(),
			on_reject: OnReject::Retry,
			requires: Requirement::default(),
		}
	}

	/// Declares explicit dependencies, replacing the implicit serial edge.
	#[must_use]
	pub fn depending_on(mut self, names: impl IntoIterator<Item = PhaseName>) -> Self {
		self.depends_on = Some(names.into_iter().collect());
		self
	}

	/// Declares consumed producers. Each input is also a dependency.
	#[must_use]
	pub fn consuming(mut self, names: impl IntoIterator<Item = PhaseName>) -> Self {
		self.inputs = names.into_iter().collect();
		self
	}

	/// Sets the rejection route.
	#[must_use]
	pub const fn on_reject(mut self, route: OnReject) -> Self {
		self.on_reject = route;
		self
	}

	/// Declares the execution posture this phase requires.
	#[must_use]
	pub const fn requiring(mut self, requirement: Requirement) -> Self {
		self.requires = requirement;
		self
	}

	/// Every phase that must be accepted before this one dispatches.
	///
	/// The union of declared dependencies and declared inputs; an input that is
	/// not also listed in `depends_on` still gates dispatch, because consuming a
	/// version the producer has not yet published is not a thing that can
	/// happen.
	pub fn required(&self) -> impl Iterator<Item = &PhaseName> {
		self
			.depends_on
			.iter()
			.flat_map(|names| names.iter())
			.chain(self.inputs.iter())
	}
}

/// A phase graph that failed validation.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WorkflowError {
	/// Two phases share a name, so a dependency on that name is ambiguous.
	#[error("duplicate phase name")]
	DuplicateName {
		/// The repeated name.
		name: PhaseName,
	},
	/// A dependency or input names a phase that does not exist.
	#[error("phase depends on an undeclared phase")]
	UnknownDependency {
		/// The phase carrying the bad reference.
		phase:   PhaseName,
		/// The name that does not resolve.
		missing: PhaseName,
	},
	/// The graph has a cycle, so no dispatch order exists.
	#[error("phase dependencies form a cycle")]
	Cycle {
		/// The phases that remain unorderable.
		phases: Vec<PhaseName>,
	},
	/// A workflow with no phases has nothing to run.
	#[error("workflow declares no phases")]
	Empty,
}

/// A validated phase graph in dependency order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Workflow {
	name:   WorkflowName,
	phases: Vec<Arc<Phase>>,
}

impl Workflow {
	/// Resolves implicit serial edges, validates the graph, and orders it.
	///
	/// Ordering is deterministic: among phases whose dependencies are all
	/// satisfied, declaration order decides. Two runs of the same workflow
	/// therefore dispatch in the same order, which is what makes a replayed
	/// trace comparable to the run it replays.
	///
	/// # Errors
	///
	/// Returns [`WorkflowError`] when the graph is empty, names collide, a
	/// reference does not resolve, or the graph contains a cycle. An invalid
	/// graph is never silently reordered into a runnable one.
	pub fn new(
		name: impl Into<WorkflowName>,
		phases: impl Into<Vec<Phase>>,
	) -> Result<Self, WorkflowError> {
		let mut phases = phases.into();
		if phases.is_empty() {
			return Err(WorkflowError::Empty);
		}

		let mut index_of = FastHashMap::default();
		for (index, phase) in phases.iter().enumerate() {
			if index_of.insert(phase.name.clone(), index).is_some() {
				return Err(WorkflowError::DuplicateName { name: phase.name.clone() });
			}
		}

		let mut previous: Option<PhaseName> = None;
		for phase in &mut phases {
			if phase.depends_on.is_none() {
				phase.depends_on = Some(previous.iter().cloned().collect());
			}
			previous = Some(phase.name.clone());
		}

		for phase in &phases {
			for required in phase.required() {
				if !index_of.contains_key(required) {
					return Err(WorkflowError::UnknownDependency {
						phase:   phase.name.clone(),
						missing: required.clone(),
					});
				}
			}
		}

		let order = topological_order(&phases, &index_of)?;
		let mut slots: Vec<Option<Phase>> = phases.into_iter().map(Some).collect();
		let phases = order
			.into_iter()
			.filter_map(|index| slots[index].take().map(Arc::new))
			.collect();

		Ok(Self { name: name.into(), phases })
	}

	/// The workflow's name.
	#[inline]
	pub const fn name(&self) -> &WorkflowName {
		&self.name
	}

	/// Phases in dependency order.
	#[inline]
	pub fn phases(&self) -> &[Arc<Phase>] {
		&self.phases
	}

	/// Position of a phase by name.
	pub fn position(&self, name: &PhaseName<str>) -> Option<usize> {
		self.phases.iter().position(|phase| &*phase.name == name)
	}

	/// Phases that declare the named phase as a dependency or input.
	pub fn dependents(&self, name: &PhaseName<str>) -> impl Iterator<Item = &Arc<Phase>> {
		self
			.phases
			.iter()
			.filter(move |phase| phase.required().any(|required| &**required == name))
	}
}

/// Phase indices in dependency order, or the cycle that prevents one.
fn topological_order(
	phases: &[Phase],
	index_of: &FastHashMap<PhaseName, usize>,
) -> Result<Vec<usize>, WorkflowError> {
	let mut done = vec![false; phases.len()];
	let mut remaining: Vec<usize> = (0..phases.len()).collect();
	let mut order = Vec::with_capacity(phases.len());
	let mut ready = Vec::new();

	while !remaining.is_empty() {
		ready.clear();
		ready.extend(remaining.iter().copied().filter(|&index| {
			phases[index]
				.required()
				.all(|name| index_of.get(name).is_some_and(|&dep| done[dep]))
		}));

		if ready.is_empty() {
			return Err(WorkflowError::Cycle {
				phases: remaining
					.iter()
					.map(|&index| phases[index].name.clone())
					.collect(),
			});
		}

		for &index in &ready {
			done[index] = true;
			order.push(index);
		}
		remaining.retain(|index| !done[*index]);
	}

	Ok(order)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn phase(name: &str) -> Phase {
		Phase::new(PhaseName::new(name), PhaseKind::Agent)
	}

	mod new {
		use super::*;

		#[test]
		fn absent_depends_on_becomes_a_serial_edge() {
			let workflow = Workflow::new(WorkflowName::new("w"), vec![phase("plan"), phase("build")])
				.expect("valid workflow");

			let build = &workflow.phases()[1];
			assert_eq!(
				build.depends_on.as_deref(),
				Some([PhaseName::new("plan")].as_slice()),
				"an undeclared dependency must inherit the preceding phase"
			);
		}

		#[test]
		fn explicit_empty_depends_on_stays_independent() {
			let workflow = Workflow::new(WorkflowName::new("w"), vec![
				phase("left"),
				phase("right").depending_on([]),
			])
			.expect("valid workflow");

			assert!(
				workflow.phases()[1]
					.depends_on
					.as_deref()
					.is_some_and(<[_]>::is_empty),
				"an explicit empty list must not be overwritten by the serial edge"
			);
		}

		#[test]
		fn independent_phases_keep_declaration_order() {
			let workflow = Workflow::new(WorkflowName::new("w"), vec![
				phase("left").depending_on([]),
				phase("right").depending_on([]),
			])
			.expect("valid workflow");

			let names: Vec<_> = workflow
				.phases()
				.iter()
				.map(|phase| phase.name.as_str())
				.collect();
			assert_eq!(names, ["left", "right"], "ready phases must tie-break on declaration order");
		}

		#[test]
		fn dependencies_are_ordered_before_dependents() {
			let workflow = Workflow::new(WorkflowName::new("w"), vec![
				phase("join").depending_on([PhaseName::new("leaf")]),
				phase("leaf").depending_on([]),
			])
			.expect("valid workflow");

			let names: Vec<_> = workflow
				.phases()
				.iter()
				.map(|phase| phase.name.as_str())
				.collect();
			assert_eq!(names, ["leaf", "join"], "a dependent must sort after its dependency");
		}

		#[test]
		fn cycle_is_rejected() {
			let error = Workflow::new(WorkflowName::new("w"), vec![
				phase("a").depending_on([PhaseName::new("b")]),
				phase("b").depending_on([PhaseName::new("a")]),
			])
			.expect_err("a cycle has no dispatch order");

			assert!(
				matches!(error, WorkflowError::Cycle { .. }),
				"a cycle must be reported, never reordered into declaration order: {error}"
			);
		}

		#[test]
		fn unknown_dependency_is_rejected() {
			let error = Workflow::new(WorkflowName::new("w"), vec![
				phase("a").depending_on([PhaseName::new("ghost")]),
			])
			.expect_err("a dependency must resolve");

			assert_eq!(error, WorkflowError::UnknownDependency {
				phase:   PhaseName::new("a"),
				missing: PhaseName::new("ghost"),
			});
		}

		#[test]
		fn duplicate_name_is_rejected() {
			let error = Workflow::new(WorkflowName::new("w"), vec![phase("a"), phase("a")])
				.expect_err("a duplicate name makes dependencies ambiguous");

			assert_eq!(error, WorkflowError::DuplicateName { name: PhaseName::new("a") });
		}

		#[test]
		fn empty_workflow_is_rejected() {
			let error = Workflow::new(WorkflowName::new("w"), vec![])
				.expect_err("a workflow with no phases has nothing to run");

			assert_eq!(error, WorkflowError::Empty);
		}

		#[test]
		fn declared_input_gates_dispatch_without_a_dependency_entry() {
			let workflow = Workflow::new(WorkflowName::new("w"), vec![
				phase("consumer")
					.depending_on([])
					.consuming([PhaseName::new("producer")]),
				phase("producer").depending_on([]),
			])
			.expect("valid workflow");

			let names: Vec<_> = workflow
				.phases()
				.iter()
				.map(|phase| phase.name.as_str())
				.collect();
			assert_eq!(
				names,
				["producer", "consumer"],
				"a declared input must order its producer first even with an empty depends_on"
			);
		}
	}

	mod dependents {
		use super::*;

		#[test]
		fn reports_consumers_of_a_producer() {
			let workflow = Workflow::new(WorkflowName::new("w"), vec![
				phase("producer").depending_on([]),
				phase("consumer")
					.depending_on([])
					.consuming([PhaseName::new("producer")]),
			])
			.expect("valid workflow");

			let names: Vec<_> = workflow
				.dependents(PhaseName::from_ref("producer"))
				.map(|phase| phase.name.as_str())
				.collect();
			assert_eq!(names, ["consumer"]);
		}
	}
}
