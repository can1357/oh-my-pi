//! What a phase requires of its execution environment, and whether it got it.
//!
//! A phase declares the posture it needs; the host reports the posture it
//! actually resolved. [`Requirement::check`] compares them. The comparison is
//! deliberately one-directional — a host may be *stricter* than a phase asked
//! for, never looser — because the alternative is a workflow that believes it
//! ran confined when it did not.

use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use crate::workflow::PhaseName;

/// How much of the filesystem a phase may write.
///
/// Ordered by confinement: `ReadOnly` is the most confined, `Unconfined` the
/// least. That ordering is what lets a check accept a stricter host.
#[derive(
	Debug,
	Clone,
	Copy,
	PartialEq,
	Eq,
	PartialOrd,
	Ord,
	Display,
	EnumString,
	IntoStaticStr,
	Serialize,
	Deserialize,
)]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
#[serde(rename_all = "kebab-case")]
pub enum WriteScope {
	/// No writes anywhere.
	ReadOnly,
	/// Writes confined to the workspace and its temporary directories.
	WorkspaceWrite,
	/// Writes unrestricted by a sandbox.
	Unconfined,
}

/// Whether a phase may reach the network.
#[derive(
	Debug,
	Clone,
	Copy,
	PartialEq,
	Eq,
	PartialOrd,
	Ord,
	Display,
	EnumString,
	IntoStaticStr,
	Serialize,
	Deserialize,
)]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkScope {
	/// No IP networking.
	Disabled,
	/// Networking limited to an allowlist.
	Scoped,
	/// Unrestricted networking.
	Unrestricted,
}

/// Who authorizes a tool call.
#[derive(
	Debug,
	Clone,
	Copy,
	PartialEq,
	Eq,
	PartialOrd,
	Ord,
	Display,
	EnumString,
	IntoStaticStr,
	Serialize,
	Deserialize,
)]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalScope {
	/// Every tool call is confirmed by a human.
	AlwaysAsk,
	/// Read and write are automatic; exec is confirmed.
	Write,
	/// Read, write, and exec are automatic.
	Yolo,
}

/// The posture a phase requires.
///
/// Every field is optional: an unset field means the phase expressed no
/// opinion and inherits whatever the operator configured. A set field is a
/// *requirement*, not a preference — [`Requirement::check`] refuses the phase
/// when the host cannot meet it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Requirement {
	/// The loosest write scope the phase tolerates.
	pub write:    Option<WriteScope>,
	/// The loosest network scope the phase tolerates.
	pub network:  Option<NetworkScope>,
	/// The loosest approval scope the phase tolerates.
	pub approval: Option<ApprovalScope>,
}

/// The posture the host actually resolved for a phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Posture {
	/// Write scope in effect.
	pub write:    WriteScope,
	/// Network scope in effect.
	pub network:  NetworkScope,
	/// Approval scope in effect.
	pub approval: ApprovalScope,
}

impl Posture {
	/// The strictest of two postures, field by field.
	///
	/// This is how a child inherits authority: whatever the parent holds,
	/// narrowed by whatever the phase asked for. A child can only ever end up
	/// with less, which is the property that makes the ceiling a ceiling —
	/// a phase requesting `Unconfined` under a `ReadOnly` parent still gets
	/// `ReadOnly`, and no chain of spawns can climb back out.
	#[must_use]
	pub fn narrowed(self, ceiling: Self) -> Self {
		Self {
			write:    self.write.min(ceiling.write),
			network:  self.network.min(ceiling.network),
			approval: self.approval.min(ceiling.approval),
		}
	}

	/// Whether this posture grants nothing beyond `ceiling`.
	#[must_use]
	pub fn within(&self, ceiling: &Self) -> bool {
		self.write <= ceiling.write
			&& self.network <= ceiling.network
			&& self.approval <= ceiling.approval
	}
}

