//! Durable, bounded session-exit diagnostics derived from the authoritative
//! DOM.
//!
//! Exit records live under `<meta><con><session-transitions>` as typed JSON.
//! They are therefore replayed, rewound, replicated, and rendered through the
//! same patch stream as every other session fact. Raw provider/tool/worker
//! output is never persisted here: the crash tail is a small redacted
//! projection containing only identities and the command/path fields useful
//! for recovery.
//!
//! Diagnostics use the authoritative session DOM instead of custom JSONL
//! markers and distinguish provider, tool, and worker failures.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_core::Str;
use omp_dom::{Dom, Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use crate::{Session, SessionError, components::jobs::jobs_handle};

/// Maximum diagnostic records retained in one exit's crash tail.
pub const MAX_CRASH_TAIL_ITEMS: usize = 12;
/// Maximum bytes retained from a human-readable failure detail.
pub const MAX_DETAIL_BYTES: usize = 512;
/// Maximum bytes retained from an identity or label.
pub const MAX_IDENTITY_BYTES: usize = 128;
/// Maximum bytes retained from a pending tool's command or path.
pub const MAX_ARGUMENT_BYTES: usize = 200;

const EXIT_TAG: &str = "session-exit";
const OWNER_PROP: &str = "owner";
const STARTED_PROP: &str = "started";
const AGENT_PROP: &str = "agent";

/// Durable terminal classification independent of the triggering subsystem.
#[derive(
	Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, Display, EnumString, IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum ExitStatus {
	/// The controller completed ordinary teardown with no unfinished work.
	Clean,
	/// A signal or cancellation interrupted otherwise valid work.
	Interrupted,
	/// A provider, tool, worker, or process reported a terminal failure.
	Failed,
	/// The harness itself panicked or crossed another fatal boundary.
	Crashed,
}

/// Process signal captured at the application boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExitSignal {
	/// Stable platform spelling (`SIGINT`, `SIGTERM`, `SIGHUP`, …).
	pub name:   Str,
	/// Numeric platform value when the host exposes it.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub number: Option<i32>,
}

impl ExitSignal {
	/// Constructs a signal identity. The session writer bounds and redacts the
	/// name before persistence.
	#[must_use]
	pub fn new(name: impl Into<Str>, number: Option<i32>) -> Self {
		Self { name: name.into(), number }
	}
}

/// Typed reason the owning application stopped a session.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExitCause {
	/// Ordinary user-requested or programmatic shutdown.
	Normal,
	/// The host received a process signal.
	Signal {
		/// Captured signal identity.
		signal: ExitSignal,
	},
	/// Provider inference failed at the process/session boundary.
	Provider {
		/// Provider identity when known.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		provider: Option<Str>,
		/// Requested model identity when known.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		model:    Option<Str>,
		/// HTTP status when the typed provider error carries one.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		status:   Option<u16>,
		/// Redacted, bounded diagnostic detail.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		detail:   Option<Str>,
	},
	/// A foreground tool failed before normal session teardown.
	Tool {
		/// Tool identity when known.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		name:    Option<Str>,
		/// Stable provider call identity when known.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		call_id: Option<Str>,
		/// Redacted, bounded diagnostic detail.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		detail:  Option<Str>,
	},
	/// A supervised subagent, process, or extension worker failed.
	Worker {
		/// Worker identity when known.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		name:      Option<Str>,
		/// Child exit code when available.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		exit_code: Option<i32>,
		/// Terminating signal when available.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		signal:    Option<ExitSignal>,
		/// Redacted, bounded diagnostic detail.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		detail:    Option<Str>,
	},
	/// An internal panic crossed the session boundary.
	Panic {
		/// Redacted, bounded panic summary. Backtraces belong in bounded log
		/// artifacts, never inline in the journal.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		detail: Option<Str>,
	},
	/// Replay found unfinished work or a torn journal tail without a durable
	/// exit marker. This covers SIGKILL and other boundaries no in-process
	/// handler can observe.
	Unexpected {
		/// Redacted, bounded recovery detail.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		detail: Option<Str>,
	},
	/// A generic process boundary failed without a more precise owner.
	Process {
		/// Exit code when available.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		exit_code: Option<i32>,
		/// Redacted, bounded diagnostic detail.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		detail:    Option<Str>,
	},
}

