//! Focused `/session info` panel.
//!
//! The session facts stay a projection of the detached DOM replica; this
//! module owns only the observer-local viewport, focus, and input behavior
//! (ADR 0005).

use omp_core::Str;
use omp_tui::{Frame, Key, MouseReport, Size, Ui, UiContext, UiEvent, dom};

use super::{Panel, PanelAnchor, PanelEvent};

/// Stable overlay identity used by host open/close notifications.
pub const ID: &str = "session";
const HINT: &str = "↑/↓ scroll · c copy · Esc close";
/// Top and bottom border, divider, and footer.
const CHROME_ROWS: u16 = 4;

/// Bottom-centered, viewport-clamped session information panel.
pub struct SessionInfoPanel {
	body:   Str,
	ui:     Ui,
	ctx:    UiContext,
	width:  u16,
	height: u16,
}

impl SessionInfoPanel {
	/// Builds the panel over the already-derived session report.
	#[must_use]
	pub fn new(body: impl Into<Str>, ctx: &UiContext) -> Self {
		let mut panel = Self {
			body:   body.into(),
			ui:     Ui::from_root(dom! { <col/> }, 1, ctx.clone()),
			ctx:    ctx.clone(),
			width:  0,
			height: 0,
		};
		panel.rebuild(80, 20);
		panel
	}

	fn rebuild(&mut self, width: u16, height: u16) {
		self.width = width.max(1);
		self.height = height.max(1);
		let body = self.body.clone();
		let hint = HINT;
		let inner_width = self.width.saturating_sub(4).max(1);
		let measured =
			Ui::from_root(dom! { <md>{body.clone()}</md> }, inner_width, self.ctx.clone()).height();
		let body_rows = measured.clamp(1, self.height.saturating_sub(CHROME_ROWS).max(1));
		let tree = dom! {
			<box border=round title="Session Info" pad-x=1>
				<col>
					<scroll id="session-info" h={body_rows} focus>
						<md>{body}</md>
					</scroll>
					<hr border=round/>
					<text fg=muted truncate>{hint}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
		let _ = self.ui.focus_id("session-info");
	}

	fn route(event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Copied(text) => PanelEvent::Copy(text),
			_ => PanelEvent::Consumed,
		}
	}
}

impl Panel for SessionInfoPanel {
	fn id(&self) -> &'static str {
		ID
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::BottomCenter
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => PanelEvent::Close,
			Key::Char('c') => PanelEvent::Copy(self.body.clone()),
			_ => Self::route(self.ui.handle_key(key)),
		}
	}

	fn paste(&mut self, _text: &str) -> PanelEvent {
		// A focused modal owns paste. Refusing it here prevents a hidden
		// composer mutation while the information panel is open.
		PanelEvent::Consumed
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		Self::route(
			self
				.ui
				.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods),
		)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width || viewport.height != self.height {
			self.rebuild(viewport.width, viewport.height);
		}
		self.ui.frame()
	}
}
