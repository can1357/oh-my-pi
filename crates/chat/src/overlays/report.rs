//! Centered scrollable report panel: the one presentation for slash
//! commands that answer with a multi-line markdown report (`/tools`,
//! `/security`, `/hotkeys`, `/changelog`, `/context`, …). They are
//! observer-local
//! panels (ADR 0005) until the local-block seam lands, so they never enter
//! the journal either way.

use std::time::Duration;

use omp_core::{Str, sf};
use omp_tui::{
	Frame, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, components::Loader, dom,
};

use super::{Panel, PanelAnchor, PanelEvent, services::Pending};

const HINT: &str = "↑/↓ scroll · PgUp/PgDn page · Esc close";
/// Border, title rule, hint, and blank rows around the scroll pane.
const CHROME_ROWS: u16 = 5;
/// Poll cadence while a pending report's feed runs.
const POLL: Duration = Duration::from_millis(100);
const PENDING_HINT: &str = "esc cancel";

/// Retained markdown report with a scroll pane.
pub struct ReportPanel {
	id:    &'static str,
	title: Str,
	body:  Str,
	ui:    Ui,
	ctx:   UiContext,
	width: u16,
	rows:  u16,
}

impl ReportPanel {
	/// Builds a report titled `title` over markdown `body`.
	#[must_use]
	pub fn new(
		id: &'static str,
		title: impl Into<Str>,
		body: impl Into<Str>,
		ctx: &UiContext,
	) -> Self {
		let mut panel = Self {
			id,
			title: title.into(),
			body: body.into(),
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 0,
			rows: 0,
		};
		panel.rebuild(80, 20);
		panel
	}

	/// Replaces the body (live reports re-render in place).
	pub fn set_body(&mut self, body: impl Into<Str>) {
		self.body = body.into();
		self.rebuild(self.width, self.rows);
	}

	/// Report body as shown.
	#[must_use]
	pub fn body(&self) -> &str {
		&self.body
	}

	fn rebuild(&mut self, width: u16, rows: u16) {
		self.width = width;
		self.rows = rows;
		let title = self.title.clone();
		let body = self.body.clone();
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					<scroll id="report" h={rows} focus>
						<md>{body}</md>
					</scroll>
					<hr border=round/>
					<text fg=muted truncate>{HINT}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
	}

	fn route(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}
}

impl Panel for ReportPanel {
	fn id(&self) -> &'static str {
		self.id
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc | Key::Char('q') => PanelEvent::Close,
			_ => {
				let event = self.ui.handle_key(key);
				self.route(event)
			},
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.route(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = viewport.height.saturating_sub(CHROME_ROWS).max(3);
		if viewport.width != self.width {
			self.rebuild(viewport.width, rows);
		} else if rows != self.rows {
			self.rows = rows;
			self.ui.set_prop("report", Prop::H, rows);
		}
		self.ui.frame()
	}
}

enum PendingState<T> {
	Waiting(Pending<T>),
	Ready(ReportPanel),
}

/// A report whose body settles asynchronously (`/stats` syncs every stored
/// journal first): a cancellable loader while the feed runs, then the
/// [`ReportPanel`] over the
/// rendered result.
pub struct PendingReportPanel<T> {
	id:        &'static str,
	title:     Str,
	message:   Str,
	state:     PendingState<T>,
	render:    fn(&T) -> Str,
	cancel:    Option<flume::Sender<()>>,
	next_wake: Option<Duration>,
	ui:        Ui,
	ctx:       UiContext,
	width:     u16,
}

impl<T> PendingReportPanel<T> {
	/// Opens the loader over `pending`; `render` turns the settled value
	/// into the report's markdown.
	#[must_use]
	pub fn new(
		id: &'static str,
		title: impl Into<Str>,
		message: impl Into<Str>,
		pending: Pending<T>,
		render: fn(&T) -> Str,
		ctx: &UiContext,
	) -> Self {
		Self::new_cancellable(id, title, message, pending, render, None, ctx)
	}

	/// Opens a cancellable loader that becomes a scrollable report after
	/// settlement.
	#[must_use]
	pub fn new_cancellable(
		id: &'static str,
		title: impl Into<Str>,
		message: impl Into<Str>,
		pending: Pending<T>,
		render: fn(&T) -> Str,
		cancel: Option<flume::Sender<()>>,
		ctx: &UiContext,
	) -> Self {
		let mut panel = Self {
			id,
			title: title.into(),
			message: message.into(),
			state: PendingState::Waiting(pending),
			render,
			cancel,
			next_wake: Some(Duration::ZERO),
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 0,
		};
		panel.rebuild(80);
		panel
	}

	/// The settled report body, once the feed completed.
	#[must_use]
	pub fn body(&self) -> Option<&str> {
		match &self.state {
			PendingState::Ready(report) => Some(report.body()),
			PendingState::Waiting(_) => None,
		}
	}