impl ExitCause {
	/// Status implied by this typed cause before unfinished DOM work is
	/// considered.
	#[must_use]
	pub const fn status(&self) -> ExitStatus {
		match self {
			Self::Normal => ExitStatus::Clean,
			Self::Signal { .. } => ExitStatus::Interrupted,
			Self::Provider { .. } | Self::Tool { .. } | Self::Worker { .. } => ExitStatus::Failed,
			Self::Panic { .. } | Self::Unexpected { .. } => ExitStatus::Crashed,
			Self::Process { exit_code: Some(0), detail: None } => ExitStatus::Clean,
			Self::Process { .. } => ExitStatus::Failed,
		}
	}

	/// Constructs a provider failure.
	#[must_use]
	pub fn provider(
		provider: Option<impl Into<Str>>,
		model: Option<impl Into<Str>>,
		status: Option<u16>,
		detail: Option<impl Into<Str>>,
	) -> Self {
		Self::Provider {
			provider: provider.map(Into::into),
			model: model.map(Into::into),
			status,
			detail: detail.map(Into::into),
		}
	}

	/// Constructs a foreground-tool failure.
	#[must_use]
	pub fn tool(
		name: Option<impl Into<Str>>,
		call_id: Option<impl Into<Str>>,
		detail: Option<impl Into<Str>>,
	) -> Self {
		Self::Tool {
			name:    name.map(Into::into),
			call_id: call_id.map(Into::into),
			detail:  detail.map(Into::into),
		}
	}

	/// Constructs a supervised-worker failure.
	#[must_use]
	pub fn worker(
		name: Option<impl Into<Str>>,
		exit_code: Option<i32>,
		signal: Option<ExitSignal>,
		detail: Option<impl Into<Str>>,
	) -> Self {
		Self::Worker { name: name.map(Into::into), exit_code, signal, detail: detail.map(Into::into) }
	}
}

/// One bounded item explaining what was active at the exit boundary.
#[derive(Clone, Debug, Eq, IntoStaticStr, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum CrashTail {
	/// Provider response stream had started but no assistant end was durable.
	Provider {
		/// Provider identity.
		provider:      Str,
		/// Requested model identity.
		model:         Str,
		/// Resolved route identity.
		route:         Str,
		/// Start instant derived from the assistant entry ULID.
		started_at_ms: u64,
	},
	/// Tool call had no terminal result at the boundary.
	Tool {
		/// Stable call identity.
		call_id:       Str,
		/// Tool identity.
		name:          Str,
		/// Agent-authored invocation intent.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		intent:        Option<Str>,
		/// Bounded command or path projection, never the full arguments.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		argument:      Option<Str>,
		/// Start instant derived from the call entry ULID.
		started_at_ms: u64,
	},
	/// Shared job primitive was still running at the boundary.
	Worker {
		/// Stable job identity.
		id:      Str,
		/// `tool`, `subagent`, or `process`.
		class:   Str,
		/// Human-facing label or agent class when present.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		name:    Option<Str>,
		/// Runtime owner identity when present.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		owner:   Option<Str>,
		/// Producer timestamp representation when present.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		started: Option<Str>,
	},
}

/// Replay-stable exit record stored in the session tree.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionExit {
	/// Terminal classification after unfinished DOM work is considered.
	pub status:             ExitStatus,
	/// Typed owner and cause of termination.
	pub cause:              ExitCause,
	/// Diagnostic instant in Unix milliseconds.
	///
	/// Live exits use the host clock. Crash recovery uses the selected journal
	/// head's ULID timestamp so diagnosis is deterministic across replay.
	pub recorded_at_ms:     u64,
	/// Bounded, redacted active-work projection.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub crash_tail:         Vec<CrashTail>,
	/// Additional active items omitted by [`MAX_CRASH_TAIL_ITEMS`].
	#[serde(default, skip_serializing_if = "is_zero")]
	pub crash_tail_omitted: u32,
}

