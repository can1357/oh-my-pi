//! Auto-retry countdown loader (ERR-07) and the retry-superseded failure
//! elements (ERR-08).
//!
//! When the
//! provider schedules a retry the status container shows one `Loader` row —
//! a warning-colored spinner and the muted text
//! `Retrying (attempt/maxAttempts) in <remaining>… (esc to cancel)` where
//! `remaining = max(0, delayMs - elapsed)` is re-read on every paint. The
//! same handler retracts the previous attempt's synthetic failure cards
//! (`#syntheticFailureCards`, #6879) so the retry's fresh cards never
//! duplicate a call that never ran.

use std::time::Duration;

use omp_core::{Str, StrMut};
use omp_dom::{Dom, Handle, KnownTag, Node, PropId, Tag};
use omp_tui::{Component, PaintCtx, Props, Rect, Slot, UiContext, cell_width, next_slot};

use crate::notices::prop_text;

/// Appended while the primary agent is focused.
const ESC_HINT: &str = " (esc to cancel)";

/// One scheduled provider retry on the presentation clock.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetryState {
	/// One-based attempt about to run.
	pub attempt:      u32,
	/// Attempt budget.
	pub max_attempts: u32,
	/// Backoff before the attempt runs.
	pub delay:        Duration,
	/// Provider failure that triggered the retry.
	pub reason:       Str,
	/// Presentation-clock instant the backoff started.
	pub started:      Duration,
}

impl RetryState {
	/// Records a retry whose backoff started at presentation time `now`.
	#[must_use]
	pub const fn new(
		attempt: u32,
		max_attempts: u32,
		delay: Duration,
		reason: Str,
		now: Duration,
	) -> Self {
		Self { attempt, max_attempts, delay, reason, started: now }
	}

	/// Backoff still to wait at `now`, clamped to zero.
	#[must_use]
	pub const fn remaining(&self, now: Duration) -> Duration {
		self.delay.saturating_sub(now.saturating_sub(self.started))
	}

	/// Whether the backoff has fully elapsed.
	#[must_use]
	pub const fn expired(&self, now: Duration) -> bool {
		self.remaining(now).is_zero()
	}

	/// Backoff still to wait at `now`, in whole milliseconds.
	fn remaining_ms(&self, now: Duration) -> u64 {
		u64::try_from(self.remaining(now).as_millis()).unwrap_or(u64::MAX)
	}

	/// Loader text at `now`: `Retrying (1/3) in 2.5s… (esc to cancel)`.
	#[must_use]
	pub fn label(&self, now: Duration, esc_hint: bool) -> String {
		let mut text = String::new();
		self.write_label(&mut text, now, esc_hint);
		text
	}

	fn write_label(&self, out: &mut impl std::fmt::Write, now: Duration, esc_hint: bool) {
		// `<label> in <remaining>…<esc hint>`.
		let _ = write!(out, "Retrying ({}/{}) in ", self.attempt, self.max_attempts);
		let _ = crate::notices::write_duration(out, self.remaining_ms(now));
		let _ = out.write_char('…');
		if esc_hint {
			let _ = out.write_str(ESC_HINT);
		}
	}

	/// Next instant the label changes: the following whole-second boundary
	/// of the remaining backoff, or `None` once expired.
	#[must_use]
	pub fn next_wake(&self, now: Duration) -> Option<Duration> {
		let remaining = self.remaining(now);
		if remaining.is_zero() {
			return None;
		}
		let into_second =
			Duration::from_nanos(u64::try_from(remaining.as_nanos() % 1_000_000_000).unwrap_or(0));
		let step = if into_second.is_zero() {
			Duration::from_secs(1)
		} else {
			into_second
		};
		Some(now.saturating_add(step))
	}
}

/// Loader for a pending retry: a warning-colored spinner and the muted
/// countdown label on one row, repainted on every spinner frame and on
/// every whole second of the backoff.
pub struct RetryLoader {
	props:    Props,
	slot:     Slot,
	state:    RetryState,
	label:    StrMut,
	/// Remaining milliseconds the retained label was rendered for.
	shown_ms: u64,
}

impl RetryLoader {
	/// Creates the loader for `state`, labelled as of the backoff start.
	#[must_use]
	pub fn new(state: RetryState) -> Self {
		let mut label = StrMut::with_capacity(48);
		state.write_label(&mut label, state.started, true);
		let shown_ms = state.remaining_ms(state.started);
		Self { props: Props::new(), slot: next_slot(), state, label, shown_ms }
	}

