//! Desktop notifications on turn completion, terminal error, and a tool
//! waiting for interactive input (NOTIF-01, NOTIF-06, NOTIF-07).
//!
//! Delivery (OSC 99 / OSC 9 / BEL, tmux passthrough, D-Bus and
//! `notify-send` fallbacks) lives in `omp_tui::notify`; this module only
//! decides *whether* to toast and builds the [`Notification`].
//!
//! On `agent_end`, the error toast fires when the last assistant stopped with
//! `error`, gated by `error.notify` and
//! suppressed while an auto-retry is outstanding; the completion toast fires
//! otherwise, gated by `completion.notify`, and never for an aborted or
//! errored turn — so one settled turn yields at most one of the two. The
//! title is the session name, else the app name; bodies are `Stopped with
//! error` and `Complete`; both request window focus. `ask.notify` toasts
//! when the ask tool blocks on the user.

use omp_con::Ctx;
use omp_core::Str;
use omp_dom::{Dom, KnownTag, PropId, Tag};
use omp_tui::{Notification, NotificationAction, NotificationSound, Urgency, cell_width};

use crate::notices::{prop_text, retry::last_turn};

omp_con::var! {
	/// Notify when the agent finishes a turn.
	pub static CL_NOTIFY_COMPLETION = cl_notify_completion: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Notifications",
			"ui.label": "Completion Notification",
			"legacy.path": "completion.notify",
		},
	};
	/// Notify when the agent stops with an error.
	pub static CL_NOTIFY_ERROR = cl_notify_error: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Notifications",
			"ui.label": "Error Notification",
			"legacy.path": "error.notify",
		},
	};
	/// Notify when the ask tool is waiting for input.
	pub static CL_NOTIFY_ASK = cl_notify_ask: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Notifications",
			"ui.label": "Ask Notification",
			"legacy.path": "ask.notify",
		},
	};
}

/// Default notification title.
const APP_TITLE: &str = "omp";
/// Completion notification body.
const COMPLETION_BODY: &str = "Complete";
/// Error notification body.
const ERROR_BODY: &str = "Stopped with error";
/// Cells kept from the first line of an ask question.
const ASK_BODY_CELLS: u16 = 120;
/// `crates/agent/src/steering.rs::append_interrupt_notice` text.
const INTERRUPT_NOTICE: &str = "Turn interrupted";

/// How a settled turn ended, as read from the session tree.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TurnEnd {
	/// The assistant finished on its own.
	Completed,
	/// The turn stopped with a terminal provider error.
	Errored,
	/// The user interrupted the turn.
	Aborted,
}

/// Decides which desktop notifications a settled turn or a waiting tool
/// earns.
#[derive(Clone, Debug, Default)]
pub struct Notifier {
	session_name:  Option<Str>,
	retry_pending: bool,
}

impl Notifier {
	/// Creates a notifier titling toasts with `session_name`, else the app
	/// name.
	#[must_use]
	pub const fn new(session_name: Option<Str>) -> Self {
		Self { session_name, retry_pending: false }
	}

	/// Marks whether an auto-retry is outstanding (set on
	/// `auto_retry_start`, cleared on `auto_retry_end`) mutes the error toast
	/// for a failure the retry may still recover from.
	pub const fn set_retry_pending(&mut self, pending: bool) {
		self.retry_pending = pending;
	}

	/// Updates the toast title after a rename or session switch.
	pub fn set_session_name(&mut self, name: Option<Str>) {
		self.session_name = name;
	}