/// Reads the newest selected-branch exit record from the materialized tree.
#[must_use]
pub fn latest_session_exit(dom: &Dom) -> Option<(Handle, SessionExit)> {
	let transitions = crate::components::lifecycle::transitions_handle(dom)?;
	dom.children(transitions).iter().rev().find_map(|handle| {
		let node = dom.get(*handle)?;
		if node.tag != Tag::Custom(Str::new_static(EXIT_TAG)) {
			return None;
		}
		let Value::Json(data) = node.prop(&PropId::Data.into())? else {
			return None;
		};
		serde_json::from_str(data.get())
			.ok()
			.map(|exit| (*handle, exit))
	})
}

impl Session {
	/// Persists deterministic recovery for work left by a disappeared process.
	///
	/// Opening a session only replays its committed journal. The one writable
	/// controller that adopts the session calls this method before issuing
	/// another provider request. Recovery records the journal-derived crash
	/// tail first, then closes the interrupted assistant and tool calls. A
	/// second call observes those durable terminals and appends nothing.
	///
	/// # Errors
	///
	/// Returns a typed session error when the recovery patch or a synthetic
	/// terminal cannot be committed.
	pub fn recover_process_disappearance(&mut self) -> Result<bool, SessionError> {
		let recovered_tail_bytes = self.journal.recovered_tail_bytes();
		let unfinished = has_unfinished_work(&self.dom);
		let mut changed = false;
		if latest_session_exit(&self.dom).is_none() && (recovered_tail_bytes > 0 || unfinished) {
			let detail = if recovered_tail_bytes == 0 {
				Str::new_static("unfinished work remained after the prior process disappeared")
			} else {
				Str::new(format!(
					"recovered {recovered_tail_bytes} uncommitted journal tail bytes after the prior \
					 process disappeared"
				))
			};
			let recorded_at_ms = self
				.head
				.map(|entry| entry.as_ulid().timestamp_ms())
				.unwrap_or_default();
			self.record_exit_at(ExitCause::Unexpected { detail: Some(detail) }, recorded_at_ms)?;
			changed = true;
		}
		if self.current_assistant.is_some()
			&& latest_session_exit(&self.dom).is_some_and(|(_, exit)| exit.status != ExitStatus::Clean)
		{
			self.assistant_end("aborted")?;
			changed = true;
		}
		if self.recover_unsettled_calls()? != 0 {
			changed = true;
		}
		Ok(changed)
	}

	/// Commits one typed process/session exit and its derived crash tail.
	///
	/// The cause and every tail string are redacted and byte-bounded before
	/// entering the journal. A nominally normal exit with unfinished work is
	/// promoted to [`ExitStatus::Interrupted`].
	///
	/// # Errors
	///
	/// Returns a typed session error when the clock, JSON encoding, journal
	/// append, or atomic DOM patch fails.
	pub fn record_exit(&mut self, cause: ExitCause) -> Result<omp_journal::EntryId, SessionError> {
		let recorded_at_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_err(|source| SessionError::Clock { source })?
			.as_millis()
			.try_into()
			.unwrap_or(u64::MAX);
		self.record_exit_at(cause, recorded_at_ms)
	}