	fn rebuild(&mut self, width: u16) {
		self.width = width;
		let title = self.title.clone();
		let loader = Loader::new(self.message.clone()).hint(PENDING_HINT);
		let tree = dom! { <box border=round title={title}>{loader}</box> };
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
	}

	fn settle(&mut self, body: Str) {
		self.cancel = None;
		self.state =
			PendingState::Ready(ReportPanel::new(self.id, self.title.clone(), body, &self.ctx));
		self.next_wake = None;
	}
}

impl<T> Panel for PendingReportPanel<T> {
	fn id(&self) -> &'static str {
		self.id
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match &mut self.state {
			PendingState::Ready(report) => report.key(key),
			PendingState::Waiting(_) => match key {
				Key::Esc => {
					if let Some(cancel) = self.cancel.take() {
						let _ = cancel.send(());
					}
					PanelEvent::Close
				},
				_ => PanelEvent::Consumed,
			},
		}
	}

	fn mouse(&mut self, mouse: MouseReport) -> PanelEvent {
		match &mut self.state {
			PendingState::Ready(report) => report.mouse(mouse),
			PendingState::Waiting(_) => PanelEvent::Ignored,
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		match &mut self.state {
			PendingState::Ready(report) => report.frame(viewport),
			PendingState::Waiting(_) => {
				if viewport.width != self.width {
					self.rebuild(viewport.width);
				}
				self.ui.frame()
			},
		}
	}

	fn tick(&mut self, now: Duration) -> bool {
		let PendingState::Waiting(pending) = &self.state else {
			return false;
		};
		let body = match pending.try_recv() {
			Ok(Ok(value)) => (self.render)(&value),
			Ok(Err(error)) => sf!("**Error:** {error}"),
			Err(flume::TryRecvError::Disconnected) => {
				Str::new_static("**Error:** the request was dropped before settling")
			},
			Err(flume::TryRecvError::Empty) => {
				self.next_wake = Some(now + POLL);
				return false;
			},
		};
		self.settle(body);
		true
	}

	fn next_wake(&self) -> Option<Duration> {
		self.next_wake
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::{Mods, Mouse, MouseButton};

	use super::*;
	use crate::overlays::services::ServiceResult;

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
	fn report_wheel_scrolls_the_retained_body() {
		let ctx = UiContext::default();
		let mut panel = ReportPanel::new(
			"report",
			"Report",
			"line 1  \nline 2  \nline 3  \nline 4  \nline 5  \nline 6",
			&ctx,
		);
		let size = Size { width: 40, height: 8 };
		let before = omp_tui::frame_text(panel.frame(size));
		let (col, row) = point(&before, "line 1");
		assert_eq!(panel.mouse(wheel_down(col, row)), PanelEvent::Consumed);
		let after = omp_tui::frame_text(panel.frame(size));
		assert_ne!(after, before, "wheel must move the report viewport");
		assert!(after.contains("line 4"), "next row did not enter the viewport:\n{after}");
	}

	#[test]
	fn pending_report_shows_loader_then_the_rendered_body() {
		let ctx = UiContext::default();
		let (tx, rx) = flume::bounded(1);
		let mut panel = PendingReportPanel::new(
			"stats",
			"Stats",
			"Syncing session files...",
			rx,
			|n: &u32| sf!("requests: {n}"),
			&ctx,
		);
		let text = omp_tui::frame_text(panel.frame(Size { width: 60, height: 12 }));
		assert!(text.contains("Syncing session files..."), "loader missing:\n{text}");
		assert!(!panel.tick(Duration::from_millis(10)));
		assert_eq!(panel.next_wake(), Some(Duration::from_millis(110)));
		tx.send(Ok(7)).unwrap();
		assert!(panel.tick(Duration::from_millis(120)));
		assert_eq!(panel.next_wake(), None);
		let text = omp_tui::frame_text(panel.frame(Size { width: 60, height: 12 }));
		assert!(text.contains("requests: 7"), "body missing:\n{text}");
		assert!(text.contains("Esc close"), "hint missing:\n{text}");
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn pending_report_escape_cancels_the_backing_operation() {
		let ctx = UiContext::default();
		let (_tx, rx) = flume::bounded::<ServiceResult<Str>>(1);
		let (cancel_tx, cancel_rx) = flume::bounded(1);
		let mut panel = PendingReportPanel::new_cancellable(
			"mcp",
			"Smithery",
			"Searching...",
			rx,
			Str::clone,
			Some(cancel_tx),
			&ctx,
		);
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
		assert_eq!(cancel_rx.try_recv(), Ok(()));
	}

	#[test]
	fn report_shows_title_body_and_hint_and_esc_closes() {
		let ctx = UiContext::default();
		let mut panel = ReportPanel::new("tools", "Tools", "- **read** · reads files", &ctx);
		let frame = panel.frame(Size { width: 60, height: 12 });
		let text = omp_tui::frame_text(frame);
		assert!(text.contains("Tools"), "title missing:\n{text}");
		assert!(text.contains("read"), "body missing:\n{text}");
		assert!(text.contains("Esc close"), "hint missing:\n{text}");
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
	}
}