	/// The retry this loader counts down.
	#[must_use]
	pub const fn state(&self) -> &RetryState {
		&self.state
	}

	/// Re-renders the retained label in place when the remaining time moved.
	fn refresh(&mut self, now: Duration) {
		let remaining_ms = self.state.remaining_ms(now);
		if remaining_ms == self.shown_ms {
			return;
		}
		self.label.truncate(0);
		self.state.write_label(&mut self.label, now, true);
		self.shown_ms = remaining_ms;
	}
}

impl Component for RetryLoader {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn paints_border(&self) -> bool {
		false
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		// glyph, space, label
		(1, cell_width(self.label.as_str()).saturating_add(2))
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip || rect.width == 0 {
			return;
		}
		let now = pc.now;
		self.refresh(now);
		let frames = pc.ctx.charset.spinner();
		let base = self.props.style(&pc.ctx.theme);
		let column = pc
			.frame
			.put(rect.x, rect.y, frames.at(now), base.fg(pc.ctx.theme.warn));
		let column = pc.frame.put(column, rect.y, " ", base);
		pc.frame
			.put(column, rect.y, self.label.as_str(), base.fg(pc.ctx.theme.muted));
		let mut wake = frames.next_change(now);
		if let Some(second) = self.state.next_wake(now) {
			wake = wake.min(second);
		}
		pc.wake(self.slot, wake);
	}
}

/// Elements of the last turn that a retry supersedes.
///
/// The trailing `<notice kind=error>` and every
/// tool call settled `error | aborted | cancelled` without ever producing
/// result or diagnostic text. The host drops these blocks from the live
/// projection when the retry starts so the re-streamed attempt does not
/// render the same call twice.
#[must_use]
pub fn superseded_notice_keys(dom: &Dom) -> Vec<Handle> {
	let Some(turn) = last_turn(dom) else {
		return Vec::new();
	};
	let mut keys = Vec::new();
	for handle in dom.children(turn) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		match &node.tag {
			Tag::Known(KnownTag::Notice) => {
				if prop_text(node, PropId::Kind).is_some_and(|kind| kind.as_str() == "error") {
					keys.push(*handle);
				}
			},
			Tag::Custom(_) => {
				let failed = prop_text(node, PropId::Status)
					.is_some_and(|status| matches!(status.as_str(), "error" | "aborted" | "cancelled"));
				if failed && !ran(dom, *handle) {
					keys.push(*handle);
				}
			},
			Tag::Known(_) => {},
		}
	}
	keys
}

/// The last `<turn>` under `<body>`.
pub(crate) fn last_turn(dom: &Dom) -> Option<Handle> {
	dom.children(dom.body())
		.iter()
		.rev()
		.copied()
		.find(|handle| {
			dom.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Turn))
		})
}

/// Whether a tool element carries any `<result>` or `<diag>` text — a call
/// that ran, as opposed to one the failing turn settled synthetically.
fn ran(dom: &Dom, tool: Handle) -> bool {
	dom.children(tool)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.filter(|node| matches!(node.tag, Tag::Known(KnownTag::Result | KnownTag::Diag)))
		.any(|node| node_text(node).is_some_and(|text| !text.is_empty()))
}

fn node_text(node: &Node) -> Option<Str> {
	node
		.content
		.clone()
		.or_else(|| prop_text(node, PropId::Text))
}

#[cfg(test)]
mod tests {
	use omp_dom::{NodeSpec, Op, Txn, Value};
	use omp_session::{ComponentRegistry, Session};
	use omp_tui::{Ui, frame_text};
	use serde_json::value::RawValue;

	use super::*;

	fn state(delay_ms: u64, started_ms: u64) -> RetryState {
		RetryState::new(
			1,
			3,
			Duration::from_millis(delay_ms),
			Str::new_static("rate limited"),
			Duration::from_millis(started_ms),
		)
	}