	fn record_exit_at(
		&mut self,
		cause: ExitCause,
		recorded_at_ms: u64,
	) -> Result<omp_journal::EntryId, SessionError> {
		let (crash_tail, crash_tail_omitted) = collect_crash_tail(&self.dom);
		let status = if cause.status() == ExitStatus::Clean && !crash_tail.is_empty() {
			ExitStatus::Interrupted
		} else {
			cause.status()
		};
		let exit = SessionExit {
			status,
			cause: sanitize_cause(cause),
			recorded_at_ms,
			crash_tail,
			crash_tail_omitted,
		};
		let data = serde_json::value::to_raw_value(&exit)?;
		let transitions = crate::components::lifecycle::transitions_handle(&self.dom)
			.ok_or(SessionError::MissingSessionTransitions)?;
		let cause = self.head.ok_or(SessionError::MissingSessionTransitions)?;
		self.patch(Txn {
			cause,
			label: Some(Str::new_static("session.exit")),
			ops: vec![
				Op::Set {
					h:     transitions,
					prop:  PropKey::Custom(Str::new_static(
						crate::components::lifecycle::PROCESS_EXITED,
					)),
					value: Value::Bool(true),
				},
				Op::Ins {
					parent: transitions,
					after:  self.dom.children(transitions).last().copied(),
					node:   NodeSpec::new(Tag::Custom(Str::new_static(EXIT_TAG)))
						.with_prop(PropId::Status, Value::Str(Str::new(status.to_string())))
						.with_prop(PropId::Data, Value::Json(data)),
				},
			],
		})
	}

	/// Removes selected-branch exit markers before a new turn starts. The
	/// removal is itself durable, so rewind restores the warning exactly where
	/// it applied and an acknowledged crash never leaks into later turns.
	pub(crate) fn clear_exit_diagnostics(&mut self) -> Result<(), SessionError> {
		let Some(transitions) = crate::components::lifecycle::transitions_handle(&self.dom) else {
			return Ok(());
		};
		let exits = self
			.dom
			.children(transitions)
			.iter()
			.copied()
			.filter(|handle| {
				self
					.dom
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Custom(Str::new_static(EXIT_TAG)))
			})
			.map(Op::Rm)
			.collect::<Vec<_>>();
		if exits.is_empty() {
			return Ok(());
		}
		let cause = self.head.ok_or(SessionError::MissingSessionTransitions)?;
		self.patch(Txn {
			cause,
			label: Some(Str::new_static("session.exit.acknowledge")),
			ops: exits,
		})?;
		Ok(())
	}
}

/// Whether the selected tree contains provider, tool, or worker state that
/// cannot have survived a process disappearance.
pub(crate) fn has_unfinished_work(dom: &Dom) -> bool {
	let (tail, omitted) = collect_crash_tail(dom);
	!tail.is_empty() || omitted != 0
}

fn collect_crash_tail(dom: &Dom) -> (Vec<CrashTail>, u32) {
	let mut tail = Vec::new();
	let mut omitted = 0_u32;
	for turn in dom.children(dom.body()).iter().rev() {
		for handle in dom.children(*turn).iter().rev() {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			match &node.tag {
				Tag::Known(KnownTag::Assistant) if node.prop(&PropId::StopReason.into()).is_none() => {
					let Some(started_at_ms) = node_entry_ms(node, PropId::Id) else {
						continue;
					};
					push_tail(&mut tail, &mut omitted, CrashTail::Provider {
						provider: bounded_prop(node, PropId::Provider, MAX_IDENTITY_BYTES),
						model: bounded_prop(node, PropId::Model, MAX_IDENTITY_BYTES),
						route: bounded_prop(node, PropId::Route, MAX_IDENTITY_BYTES),
						started_at_ms,
					});
				},
				Tag::Custom(name) if is_running_tool(node) => {
					let Some(started_at_ms) = node_entry_ms(node, PropId::Cause) else {
						continue;
					};
					push_tail(&mut tail, &mut omitted, CrashTail::Tool {
						call_id: bounded_prop(node, PropId::Id, MAX_IDENTITY_BYTES),
						name: bound_redact(name.clone(), MAX_IDENTITY_BYTES),
						intent: optional_prop(node, PropId::I, MAX_DETAIL_BYTES),
						argument: tool_argument(dom, *handle),
						started_at_ms,
					});
				},
				_ => {},
			}
		}
		// Only the newest interrupted turn can own active provider/tool work.
		break;
	}
	if let Some(jobs) = jobs_handle(dom) {
		for handle in dom.children(jobs).iter().rev() {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			if node.prop(&PropId::Status.into()).and_then(Value::as_str) != Some("running") {
				continue;
			}
			push_tail(&mut tail, &mut omitted, CrashTail::Worker {
				id:      bounded_prop(node, PropId::Id, MAX_IDENTITY_BYTES),
				class:   bounded_prop(node, PropId::Kind, MAX_IDENTITY_BYTES),
				name:    optional_prop(node, PropId::Label, MAX_IDENTITY_BYTES)
					.or_else(|| optional_custom_prop(node, AGENT_PROP, MAX_IDENTITY_BYTES)),
				owner:   optional_custom_prop(node, OWNER_PROP, MAX_IDENTITY_BYTES),
				started: optional_custom_prop(node, STARTED_PROP, MAX_IDENTITY_BYTES),
			});
		}
	}
	(tail, omitted)
}

