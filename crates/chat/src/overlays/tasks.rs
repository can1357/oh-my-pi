//! Panel over one asynchronous service request: a cancellable loader while
//! the request runs, then its settled line. `/share`
//! and `/cleanse` open one; the host polls it through [`Panel::tick`] so
//! the actor never blocks on the application.

use std::time::Duration;

use flume::Sender;
use omp_core::{Str, sf};
use omp_tui::{Frame, Key, Size, Ui, UiContext, components::Loader, dom};

use super::{Panel, PanelAnchor, PanelEvent, services::Pending};

/// Poll cadence while the request is pending.
const POLL: Duration = Duration::from_millis(100);
const PENDING_HINT: &str = "esc cancel";
const SETTLED_HINT: &str = "Esc close";

/// Where a settled result goes besides the panel row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Settle {
	/// Show the line only.
	Show,
	/// Show the line and copy it to the clipboard (share URLs).
	Copy,
}

enum State {
	Pending(Pending<Str>),
	Done(Str),
	Failed(Str),
	Cancelled,
}

/// Retained loader-then-result panel.
pub struct PendingPanel {
	id:        &'static str,
	anchor:    PanelAnchor,
	title:     Str,
	message:   Str,
	state:     State,
	cancel:    Option<Sender<()>>,
	settle:    Settle,
	/// Copy requested by the settle policy and not yet delivered.
	copy_due:  bool,
	next_wake: Option<Duration>,
	ui:        Ui,
	ctx:       UiContext,
	width:     u16,
}

impl PendingPanel {
	/// Opens a panel over `pending`, showing `message` beside the spinner.
	#[must_use]
	pub fn new(
		id: &'static str,
		anchor: PanelAnchor,
		title: impl Into<Str>,
		message: impl Into<Str>,
		pending: Pending<Str>,
		cancel: Option<Sender<()>>,
		settle: Settle,
		ctx: &UiContext,
	) -> Self {
		let mut panel = Self {
			id,
			anchor,
			title: title.into(),
			message: message.into(),
			state: State::Pending(pending),
			cancel,
			settle,
			copy_due: false,
			next_wake: Some(Duration::ZERO),
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 0,
		};
		panel.rebuild(80);
		panel
	}

	/// The settled line, once the request completed.
	#[must_use]
	pub fn result(&self) -> Option<&str> {
		match &self.state {
			State::Done(line) | State::Failed(line) => Some(line),
			State::Pending(_) | State::Cancelled => None,
		}
	}

	fn rebuild(&mut self, width: u16) {
		self.width = width;
		let title = self.title.clone();
		let tree = match &self.state {
			State::Pending(_) => {
				let loader = Loader::new(self.message.clone()).hint(PENDING_HINT);
				dom! { <box border=round title={title}>{loader}</box> }
			},
			State::Done(line) => {
				let line = line.clone();
				dom! {
					<box border=round title={title} pad-x=1>
						<col>
							<text wrap>{line}</text>
							<text fg=muted>{SETTLED_HINT}</text>
						</col>
					</box>
				}
			},
			State::Failed(line) => {
				let line = line.clone();
				dom! {
					<box border=round title={title} pad-x=1>
						<col>
							<text fg=err wrap>{line}</text>
							<text fg=muted>{SETTLED_HINT}</text>
						</col>
					</box>
				}
			},
			State::Cancelled => dom! {
				<box border=round title={title} pad-x=1>
					<col>
						<text fg=muted>{"Cancelled"}</text>
						<text fg=muted>{SETTLED_HINT}</text>
					</col>
				</box>
			},
		};
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
	}
}

impl Panel for PendingPanel {
	fn id(&self) -> &'static str {
		self.id
	}

	fn anchor(&self) -> PanelAnchor {
		self.anchor
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => {
				if let State::Pending(_) = self.state {
					if let Some(cancel) = self.cancel.take() {
						let _ = cancel.send(());
					}
					self.state = State::Cancelled;
					self.next_wake = None;
					self.rebuild(self.width);
					PanelEvent::Close
				} else {
					PanelEvent::Close
				}
			},
			Key::Enter | Key::Char('q') if !matches!(self.state, State::Pending(_)) => {
				PanelEvent::Close
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let width = match self.anchor {
			PanelAnchor::Center | PanelAnchor::Full => viewport.width,
			PanelAnchor::Bottom | PanelAnchor::BottomCenter | PanelAnchor::Side => viewport.width,
		};
		if width != self.width {
			self.rebuild(width);
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		let State::Pending(pending) = &self.state else {
			return false;
		};
		match pending.try_recv() {
			Ok(Ok(line)) => {
				self.copy_due = self.settle == Settle::Copy;
				self.state = State::Done(line);
			},
			Ok(Err(error)) => self.state = State::Failed(sf!("{error}")),
			Err(flume::TryRecvError::Disconnected) => {
				self.state = State::Failed(Str::new_static("the request was dropped before settling"));
			},
			Err(flume::TryRecvError::Empty) => {
				self.next_wake = Some(now + POLL);
				return false;
			},
		}
		self.next_wake = None;
		self.rebuild(self.width);
		true
	}

	fn next_wake(&self) -> Option<Duration> {
		self.next_wake
	}

	fn settled(&mut self) -> Option<PanelEvent> {
		if self.copy_due {
			self.copy_due = false;
			if let State::Done(line) = &self.state {
				return Some(PanelEvent::Copy(line.clone()));
			}
		}
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn loader_then_result_then_close() {
		let ctx = UiContext::default();
		let (tx, rx) = flume::bounded(1);
		let (cancel_tx, cancel_rx) = flume::bounded(1);
		let mut panel = PendingPanel::new(
			"share",
			PanelAnchor::Center,
			"Share",
			"Sharing session…",
			rx,
			Some(cancel_tx),
			Settle::Copy,
			&ctx,
		);
		let text = omp_tui::frame_text(panel.frame(Size { width: 50, height: 12 }));
		assert!(text.contains("Sharing session"), "loader missing:\n{text}");
		assert!(text.contains("esc cancel"), "hint missing:\n{text}");
		assert!(!panel.tick(Duration::ZERO), "nothing settled yet");
		assert_eq!(panel.next_wake(), Some(POLL));
		tx.send(Ok(Str::new_static("https://share.example/#k")))
			.unwrap();
		assert!(panel.tick(POLL), "settling repaints");
		assert_eq!(
			panel.settled(),
			Some(PanelEvent::Copy(Str::new_static("https://share.example/#k")))
		);
		assert_eq!(panel.settled(), None, "copy delivered once");
		let text = omp_tui::frame_text(panel.frame(Size { width: 50, height: 12 }));
		assert!(text.contains("share.example"), "result missing:\n{text}");
		assert!(text.contains("Esc close"), "settled hint missing:\n{text}");
		assert_eq!(panel.key(Key::Enter), PanelEvent::Close);
		assert!(cancel_rx.try_recv().is_err(), "settled runs are never cancelled");
	}

	#[test]
	fn escape_while_pending_cancels() {
		let ctx = UiContext::default();
		let (_tx, rx) = flume::bounded::<Result<Str, super::super::services::ServiceError>>(1);
		let (cancel_tx, cancel_rx) = flume::bounded(1);
		let mut panel = PendingPanel::new(
			"cleanse",
			PanelAnchor::Side,
			"Cleanse",
			"Cleansing workspace…",
			rx,
			Some(cancel_tx),
			Settle::Show,
			&ctx,
		);
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
		assert!(cancel_rx.try_recv().is_ok(), "Esc sends the cancellation");
	}
}
