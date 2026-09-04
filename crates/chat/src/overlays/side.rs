//! Side-channel panel above the editor for `/btw`: the question as a header
//! with a status
//! indicator, the answer streamed in below it, `c` to copy, Esc to close
//! (aborting the side kernel when it is still answering). The composer
//! stays live underneath (`PanelAnchor::Side`).

use std::time::Duration;

use flume::Receiver;
use omp_core::{Str, StrMut};
use omp_tui::{Frame, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, dom};

use super::{Panel, PanelAnchor, PanelCx, PanelEvent, services::SideEvent};

/// Streaming poll cadence while the side kernel is answering.
const POLL: Duration = Duration::from_millis(33);
const HINT_RUNNING: &str = "esc close (aborts) · c copy answer";
const HINT_DONE: &str = "esc close · c copy answer";
/// Border, header, rule, hint rows around the answer pane.
const CHROME_ROWS: u16 = 5;
/// Answer pane cap: the side panel never eats the transcript.
const MAX_ROWS: u16 = 12;

/// Side-panel status badge.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SideStatus {
	/// The side kernel is still streaming.
	Running,
	/// The answer is complete.
	Complete,
	/// The side kernel failed.
	Error,
	/// The user closed the panel while streaming.
	Aborted,
}

impl SideStatus {
	const fn label(self) -> &'static str {
		match self {
			Self::Running => "running",
			Self::Complete => "complete",
			Self::Error => "error",
			Self::Aborted => "aborted",
		}
	}
}

/// Retained `/btw` side panel.
pub struct SidePanel {
	question: Str,
	answer:   StrMut,
	error:    Option<Str>,
	status:   SideStatus,
	events:   Receiver<SideEvent>,
	ui:       Ui,
	ctx:      UiContext,
	width:    u16,
	rows:     u16,
	last:     Duration,
}

impl SidePanel {
	/// Opens the panel over a streaming side answer.
	#[must_use]
	pub fn btw(question: Str, events: Receiver<SideEvent>, cx: &PanelCx<'_>) -> Self {
		let mut panel = Self {
			question,
			answer: StrMut::new(""),
			error: None,
			status: SideStatus::Running,
			events,
			ui: Ui::from_root(dom! { <col/> }, cx.viewport.width, cx.ui.clone()),
			ctx: cx.ui.clone(),
			width: cx.viewport.width,
			rows: 3,
			last: Duration::ZERO,
		};
		panel.rebuild();
		panel
	}

	/// Current status badge.
	#[must_use]
	pub const fn status(&self) -> SideStatus {
		self.status
	}

	/// Answer text received so far.
	#[must_use]
	pub fn answer(&self) -> &str {
		self.answer.as_str()
	}

	/// Drains queued side events; returns whether anything changed.
	fn drain(&mut self) -> bool {
		let mut changed = false;
		while let Ok(event) = self.events.try_recv() {
			changed = true;
			match event {
				SideEvent::Delta(text) => self.answer.push_str(text.as_str()),
				SideEvent::Done => self.status = SideStatus::Complete,
				SideEvent::Error(error) => {
					self.error = Some(error);
					self.status = SideStatus::Error;
				},
			}
		}
		if self.status == SideStatus::Running && self.events.is_disconnected() {
			self.status = SideStatus::Complete;
			changed = true;
		}
		changed
	}

	fn route(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}

	fn rebuild(&mut self) {
		let question = self.question.clone();
		let status = self.status.label();
		let status_fg = match self.status {
			SideStatus::Running => "accent",
			SideStatus::Complete => "success",
			SideStatus::Error | SideStatus::Aborted => "err",
		};
		let body = match &self.error {
			Some(error) => Str::new(format!("Error: {error}")),
			None if self.answer.is_empty() => Str::new_static("…"),
			None => Str::new(self.answer.as_str()),
		};
		let hint = if self.status == SideStatus::Running {
			HINT_RUNNING
		} else {
			HINT_DONE
		};
		let rows = self.rows;
		let tree = dom! {
			<box border=round title="btw" pad-x=1>
				<col>
					<row gap=1>
						<text bold truncate grow>{question}</text>
						<text fg={status_fg}>{status}</text>
					</row>
					<hr border=round/>
					<scroll id="answer" h={rows} focus>
						<md>{body}</md>
					</scroll>
					<text fg=muted truncate>{hint}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}
}

impl Panel for SidePanel {
	fn id(&self) -> &'static str {
		"btw"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Side
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => {
				if self.status == SideStatus::Running {
					self.status = SideStatus::Aborted;
				}
				PanelEvent::Close
			},
			Key::Char('c') => {
				if self.answer.is_empty() {
					PanelEvent::Notice(Str::new_static("No /btw answer to copy yet"))
				} else {
					PanelEvent::Copy(Str::new(self.answer.as_str()))
				}
			},
			Key::Up | Key::Down | Key::PageUp | Key::PageDown => {
				let event = self.ui.handle_key(key);
				self.route(event)
			},
			_ => PanelEvent::Ignored,
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.route(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = (viewport.height / 3)
			.saturating_sub(CHROME_ROWS)
			.clamp(3, MAX_ROWS);
		if viewport.width != self.width || rows != self.rows {
			self.width = viewport.width;
			self.rows = rows;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		self.last = now;
		if self.drain() {
			self.rebuild();
			// Follow the stream: keep the newest answer rows visible.
			self.ui.set_prop("answer", Prop::H, self.rows);
			return true;
		}
		false
	}

	fn next_wake(&self) -> Option<Duration> {
		(self.status == SideStatus::Running).then(|| self.last + POLL)
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_con::Ctx;
	use omp_dom::Dom;
	use omp_tui::{Mods, Mouse, MouseButton};

	use super::*;
	use crate::overlays::{NoServices, Services};

	fn cx<'a>(
		dom: &'a Dom,
		con: &'a Ctx,
		ui: &'a UiContext,
		services: &'a Arc<dyn Services>,
	) -> PanelCx<'a> {
		PanelCx { dom, con, ui, viewport: Size { width: 60, height: 24 }, services }
	}