fn push_tail(tail: &mut Vec<CrashTail>, omitted: &mut u32, item: CrashTail) {
	if tail.len() < MAX_CRASH_TAIL_ITEMS {
		tail.push(item);
	} else {
		*omitted = omitted.saturating_add(1);
	}
}

const fn is_zero(value: &u32) -> bool {
	*value == 0
}

fn is_running_tool(node: &omp_dom::Node) -> bool {
	node
		.prop(&PropId::Status.into())
		.and_then(Value::as_str)
		.is_some_and(|status| matches!(status, "arguments" | "running"))
}

fn node_entry_ms(node: &omp_dom::Node, prop: PropId) -> Option<u64> {
	node
		.prop(&prop.into())
		.and_then(Value::as_str)
		.and_then(|id| id.parse::<omp_journal::EntryId>().ok())
		.map(|id| id.as_ulid().timestamp_ms())
}

fn tool_argument(dom: &Dom, tool: Handle) -> Option<Str> {
	let input = dom.children(tool).iter().find_map(|handle| {
		let node = dom.get(*handle)?;
		(node.tag == Tag::Known(KnownTag::Input)).then_some(node)
	})?;
	let raw = match input.prop(&PropId::Data.into()) {
		Some(Value::Json(raw)) => raw.get(),
		_ => input
			.content
			.as_deref()
			.or_else(|| input.prop(&PropId::Text.into()).and_then(Value::as_str))?,
	};
	let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
	let object = value.as_object()?;
	for key in ["command", "path"] {
		if let Some(value) = object.get(key).and_then(serde_json::Value::as_str)
			&& !value.is_empty()
		{
			return Some(bound_redact(Str::new(value), MAX_ARGUMENT_BYTES));
		}
	}
	None
}

fn sanitize_cause(cause: ExitCause) -> ExitCause {
	match cause {
		ExitCause::Normal => ExitCause::Normal,
		ExitCause::Signal { signal } => ExitCause::Signal { signal: sanitize_signal(signal) },
		ExitCause::Provider { provider, model, status, detail } => ExitCause::Provider {
			provider: provider.map(|value| bound_redact(value, MAX_IDENTITY_BYTES)),
			model: model.map(|value| bound_redact(value, MAX_IDENTITY_BYTES)),
			status,
			detail: detail.map(|value| bound_redact(value, MAX_DETAIL_BYTES)),
		},
		ExitCause::Tool { name, call_id, detail } => ExitCause::Tool {
			name:    name.map(|value| bound_redact(value, MAX_IDENTITY_BYTES)),
			call_id: call_id.map(|value| bound_redact(value, MAX_IDENTITY_BYTES)),
			detail:  detail.map(|value| bound_redact(value, MAX_DETAIL_BYTES)),
		},
		ExitCause::Worker { name, exit_code, signal, detail } => ExitCause::Worker {
			name: name.map(|value| bound_redact(value, MAX_IDENTITY_BYTES)),
			exit_code,
			signal: signal.map(sanitize_signal),
			detail: detail.map(|value| bound_redact(value, MAX_DETAIL_BYTES)),
		},
		ExitCause::Panic { detail } => {
			ExitCause::Panic { detail: detail.map(|value| bound_redact(value, MAX_DETAIL_BYTES)) }
		},
		ExitCause::Unexpected { detail } => {
			ExitCause::Unexpected { detail: detail.map(|value| bound_redact(value, MAX_DETAIL_BYTES)) }
		},
		ExitCause::Process { exit_code, detail } => ExitCause::Process {
			exit_code,
			detail: detail.map(|value| bound_redact(value, MAX_DETAIL_BYTES)),
		},
	}
}

