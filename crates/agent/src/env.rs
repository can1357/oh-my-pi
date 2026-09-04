//! Environment-to-kernel events carried by the single upward mailbox.

use std::{fmt::Write as _, sync::Arc};

use omp_core::{Str, StrMut};
use omp_dom::{Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Value};
use omp_journal::data::{IrcTraffic, LaunchCompletion, LaunchDaemonCompletion};
use omp_proto::env::v1::{WorkspaceRestored, WorkspaceSnapshot};
use omp_session::{Session, SessionError};

/// Builds the atomic journal operations for a supervised-process settlement.
///
/// The completion row and the job's delivery marker are committed in the same
/// `jobs.settle` patch. A crash therefore observes both or neither, and replay
/// cannot inject a second row for the process through generic async delivery.
pub fn launch_completion_ops(
	session: &Session,
	job: Handle,
	completion: &LaunchDaemonCompletion,
) -> Result<Vec<Op>, SessionError> {
	let turn = session
		.dom()
		.children(session.dom().body())
		.last()
		.copied()
		.ok_or(SessionError::NoActiveTurn)?;
	let data =
		serde_json::value::to_raw_value(&LaunchCompletion { daemons: vec![completion.clone()] })?;
	let mut body = StrMut::new("");
	let _ = write!(body, "Supervised process {} {} ", completion.name, completion.status);
	match completion.exit_code {
		Some(code) => {
			let _ = write!(body, "with exit code {code}.");
		},
		None => body.push_str("without an exit code."),
	}
	if let Some(fault) = &completion.fault {
		let _ = write!(body, " Fault: {}", fault.kind);
		if let Some(message) = &fault.message {
			let _ = write!(body, " — {message}");
		}
		if let Some(signal) = &fault.signal {
			let _ = write!(body, " ({signal})");
		}
		body.push('.');
	}
	Ok(vec![
		Op::Ins {
			parent: turn,
			after:  session.dom().children(turn).last().copied(),
			node:   NodeSpec::new(KnownTag::User)
				.with_prop(PropKey::Custom(Str::new_static("launch_completion")), Value::Bool(true))
				.with_prop(PropId::Data, Value::Json(data))
				.with_content(body.freeze()),
		},
		Op::Set {
			h:     job,
			prop:  PropKey::Custom(Str::new_static(crate::jobs::DELIVERED)),
			value: Value::Bool(true),
		},
	])
}

/// Journals one typed IRC observation under the active turn.
///
/// The typed JSON remains the presentation contract across replay while the
/// duplicate body content keeps generic fallback and copy projections lossless.
pub fn append_irc_traffic(
	session: &mut Session,
	turn: Handle,
	payload: &IrcTraffic,
) -> Result<(), SessionError> {
	let data = serde_json::value::to_raw_value(payload)?;
	session.patch(omp_dom::Txn {
		cause: session.head().ok_or(SessionError::NoActiveTurn)?,
		label: Some(Str::new_static("kernel.irc")),
		ops:   vec![Op::Ins {
			parent: turn,
			after:  session.dom().children(turn).last().copied(),
			node:   NodeSpec::new(KnownTag::Notice)
				.with_prop(PropId::Kind, Value::Str(Str::new_static("irc")))
				.with_prop(PropId::Data, Value::Json(data))
				.with_content(payload.body.clone()),
		}],
	})?;
	Ok(())
}

/// Environment observation or control request for the session authority.
///
/// These messages are ephemeral transport. The kernel translates accepted
/// changes into session patches before they become authoritative.
#[derive(Clone, Debug)]
pub enum EnvEvent {
	/// The extension/device roster changed.
	DeviceAvailability {
		/// Canonical JSON projection of the available devices.
		payload: Str,
	},
	/// A workspace generation was captured before speculative exploration.
	CheckpointOpened {
		/// Opaque token scoped to the bound session controller.
		token:        Str,
		/// Human-readable unique branch label.
		label:        Str,
		/// Human-readable exploration goal.
		goal:         Str,
		/// Immediate checkpoint ancestor on the selected branch.
		parent_token: Option<Str>,
		/// Checkpoint creation time in epoch milliseconds.
		started_at:   u64,
		/// Typed environment-owned workspace generation.
		workspace:    WorkspaceSnapshot,
	},
	/// Workspace restoration completed and the matching journal branch may be
	/// selected.
	CheckpointRewind {
		/// Opaque token scoped to the bound session controller.
		token:      Str,
		/// Findings retained on the selected branch.
		report:     Str,
		/// Stable environment-issued operation receipt.
		receipt:    Str,
		/// Restoration result, including its durable undo generation.
		workspace:  WorkspaceRestored,
		/// Completion time in epoch milliseconds.
		rewound_at: u64,
	},
	/// A staged mutation requires a host-side resolution director.
	StagedPreview {
		/// Stable staged proposal identity.
		proposal_id: Str,
		/// Tool that produced the proposal.
		source_tool: Str,
	},
	/// Replay-stable incoming, autoreply, relay, or work-pool IRC traffic.
	IrcTraffic {
		/// Complete producer-attributed observation, shared across mailbox
		/// fan-out without cloning its message body or attribution strings.
		payload: Arc<IrcTraffic>,
	},
	/// Revision-fenced diagnostics that settled after a mutation tool returned.
	LateDiagnostics(omp_session::late_diagnostics::LateDiagnostics),
	/// A durable extension message projected into inference and the transcript.
	///
	/// Renderer output is optional presentation metadata: its semantic Markdown
	/// body remains authoritative for replay, copy, and fallback rendering.
	CustomMessage(omp_session::custom_message::CustomMessage),
	/// A hook or extension notice journaled as `<notice kind=… name=…>` under
	/// the current turn at the next mailbox drain.
	Notice {
		/// Notice kind (`hook`, `custom`, …).
		kind: Str,
		/// Producer-chosen name.
		name: Option<Str>,
		/// Notice body.
		body: Str,
	},
}
