//! User-local execution for the interactive `!` (bash) and `$` (eval)
//! prefix modes.
//!
//! These execute locally without asking the provider. The executor is shared
//! with the corresponding tool, but the durable element is explicitly marked
//! as a local run so actors never present it as a model-issued tool call. Its
//! optional context projection remains a user-authored local-execution
//! message.

use omp_core::{Str, Ulid};
use omp_dom::{Op, PropKey, Txn, Value};
use omp_session::{
	Session,
	projection::{LOCAL_CONTEXT_EXCLUDED, LOCAL_CONTEXT_PROP},
};
use omp_tool::RegistryError;
use serde_json::value::RawValue;
use strum::IntoStaticStr;

use crate::{
	Inference, Kernel, KernelError, KernelEvent, RunControl, TurnOutcome, TurnStop,
	loop_::{ReadyCall, cancelled_outcome, current_turn, outcome},
};

/// DOM property selecting the dedicated local-run presenter.
pub const LOCAL_PRESENTATION_PROP: &str = "presentation";
/// [`LOCAL_PRESENTATION_PROP`] value for user-local execution.
pub const LOCAL_PRESENTATION_VALUE: &str = "local-run";
/// DOM property distinguishing `!` from `$`.
pub const LOCAL_KIND_PROP: &str = "local-kind";
/// DOM property carrying the submitted command/code without requiring an
/// actor to decode tool arguments.
pub const LOCAL_INPUT_PROP: &str = "local-input";
/// [`LOCAL_CONTEXT_PROP`] value allowing the completed run into context.
pub const LOCAL_CONTEXT_INCLUDED: &str = "included";

/// Closed user-local executor roster.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "snake_case")]
pub enum LocalRunKind {
	/// `!` — the stateful in-process Bash interpreter.
	Bash,
	/// `$` — the persistent Python eval kernel.
	Eval,
}

/// One user-local invocation the host asked to run without inference.
#[derive(Clone, Debug)]
pub struct LocalRun {
	/// Executor selected by the submitted prefix.
	pub kind:    LocalRunKind,
	/// Command or code after the prefix.
	pub input:   Str,
	/// Keep the completed run out of the model's context.
	pub exclude: bool,
}

impl LocalRun {
	fn args(&self) -> Box<RawValue> {
		match self.kind {
			LocalRunKind::Bash => serde_json::value::to_raw_value(&serde_json::json!({
				"command": self.input.as_str(),
			})),
			LocalRunKind::Eval => serde_json::value::to_raw_value(&serde_json::json!({
				"language": "py",
				"code": self.input.as_str(),
			})),
		}
		.expect("local arguments are JSON literals")
	}
}

impl<C: Inference> Kernel<C> {
	/// Runs one user-local command as its own turn: no user message and no
	/// inference. The tool executor and cancellation scope are reused, while
	/// the journaled DOM identity remains `presentation=local-run`.
	pub async fn run_local(
		&mut self,
		session: &mut Session,
		run: LocalRun,
		control: RunControl,
	) -> Result<TurnOutcome, KernelError> {
		if control.is_expired() || self.cancel.is_session_cancelled() {
			return Ok(cancelled_outcome());
		}
		let name: &'static str = run.kind.into();
		let identity = self
			.dispatcher
			.registry()
			.resolved_identity(name)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new_static(name)))?;
		let args = run.args();
		let turn_cancel = self.cancel.begin_turn();
		session.begin_turn()?;
		self.apply_live_components(session)?;
		let call_id = Str::new(format!("local-{}", Ulid::generate()));
		let entry = session.call(
			Str::new_static(name),
			crate::journal_revision(&identity.rev),
			call_id.clone(),
			None,
			Some(args.clone()),
			None,
		)?;
		self.apply_live_components(session)?;
		let turn = current_turn(session)?;
		let Some(element) = session.dom().children(turn).last().copied() else {
			return Err(KernelError::MissingResponseStart);
		};
		let context = if run.exclude {
			LOCAL_CONTEXT_EXCLUDED
		} else {
			LOCAL_CONTEXT_INCLUDED
		};
		session.patch(Txn {
			cause: entry,
			label: Some(Str::new_static("local.run")),
			ops:   vec![
				Op::Set {
					h:     element,
					prop:  PropKey::Custom(Str::new_static(LOCAL_PRESENTATION_PROP)),
					value: Value::Str(Str::new_static(LOCAL_PRESENTATION_VALUE)),
				},
				Op::Set {
					h:     element,
					prop:  PropKey::Custom(Str::new_static(LOCAL_KIND_PROP)),
					value: Value::Str(Str::new_static(name)),
				},
				Op::Set {
					h:     element,
					prop:  PropKey::Custom(Str::new_static(LOCAL_INPUT_PROP)),
					value: Value::Str(run.input.clone()),
				},
				Op::Set {
					h:     element,
					prop:  PropKey::Custom(Str::new_static(LOCAL_CONTEXT_PROP)),
					value: Value::Str(Str::new_static(context)),
				},
			],
		})?;
		self.events.publish(KernelEvent::ToolReady {
			call_id: call_id.clone(),
			name:    identity.name.clone(),
		});
		let mut steering = Vec::new();
		let dispatched = self
			.dispatch_call(
				session,
				ReadyCall { entry, identity, call_id, args },
				&turn_cancel,
				&control,
				&mut steering,
			)
			.await;
		// Steering typed while a local command runs has no inference to
		// land in; it goes back to the mailbox for the next model turn.
		for (text, attachments) in steering {
			let _ = self.mailbox_tx.send(crate::Up::Steer { text, attachments });
		}
		let stop = match dispatched {
			Ok(_) if turn_cancel.is_turn_cancelled() => TurnStop::Cancelled,
			Ok(true) | Err(_) => TurnStop::Failed,
			Ok(false) => TurnStop::Completed,
		};
		self.events.publish(KernelEvent::TurnEnded { stop });
		dispatched.map(|_| outcome(stop, String::new(), 0, 0))
	}
}