fn sanitize_signal(signal: ExitSignal) -> ExitSignal {
	ExitSignal { name: bound_redact(signal.name, MAX_IDENTITY_BYTES), number: signal.number }
}

fn bounded_prop(node: &omp_dom::Node, prop: PropId, maximum: usize) -> Str {
	optional_prop(node, prop, maximum).unwrap_or_default()
}

fn optional_prop(node: &omp_dom::Node, prop: PropId, maximum: usize) -> Option<Str> {
	node
		.prop(&prop.into())
		.and_then(Value::as_str)
		.filter(|value| !value.is_empty())
		.map(|value| bound_redact(Str::new(value), maximum))
}

fn optional_custom_prop(node: &omp_dom::Node, prop: &'static str, maximum: usize) -> Option<Str> {
	node
		.prop(&PropKey::Custom(Str::new_static(prop)))
		.and_then(Value::as_str)
		.filter(|value| !value.is_empty())
		.map(|value| bound_redact(Str::new(value), maximum))
}

fn bound_redact(value: Str, maximum: usize) -> Str {
	let redacted = omp_observability::redact::redact_sensitive_credentials(value.as_str());
	if redacted.len() <= maximum {
		return Str::new(redacted);
	}
	let mut end = maximum.saturating_sub('…'.len_utf8()).min(redacted.len());
	while end > 0 && !redacted.is_char_boundary(end) {
		end -= 1;
	}
	let mut bounded = String::with_capacity(end + '…'.len_utf8());
	bounded.push_str(&redacted[..end]);
	bounded.push('…');
	Str::new(bounded)
}

#[cfg(test)]
mod tests {
	use std::io::Write as _;

	use omp_dom::{Op, PropId, Value};
	use serde_json::value::RawValue;

	use super::*;
	use crate::ComponentRegistry;

	fn session() -> (tempfile::TempDir, Session) {
		let directory = tempfile::tempdir().expect("temporary directory");
		let session =
			Session::create(directory.path().join("exit.oms"), ComponentRegistry::default())
				.expect("session");
		(directory, session)
	}

	#[test]
	fn clean_exit_is_durable_but_not_noteworthy() {
		let (directory, mut session) = session();
		session.record_exit(ExitCause::Normal).expect("exit");
		let (_, exit) = latest_session_exit(session.dom()).expect("exit projection");
		assert_eq!(exit.status, ExitStatus::Clean);
		assert!(exit.crash_tail.is_empty());
		drop(session);
		let restored = Session::open(directory.path().join("exit.oms"), ComponentRegistry::default())
			.expect("replay");
		assert_eq!(
			latest_session_exit(restored.dom()).map(|(_, exit)| exit.status),
			Some(ExitStatus::Clean)
		);
	}

