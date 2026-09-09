//! `/pause` hold screen: a full-screen `P A U S E D`
//! banner with a `paused for M:SS` clock ticking every second; Esc, Enter,
//! Space, or Ctrl+C resume. The gate itself is controller-owned
//! (`HostCommand::Pause`); this panel only shows the hold and reports how
//! long it lasted.

use std::time::Duration;

use omp_core::{Str, sf};
use omp_tui::{Frame, Key, Size, Ui, UiContext, dom};

use super::{Panel, PanelAnchor, PanelCx, PanelEvent};

/// Pause-clock update cadence.
const TICK: Duration = Duration::from_secs(1);
/// Compact-layout thresholds.
const COMPACT_WIDTH: u16 = 64;
const COMPACT_HEIGHT: u16 = 18;
/// Pause-bar geometry: two blocks of `BAR_WIDTH` separated by `BAR_GAP`,
/// `BAR_ROWS` tall.
const BAR_WIDTH: usize = 5;
const BAR_GAP: usize = 4;
const BAR_ROWS: usize = 7;
const TITLE: &str = "P A U S E D";
const BODY_1: &str = "Main agent, subagents, and advisor hold at their next step.";
const BODY_2: &str = "In-flight calls finish; nothing new starts until you resume.";
const HINT_FULL: &str = "esc · enter · space — resume";
const HINT_COMPACT: &str = "esc to resume";

/// Retained pause screen.
pub struct PausePanel {
	session: Option<Str>,
	ui:      Ui,
	ctx:     UiContext,
	size:    Size,
	opened:  Option<Duration>,
	now:     Duration,
	shown:   u64,
}

impl PausePanel {
	/// Opens the screen; `session` is the session title shown on top.
	#[must_use]
	pub fn open(session: Option<Str>, cx: &PanelCx<'_>) -> Self {
		let mut panel = Self {
			session,
			ui: Ui::from_root(dom! { <col/> }, cx.viewport.width, cx.ui.clone()),
			ctx: cx.ui.clone(),
			size: cx.viewport,
			opened: None,
			now: Duration::ZERO,
			shown: 0,
		};
		panel.rebuild();
		panel
	}

	/// Whole seconds held so far.
	#[must_use]
	pub fn held(&self) -> Duration {
		self
			.opened
			.map_or(Duration::ZERO, |opened| self.now.saturating_sub(opened))
	}

	/// Formats `M:SS`, or `H:MM:SS` past an hour.
	#[must_use]
	pub fn clock(elapsed: Duration) -> Str {
		let total = elapsed.as_secs();
		let (hours, minutes, seconds) = (total / 3600, (total % 3600) / 60, total % 60);
		if hours > 0 {
			sf!("{hours}:{minutes:02}:{seconds:02}")
		} else {
			sf!("{minutes}:{seconds:02}")
		}
	}

	/// Formats the resume notice as `Ns`, `Nm Ss`, or `Nh Mm`.
	#[must_use]
	pub fn duration(elapsed: Duration) -> Str {
		let total = elapsed.as_secs();
		let (hours, minutes, seconds) = (total / 3600, (total % 3600) / 60, total % 60);
		if hours > 0 {
			sf!("{hours}h {minutes}m")
		} else if minutes > 0 {
			sf!("{minutes}m {seconds}s")
		} else {
			sf!("{seconds}s")
		}
	}

	fn rebuild(&mut self) {
		let compact = self.size.width < COMPACT_WIDTH || self.size.height < COMPACT_HEIGHT;
		let clock = sf!("paused for {}", Self::clock(self.held()));
		let session = self.session.clone().unwrap_or_default();
		let has_session = !session.is_empty();
		let bar = {
			let mut row = String::with_capacity(BAR_WIDTH * 2 + BAR_GAP);
			row.extend(std::iter::repeat_n('█', BAR_WIDTH));
			row.extend(std::iter::repeat_n(' ', BAR_GAP));
			row.extend(std::iter::repeat_n('█', BAR_WIDTH));
			Str::new(row)
		};
		let bars = (0..BAR_ROWS).map(|_| bar.clone()).collect::<Vec<_>>();
		let tree = if compact {
			dom! {
				<col align=center>
					if has_session { <text bold align=center>{session}</text> }
					<text/>
					<text bold fg=accent align=center>{"▌▌ P A U S E D"}</text>
					<text/>
					<text fg=muted align=center>{clock}</text>
					<text fg=muted align=center>{HINT_COMPACT}</text>
				</col>
			}
		} else {
			dom! {
				<col align=center>
					if has_session { <text bold align=center>{session}</text> }
					<text/>
					<text/>
					for row in bars { <text fg=accent align=center>{row}</text> }
					<text/>
					<text bold fg=accent align=center>{TITLE}</text>
					<text/>
					<text fg=muted align=center>{BODY_1}</text>
					<text fg=muted align=center>{BODY_2}</text>
					<text/>
					<text fg=muted align=center>{clock}</text>
					<text/>
					<text fg=muted align=center>{HINT_FULL}</text>
				</col>
			}
		};
		self.ui = Ui::from_root(tree, self.size.width, self.ctx.clone());
		self.shown = self.held().as_secs();
	}
}