/// A requirement the resolved posture does not satisfy.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum PostureError {
	/// The phase declares a requirement but no posture was reported.
	#[error("phase requires a posture the host never reported")]
	Unreported {
		/// The phase that declared the requirement.
		phase: PhaseName,
	},
	/// The host would permit wider writes than the phase allows.
	#[error("resolved write scope is looser than the phase requires")]
	Write {
		/// The phase that declared the requirement.
		phase:    PhaseName,
		/// What the phase requires.
		required: WriteScope,
		/// What the host resolved.
		resolved: WriteScope,
	},
	/// The host would permit wider network access than the phase allows.
	#[error("resolved network scope is looser than the phase requires")]
	Network {
		/// The phase that declared the requirement.
		phase:    PhaseName,
		/// What the phase requires.
		required: NetworkScope,
		/// What the host resolved.
		resolved: NetworkScope,
	},
	/// The host would auto-approve more than the phase allows.
	#[error("resolved approval scope is looser than the phase requires")]
	Approval {
		/// The phase that declared the requirement.
		phase:    PhaseName,
		/// What the phase requires.
		required: ApprovalScope,
		/// What the host resolved.
		resolved: ApprovalScope,
	},
}

impl Requirement {
	/// Requires a write scope no looser than `scope`.
	#[must_use]
	pub const fn writing(mut self, scope: WriteScope) -> Self {
		self.write = Some(scope);
		self
	}

	/// Requires a network scope no looser than `scope`.
	#[must_use]
	pub const fn networking(mut self, scope: NetworkScope) -> Self {
		self.network = Some(scope);
		self
	}

	/// Requires an approval scope no looser than `scope`.
	#[must_use]
	pub const fn approving(mut self, scope: ApprovalScope) -> Self {
		self.approval = Some(scope);
		self
	}

	/// Whether any requirement is declared.
	#[inline]
	pub const fn is_empty(&self) -> bool {
		self.write.is_none() && self.network.is_none() && self.approval.is_none()
	}