	#[test]
	fn pending_tool_tail_is_typed_bounded_redacted_and_replayed() {
		let (directory, mut session) = session();
		session.begin_turn().expect("turn");
		session.user("run it", Vec::new()).expect("user");
		let call = session
			.call(
				"bash",
				1,
				"call-secret",
				Some(Str::new_static("inspect command")),
				Some(
					RawValue::from_string(
						serde_json::json!({
							"command": format!("echo sk-proj-{} {}", "A".repeat(36), "x".repeat(400))
						})
						.to_string(),
					)
					.expect("raw"),
				),
				None,
			)
			.expect("call");
		assert!(session.entry(call).is_some());
		session.record_exit(ExitCause::Normal).expect("exit");
		let (_, exit) = latest_session_exit(session.dom()).expect("exit projection");
		assert_eq!(exit.status, ExitStatus::Interrupted);
		let CrashTail::Tool { name, intent, argument, .. } = &exit.crash_tail[0] else {
			panic!("tool tail")
		};
		assert_eq!(name, "bash");
		assert_eq!(intent.as_deref(), Some("inspect command"));
		let argument = argument.as_deref().expect("argument summary");
		assert!(argument.len() <= MAX_ARGUMENT_BYTES);
		assert!(!argument.contains("sk-proj-"));
		drop(session);
		let restored = Session::open(directory.path().join("exit.oms"), ComponentRegistry::default())
			.expect("replay");
		let (_, replayed) = latest_session_exit(restored.dom()).expect("replayed exit");
		assert_eq!(replayed, exit);
	}

	#[test]
	fn torn_journal_tail_synthesizes_crashed_exit() {
		let (directory, session) = session();
		let path = session.journal_path().to_path_buf();
		drop(session);
		std::fs::OpenOptions::new()
			.append(true)
			.open(&path)
			.expect("journal")
			.write_all(b"event: patch@1\\n")
			.expect("torn write");

		let mut restored =
			Session::open(directory.path().join("exit.oms"), ComponentRegistry::default())
				.expect("replay");
		assert!(
			latest_session_exit(restored.dom()).is_none(),
			"opening only replays committed state"
		);
		restored
			.recover_process_disappearance()
			.expect("writable owner recovers");
		let (_, exit) = latest_session_exit(restored.dom()).expect("synthesized exit");
		assert_eq!(exit.status, ExitStatus::Crashed);
		let ExitCause::Unexpected { detail } = &exit.cause else {
			panic!("unexpected crash cause")
		};
		assert!(
			detail
				.as_deref()
				.is_some_and(|detail| detail.contains("recovered"))
		);
	}