impl Panel for PausePanel {
	fn id(&self) -> &'static str {
		"pause"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc | Key::Enter | Key::Char(' ') | Key::Ctrl('c') => {
				PanelEvent::Finish(sf!("pause_resume {}", self.held().as_millis()))
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport != self.size {
			self.size = viewport;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		self.now = now;
		if self.opened.is_none() {
			self.opened = Some(now);
		}
		if self.held().as_secs() != self.shown {
			self.rebuild();
			return true;
		}
		false
	}

	fn next_wake(&self) -> Option<Duration> {
		let opened = self.opened?;
		let next = self.held().as_secs().saturating_add(1);
		Some(opened + Duration::from_secs(next).max(TICK))
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_con::Ctx;
	use omp_dom::Dom;

	use super::*;
	use crate::overlays::{NoServices, Services};

	#[test]
	fn clock_ticks_once_per_second_and_any_resume_key_reports_the_hold() {
		let dom = Dom::new();
		let con = Ctx::new();
		let ui = UiContext::default();
		let services: Arc<dyn Services> = Arc::new(NoServices);
		let cx = PanelCx {
			dom:      &dom,
			con:      &con,
			ui:       &ui,
			viewport: Size { width: 80, height: 24 },
			services: &services,
		};
		let mut panel = PausePanel::open(Some(Str::new_static("refactor auth")), &cx);
		assert!(panel.tick(Duration::from_secs(10)) || panel.held().is_zero());
		let text = omp_tui::frame_text(panel.frame(Size { width: 80, height: 24 }));
		assert!(text.contains("P A U S E D"), "banner missing:\n{text}");
		assert!(text.contains("refactor auth"), "session title missing:\n{text}");
		assert!(text.contains("paused for 0:00"), "clock missing:\n{text}");
		assert!(text.contains(HINT_FULL), "hint missing:\n{text}");
		assert!(!panel.tick(Duration::from_millis(10_500)), "sub-second ticks do not repaint");
		assert_eq!(panel.next_wake(), Some(Duration::from_secs(11)));
		assert!(panel.tick(Duration::from_secs(71)));
		let text = omp_tui::frame_text(panel.frame(Size { width: 80, height: 24 }));
		assert!(text.contains("paused for 1:01"), "clock did not advance:\n{text}");
		assert_eq!(panel.key(Key::Char('x')), PanelEvent::Consumed);
		assert_eq!(
			panel.key(Key::Char(' ')),
			PanelEvent::Finish(Str::new_static("pause_resume 61000"))
		);
	}

	#[test]
	fn compact_layout_below_pi_thresholds() {
		let dom = Dom::new();
		let con = Ctx::new();
		let ui = UiContext::default();
		let services: Arc<dyn Services> = Arc::new(NoServices);
		let cx = PanelCx {
			dom:      &dom,
			con:      &con,
			ui:       &ui,
			viewport: Size { width: 50, height: 12 },
			services: &services,
		};
		let mut panel = PausePanel::open(None, &cx);
		let text = omp_tui::frame_text(panel.frame(Size { width: 50, height: 12 }));
		assert!(text.contains("▌▌ P A U S E D"), "compact banner missing:\n{text}");
		assert!(text.contains(HINT_COMPACT));
		assert!(!text.contains(BODY_1));
		assert_eq!(PausePanel::clock(Duration::from_secs(3725)).as_str(), "1:02:05");
		assert_eq!(PausePanel::duration(Duration::from_secs(95)).as_str(), "1m 35s");
	}
}