	/// Confirms `posture` satisfies this requirement for `phase`.
	///
	/// A stricter host passes: a phase asking for `WorkspaceWrite` is content
	/// to run `ReadOnly`, because nothing it is permitted to do becomes
	/// impossible — only the reverse is a violation.
	///
	/// # Errors
	///
	/// Returns [`PostureError`] naming the first requirement the posture fails.
	/// The phase must not dispatch: a declared requirement that silently
	/// degrades is worse than no requirement at all.
	pub fn check(&self, phase: &PhaseName<str>, posture: &Posture) -> Result<(), PostureError> {
		if let Some(required) = self.write
			&& posture.write > required
		{
			return Err(PostureError::Write {
				phase: phase.to_owned(),
				required,
				resolved: posture.write,
			});
		}
		if let Some(required) = self.network
			&& posture.network > required
		{
			return Err(PostureError::Network {
				phase: phase.to_owned(),
				required,
				resolved: posture.network,
			});
		}
		if let Some(required) = self.approval
			&& posture.approval > required
		{
			return Err(PostureError::Approval {
				phase: phase.to_owned(),
				required,
				resolved: posture.approval,
			});
		}
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const UNCONFINED: Posture = Posture {
		write:    WriteScope::Unconfined,
		network:  NetworkScope::Unrestricted,
		approval: ApprovalScope::Yolo,
	};

	const CONFINED: Posture = Posture {
		write:    WriteScope::ReadOnly,
		network:  NetworkScope::Disabled,
		approval: ApprovalScope::AlwaysAsk,
	};

	fn reviewer() -> PhaseName {
		PhaseName::new("review")
	}

	mod check {
		use super::*;

		#[test]
		fn empty_requirement_accepts_any_posture() {
			assert!(
				Requirement::default()
					.check(&reviewer(), &UNCONFINED)
					.is_ok(),
				"a phase that expressed no opinion must inherit the operator's posture"
			);
		}

		#[test]
		fn read_only_requirement_refuses_an_unconfined_host() {
			let error = Requirement::default()
				.writing(WriteScope::ReadOnly)
				.check(&reviewer(), &UNCONFINED)
				.expect_err("an unconfined host cannot satisfy a read-only requirement");

			assert_eq!(error, PostureError::Write {
				phase:    reviewer(),
				required: WriteScope::ReadOnly,
				resolved: WriteScope::Unconfined,
			});
		}

		#[test]
		fn workspace_write_requirement_accepts_a_stricter_host() {
			assert!(
				Requirement::default()
					.writing(WriteScope::WorkspaceWrite)
					.check(&reviewer(), &CONFINED)
					.is_ok(),
				"a stricter host takes nothing away that the phase was promised"
			);
		}

		#[test]
		fn network_requirement_refuses_an_unrestricted_host() {
			let error = Requirement::default()
				.networking(NetworkScope::Disabled)
				.check(&reviewer(), &UNCONFINED)
				.expect_err("unrestricted networking cannot satisfy a disabled requirement");

			assert!(
				matches!(error, PostureError::Network { .. }),
				"the network requirement must be the one reported: {error}"
			);
		}

		#[test]
		fn approval_requirement_refuses_auto_approval() {
			let error = Requirement::default()
				.approving(ApprovalScope::AlwaysAsk)
				.check(&reviewer(), &UNCONFINED)
				.expect_err("yolo cannot satisfy an always-ask requirement");

			assert_eq!(error, PostureError::Approval {
				phase:    reviewer(),
				required: ApprovalScope::AlwaysAsk,
				resolved: ApprovalScope::Yolo,
			});
		}

		#[test]
		fn reports_the_write_violation_before_the_others() {
			let error = Requirement::default()
				.writing(WriteScope::ReadOnly)
				.networking(NetworkScope::Disabled)
				.approving(ApprovalScope::AlwaysAsk)
				.check(&reviewer(), &UNCONFINED)
				.expect_err("every requirement is violated");

			assert!(
				matches!(error, PostureError::Write { .. }),
				"a multiply-violating posture must report deterministically: {error}"
			);
		}
	}

	mod narrowed {
		use super::*;

		#[test]
		fn a_child_cannot_widen_its_parent_authority() {
			let child = UNCONFINED.narrowed(CONFINED);

			assert_eq!(
				child, CONFINED,
				"a child requesting more than its parent holds must receive the parent's ceiling"
			);
		}

		#[test]
		fn a_child_keeps_a_stricter_request() {
			let ceiling = Posture {
				write:    WriteScope::WorkspaceWrite,
				network:  NetworkScope::Scoped,
				approval: ApprovalScope::Write,
			};

			assert_eq!(
				CONFINED.narrowed(ceiling),
				CONFINED,
				"asking for less than the ceiling must be honoured, not widened to it"
			);
		}

		#[test]
		fn narrowing_takes_the_strictest_of_each_field_independently() {
			let ceiling = Posture {
				write:    WriteScope::Unconfined,
				network:  NetworkScope::Disabled,
				approval: ApprovalScope::Yolo,
			};
			let request = Posture {
				write:    WriteScope::ReadOnly,
				network:  NetworkScope::Unrestricted,
				approval: ApprovalScope::Yolo,
			};

			assert_eq!(request.narrowed(ceiling), Posture {
				write:    WriteScope::ReadOnly,
				network:  NetworkScope::Disabled,
				approval: ApprovalScope::Yolo,
			});
		}

		#[test]
		fn repeated_narrowing_never_climbs_back_out() {
			let grandchild = CONFINED.narrowed(UNCONFINED).narrowed(UNCONFINED);

			assert_eq!(
				grandchild, CONFINED,
				"no chain of spawns may recover authority an ancestor gave up"
			);
		}
	}

	mod within {
		use super::*;

		#[test]
		fn an_unconfined_posture_is_not_within_a_confined_ceiling() {
			assert!(!UNCONFINED.within(&CONFINED));
		}

		#[test]
		fn a_narrowed_posture_is_always_within_its_ceiling() {
			assert!(UNCONFINED.narrowed(CONFINED).within(&CONFINED));
		}
	}

	mod is_empty {
		use super::*;

		#[test]
		fn a_declared_requirement_is_not_empty() {
			assert!(
				!Requirement::default()
					.writing(WriteScope::ReadOnly)
					.is_empty()
			);
		}
	}
}