	#[test]
	fn reopening_unfinished_work_synthesizes_crashed_exit_before_recovery() {
		let (directory, mut session) = session();
		session.begin_turn().expect("turn");
		session.user("run it", Vec::new()).expect("user");
		session
			.call(
				"read",
				1,
				"call-lost",
				Some(Str::new_static("inspect file")),
				Some(RawValue::from_string(r#"{"path":"secret.txt"}"#.to_owned()).expect("raw")),
				None,
			)
			.expect("call");
		let replayed = session.dom().snapshot();
		let recovery_timestamp = session
			.head()
			.expect("journal head")
			.as_ulid()
			.timestamp_ms();
		drop(session);

		let mut restored =
			Session::open(directory.path().join("exit.oms"), ComponentRegistry::default())
				.expect("replay");
		assert_eq!(restored.dom().snapshot(), replayed);
		assert!(latest_session_exit(restored.dom()).is_none());
		assert!(
			restored
				.recover_process_disappearance()
				.expect("owner recovery")
		);
		let recovered = restored.dom().snapshot();
		assert!(
			!restored
				.recover_process_disappearance()
				.expect("idempotent recovery")
		);
		assert_eq!(restored.dom().snapshot(), recovered);
		let (_, exit) = latest_session_exit(restored.dom()).expect("synthesized exit");
		assert_eq!(exit.status, ExitStatus::Crashed);
		assert_eq!(exit.recorded_at_ms, recovery_timestamp);
		assert!(matches!(&exit.cause, ExitCause::Unexpected { .. }));
		assert!(
			matches!(&exit.crash_tail[0], CrashTail::Tool { call_id, .. } if call_id == "call-lost")
		);
		assert!(
			restored.unsettled_calls().is_empty(),
			"recovery settles the call after recording the tail"
		);
	}

	#[test]
	fn unfinished_provider_stream_is_tailed_and_closed_as_aborted() {
		let (directory, mut session) = session();
		session.begin_turn().expect("turn");
		session.user("answer", Vec::new()).expect("user");
		session
			.assistant_start("claude", "anthropic", "anthropic/claude")
			.expect("assistant");
		drop(session);

		let mut restored =
			Session::open(directory.path().join("exit.oms"), ComponentRegistry::default())
				.expect("replay");
		restored
			.recover_process_disappearance()
			.expect("writable owner recovers");
		let (_, exit) = latest_session_exit(restored.dom()).expect("synthesized exit");
		assert!(matches!(
			&exit.crash_tail[0],
			CrashTail::Provider { provider, model, .. }
				if provider == "anthropic" && model == "claude"
		));
		let turn = restored.dom().children(restored.dom().body())[0];
		let assistant = restored
			.dom()
			.children(turn)
			.iter()
			.find_map(|handle| {
				let node = restored.dom().get(*handle)?;
				(node.tag == Tag::Known(KnownTag::Assistant)).then_some(node)
			})
			.expect("assistant");
		assert_eq!(
			assistant
				.prop(&PropId::StopReason.into())
				.and_then(Value::as_str),
			Some("aborted")
		);
	}

	#[test]
	fn signal_provider_tool_worker_and_panic_causes_keep_distinct_statuses() {
		let causes = [
			(
				ExitCause::Signal { signal: ExitSignal::new("SIGTERM", Some(15)) },
				ExitStatus::Interrupted,
			),
			(
				ExitCause::provider(Some("anthropic"), Some("claude"), Some(529), Some("overloaded")),
				ExitStatus::Failed,
			),
			(ExitCause::tool(Some("bash"), Some("call-1"), Some("spawn failed")), ExitStatus::Failed),
			(
				ExitCause::worker(Some("python"), Some(9), None, Some("worker exited")),
				ExitStatus::Failed,
			),
			(ExitCause::Panic { detail: Some(Str::new_static("boom")) }, ExitStatus::Crashed),
			(ExitCause::Unexpected { detail: None }, ExitStatus::Crashed),
		];
		for (cause, status) in causes {
			assert_eq!(cause.status(), status);
		}
	}

	#[test]
	fn new_turn_acknowledges_old_exit_on_the_selected_branch() {
		let (_directory, mut session) = session();
		session
			.record_exit(ExitCause::Signal { signal: ExitSignal::new("SIGHUP", Some(1)) })
			.expect("exit");
		assert!(latest_session_exit(session.dom()).is_some());
		session.begin_turn().expect("turn");
		assert!(latest_session_exit(session.dom()).is_none());
	}

	#[test]
	fn running_worker_is_captured_without_worker_payload() {
		let (_directory, mut session) = session();
		let jobs = jobs_handle(session.dom()).expect("jobs");
		let cause = session.head().expect("head");
		session
			.patch(Txn {
				cause,
				label: Some(Str::new_static("test.worker")),
				ops: vec![Op::Ins {
					parent: jobs,
					after:  None,
					node:   NodeSpec::new(KnownTag::Job)
						.with_prop(PropId::Id, Value::Str(Str::new_static("worker-1")))
						.with_prop(PropId::Kind, Value::Str(Str::new_static("subagent")))
						.with_prop(PropId::Status, Value::Str(Str::new_static("running"))),
				}],
			})
			.expect("worker patch");
		session.record_exit(ExitCause::Normal).expect("exit");
		let (_, exit) = latest_session_exit(session.dom()).expect("exit");
		assert_eq!(exit.status, ExitStatus::Interrupted);
		assert!(matches!(&exit.crash_tail[0], CrashTail::Worker { id, .. } if id == "worker-1"));
	}
}