	/// The toast for a settled turn, if its kind is enabled: `Complete` for a
	/// completed turn, `Stopped with error` for an errored one with no retry
	/// pending, nothing for an interrupt. Never both for one turn.
	#[must_use]
	pub fn turn_ended(&self, con: &Ctx, end: TurnEnd) -> Option<Notification> {
		match end {
			TurnEnd::Completed if CL_NOTIFY_COMPLETION.get(con) => Some(
				self
					.toast()
					.body(Str::new_static(COMPLETION_BODY))
					.notification_type(Str::new_static("completion"))
					.build(),
			),
			TurnEnd::Errored if CL_NOTIFY_ERROR.get(con) && !self.retry_pending => Some(
				self
					.toast()
					.body(Str::new_static(ERROR_BODY))
					.notification_type(Str::new_static("error"))
					.urgency(Urgency::Critical)
					.sound(NotificationSound::Error)
					.build(),
			),
			TurnEnd::Completed | TurnEnd::Errored | TurnEnd::Aborted => None,
		}
	}

	/// The toast for a tool blocked on the user, if enabled: the first line
	/// of `question` clipped to 120 cells.
	#[must_use]
	pub fn ask_pending(&self, con: &Ctx, question: &str) -> Option<Notification> {
		if !CL_NOTIFY_ASK.get(con) {
			return None;
		}
		Some(
			self
				.toast()
				.body(ask_body(question))
				.notification_type(Str::new_static("ask"))
				.urgency(Urgency::Normal)
				.sound(NotificationSound::Question)
				.build(),
		)
	}

	/// Classifies the last turn of `dom`: an error notice tail is
	/// [`TurnEnd::Errored`], an interrupt notice tail is [`TurnEnd::Aborted`],
	/// an assistant closed with a stop reason other than `tool_calls` while
	/// every tool has settled is [`TurnEnd::Completed`]; a turn still in
	/// flight is `None`.
	#[must_use]
	pub fn turn_end_from_dom(dom: &Dom) -> Option<TurnEnd> {
		let turn = last_turn(dom)?;
		let mut stop_reason: Option<Str> = None;
		let mut tool_open = false;
		let mut tail: Option<TurnEnd> = None;
		for handle in dom.children(turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			match &node.tag {
				Tag::Known(KnownTag::Assistant) => {
					stop_reason = prop_text(node, PropId::StopReason);
					tail = None;
				},
				Tag::Custom(_) => {
					tool_open |= !prop_text(node, PropId::Status).is_some_and(|status| {
						matches!(status.as_str(), "ok" | "error" | "cancelled" | "aborted")
					});
					tail = None;
				},
				Tag::Known(KnownTag::Notice) => {
					let kind = prop_text(node, PropId::Kind);
					tail = match kind.as_deref() {
						Some("error") => Some(TurnEnd::Errored),
						Some("warn" | "warning")
							if node.content.as_deref().is_some_and(|text| {
								text.starts_with(INTERRUPT_NOTICE) || text.starts_with("Interrupted")
							}) =>
						{
							Some(TurnEnd::Aborted)
						},
						_ => tail,
					};
				},
				Tag::Known(_) => {},
			}
		}
		if tail.is_some() {
			return tail;
		}
		let stop_reason = stop_reason?;
		if tool_open {
			return None;
		}
		match stop_reason.as_str() {
			"tool_calls" => None,
			"error" => Some(TurnEnd::Errored),
			"cancelled" | "aborted" => Some(TurnEnd::Aborted),
			_ => Some(TurnEnd::Completed),
		}
	}

	fn toast(&self) -> omp_tui::NotificationBuilder {
		let title = self
			.session_name
			.clone()
			.unwrap_or_else(|| Str::new_static(APP_TITLE));
		Notification::builder()
			.title(title)
			.actions(NotificationAction::Focus)
	}
}

/// The first line of `question`, clipped to [`ASK_BODY_CELLS`] with an
/// ellipsis when cut.
fn ask_body(question: &str) -> Str {
	let line = question
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.unwrap_or("Waiting for input");
	let mut cells = 0u16;
	let mut buffer = [0u8; 4];
	for (index, ch) in line.char_indices() {
		let width = cell_width(ch.encode_utf8(&mut buffer));
		if cells.saturating_add(width) > ASK_BODY_CELLS.saturating_sub(1) {
			let mut clipped = String::with_capacity(index + 3);
			clipped.push_str(&line[..index]);
			clipped.push('…');
			return Str::new(clipped);
		}
		cells = cells.saturating_add(width);
	}
	Str::new(line)
}