	fn wheel_down(col: u16, row: u16) -> MouseReport {
		MouseReport {
			kind: Mouse::WheelDown,
			col,
			row,
			button: MouseButton::WheelDown,
			mods: Mods::default(),
			pressed: true,
		}
	}

	fn point(text: &str, needle: &str) -> (u16, u16) {
		text
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find(needle)?;
				Some((omp_tui::cell_width(&line[..byte]), u16::try_from(row).unwrap()))
			})
			.expect("text point")
	}

	#[test]
	fn streams_deltas_then_settles_and_copies() {
		let dom = Dom::new();
		let con = Ctx::new();
		let ui = UiContext::default();
		let services: Arc<dyn Services> = Arc::new(NoServices);
		let (tx, rx) = flume::unbounded();
		let mut panel = SidePanel::btw(
			Str::new_static("why is the sky blue?"),
			rx,
			&cx(&dom, &con, &ui, &services),
		);
		assert_eq!(panel.status(), SideStatus::Running);
		assert!(panel.next_wake().is_some(), "running panels poll the stream");
		tx.send(SideEvent::Delta(Str::new_static("Rayleigh ")))
			.unwrap();
		tx.send(SideEvent::Delta(Str::new_static("scattering.")))
			.unwrap();
		assert!(panel.tick(Duration::from_millis(40)));
		assert_eq!(panel.answer(), "Rayleigh scattering.");
		let text = omp_tui::frame_text(panel.frame(Size { width: 60, height: 24 }));
		assert!(text.contains("why is the sky blue?"), "question header missing:\n{text}");
		assert!(text.contains("running"), "status badge missing:\n{text}");
		tx.send(SideEvent::Done).unwrap();
		assert!(panel.tick(Duration::from_millis(80)));
		assert_eq!(panel.status(), SideStatus::Complete);
		assert!(panel.next_wake().is_none(), "settled panels stop polling");
		assert_eq!(
			panel.key(Key::Char('c')),
			PanelEvent::Copy(Str::new_static("Rayleigh scattering."))
		);
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn wheel_scrolls_the_streamed_answer() {
		let dom = Dom::new();
		let con = Ctx::new();
		let ui = UiContext::default();
		let services: Arc<dyn Services> = Arc::new(NoServices);
		let (tx, rx) = flume::unbounded();
		let mut panel = SidePanel::btw(Str::new_static("q"), rx, &cx(&dom, &con, &ui, &services));
		tx.send(SideEvent::Delta(Str::new_static(
			"line 1  \nline 2  \nline 3  \nline 4  \nline 5  \nline 6",
		)))
		.unwrap();
		assert!(panel.tick(Duration::from_millis(40)));
		let size = Size { width: 60, height: 15 };
		let before = omp_tui::frame_text(panel.frame(size));
		let (col, row) = point(&before, "line 1");
		assert_eq!(panel.mouse(wheel_down(col, row)), PanelEvent::Consumed);
		let after = omp_tui::frame_text(panel.frame(size));
		assert_ne!(after, before, "wheel must move the answer viewport");
		assert!(after.contains("line 4"), "next answer row did not enter the viewport:\n{after}");
	}

	#[test]
	fn escape_while_running_marks_the_answer_aborted() {
		let dom = Dom::new();
		let con = Ctx::new();
		let ui = UiContext::default();
		let services: Arc<dyn Services> = Arc::new(NoServices);
		let (_tx, rx) = flume::unbounded::<SideEvent>();
		let mut panel = SidePanel::btw(Str::new_static("q"), rx, &cx(&dom, &con, &ui, &services));
		assert_eq!(
			panel.key(Key::Char('c')),
			PanelEvent::Notice(Str::new_static("No /btw answer to copy yet"))
		);
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
		assert_eq!(panel.status(), SideStatus::Aborted);
	}
}
