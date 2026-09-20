//! Production posture resolution and phase dispatch.
//!
//! Agent and review phases run as restricted child kernels; code phases run as
//! processes whose exit status decides the outcome. Both report a
//! [`PhaseResult`] the domain turns into a transition.

use std::{
	path::{Path, PathBuf},
	process::Stdio,
	sync::Arc,
};

use omp_adw::{ApprovalScope, NetworkScope, Phase, PhaseKind, Posture, SelectedInput, WriteScope};
use omp_core::{Str, StrMut, sf};
use omp_envd::{
	exec_settings::{ExecSandboxMode, SandboxNetworkMode},
	tool_settings::ApprovalMode,
};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::{AdwHost, PhaseResult, PhaseSpec};
use crate::{
	cleanse::checkers::{BinaryResolver as _, FilesystemResolver},
	headless::{HeadlessError, KernelOptions, compose_kernel},
};

/// A phase that could not be executed.
#[derive(Debug, thiserror::Error)]
pub enum ProductionError {
	/// The project root could not be canonicalized, or a process failed.
	#[error("workflow host filesystem or process operation failed")]
	Io(#[from] std::io::Error),
	/// A child kernel could not be composed.
	#[error("workflow child session composition failed")]
	Session(#[from] HeadlessError),
	/// A child turn failed.
	#[error("workflow child turn failed")]
	Turn(#[from] omp_agent::KernelError),
	/// A code phase named an executable this project cannot resolve.
	#[error("workflow phase executable `{binary}` was not found in the project or PATH")]
	UnresolvedBinary {
		/// The unresolved executable name.
		binary: Str,
	},
}

/// Production owner for one workflow run.
pub struct ProductionAdwHost {
	root:     PathBuf,
	data_dir: PathBuf,
	model:    Str,
	ctx:      Arc<omp_con::Ctx>,
	resolver: FilesystemResolver,
}

impl ProductionAdwHost {
	/// Opens a host rooted at a canonical project directory.
	///
	/// # Errors
	///
	/// Returns [`ProductionError`] when the project root cannot be resolved.
	pub fn open(
		root: PathBuf,
		data_dir: PathBuf,
		model: Str,
		ctx: Arc<omp_con::Ctx>,
	) -> Result<Self, ProductionError> {
		Ok(Self {
			root: std::fs::canonicalize(root)?,
			data_dir,
			model,
			ctx,
			resolver: FilesystemResolver,
		})
	}

	async fn run_child(
		&self,
		prompt: Str,
		cancel: &CancellationToken,
	) -> Result<Str, ProductionError> {
		let (mut kernel, mut session, _) = compose_kernel(
			&self.data_dir,
			&self.root,
			self.model.as_str(),
			Arc::clone(&self.ctx),
			KernelOptions { ephemeral: true, ..KernelOptions::default() },
		)
		.await?;
		let outcome = kernel
			.run_turn(
				&mut session,
				omp_agent::TurnInput { text: prompt, attachments: Vec::new() },
				omp_agent::RunControl::new(cancel.clone(), None),
			)
			.await?;
		Ok(outcome.assistant_text)
	}

	async fn run_command(
		&self,
		binary: &str,
		args: &[Str],
		cwd: Option<&str>,
		cancel: &CancellationToken,
	) -> Result<PhaseResult, ProductionError> {
		let directory = cwd.map_or_else(|| self.root.clone(), |cwd| self.root.join(cwd));
		let resolved = self
			.resolver
			.resolve(&self.root, &directory, &[binary])
			.ok_or_else(|| ProductionError::UnresolvedBinary { binary: Str::new(binary) })?;
		let mut child = Command::new(resolved);
		child
			.args(args.iter().map(Str::as_str))
			.current_dir(&directory)
			.kill_on_drop(true)
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		let output = tokio::select! {
			result = child.output() => result?,
			() = cancel.cancelled() => {
				return Ok(PhaseResult { accepted: false, feedback: sf!("cancelled") });
			},
		};
		if output.status.success() {
			return Ok(PhaseResult { accepted: true, feedback: Str::empty() });
		}
		// The rejection feedback is the next attempt's only record of what was
		// wrong, so it carries the diagnostics rather than just the status.
		let mut feedback = StrMut::new(format!(
			"`{binary}` exited with status {}\n",
			output
				.status
				.code()
				.map_or_else(|| sf!("signal"), |code| Str::from(code.to_string()))
		));
		feedback.push_str(&String::from_utf8_lossy(&output.stdout));
		feedback.push_str(&String::from_utf8_lossy(&output.stderr));
		Ok(PhaseResult { accepted: false, feedback: feedback.freeze() })
	}
}

impl AdwHost for ProductionAdwHost {
	type Error = ProductionError;

	fn project_root(&self) -> &Path {
		&self.root
	}

	fn posture(&self) -> Result<Posture, Self::Error> {
		Ok(Posture {
			write:    match omp_envd::exec_settings::SV_SANDBOX_MODE.get(&self.ctx) {
				ExecSandboxMode::ReadOnly => WriteScope::ReadOnly,
				ExecSandboxMode::WorkspaceWrite => WriteScope::WorkspaceWrite,
				ExecSandboxMode::Off => WriteScope::Unconfined,
			},
			network:  match omp_envd::exec_settings::SV_SANDBOX_NETWORK_MODE.get(&self.ctx) {
				SandboxNetworkMode::Disabled => NetworkScope::Disabled,
				SandboxNetworkMode::Scoped => NetworkScope::Scoped,
				SandboxNetworkMode::Open => NetworkScope::Unrestricted,
			},
			approval: match omp_envd::tool_settings::SV_TOOLS_APPROVAL_MODE.get(&self.ctx) {
				ApprovalMode::AlwaysAsk => ApprovalScope::AlwaysAsk,
				ApprovalMode::Write => ApprovalScope::Write,
				ApprovalMode::Yolo => ApprovalScope::Yolo,
			},
		})
	}

	async fn dispatch(
		&self,
		phase: &Phase,
		spec: &PhaseSpec,
		attempt: u32,
		correction: Option<&Str>,
		inputs: &[SelectedInput],
		cancel: &CancellationToken,
	) -> Result<PhaseResult, Self::Error> {
		match spec {
			PhaseSpec::Command { binary, args, cwd } => {
				self
					.run_command(binary.as_str(), args, cwd.as_deref(), cancel)
					.await
			},
			PhaseSpec::Prompt { text } => {
				let prompt = phase_prompt(phase, text, attempt, correction, inputs);
				let answer = self.run_child(prompt, cancel).await?;
				Ok(judge(phase.kind, answer))
			},
		}
	}
}

/// Composes the brief one model phase receives.
///
/// The attempt ordinal, the rejection that caused the retry, and the producer
/// versions consumed are all facts the child cannot otherwise observe: the
/// engine does not require a retry to reuse the rejected attempt's session.
fn phase_prompt(
	phase: &Phase,
	instruction: &Str,
	attempt: u32,
	correction: Option<&Str>,
	inputs: &[SelectedInput],
) -> Str {
	let mut text = StrMut::new(format!("Workflow phase `{}`.\n", phase.name.as_str()));
	if attempt > 1 {
		text.push_str(&format!("This is attempt {attempt}; a prior attempt was rejected.\n"));
	}
	if !inputs.is_empty() {
		text.push_str("Consuming: ");
		for (index, input) in inputs.iter().enumerate() {
			if index > 0 {
				text.push_str(", ");
			}
			text.push_str(&format!("`{}` v{}", input.phase.as_str(), input.version));
		}
		text.push('\n');
	}
	text.push('\n');
	text.push_str(instruction.as_str());
	if let Some(correction) = correction {
		text.push_str("\n\nCorrect this rejection:\n");
		text.push_str(correction.as_str());
	}
	if phase.kind == PhaseKind::Review {
		text.push_str(
			"\n\nAnswer with ACCEPT on its own first line when the work meets the bar, or REJECT \
			 followed by exactly what must change.",
		);
	}
	text.freeze()
}

/// Reads a model phase's verdict.
///
/// A review phase judges, so its answer is the verdict and an unparseable
/// answer is a rejection — a reviewer that did not say ACCEPT has not
/// accepted. A producing phase reports completion, so any answer stands.
fn judge(kind: PhaseKind, answer: Str) -> PhaseResult {
	if kind != PhaseKind::Review {
		return PhaseResult { accepted: true, feedback: Str::empty() };
	}
	if answer
		.as_str()
		.split_whitespace()
		.next()
		.is_some_and(|word| word.eq_ignore_ascii_case("accept"))
	{
		PhaseResult { accepted: true, feedback: Str::empty() }
	} else {
		PhaseResult { accepted: false, feedback: answer }
	}
}

#[cfg(test)]
mod tests {
	use omp_adw::PhaseName;

	use super::*;

	#[test]
	fn a_reviewer_that_did_not_say_accept_has_not_accepted() {
		assert!(judge(PhaseKind::Review, sf!("ACCEPT")).accepted);
		assert!(judge(PhaseKind::Review, sf!("  accept\nlooks good")).accepted);
		let rejected = judge(PhaseKind::Review, sf!("REJECT the tests are missing"));
		assert!(!rejected.accepted);
		assert_eq!(rejected.feedback, sf!("REJECT the tests are missing"));
		// An empty or off-script answer is not an acceptance.
		assert!(!judge(PhaseKind::Review, Str::empty()).accepted);
		assert!(!judge(PhaseKind::Review, sf!("acceptable with changes")).accepted);
		// A producing phase reports completion rather than a verdict.
		assert!(judge(PhaseKind::Agent, sf!("done")).accepted);
	}

	#[test]
	fn a_retry_brief_carries_the_rejection_and_consumed_versions() {
		let phase = Phase::new(PhaseName::new("review"), PhaseKind::Review);
		let inputs = [SelectedInput { phase: PhaseName::new("build"), version: 2 }];
		let prompt = phase_prompt(&phase, &sf!("Judge it."), 3, Some(&sf!("tests missing")), &inputs);
		let text = prompt.as_str();
		assert!(text.contains("attempt 3"));
		assert!(text.contains("`build` v2"));
		assert!(text.contains("Judge it."));
		assert!(text.contains("tests missing"));
		assert!(text.contains("ACCEPT"));

		let first = phase_prompt(&phase, &sf!("Judge it."), 1, None, &[]);
		assert!(!first.as_str().contains("attempt"));
		assert!(!first.as_str().contains("Consuming"));
	}
}