#[cfg(test)]
mod tests {
	use omp_con::Source;
	use omp_dom::{NodeSpec, Op, Txn, Value};
	use omp_session::{ComponentRegistry, Session};
	use serde_json::value::RawValue;

	use super::*;

	fn ctx() -> Ctx {
		Ctx::builder().build()
	}

	#[test]
	fn completion_toast_respects_convar() {
		let con = ctx();
		let notifier = Notifier::new(Some(Str::new_static("refactor")));
		let toast = notifier
			.turn_ended(&con, TurnEnd::Completed)
			.expect("enabled by default");
		assert_eq!(toast.title.as_deref(), Some("refactor"));
		assert_eq!(toast.body.as_deref(), Some("Complete"));
		assert_eq!(toast.actions, Some(NotificationAction::Focus));

		con.exec("cl_notify_completion 0", Source::Console)
			.expect("set");
		con.exec("cl_notify_error 1", Source::Console)
			.expect("opt in");
		assert_eq!(notifier.turn_ended(&con, TurnEnd::Completed), None);
		assert!(
			notifier.turn_ended(&con, TurnEnd::Errored).is_some(),
			"the error toast has its own switch"
		);
	}

	#[test]
	fn error_toast_is_opt_in_like_pi_error_notify() {
		let con = ctx();
		let notifier = Notifier::new(None);
		assert_eq!(
			notifier.turn_ended(&con, TurnEnd::Errored),
			None,
			"error notifications default to off"
		);
		assert!(notifier.turn_ended(&con, TurnEnd::Completed).is_some());
		con.exec("cl_notify_error 1", Source::Console).expect("set");
		assert!(notifier.turn_ended(&con, TurnEnd::Errored).is_some());
	}

	#[test]
	fn error_toast_suppressed_while_retry_pending() {
		let con = ctx();
		con.exec("cl_notify_error 1", Source::Console)
			.expect("opt in");
		let mut notifier = Notifier::new(None);
		let toast = notifier
			.turn_ended(&con, TurnEnd::Errored)
			.expect("enabled");
		assert_eq!(toast.title.as_deref(), Some("omp"), "app name when the session is unnamed");
		assert_eq!(toast.body.as_deref(), Some("Stopped with error"));

		notifier.set_retry_pending(true);
		assert_eq!(notifier.turn_ended(&con, TurnEnd::Errored), None);
		notifier.set_retry_pending(false);
		assert!(notifier.turn_ended(&con, TurnEnd::Errored).is_some());

		con.exec("cl_notify_error 0", Source::Console).expect("set");
		assert_eq!(notifier.turn_ended(&con, TurnEnd::Errored), None);
		assert!(
			notifier.turn_ended(&con, TurnEnd::Completed).is_some(),
			"the completion toast has its own switch"
		);
	}

	#[test]
	fn aborted_turn_never_notifies() {
		let con = ctx();
		let mut notifier = Notifier::new(Some(Str::new_static("named")));
		assert_eq!(notifier.turn_ended(&con, TurnEnd::Aborted), None);
		notifier.set_retry_pending(true);
		assert_eq!(notifier.turn_ended(&con, TurnEnd::Aborted), None);
	}