	#[test]
	fn retry_label_counts_down_whole_seconds() {
		let state = state(3_000, 10_000);
		assert_eq!(
			state.label(Duration::from_millis(10_000), true),
			"Retrying (1/3) in 3.0s… (esc to cancel)"
		);
		assert_eq!(
			state.label(Duration::from_millis(11_200), true),
			"Retrying (1/3) in 1.8s… (esc to cancel)"
		);
		assert_eq!(
			state.label(Duration::from_millis(13_500), true),
			"Retrying (1/3) in 0ms… (esc to cancel)"
		);
		assert_eq!(state.label(Duration::from_secs(10), false), "Retrying (1/3) in 3.0s…");
		assert!(!state.expired(Duration::from_millis(12_999)));
		assert!(state.expired(Duration::from_secs(13)));
		assert_eq!(
			state.remaining(Duration::from_secs(5)),
			Duration::from_secs(3),
			"pre-start clock saturates"
		);
	}

	#[test]
	fn retry_next_wake_hits_second_boundaries() {
		let state = state(3_000, 10_000);
		assert_eq!(state.next_wake(Duration::from_secs(10)), Some(Duration::from_secs(11)));
		assert_eq!(state.next_wake(Duration::from_millis(11_200)), Some(Duration::from_secs(12)));
		assert_eq!(state.next_wake(Duration::from_millis(12_999)), Some(Duration::from_secs(13)));
		assert_eq!(state.next_wake(Duration::from_secs(13)), None);
		assert_eq!(state.next_wake(Duration::from_secs(20)), None);
	}

	#[test]
	fn retry_loader_paints_spinner_and_label_and_reschedules() {
		let mut ui = Ui::from_root(RetryLoader::new(state(2_500, 0)), 60, UiContext::default());
		assert_eq!(frame_text(ui.frame()), "⠋ Retrying (1/3) in 2.5s… (esc to cancel)");
		assert_eq!(
			ui.next_wake(),
			Some(Duration::from_millis(80)),
			"spinner frame precedes the second"
		);

		assert!(ui.tick(Duration::from_millis(80)));
		assert_eq!(frame_text(ui.frame()), "⠙ Retrying (1/3) in 2.4s… (esc to cancel)");

		assert!(ui.tick(Duration::from_millis(1_000)));
		assert_eq!(frame_text(ui.frame()), "⠹ Retrying (1/3) in 1.5s… (esc to cancel)");
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(1_040)));

		assert!(ui.tick(Duration::from_millis(2_500)));
		assert_eq!(frame_text(ui.frame()), "⠙ Retrying (1/3) in 0ms… (esc to cancel)");
		assert_eq!(
			ui.next_wake(),
			Some(Duration::from_millis(2_560)),
			"only the spinner keeps waking once expired"
		);
	}

	fn raw(json: &str) -> Box<RawValue> {
		RawValue::from_string(json.to_owned()).expect("valid json")
	}

	fn append_notice(session: &mut Session, turn: Handle, kind: &'static str, text: &'static str) {
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
	fn superseded_keys_pick_never_ran_failures() {
		let directory = tempfile::tempdir().expect("temp directory");
		let mut session =
			Session::create(directory.path().join("retry.oms"), ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn");
		session.user("hello", Vec::new()).expect("user");
		let turn = last_turn(session.dom()).expect("turn handle");
		let ok = session
			.call("read", 1, "call-ok", None, Some(raw("{}")), None)
			.expect("call");
		session
			.settle(ok, raw("{\"text\":\"done\"}"))
			.expect("settle");
		session
			.call("bash", 1, "call-aborted", None, Some(raw("{}")), None)
			.expect("call");
		let aborted = *session.dom().children(turn).last().expect("tool handle");
		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: None,
				ops:   vec![Op::Set {
					h:     aborted,
					prop:  PropId::Status.into(),
					value: Value::Str(Str::new_static("aborted")),
				}],
			})
			.expect("abort");
		append_notice(&mut session, turn, "error", "provider exploded");
		let notice = *session.dom().children(turn).last().expect("notice handle");

		assert_eq!(superseded_notice_keys(session.dom()), [aborted, notice]);
	}

	#[test]
	fn superseded_keys_skip_failures_that_ran() {
		let directory = tempfile::tempdir().expect("temp directory");
		let mut session =
			Session::create(directory.path().join("retry.oms"), ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn");
		session.user("hello", Vec::new()).expect("user");
		let turn = last_turn(session.dom()).expect("turn handle");
		let call = session
			.call("bash", 1, "call-failed", None, Some(raw("{}")), None)
			.expect("call");
		session
			.fail(call, raw("{\"error\":\"exit 1\"}"))
			.expect("fail");
		append_notice(&mut session, turn, "warn", "Turn interrupted");

		assert_eq!(superseded_notice_keys(session.dom()), []);
	}
}