	#[test]
	fn ask_toast_uses_first_line() {
		let con = ctx();
		let mut notifier = Notifier::new(None);
		notifier.set_session_name(Some(Str::new_static("deploy")));
		let toast = notifier
			.ask_pending(&con, "\n  Which region?  \nOptions: us, eu")
			.expect("enabled by default");
		assert_eq!(toast.title.as_deref(), Some("deploy"));
		assert_eq!(toast.body.as_deref(), Some("Which region?"));
		assert_eq!(toast.urgency, Some(Urgency::Normal));
		assert_eq!(toast.sound, Some(NotificationSound::Question));
		assert_eq!(toast.actions, Some(NotificationAction::Focus));

		let long = "x".repeat(200);
		let toast = notifier.ask_pending(&con, &long).expect("toast");
		let body = toast.body.expect("body");
		assert_eq!(cell_width(body.as_str()), ASK_BODY_CELLS);
		assert!(body.as_str().ends_with('…'));

		let blank = notifier.ask_pending(&con, "\n\n").expect("toast");
		assert_eq!(blank.body.as_deref(), Some("Waiting for input"));

		con.exec("cl_notify_ask 0", Source::Console).expect("set");
		assert_eq!(notifier.ask_pending(&con, "Which region?"), None);
	}

	fn raw(json: &str) -> Box<RawValue> {
		RawValue::from_string(json.to_owned()).expect("valid json")
	}

	fn session(directory: &tempfile::TempDir, name: &str) -> Session {
		let mut session = Session::create(directory.path().join(name), ComponentRegistry::standard())
			.expect("session");
		session.begin_turn().expect("turn");
		session.user("hello", Vec::new()).expect("user");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		session
	}

	fn append_notice(session: &mut Session, kind: &'static str, text: &'static str) {
		let turn = last_turn(session.dom()).expect("turn");
		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: Some(Str::new_static("kernel.notice")),
				ops:   vec![Op::Ins {
					parent: turn,
					after:  session.dom().children(turn).last().copied(),
					node:   NodeSpec::new(KnownTag::Notice)
						.with_prop(PropId::Kind, Value::Str(Str::new_static(kind)))
						.with_content(Str::new_static(text)),
				}],
			})
			.expect("notice");
	}

	#[test]
	fn turn_end_classifies_error_interrupt_and_completion() {
		let directory = tempfile::tempdir().expect("temp directory");

		let mut errored = session(&directory, "error.oms");
		assert_eq!(Notifier::turn_end_from_dom(errored.dom()), None, "open assistant");
		errored.assistant_end("error").expect("end");
		append_notice(&mut errored, "error", "provider exploded");
		assert_eq!(Notifier::turn_end_from_dom(errored.dom()), Some(TurnEnd::Errored));

		let mut interrupted = session(&directory, "interrupt.oms");
		interrupted.assistant_end("cancelled").expect("end");
		append_notice(&mut interrupted, "warn", INTERRUPT_NOTICE);
		assert_eq!(Notifier::turn_end_from_dom(interrupted.dom()), Some(TurnEnd::Aborted));

		let mut completed = session(&directory, "complete.oms");
		completed.assistant_end("tool_calls").expect("end");
		let call = completed
			.call("read", 1, "call-1", None, Some(raw("{}")), None)
			.expect("call");
		assert_eq!(Notifier::turn_end_from_dom(completed.dom()), None, "tool still running");
		completed
			.settle(call, raw("{\"text\":\"done\"}"))
			.expect("settle");
		assert_eq!(
			Notifier::turn_end_from_dom(completed.dom()),
			None,
			"tool_calls continues the turn"
		);
		completed
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		assert_eq!(Notifier::turn_end_from_dom(completed.dom()), None, "second assistant open");
		completed.assistant_end("stop").expect("end");
		completed
			.receipt(omp_journal::data::TurnReceipt {
				tokens_in: 10,
				tokens_out: 5,
				..Default::default()
			})
			.expect("receipt");
		assert_eq!(Notifier::turn_end_from_dom(completed.dom()), Some(TurnEnd::Completed));

		let mut plain = session(&directory, "warn.oms");
		plain.assistant_end("stop").expect("end");
		append_notice(&mut plain, "warn", "Context is 90% full");
		assert_eq!(
			Notifier::turn_end_from_dom(plain.dom()),
			Some(TurnEnd::Completed),
			"an ordinary warning is not an interrupt"
		);
	}
}
